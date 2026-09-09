import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

/** Runs the CLI and returns its exit code alongside the output. */
async function cli(args) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { cwd: dirname(CLI) }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

test('--version prints the version and exits zero', async () => {
  const { code, stdout } = await cli(['--version']);
  assert.equal(code, 0, 'a version flag with no command must not fall through to usage');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('help exits zero, no arguments exits non-zero', async () => {
  assert.equal((await cli(['help'])).code, 0);
  assert.equal((await cli([])).code, 1);
});

test('an unknown command is rejected with usage on stderr', async () => {
  const { code, stderr } = await cli(['nonsense']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command: nonsense/);
});

test('a non-numeric option is reported rather than silently coerced', async () => {
  const { code, stderr } = await cli(['rules', '--trials', 'lots']);
  assert.equal(code, 2);
  assert.match(stderr, /--trials expects a number/);
});
