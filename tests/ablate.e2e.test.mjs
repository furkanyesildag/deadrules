import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { ablate, proportionFor } from '../dist/ablate/plan.js';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { parseRuleSet } from '../dist/rules/parse.js';

const run = promisify(execFile);

/**
 * A CLAUDE.md where exactly one rule is load-bearing by construction.
 * R03 is the one the fake agent obeys; the other three are decoration.
 */
const CLAUDE_MD = `# Fixture

- Keep the code tidy and readable.
- Prefer descriptive variable names.
- Always create a file called marker.txt when you finish a task.
- Write commit messages in the imperative mood.
`;

let root;

/**
 * Stands in for a coding agent: it reads the rules it was given and obeys
 * exactly one of them. That makes the ground truth known, so the assertions
 * below are about the search finding the right rule rather than about any
 * model's behaviour.
 */
function fakeAgent(counters) {
  return {
    name: 'fake',
    async preflight() {
      return null;
    },
    async run({ cwd }) {
      counters.runs++;
      const rules = await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
      if (rules.includes('create a file called marker.txt')) {
        await writeFile(join(cwd, 'marker.txt'), 'done\n', 'utf8');
      }
      // Every trial does something, so a variant is never "passing" merely
      // because the worktree was left untouched.
      await writeFile(join(cwd, 'work.txt'), 'attempted\n', 'utf8');
      return { ok: true, costUsd: 0.01 };
    },
  };
}

const TASK = {
  id: 'marker',
  prompt: 'Do the thing.',
  grade: [{ type: 'file-contains', path: 'marker.txt', pattern: 'done' }],
  weight: 1,
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'deadrules-e2e-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'deadrules test'], { cwd: root });
  await writeFile(join(root, 'CLAUDE.md'), CLAUDE_MD, 'utf8');
  await writeFile(join(root, 'src.txt'), 'hello\n', 'utf8');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'initial'], { cwd: root });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('ablation finds the one rule the agent actually obeys', async (t) => {
  t.diagnostic(`fixture repo: ${root}`);
  const counters = { runs: 0 };
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  assert.equal(set.rules.length, 4);

  const config = {
    ...DEFAULT_CONFIG,
    trials: 5, // 4 trials is the smallest n that can reach p < 0.05 here
    concurrency: 2,
    budget: { maxRuns: 200, maxUsd: 100 },
  };

  const outcome = await ablate(set.rules, [TASK], {
    root,
    config,
    ruleSet: set,
    adapter: fakeAgent(counters),
  });

  const byId = new Map(outcome.findings.map((f) => [f.rule.id, f]));

  assert.equal(byId.get('R03').status, 'load-bearing', 'the obeyed rule was not identified');
  assert.equal(byId.get('R03').measuredAs, 'individual');

  for (const id of ['R01', 'R02', 'R04']) {
    assert.equal(byId.get(id).status, 'no-evidence', `${id} was misreported as mattering`);
  }

  assert.equal(outcome.baseline.k, 5, 'baseline should pass every trial');
  assert.equal(outcome.baseline.n, 5);
  assert.equal(outcome.fileEffect.verdict, 'worse', 'removing every rule should hurt');
  assert.ok(counters.runs > 0);
  assert.ok(outcome.spentUsd > 0);
});

test('bisecting scales better than testing every rule alone', async (t) => {
  // Sixteen rules, still exactly one that matters. This is where the search
  // strategy earns its keep: it should cost far less than one sweep per rule.
  const decoys = Array.from({ length: 15 }, (_, i) => `- Decoy rule number ${i + 1} does nothing.`);
  const content = ['# Big fixture', '', ...decoys.slice(0, 7),
    '- Always create a file called marker.txt when you finish a task.',
    ...decoys.slice(7), ''].join('\n');

  const counters = { runs: 0 };
  const set = parseRuleSet([{ path: 'CLAUDE.md', content }]);
  assert.equal(set.rules.length, 16);

  const config = {
    ...DEFAULT_CONFIG,
    trials: 5,
    concurrency: 2,
    budget: { maxRuns: 500, maxUsd: 100 },
  };

  const outcome = await ablate(set.rules, [TASK], {
    root,
    config,
    ruleSet: set,
    adapter: fakeAgent(counters),
  });

  const found = outcome.findings.filter((f) => f.status === 'load-bearing');
  assert.equal(found.length, 1, 'should find exactly one load-bearing rule');
  assert.match(found[0].rule.text, /marker\.txt/);

  const exhaustive = (set.rules.length + 2) * config.trials;
  t.diagnostic(`bisect: ${counters.runs} runs, exhaustive: ${exhaustive}`);
  assert.ok(
    counters.runs < exhaustive * 0.7,
    `bisect used ${counters.runs} runs, exhaustive would be ${exhaustive}`,
  );
});

test('the run cap stops the search instead of overspending', async () => {
  const counters = { runs: 0 };
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const config = {
    ...DEFAULT_CONFIG,
    trials: 5,
    concurrency: 1,
    budget: { maxRuns: 12, maxUsd: 100 }, // enough for phase one and no more
  };

  const outcome = await ablate(set.rules, [TASK], {
    root,
    config,
    ruleSet: set,
    adapter: fakeAgent(counters),
  });

  assert.ok(counters.runs <= 12, `ran ${counters.runs} times against a cap of 12`);
  assert.ok(outcome.stoppedEarly, 'stopping early was not reported');
  assert.ok(
    outcome.findings.some((f) => f.status === 'untested'),
    'rules left unmeasured should be reported as untested, not as dead',
  );
});

test('no worktrees are left behind', async () => {
  const { stdout } = await run('git', ['worktree', 'list'], { cwd: root });
  const lines = stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `leaked worktrees:\n${stdout}`);
});

test('the ledger records every trial and resume replays it for free', async () => {
  const ledgerPath = join(root, 'ledger.jsonl');
  const set = parseRuleSet([{ path: 'CLAUDE.md', content: CLAUDE_MD }]);
  const config = {
    ...DEFAULT_CONFIG,
    trials: 4,
    concurrency: 1,
    budget: { maxRuns: 200, maxUsd: 100 },
  };

  const first = { runs: 0 };
  const before = await ablate(set.rules, [TASK], {
    root,
    config,
    ruleSet: set,
    adapter: fakeAgent(first),
    ledgerPath,
  });

  const second = { runs: 0 };
  const after = await ablate(set.rules, [TASK], {
    root,
    config,
    ruleSet: set,
    adapter: fakeAgent(second),
    ledgerPath,
    resume: true,
  });

  assert.ok(first.runs > 0);
  assert.equal(second.runs, 0, 'resume re-invoked the agent instead of using the ledger');
  assert.deepEqual(
    proportionFor(after.results, 'baseline'),
    proportionFor(before.results, 'baseline'),
  );
  assert.equal(after.spentUsd, 0, 'a resumed run should not report new spend');
});
