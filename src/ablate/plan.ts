import type { Config } from '../config.js';
import { baselineVariant, emptyVariant, minusVariant } from '../rules/render.js';
import { buildPlan, runPlan, type RunnerOptions } from '../run/runner.js';
import type { Rule, RunResult, Task, Variant } from '../types.js';
import {
  adjustFdr,
  compare,
  minDetectableEffect,
  rate,
  type Comparison,
  type Proportion,
} from './stats.js';

export type RuleStatus = 'load-bearing' | 'harmful' | 'no-evidence' | 'untested';

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
  stoppedEarly?: string;
  /**
   * Set when the run was abandoned because the measurement could not mean
   * anything — a baseline that never passes leaves no effect to detect.
   */
  aborted?: string;
  /** Smallest pass-rate difference this budget could have detected. */
  mde: number;
}

/** Pass rate for one variant, pooled over tasks and trials. Errored trials are excluded. */
export function proportionFor(results: RunResult[], variantId: string): Proportion {
  const usable = results.filter((r) => r.variantId === variantId && !r.error);
  return { k: usable.filter((r) => r.pass).length, n: usable.length };
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

  const execute = async (variants: Variant[]) => {
    const remaining = { ...config, budget: { ...config.budget, maxRuns: budgetLeft() } };
    const summary = await runPlan(buildPlan(variants, tasks, config.trials), {
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

  // Phase 1: is the document load-bearing at all?
  const base = baselineVariant();
  const empty = emptyVariant({ files: [], rules });
  await execute([base, empty]);

  const baselineProp = proportionFor(all, base.id);
  const fileEffect = compare(baselineProp, proportionFor(all, empty.id), config.alpha);

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
      aborted:
        baselineProp.n === 0
          ? 'no trial completed: the agent never ran successfully'
          : `the unmodified rules failed every one of the ${baselineProp.n} baseline trials, ` +
            'so there is no effect for removing a rule to reveal',
      mde: minDetectableEffect(baselineProp.n, 0.5),
    };
  }

  // Phase 2: bisect. Queue holds groups still to be explained.
  let queue: Rule[][] = rules.length > 1 ? chunk(rules, 2) : [rules];
  const pending: { finding: RuleFinding; comparison: Comparison }[] = [];

  while (queue.length > 0 && !stoppedEarly) {
    if (budgetLeft() < sweepCost) {
      stoppedEarly ??= `run cap reached (${config.budget.maxRuns} agent runs)`;
      break;
    }

    const round: Round = { variants: [], groups: [] };
    for (const group of queue) {
      if (budgetLeft() < sweepCost * (round.variants.length + 1)) break;
      round.variants.push(minusVariant(group.map((r) => r.id)));
      round.groups.push(group);
    }
    if (round.variants.length === 0) break;

    await execute(round.variants);

    const next: Rule[][] = [];
    round.variants.forEach((variant, i) => {
      const group = round.groups[i] ?? [];
      const cmp = compare(baselineProp, proportionFor(all, variant.id), config.alpha);

      if (cmp.verdict === 'inconclusive') {
        // Nothing in this group moved the outcome, even all together.
        for (const rule of group) {
          findings.set(rule.id, {
            rule,
            status: 'no-evidence',
            comparison: cmp,
            measuredAs: group.length === 1 ? 'individual' : 'group',
            groupSize: group.length,
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
        pending.push({ finding, comparison: cmp });
        return;
      }

      next.push(...chunk(group, 2));
    });

    queue = next;
  }

  // Anything still queued ran out of budget before it could be split.
  for (const group of queue) {
    for (const rule of group) {
      if (findings.get(rule.id)?.status === 'untested') {
        findings.set(rule.id, { rule, status: 'untested', measuredAs: 'none' });
      }
    }
  }

  // Every individual verdict is one test in a family of them; without this
  // correction a 40-rule sweep reports two false discoveries by construction.
  const corrected = adjustFdr(
    pending.map((p) => p.comparison),
    config.alpha,
  );
  corrected.forEach((c, i) => {
    const entry = pending[i];
    if (!entry) return;
    const updated: RuleFinding = {
      ...entry.finding,
      comparison: { ...entry.finding.comparison!, qValue: c.qValue },
      status: c.significant
        ? entry.finding.comparison!.diff < 0
          ? 'load-bearing'
          : 'harmful'
        : 'no-evidence',
    };
    findings.set(entry.finding.rule.id, updated);
  });

  return {
    baseline: baselineProp,
    fileEffect,
    findings: rules.map((r) => findings.get(r.id)!),
    results: all,
    spentUsd,
    replayedUsd,
    runsUsed,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    mde: minDetectableEffect(baselineProp.n, rate(baselineProp) || 0.5),
  };
}
