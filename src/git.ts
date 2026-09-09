import { exec } from './exec.js';

export interface DiffStats {
  files: string[];
  insertions: number;
  deletions: number;
}

export interface MinedCommit {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

async function git(cwd: string, args: string[], timeoutMs = 60_000) {
  const res = await exec('git', args, { cwd, timeoutMs });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', ref])).trim();
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).trim() === '';
}

export async function addWorktree(root: string, dir: string, ref: string): Promise<void> {
  await git(root, ['worktree', 'add', '--detach', '--force', dir, ref], 120_000);
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  // A failed run can leave the worktree dirty; the measurement is already
  // recorded by this point, so discarding it is always the right move.
  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: root, timeoutMs: 60_000 });
}

export async function pruneWorktrees(root: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: root, timeoutMs: 30_000 });
}

/**
 * What the agent changed in a worktree, counting untracked files.
 *
 * Untracked files matter more than tracked ones here: a new source file is the
 * most common shape of agent output, and `git diff` alone would miss it.
 */
export async function worktreeDiff(cwd: string): Promise<DiffStats> {
  await exec('git', ['add', '-A', '--intent-to-add'], { cwd, timeoutMs: 60_000 });
  const numstat = await git(cwd, ['diff', '--numstat']);
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    files.push(path);
    insertions += add === '-' ? 0 : Number(add) || 0;
    deletions += del === '-' ? 0 : Number(del) || 0;
  }
  return { files, insertions, deletions };
}

/** The unified diff of a worktree, used by pattern graders. */
export async function worktreePatch(cwd: string): Promise<string> {
  await exec('git', ['add', '-A', '--intent-to-add'], { cwd, timeoutMs: 60_000 });
  const res = await exec('git', ['diff', '--unified=0'], { cwd, timeoutMs: 60_000 });
  return res.stdout;
}

/**
 * Recent non-merge commits that touched code, newest first.
 *
 * These become candidate tasks: a real commit is a task whose correct answer is
 * already known, which is what makes mined tasks cheaper than written ones.
 */
export async function recentCommits(cwd: string, limit: number): Promise<MinedCommit[]> {
  const sep = String.fromCharCode(31); // unit separator
  const rec = String.fromCharCode(30); // record separator
  // The body is terminated by its own separator rather than by a blank line:
  // commit bodies contain blank lines of their own, and using one as the
  // boundary makes git read paragraphs of prose as file names.
  const log = await git(cwd, [
    'log',
    '--no-merges',
    `-n${limit}`,
    `--pretty=format:${rec}%H${sep}%s${sep}%b${sep}`,
    '--name-only',
  ]);

  const out: MinedCommit[] = [];
  for (const chunk of log.split(rec)) {
    if (!chunk.trim()) continue;
    const [sha, subject, body, fileBlock] = chunk.split(sep);
    if (!sha?.trim() || !subject) continue;
    out.push({
      sha: sha.trim(),
      subject,
      body: (body ?? '').trim(),
      files: (fileBlock ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }
  return out;
}
