import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execShell } from '../exec.js';
import { worktreeDiff, worktreePatch } from '../git.js';
import type { GradeResult, Grader } from '../types.js';

export interface GradeContext {
  cwd: string;
  /** Per-grader cap; a rules change can easily send a test suite into a loop. */
  defaultTimeoutMs: number;
}

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
  }
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
      const re = new RegExp(g.pattern, g.flags ?? 'i');
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
