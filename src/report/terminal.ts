import type { AblationOutcome, RuleFinding } from '../ablate/plan.js';
import { rate, wilson, type Comparison, type Proportion } from '../ablate/stats.js';
import type { Rule } from '../types.js';

// FORCE_COLOR lets a redirected run keep its colours, which is what the SVG
// renderer in scripts/ reads. NO_COLOR wins over both, per the convention.
const useColor =
  !process.env['NO_COLOR'] &&
  (Boolean(process.env['FORCE_COLOR']) || Boolean(process.stdout.isTTY));

const ESC = String.fromCharCode(27);
const paint = (code: string) => (s: string) =>
  useColor ? ESC + '[' + code + 'm' + s + ESC + '[0m' : s;
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return '#'.repeat(filled) + '.'.repeat(Math.max(0, width - filled));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Percentage points, signed, because a rate difference is not a percentage. */
function pp(diff: number): string {
  const v = Math.round(diff * 100);
  return `${v > 0 ? '+' : ''}${v}pp`;
}

function firstLine(rule: Rule, width: number): string {
  const text = rule.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split('\n')[0] ?? '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function propLine(label: string, p: Proportion): string {
  const r = rate(p);
  const ci = wilson(p);
  return [
    `  ${label.padEnd(12)}`,
    bar(r),
    `  ${pct(r).padStart(4)}`,
    dim(` (${p.k}/${p.n})`),
    dim(`  95% CI ${pct(ci.lo)}-${pct(ci.hi)}`),
  ].join('');
}

function significance(cmp: Comparison): string {
  const p = cmp.qValue ?? cmp.pValue;
  const name = cmp.qValue === undefined ? 'p' : 'q';
  return `${name}=${p < 0.001 ? '<0.001' : p.toFixed(3)}`;
}

function findingLine(f: RuleFinding, colour: (s: string) => string): string {
  const cmp = f.comparison;
  // Signed from the point of view of removal, matching the section heading:
  // a load-bearing rule shows the drop its absence caused.
  const delta = cmp ? pp(cmp.diff) : '';
  return [
    `    ${colour(f.rule.id)}`,
    `  ${delta.padStart(6)}`,
    dim(`  ${cmp ? significance(cmp) : ''}`.padEnd(12)),
    `  ${firstLine(f.rule, 58)}`,
  ].join('');
}

export interface ReportHeader {
  ruleFiles: string[];
  ruleCount: number;
  taskCount: number;
  agent: string;
  model?: string;
  trials: number;
}

export function renderAblationReport(
  outcome: AblationOutcome,
  header: ReportHeader,
  showAll: boolean,
): string {
  const out: string[] = ['', `  ${bold('deadrules')}`, ''];

  out.push(
    `  ${dim('rules')}    ${header.ruleFiles.join(', ')} ${dim(`· ${header.ruleCount} rules`)}`,
  );
  out.push(`  ${dim('tasks')}    ${header.taskCount}`);
  out.push(
    `  ${dim('agent')}    ${header.agent}${header.model ? ` (${header.model})` : ''} ${dim(
      `· ${header.trials} trials per variant`,
    )}`,
  );
  const replayed =
    outcome.replayedUsd > 0
      ? dim(` · replayed $${outcome.replayedUsd.toFixed(2)} from the ledger`)
      : '';
  out.push(
    `  ${dim('spent')}    ${outcome.runsUsed} runs ${dim(
      `· $${outcome.spentUsd.toFixed(2)}`,
    )}${replayed}`,
  );
  out.push('');

  if (outcome.aborted) {
    out.push(`  ${red('nothing was measured')}`);
    out.push(`  ${outcome.aborted}.`);
    out.push('');
    out.push(dim('  Check, in this order:'));
    out.push(dim('    1. does the task pass when you do it by hand at that base commit?'));
    out.push(dim('    2. do the graders run there — try the `run` command yourself;'));
    out.push(dim('    3. can the agent edit files unattended (permissionMode, maxTurns)?'));
    out.push('');
    return out.join('\n');
  }

  out.push(`  ${bold('DOES THE FILE MATTER?')}`);
  out.push(propLine('all rules', outcome.baseline));
  out.push(propLine('no rules', outcome.fileEffect.candidate));
  const fileVerdict =
    outcome.fileEffect.verdict === 'inconclusive'
      ? yellow('no measurable difference with or without the file')
      : outcome.fileEffect.verdict === 'worse'
        ? green('the file helps')
        : red('the file hurts');
  out.push(`  ${''.padEnd(12)}${dim(significance(outcome.fileEffect))}  ${fileVerdict}`);
  out.push('');

  const byStatus = (s: RuleFinding['status']) => outcome.findings.filter((f) => f.status === s);
  const loadBearing = byStatus('load-bearing');
  const harmful = byStatus('harmful');
  const none = byStatus('no-evidence');
  const groupMatters = byStatus('group-matters');
  const untested = byStatus('untested');

  if (loadBearing.length) {
    out.push(
      `  ${bold('LOAD-BEARING')}  ${dim('removing this rule made the agent worse')}`,
    );
    out.push(dim(`    ${'id'.padEnd(6)}${'removed'.padStart(6)}`));
    for (const f of loadBearing) out.push(findingLine(f, green));
    out.push('');
  }

  if (harmful.length) {
    out.push(
      `  ${bold('HARMFUL')}       ${dim('removing this rule made the agent better')}`,
    );
    out.push(dim(`    ${'id'.padEnd(6)}${'removed'.padStart(6)}`));
    for (const f of harmful) out.push(findingLine(f, red));
    out.push('');
  }

  if (none.length) {
    out.push(
      `  ${bold('NO EVIDENCE')}   ${dim(`${none.length} rules changed nothing that was measured`)}`,
    );
    const individual = none.filter((f) => f.measuredAs === 'individual').length;
    if (showAll) {
      for (const f of none) {
        out.push(
          `    ${dim(f.rule.id)}  ${dim(
            f.measuredAs === 'group' ? `in a group of ${f.groupSize}` : 'tested alone',
          ).padEnd(28)}${firstLine(f.rule, 58)}`,
        );
      }
    } else {
      out.push(`    ${dim(none.map((f) => f.rule.id).join(' '))}`);
      out.push(dim(`    ${individual} tested alone, ${none.length - individual} in groups`));
      out.push(dim('    --all to list them'));
    }
    out.push('');
  }

  if (groupMatters.length) {
    out.push(
      `  ${bold('GROUP MATTERS')} ${dim('something in here changed the outcome, but which is unresolved')}`,
    );
    // Group by the set they were measured in, so the reader sees "one of these
    // four", not a flat list that hides how far the search actually got.
    const groups = new Map<string, RuleFinding[]>();
    for (const f of groupMatters) {
      const key = [f.rule.id, ...(f.groupWith ?? [])].sort().join(' ');
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [key, members] of groups) {
      const first = members[0];
      out.push(`    ${dim(`1 of ${key.split(' ').length}:`)} ${yellow(key)}`);
      if (first?.comparison) {
        out.push(
          dim(`      removing all of them: ${pp(first.comparison.diff)}  ${significance(first.comparison)}`),
        );
      }
    }
    out.push(dim('    raise --budget-runs to find out which'));
    out.push('');
  }

  if (untested.length) {
    out.push(`  ${bold('UNTESTED')}      ${dim(`${untested.length} rules · budget ran out`)}`);
    out.push(`    ${dim(untested.map((f) => f.rule.id).join(' '))}`);
    out.push('');
  }

  out.push(`  ${dim('─'.repeat(76))}`);
  out.push(
    `  ${loadBearing.length} load-bearing · ${harmful.length} harmful · ${none.length} no evidence` +
      `${groupMatters.length ? ` · ${groupMatters.length} in groups that matter` : ''} · ${untested.length} untested`,
  );
  out.push(
    cyan(
      [
        `  "No evidence" is not "no effect": on ${outcome.armSizes.baseline} baseline trials against`,
        `  ${outcome.armSizes.variant} per variant, this run could only detect a swing of about`,
        `  ${Math.round(outcome.mde * 100)}pp. More tasks, or more trials, shrink that.`,
      ].join('\n'),
    ),
  );
  out.push(
    dim(
      [
        '  Pass rates are compared task by task and combined, so a hard task is',
        "  not mistaken for a rule's effect. q-values correct across all " +
          `${outcome.testsPerformed} tests`,
        '  this run made, but the search reached individual rules by passing',
        '  earlier uncorrected group tests, so read them as nominal.',
      ].join('\n'),
    ),
  );
  if (outcome.stoppedEarly) out.push(yellow(`  stopped early: ${outcome.stoppedEarly}`));
  out.push('');

  return out.join('\n');
}
