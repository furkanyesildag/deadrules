import type { Config } from '../config.js';
import { baselineVariant, emptyVariant, minusVariant } from '../rules/render.js';
import { buildPlan, runPlan, type RunnerOptions } from '../run/runner.js';
import type { Rule, RunResult, Task, Variant } from '../types.js';
import {
  adjustFdr,
  compareStratified,
  effectiveArmSize,
  minDetectableEffect,
  rate,
  type Comparison,
  type Proportion,
  type Stratum,
} from './stats.js';

export type RuleStatus =
  | 'load-bearing'
  | 'harmful'
  | 'no-evidence'
  /**
   * Removing the group this rule belongs to changed the outcome, but the budget
   * ran out before the group could be split. Something in there matters and we
   * do not know which -- a partial answer, but one that was paid for.
   */
  | 'group-matters'
  | 'untested';

export interface RuleFinding {
  rule: Rule;
  status: RuleStatus;
  /** Absent when the rule was never reached within the budget. */
  comparison?: Comparison;
  /**
   * Whether the verdict comes from removing this rule alone or from removing a
   * group it belonged to. A group-level null is genuine evidence — the whole
   * group came out with no measurable effect — but it is weaker than an
   * individual test and the report says so.
   */
  measuredAs: 'individual' | 'group' | 'none';
  groupSize?: number;
  /** The other rules removed alongside this one, when the verdict is group-level. */
  groupWith?: string[];
}

export interface AblationOutcome {
  baseline: Proportion;
  /** Removing every rule at once: does the file do anything at all? */
  fileEffect: Comparison;
  findings: RuleFinding[];
  results: RunResult[];
  spentUsd: number;
  /** What the replayed trials originally cost, when resuming from a ledger. */
  replayedUsd: number;
  runsUsed: number;
  /** Total pass-rate comparisons performed: the family the q-values correct over. */
  testsPerformed: number;
  stoppedEarly?: string;
  /**
   * Set when the run was abandoned because the measurement could not mean
   * anything — a baseline that never passes leaves no effect to detect.
   */
  aborted?: string;
  /** Smallest pass-rate difference this budget could have detected. */
  mde: number;
  /** Trials behind each side of a comparison; the arms are deliberately unequal. */
  armSizes: { baseline: number; variant: number };
}

/** Pass rate for one variant, pooled over tasks and trials. Errored trials are excluded. */
export function proportionFor(results: RunResult[], variantId: string): Proportion {
  const usable = results.filter((r) => r.variantId === variantId && !r.error);
  return { k: usable.filter((r) => r.pass).length, n: usable.length };
}

/**
 * Splits a comparison into one 2x2 table per task.
 *
 * Task difficulty is a confounder, not noise: an easy task passes whatever the
 * rules say. Handing the test one table per task lets it compare each task only
 * against itself.
 */
export function strataFor(
  results: RunResult[],
  baselineId: string,
  candidateId: string,
  tasks: Task[],
): Stratum[] {
  return tasks.map((task) => {
    const forTask = (variantId: string): Proportion => {
      const usable = results.filter(
        (r) => r.variantId === variantId && r.taskId === task.id && !r.error,
      );
      return { k: usable.filter((r) => r.pass).length, n: usable.length };
    };
    return { key: task.id, baseline: forTask(baselineId), candidate: forTask(candidateId) };
  });
}

function chunk<T>(items: T[], parts: number): T[][] {
  const out: T[][] = [];
  const size = Math.ceil(items.length / parts);
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.filter((c) => c.length > 0);
}

interface Round {
  variants: Variant[];
  groups: Rule[][];
}

/**
 * Ablates a rules file under a fixed budget.
 *
 * Testing 40 rules one at a time costs 40 sweeps. Instead this removes groups
 * and only splits the ones that moved the needle: a group that changes nothing
 * when removed wholesale contains no rule that changes anything on its own, so
 * the search is logarithmic in the number of rules that actually matter rather
 * than linear in the number of rules written.
 *
 * The cost of that efficiency is interaction effects. Two rules that cover for
 * each other are both removed in the same group, the group looks load-bearing,
 * and the bisect blames whichever half happens to fail — see README.
 */
export async function ablate(
  rules: Rule[],
  tasks: Task[],
  opts: RunnerOptions,
): Promise<AblationOutcome> {
  const config: Config = opts.config;
  const all: RunResult[] = [];
  let spentUsd = 0;
  let replayedUsd = 0;
  let runsUsed = 0;
  let stoppedEarly: string | undefined;

  const budgetLeft = () => config.budget.maxRuns - runsUsed;
  const sweepCost = tasks.length * config.trials;

  const execute = async (variants: Variant[], trialOverrides: Record<string, number> = {}) => {
    // Both caps have to be decremented. Passing `maxUsd` through untouched
    // made it a per-round allowance, so a twelve-sweep ablation could spend
    // twelve times the number the user set and the report would still say the
    // cap was respected.
    const remaining = {
      ...config,
      budget: { maxRuns: budgetLeft(), maxUsd: Math.max(0, config.budget.maxUsd - spentUsd) },
    };
    const summary = await runPlan(buildPlan(variants, tasks, config.trials, trialOverrides), {
      ...opts,
      config: remaining,
    });
    all.push(...summary.results);
    spentUsd += summary.spentUsd;
    replayedUsd += summary.replayedUsd;
    runsUsed += summary.runsExecuted;
    if (summary.stoppedEarly) stoppedEarly = summary.stoppedEarly;
    return summary;
  };

  // Phase 1: is the document load-bearing at all? The baseline arm gets extra
  // trials here because every later finding is measured against it.
  const base = baselineVariant();
  const empty = emptyVariant({ files: [], rules });
  const baselineTrials = config.baselineTrials ?? config.trials * 2;
  await execute([base, empty], { [base.id]: baselineTrials });

  const baselineProp = proportionFor(all, base.id);
  const compareTo = (variantId: string) =>
    compareStratified(strataFor(all, base.id, variantId, tasks), config.alpha);

  const fileEffect = compareTo(empty.id);

  const findings = new Map<string, RuleFinding>(
    rules.map((rule) => [rule.id, { rule, status: 'untested', measuredAs: 'none' }]),
  );

  // A baseline that never passes has no room to drop, so every later comparison
  // would come back "no evidence" no matter what the rules say. Stop here
  // rather than spending the rest of the budget proving nothing.
  if (baselineProp.n === 0 || baselineProp.k === 0) {
    return {
      baseline: baselineProp,
      fileEffect,
      findings: rules.map((r) => findings.get(r.id)!),
      results: all,
      spentUsd,
      replayedUsd,
      runsUsed,
      testsPerformed: 1,
      armSizes: { baseline: baselineProp.n, variant: tasks.length * config.trials },
      aborted:
        baselineProp.n === 0
          ? 'no trial completed: the agent never ran successfully'
          : `the unmodified rules failed every one of the ${baselineProp.n} baseline trials, ` +
            'so there is no effect for removing a rule to reveal',
      mde: minDetectableEffect(baselineProp.n, 0.5),
    };
  }

  // Phase 2: bisect. The queue holds groups still to be explained, each one
  // carrying the comparison that sent it there so a group whose split never
  // happens can still report what was learned about it.
  let queue: { rules: Rule[]; parent?: Comparison }[] =
    rules.length > 1 ? chunk(rules, 2).map((g) => ({ rules: g })) : [{ rules }];

  /** Every comparison made, group and individual alike: the correction family. */
  const tests: { comparison: Comparison; leaf?: RuleFinding }[] = [
    { comparison: fileEffect },
  ];

  while (queue.length > 0 && !stoppedEarly) {
    if (budgetLeft() < sweepCost) {
      stoppedEarly ??= `run cap reached (${config.budget.maxRuns} agent runs)`;
      break;
    }

    const round: Round = { variants: [], groups: [] };
    const parents: (Comparison | undefined)[] = [];
    for (const entry of queue) {
      if (budgetLeft() < sweepCost * (round.variants.length + 1)) break;
      round.variants.push(minusVariant(entry.rules.map((r) => r.id)));
      round.groups.push(entry.rules);
      parents.push(entry.parent);
    }
    if (round.variants.length === 0) break;

    await execute(round.variants);

    const next: { rules: Rule[]; parent?: Comparison }[] = [];
    round.variants.forEach((variant, i) => {
      const group = round.groups[i] ?? [];
      const cmp = compareTo(variant.id);
      tests.push({ comparison: cmp });

      if (cmp.verdict === 'inconclusive') {
        // The group as a whole did not move the outcome. That is evidence
        // about all of them together, and weaker than an individual test --
        // see the note on cancelling rules above.
        for (const rule of group) {
          findings.set(rule.id, {
            rule,
            status: 'no-evidence',
            comparison: cmp,
            measuredAs: group.length === 1 ? 'individual' : 'group',
            groupSize: group.length,
            ...(group.length > 1
              ? { groupWith: group.filter((r) => r.id !== rule.id).map((r) => r.id) }
              : {}),
          });
        }
        return;
      }

      if (group.length === 1) {
        const rule = group[0];
        if (!rule) return;
        const finding: RuleFinding = {
          rule,
          status: cmp.verdict === 'worse' ? 'load-bearing' : 'harmful',
          comparison: cmp,
          measuredAs: 'individual',
          groupSize: 1,
        };
        findings.set(rule.id, finding);
        tests[tests.length - 1] = { comparison: cmp, leaf: finding };
        return;
      }

      for (const half of chunk(group, 2)) next.push({ rules: half, parent: cmp });
    });

    queue = next;
  }

  // Groups the budget could not split. A sweep was already paid for to learn
  // that something in there matters, so reporting them as merely `untested`
  // would throw that away.
  for (const entry of queue) {
    for (const rule of entry.rules) {
      if (findings.get(rule.id)?.status !== 'untested') continue;
      findings.set(
        rule.id,
        entry.parent
          ? {
              rule,
              status: 'group-matters',
              comparison: entry.parent,
              measuredAs: 'group',
              groupSize: entry.rules.length,
              groupWith: entry.rules.filter((r) => r.id !== rule.id).map((r) => r.id),
            }
          : { rule, status: 'untested', measuredAs: 'none' },
      );
    }
  }

  // Correct across every comparison the run made, not only the ones that
  // reached a single rule. Correcting the leaves alone would be correcting a
  // family that was itself selected for looking significant, which flatters the
  // q-values; including the group tests that did the selecting is closer to
  // honest. It is not a complete answer -- the branching used raw alpha as it
  // went, because those decisions had to be made before the family was known --
  // and the report says so.
  const corrected = adjustFdr(
    tests.map((t) => t.comparison),
    config.alpha,
  );
  corrected.forEach((c, i) => {
    const entry = tests[i];
    if (!entry?.leaf) return;
    const previous = entry.leaf.comparison;
    if (!previous) return;
    findings.set(entry.leaf.rule.id, {
      ...entry.leaf,
      comparison: { ...previous, qValue: c.qValue },
      status: c.significant
        ? previous.verdict === 'worse'
          ? 'load-bearing'
          : 'harmful'
        : 'no-evidence',
    });
  });

  return {
    baseline: baselineProp,
    fileEffect,
    findings: rules.map((r) => findings.get(r.id)!),
    results: all,
    spentUsd,
    replayedUsd,
    runsUsed,
    testsPerformed: tests.length,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    mde: minDetectableEffect(
      effectiveArmSize(baselineProp.n, tasks.length * config.trials),
      rate(baselineProp) || 0.5,
    ),
    armSizes: { baseline: baselineProp.n, variant: tasks.length * config.trials },
  };
}
