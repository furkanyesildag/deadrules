import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const run = promisify(execFile);
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let root;

/** Polls until the predicate holds, so the test never races the child process. */
async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'deadrules-int-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 't'], { cwd: root });
  await writeFile(join(root, 'CLAUDE.md'), '- A rule that is long enough to parse.\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'base'], { cwd: root });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('Ctrl-C removes the worktrees instead of leaking them', async (t) => {
  const signalFile = join(root, 'agent-is-running');
  const script = `
    import { runPlan, buildPlan } from ${JSON.stringify(join(DIST, 'run/runner.js'))};
    import { parseRuleSet } from ${JSON.stringify(join(DIST, 'rules/parse.js'))};
    import { baselineVariant } from ${JSON.stringify(join(DIST, 'rules/render.js'))};
    import { DEFAULT_CONFIG } from ${JSON.stringify(join(DIST, 'config.js'))};
    import { writeFileSync } from 'node:fs';

    const content = '- A rule that is long enough to parse.\\n';
    const set = parseRuleSet([{ path: 'CLAUDE.md', content }]);
    const slow = {
      name: 'slow',
      preflight: async () => null,
      // Signals that a worktree exists, then hangs so the interrupt lands
      // while it is checked out.
      run: async () => {
        writeFileSync(${JSON.stringify(signalFile)}, 'yes');
        await new Promise((r) => setTimeout(r, 60000));
        return { ok: true, costUsd: 0 };
      },
    };
    const task = { id: 't', prompt: 'x', grade: [{ type: 'diff-files-max', max: 9 }], weight: 1 };
    await runPlan(buildPlan([baselineVariant()], [task], 1), {
      root: ${JSON.stringify(root)},
      config: { ...DEFAULT_CONFIG, concurrency: 1 },
      ruleSet: set,
      adapter: slow,
    });
  `;
  const scriptPath = join(root, 'interrupt-runner.mjs');
  await writeFile(scriptPath, script, 'utf8');

  // The child gets a temp directory of its own: the suite runs files in
  // parallel, so scanning the shared one would pick up other tests' worktrees.
  const childTmp = join(root, 'tmp');
  await mkdir(childTmp, { recursive: true });
  const child = spawn(process.execPath, [scriptPath], {
    stdio: 'ignore',
    env: { ...process.env, TMPDIR: childTmp },
  });
  const started = await waitFor(async () => existsSync(signalFile));
  assert.ok(started, 'the agent never reached a worktree');

  const before = (await run('git', ['worktree', 'list'], { cwd: root })).stdout
    .trim()
    .split('\n').length;
  assert.ok(before > 1, 'expected a worktree to be checked out at this point');

  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  t.diagnostic(`child exited with ${code}, worktrees before the interrupt: ${before}`);

  const { stdout } = await run('git', ['worktree', 'list'], { cwd: root });
  const remaining = stdout.trim().split('\n').filter(Boolean);
  assert.equal(remaining.length, 1, `worktrees leaked after Ctrl-C:\n${stdout}`);

  const leftovers = (await readdir(childTmp)).filter((n) => n.startsWith('deadrules-wt-'));
  assert.deepEqual(leftovers, [], `worktree checkouts leaked: ${leftovers.join(', ')}`);
});
