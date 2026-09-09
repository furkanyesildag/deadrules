export { ablate, proportionFor } from './ablate/plan.js';
export type { AblationOutcome, RuleFinding, RuleStatus } from './ablate/plan.js';
export {
  adjustFdr,
  compare,
  fisherExact,
  minDetectableEffect,
  rate,
  wilson,
} from './ablate/stats.js';
export type { Comparison, Interval, Proportion, Verdict } from './ablate/stats.js';
export { buildAdapter, DEFAULT_CONFIG, loadConfig, mergeConfig } from './config.js';
export type { AgentConfig, BudgetConfig, Config } from './config.js';
export { grade, runGrader } from './grade/graders.js';
export { discoverRuleFiles } from './rules/discover.js';
export { hashRule, parseRuleFile, parseRuleSet } from './rules/parse.js';
export {
  baselineVariant,
  emptyVariant,
  literalVariant,
  minusVariant,
  renderVariant,
} from './rules/render.js';
export { claudeAdapter } from './run/adapters/claude.js';
export { commandAdapter } from './run/adapters/command.js';
export { buildPlan, runPlan } from './run/runner.js';
export type { RunnerOptions, RunPlanItem, RunSummary } from './run/runner.js';
export { loadTasks, parseTaskFile } from './tasks/load.js';
export { detectTestCommand, mineTasks, renderTaskFile } from './tasks/mine.js';
export type * from './types.js';
