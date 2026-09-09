import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { recentCommits } from '../dist/git.js';
import { detectTestCommand, mineTasks, renderTaskFile } from '../dist/tasks/mine.js';
import { parseTaskFile } from '../dist/tasks/load.js';

const run = promisify(execFile);
let root;

const PROSE_BODY = `The directory was derived by replacing forward slashes only.

That meant the slug still contained a drive letter, so nothing ever matched.

Derive it from a set of substitutions instead.

Co-Authored-By: Someone <someone@example.com>
Signed-off-by: Someone Else <else@example.com>`;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'deadrules-mine-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'deadrules test'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });

  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n', 'utf8');
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'Add the first module to the project'], { cwd: root });

  await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-q', '-m', 'Find the agent transcript on Windows too', '-m', PROSE_BODY], {
    cwd: root,
  });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('a multi-line commit body is never mistaken for a file list', async () => {
  const commits = await recentCommits(root, 5);
  const target = commits.find((c) => c.subject.startsWith('Find the agent'));

  assert.ok(target, 'commit not found');
  assert.deepEqual(target.files, ['src/b.ts']);
  assert.match(target.body, /drive letter/);
  // The blank lines inside the body used to terminate parsing and turn every
  // following paragraph into a filename.
  assert.ok(!target.files.some((f) => f.includes(' ')), `prose leaked in: ${target.files}`);
});

test('mined prompts drop the trailer block', async () => {
  const tasks = await mineTasks(root, 5, 'npm test');
  const task = tasks.find((t) => t.prompt.startsWith('Find the agent'));

  assert.ok(task, 'task not mined');
  assert.match(task.prompt, /drive letter/);
  assert.ok(!/Co-Authored-By/.test(task.prompt), 'trailer left in the prompt');
  assert.ok(!/Signed-off-by/.test(task.prompt), 'trailer left in the prompt');
});

test('mined tasks start from the commit parent and grade on the test suite', async () => {
  const tasks = await mineTasks(root, 5, 'npm test');
  const task = tasks[0];
  assert.match(task.base, /\^$/);
  assert.ok(task.grade.some((g) => g.type === 'run' && g.cmd === 'npm test'));
  assert.ok(task.grade.some((g) => g.type === 'touched'));
});

test('the test command is detected from package.json', async () => {
  assert.equal(await detectTestCommand(root), 'npm test');
});

test('a rendered task file parses back to the same task', async () => {
  const [task] = await mineTasks(root, 1, 'npm test');
  const round = parseTaskFile(`${task.id}.md`, renderTaskFile(task));

  assert.equal(round.id, task.id);
  assert.equal(round.base, task.base);
  assert.deepEqual(round.grade, task.grade);
  assert.match(round.prompt, /Find the agent|Add the first module/);
});

test('a task with no graders is rejected rather than silently scoring zero', () => {
  assert.throws(
    () => parseTaskFile('t.md', '---\n{"grade": []}\n---\nDo something.'),
    /no graders/,
  );
});

test('invalid frontmatter names the file it came from', () => {
  assert.throws(() => parseTaskFile('broken.md', '---\n{nope}\n---\nbody'), /broken\.md/);
});
