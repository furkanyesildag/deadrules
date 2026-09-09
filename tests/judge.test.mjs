import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { runGrader } from '../dist/grade/graders.js';

const run = promisify(execFile);
let cwd;

/** Records what the judge was shown, so the blinding can be asserted. */
function recordingJudge(reply) {
  const seen = [];
  return {
    seen,
    judge: async (prompt) => {
      seen.push(prompt);
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  };
}

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'deadrules-judge-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd });
  await run('git', ['config', 'user.name', 't'], { cwd });
  await writeFile(join(cwd, 'CLAUDE.md'), '- SECRETRULE always add a comment.\n', 'utf8');
  await writeFile(join(cwd, 'a.js'), 'const a = 1;\n', 'utf8');
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-qm', 'base'], { cwd });
  // The agent's change, which is what the judge is allowed to see.
  await writeFile(join(cwd, 'a.js'), 'const a = 1;\n// why: the answer\nconst b = 2;\n', 'utf8');
});

after(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const grader = { type: 'judge', rubric: 'New code carries a comment explaining why.' };

test('a PASS verdict passes and reports its cost', async () => {
  const { judge } = recordingJudge({ text: 'PASS', costUsd: 0.002 });
  const res = await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge });

  assert.equal(res.pass, true);
  assert.equal(res.costUsd, 0.002);
});

test('a FAIL verdict fails', async () => {
  const { judge } = recordingJudge({ text: 'FAIL' });
  assert.equal((await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge })).pass, false);
});

test('the last verdict word wins when the model restates the question', async () => {
  const { judge } = recordingJudge({
    text: 'The criterion asks whether to PASS or FAIL. My answer: PASS',
  });
  assert.equal((await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge })).pass, true);
});

test('the judge never sees the rules file', async () => {
  const { judge, seen } = recordingJudge({ text: 'PASS' });
  await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge });

  assert.equal(seen.length, 1);
  // If the judge could read CLAUDE.md it would be scoring the rule by looking
  // it up, and every variant that still contained the rule would pass for free.
  assert.ok(!seen[0].includes('SECRETRULE'), 'the rules file leaked into the judge prompt');
  assert.match(seen[0], /const b = 2/, 'the judge was not shown the change');
  assert.match(seen[0], /New code carries a comment/);
});

test('an unreadable verdict fails closed', async () => {
  const { judge } = recordingJudge({ text: 'I am not sure about this one.' });
  const res = await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge });

  assert.equal(res.pass, false, 'a non-answer must not count as success');
  assert.match(res.detail, /unparseable/);
});

test('a judge error fails closed rather than passing', async () => {
  const { judge } = recordingJudge({ text: '', error: 'judge timed out' });
  const res = await runGrader(grader, { cwd, defaultTimeoutMs: 1000, judge });

  assert.equal(res.pass, false);
  assert.match(res.detail, /timed out/);
});

test('with no judge configured the grader fails and says why', async () => {
  const res = await runGrader(grader, { cwd, defaultTimeoutMs: 1000 });

  assert.equal(res.pass, false);
  assert.match(res.detail, /no judge available/);
});

test('an empty change is failed without asking the judge to be generous', async () => {
  const clean = await mkdtemp(join(tmpdir(), 'deadrules-judge-empty-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: clean });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: clean });
  await run('git', ['config', 'user.name', 't'], { cwd: clean });
  await writeFile(join(clean, 'a.js'), 'const a = 1;\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: clean });
  await run('git', ['commit', '-qm', 'base'], { cwd: clean });

  const { judge, seen } = recordingJudge({ text: 'PASS' });
  await runGrader(grader, { cwd: clean, defaultTimeoutMs: 1000, judge });

  assert.match(seen[0], /the change is empty|An empty diff/);
  await rm(clean, { recursive: true, force: true });
});
