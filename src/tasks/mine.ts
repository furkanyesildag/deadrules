import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recentCommits, type MinedCommit } from '../git.js';
import type { Grader, Task } from '../types.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|cs|php|scala|ex|exs)$/i;
const NOISE = /^(wip|fixup|squash|merge|bump|release|v?\d+\.\d+\.\d+)/i;

/** Detects how this repo runs its tests, so mined tasks are graded on something real. */
export async function detectTestCommand(root: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.['test']) return 'npm test';
  } catch {
    /* not a node project */
  }

  const probes: [string, string][] = [
    ['pyproject.toml', 'pytest -q'],
    ['Cargo.toml', 'cargo test'],
    ['go.mod', 'go test ./...'],
    ['Gemfile', 'bundle exec rspec'],
    ['Makefile', 'make test'],
  ];
  for (const [file, cmd] of probes) {
    try {
      await readFile(join(root, file), 'utf8');
      return cmd;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

/**
 * Drops the trailer block (`Co-Authored-By:`, `Signed-off-by:`, and friends).
 * Those lines are addressed to reviewers, not to whoever has to do the work,
 * and leaving them in the prompt only spends tokens.
 */
function stripTrailers(body: string): string {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0) {
    const line = (lines[end - 1] ?? '').trim();
    if (line === '' || /^[A-Za-z-]+:\s/.test(line)) end--;
    else break;
  }
  return lines.slice(0, end).join('\n').trim();
}

function slug(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function isUsable(c: MinedCommit): boolean {
  if (c.subject.length < 15) return false;
  if (NOISE.test(c.subject.trim())) return false;
  const code = c.files.filter((f) => CODE.test(f));
  // One to six code files is the band where a commit reads as a single task:
  // smaller is usually a typo fix, larger is a refactor no agent will reproduce.
  return code.length >= 1 && code.length <= 6 && c.files.length <= 10;
}

/**
 * Turns real commits into draft tasks.
 *
 * A commit is a task whose accepted answer is already in the repo, which is why
 * mining beats writing tasks by hand. It is still only a draft: the commit
 * message was written for humans who had the surrounding context, so the
 * prompt usually needs an edit before the task measures anything meaningful.
 */
export async function mineTasks(
  root: string,
  count: number,
  testCommand: string | null,
): Promise<Task[]> {
  const commits = await recentCommits(root, Math.max(count * 6, 40));
  const usable = commits.filter(isUsable).slice(0, count);

  return usable.map((c) => {
    const body = stripTrailers(c.body);
    const grade: Grader[] = [];
    if (testCommand) grade.push({ type: 'run', cmd: testCommand, label: 'tests pass' });
    grade.push({ type: 'touched', paths: c.files.filter((f) => CODE.test(f)).slice(0, 3) });

    return {
      id: `${c.sha.slice(0, 7)}-${slug(c.subject)}`,
      prompt: body ? `${c.subject}\n\n${body}` : c.subject,
      base: `${c.sha}^`,
      grade,
      weight: 1,
      origin: `mined from commit ${c.sha.slice(0, 7)}`,
    };
  });
}

export function renderTaskFile(task: Task): string {
  const front = {
    id: task.id,
    base: task.base,
    grade: task.grade,
    weight: task.weight,
    origin: task.origin,
  };
  return [
    '---',
    JSON.stringify(front, null, 2),
    '---',
    '',
    '<!-- Draft mined from git history. Read it before trusting any number it',
    '     produces: the prompt is a commit subject, so it may assume context the',
    '     agent will not have, and the `touched` grader only checks that the right',
    '     files moved, not that the change was correct. -->',
    '',
    task.prompt,
    '',
  ].join('\n');
}
