import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execShell } from '../exec.js';
import { worktreeDiff, worktreePatch } from '../git.js';
import type { AskOutcome, GradeResult, Grader } from '../types.js';

export interface GradeContext {
  cwd: string;
  /** Per-grader cap; a rules change can easily send a test suite into a loop. */
  defaultTimeoutMs: number;
  /**
   * Answers `judge` graders. Absent when the adapter cannot answer questions,
   * in which case judge graders fail rather than pass.
   */
  judge?: (prompt: string, timeoutMs: number) => Promise<AskOutcome>;
  judgeTimeoutMs?: number;
}

/** Beyond this the diff is truncated; a judge cannot read a 200kB patch anyway. */
const MAX_JUDGE_PATCH = 24_000;

function label(g: Grader): string {
  switch (g.type) {
    case 'run':
      return g.label ?? g.cmd;
    case 'file-contains':
      return `${g.path} matches /${g.pattern}/`;
    case 'file-absent':
      return `${g.path} is absent`;
    case 'no-new-pattern':
      return `no new /${g.pattern}/`;
    case 'diff-files-max':
      return `at most ${g.max} files changed`;
    case 'touched':
      return `touched ${g.paths.join(', ')}`;
    case 'judge':
      return g.label ?? `judged: ${g.rubric.slice(0, 50)}`;
  }
}

/**
 * The judge sees the diff and the criterion, and nothing else.
 *
 * Withholding the repository is the point: if the judge could read the rules
 * file, it would be scoring whether the rule was followed by looking the rule
 * up, and every variant that still contained the rule would score well by
 * construction.
 */
function judgePrompt(rubric: string, patch: string): string {
  const body =
    patch.length > MAX_JUDGE_PATCH
      ? `${patch.slice(0, MAX_JUDGE_PATCH)}\n[diff truncated]`
      : patch;
  return [
    'You are grading one code change against one criterion.',
    '',
    'CRITERION',
    rubric,
    '',
    'DIFF',
    body || '(the change is empty)',
    '',
    'Answer PASS if the change meets the criterion and FAIL if it does not.',
    'An empty diff, or one that does not address the criterion, is a FAIL.',
    'Reply with exactly one word: PASS or FAIL.',
  ].join('\n');
}

/** Takes the last verdict word, since a model often restates before answering. */
function parseVerdict(text: string): boolean | null {
  const matches = text.match(/\b(PASS|FAIL)\b/gi);
  if (!matches || matches.length === 0) return null;
  return (matches[matches.length - 1] ?? '').toUpperCase() === 'PASS';
}

/** Only `+` lines of the patch, so a pre-existing match is not blamed on the agent. */
function addedLines(patch: string): string {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function runGrader(g: Grader, ctx: GradeContext): Promise<GradeResult> {
  const name = label(g);

  switch (g.type) {
    case 'run': {
      const res = await execShell(g.cmd, {
        cwd: ctx.cwd,
        timeoutMs: g.timeoutMs ?? ctx.defaultTimeoutMs,
      });
      if (res.timedOut) return { label: name, pass: false, detail: 'timed out' };
      const tail = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' ');
      return {
        label: name,
        pass: res.code === 0,
        ...(res.code === 0 ? {} : { detail: `exit ${res.code}: ${tail.slice(0, 200)}` }),
      };
    }

    case 'file-contains': {
      const content = await readOrNull(join(ctx.cwd, g.path));
      if (content === null) return { label: name, pass: false, detail: 'file not found' };
      // Defaults to case-sensitive, matching `no-new-pattern` and a bare regex.
      const re = new RegExp(g.pattern, g.flags ?? '');
      return { label: name, pass: re.test(content) };
    }

    case 'file-absent': {
      const content = await readOrNull(join(ctx.cwd, g.path));
      return {
        label: name,
        pass: content === null,
        ...(content === null ? {} : { detail: 'file exists' }),
      };
    }

    case 'no-new-pattern': {
      const patch = await worktreePatch(ctx.cwd);
      const re = new RegExp(g.pattern, g.flags ?? '');
      const hit = addedLines(patch)
        .split('\n')
        .find((l) => re.test(l));
      return {
        label: name,
        pass: hit === undefined,
        ...(hit === undefined ? {} : { detail: hit.trim().slice(0, 120) }),
      };
    }

    case 'diff-files-max': {
      const diff = await worktreeDiff(ctx.cwd);
      return {
        label: name,
        pass: diff.files.length <= g.max,
        detail: `${diff.files.length} changed`,
      };
    }

    case 'touched': {
      const diff = await worktreeDiff(ctx.cwd);
      const missing = g.paths.filter((p) => !diff.files.some((f) => f === p || f.endsWith(`/${p}`)));
      return {
        label: name,
        pass: missing.length === 0,
        ...(missing.length === 0 ? {} : { detail: `untouched: ${missing.join(', ')}` }),
      };
    }

    case 'judge': {
      if (!ctx.judge) {
        // A configuration fault, not a measurement: excluded rather than
        // silently scored, so a missing judge cannot look like a failing agent.
        return {
          label: name,
          pass: false,
          errored: true,
          detail: 'no judge available; set agent.askCmd or use the claude adapter',
        };
      }
      const patch = await worktreePatch(ctx.cwd);
      const answer = await ctx.judge(
        judgePrompt(g.rubric, patch),
        ctx.judgeTimeoutMs ?? 120_000,
      );
      if (answer.error) {
        return {
          label: name,
          pass: false,
          errored: true,
          detail: answer.error,
          costUsd: answer.costUsd ?? 0,
        };
      }
      const verdict = parseVerdict(answer.text);
      if (verdict === null) {
        return {
          label: name,
          pass: false,
          errored: true,
          detail: `unparseable verdict: ${answer.text.trim().slice(0, 80)}`,
          costUsd: answer.costUsd ?? 0,
        };
      }
      return { label: name, pass: verdict, costUsd: answer.costUsd ?? 0 };
    }
  }
}

/**
 * Grades one trial. Every grader runs even after the first failure, because the
 * per-grader breakdown is what tells you *how* a rule changed behaviour.
 */
export async function grade(graders: Grader[], ctx: GradeContext): Promise<GradeResult[]> {
  const results: GradeResult[] = [];
  for (const g of graders) results.push(await runGrader(g, ctx));
  return results;
}
