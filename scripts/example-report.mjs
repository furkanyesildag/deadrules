#!/usr/bin/env node
/**
 * Emits an ILLUSTRATIVE ablation report for the README image.
 *
 * The layout, colours and wording come from the real reporter, so the picture
 * cannot drift from the tool. The numbers do not come from a real run -- they
 * are invented, and the README image says so. To render a real one:
 *
 *   FORCE_COLOR=1 deadrules ablate | node scripts/render-svg.mjs > docs/report.svg
 */
import { renderAblationReport } from '../dist/report/terminal.js';
import { compare } from '../dist/ablate/stats.js';

const rule = (id, text, section) => ({
  id, hash: id, file: 'CLAUDE.md', line: 1, span: 1, text, kind: 'bullet', section,
});

const baseline = { k: 26, n: 36 };

const finding = (id, text, section, status, candidate, qValue) => {
  const cmp = compare(baseline, candidate);
  const individual = qValue !== undefined;
  return {
    rule: rule(id, text, section),
    status,
    comparison: individual ? { ...cmp, qValue } : cmp,
    measuredAs: individual ? 'individual' : 'group',
    groupSize: individual ? 1 : 10,
  };
};

const dead = (id, text, section) =>
  finding(id, text, section, 'no-evidence', { k: 25, n: 36 });

const outcome = {
  baseline,
  fileEffect: compare(baseline, { k: 18, n: 36 }),
  findings: [
    finding('R07', 'Always add a test alongside a behaviour change.', ['Testing'], 'load-bearing', { k: 12, n: 36 }, 0.004),
    finding('R22', 'Never edit files under `generated/` — they come from the schema.', ['Boundaries'], 'load-bearing', { k: 16, n: 36 }, 0.031),
    finding('R31', 'Think step by step before writing any code.', ['Process'], 'harmful', { k: 34, n: 36 }, 0.022),
    dead('R01', 'Write clean, readable, maintainable code.', ['Style']),
    dead('R02', 'Follow the existing conventions of the codebase.', ['Style']),
    dead('R03', 'Use meaningful variable names.', ['Style']),
    dead('R04', 'Add comments where the code is non-obvious.', ['Style']),
    dead('R05', 'Handle errors properly.', ['Style']),
    dead('R11', 'Be concise in your responses.', ['Communication']),
    dead('R12', 'Do not apologise.', ['Communication']),
    dead('R13', 'Ask before making large changes.', ['Communication']),
    { rule: rule('R38', 'Prefer composition over inheritance.', ['Design']), status: 'untested', measuredAs: 'none' },
    { rule: rule('R39', 'Keep functions under 50 lines.', ['Design']), status: 'untested', measuredAs: 'none' },
  ],
  results: [],
  spentUsd: 6.42,
  replayedUsd: 0,
  runsUsed: 288,
  mde: 0.33,
};

process.stdout.write(
  renderAblationReport(
    outcome,
    { ruleFiles: ['CLAUDE.md'], ruleCount: 39, taskCount: 12, agent: 'claude', model: 'haiku-4.5', trials: 3 },
    false,
  ),
);
