import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { execShell } from '../exec.js';
import { addWorktree, pruneWorktrees, removeWorktree } from '../git.js';
import { grade } from '../grade/graders.js';
import { renderVariant } from '../rules/render.js';
import type { AgentAdapter, RuleSet, RunResult, Task, Variant } from '../types.js';

export interface RunPlanItem {
  variant: Variant;
  task: Task;
  trial: number;
}

export interface RunnerOptions {
  root: string;
  config: Config;
  ruleSet: RuleSet;
  adapter: AgentAdapter;
  /** Appends every completed trial here, so an interrupted run is not lost. */
  ledgerPath?: string;
  /** Trials already in the ledger are skipped and replayed from it. */
  resume?: boolean;
  onTrialStart?: (item: RunPlanItem, index: number, total: number) => void;
  onTrialEnd?: (result: RunResult, index: number, total: number) => void;
}

export interface RunSummary {
  results: RunResult[];
  /** Spend incurred by this invocation. Replayed trials cost nothing. */
  spentUsd: number;
  /** Spend the replayed trials originally cost, for reporting only. */
  replayedUsd: number;
  /** Agent invocations this run actually made, excluding replayed trials. */
  runsExecuted: number;
  /** Set when the run stopped early; explains which cap was hit. */
  stoppedEarly?: string;
}

function keyOf(item: RunPlanItem): string {
  return `${item.variant.id}::${item.task.id}::${item.trial}`;
}

async function readLedger(path: string): Promise<Map<string, RunResult>> {
  const found = new Map<string, RunResult>();
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return found;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunResult;
      found.set(`${r.variantId}::${r.taskId}::${r.trial}`, r);
    } catch {
      /* a partial final line from an interrupted run */
    }
  }
  return found;
}

/**
 * Runs one trial in a disposable worktree.
 *
 * Isolation is the whole point: the agent gets a real checkout of the task's
 * base commit with exactly one thing changed — the rules files — so anything
 * the graders see afterwards is attributable to that change.
 */
async function runTrial(
  item: RunPlanItem,
  opts: RunnerOptions,
  adapter: AgentAdapter,
): Promise<RunResult> {
  const { root, config, ruleSet } = opts;
  const started = Date.now();
  const base = item.task.base ?? config.base;
  const parent = await mkdtemp(join(tmpdir(), 'deadrules-'));
  // `git worktree add` wants a path it can create, so the temp dir is only the
  // parent and the checkout goes one level down.
  const dir = join(parent, 'wt');

  const fail = (error: string): RunResult => ({
    variantId: item.variant.id,
    taskId: item.task.id,
    trial: item.trial,
    pass: false,
    grades: [],
    costUsd: 0,
    durationMs: Date.now() - started,
    error,
  });

  try {
    await addWorktree(root, dir, base);

    for (const file of renderVariant(ruleSet, item.variant)) {
      const target = join(dir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }

    for (const cmd of item.task.setup ?? []) {
      const res = await execShell(cmd, { cwd: dir, timeoutMs: config.gradeTimeoutMs });
      if (res.code !== 0) {
        return fail(`setup failed (${cmd}): ${res.stderr.trim().slice(0, 200)}`);
      }
    }

    const outcome = await adapter.run({
      prompt: item.task.prompt,
      cwd: dir,
      trial: item.trial,
      timeoutMs: config.agent.timeoutMs ?? 600_000,
      ...(config.agent.model !== undefined ? { model: config.agent.model } : {}),
      ...(config.agent.maxTurns !== undefined ? { maxTurns: config.agent.maxTurns } : {}),
    });

    if (!outcome.ok) return fail(outcome.error ?? 'agent did not run');

    const grades = await grade(item.task.grade, {
      cwd: dir,
      defaultTimeoutMs: config.gradeTimeoutMs,
      ...(adapter.ask ? { judge: adapter.ask.bind(adapter) } : {}),
      judgeTimeoutMs: config.judgeTimeoutMs,
    });

    // Judge graders spend real money, so their cost belongs in the trial's
    // total or the budget cap would only be counting half the bill.
    const gradeCost = grades.reduce((sum, g) => sum + (g.costUsd ?? 0), 0);

    return {
      variantId: item.variant.id,
      taskId: item.task.id,
      trial: item.trial,
      pass: grades.length > 0 && grades.every((g) => g.pass),
      grades,
      costUsd: (outcome.costUsd ?? 0) + gradeCost,
      durationMs: Date.now() - started,
      ...(outcome.turns !== undefined ? { turns: outcome.turns } : {}),
    };
  } catch (err) {
    return fail((err as Error).message);
  } finally {
    await removeWorktree(root, dir);
    await rm(parent, { recursive: true, force: true });
  }
}

/**
 * Executes a plan under the configured budget.
 *
 * The caps are checked before each trial rather than after, so a run stops
 * short of the limit instead of overshooting it by one expensive invocation.
 */
export async function runPlan(plan: RunPlanItem[], opts: RunnerOptions): Promise<RunSummary> {
  const { config, adapter } = opts;
  const results: RunResult[] = [];
  let spentUsd = 0;
  let replayedUsd = 0;
  let stoppedEarly: string | undefined;
  let cursor = 0;
  let started = 0;

  const cached = opts.resume && opts.ledgerPath ? await readLedger(opts.ledgerPath) : new Map();

  const record = async (result: RunResult, index: number, fromCache: boolean) => {
    results.push(result);
    // A replayed trial must not consume the budget, or resuming a capped run
    // would trip the cap on history alone and make no further progress.
    if (fromCache) replayedUsd += result.costUsd;
    else spentUsd += result.costUsd;
    if (opts.ledgerPath && !fromCache) {
      await appendFile(opts.ledgerPath, `${JSON.stringify(result)}\n`, 'utf8');
    }
    opts.onTrialEnd?.(result, index, plan.length);
  };

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= plan.length) return;
      const item = plan[index];
      if (!item) return;

      const hit = cached.get(keyOf(item));
      if (hit) {
        await record(hit, index, true);
        continue;
      }

      if (stoppedEarly) return;
      if (started >= config.budget.maxRuns) {
        stoppedEarly = `run cap reached (${config.budget.maxRuns} agent runs)`;
        return;
      }
      if (spentUsd >= config.budget.maxUsd) {
        stoppedEarly = `spend cap reached ($${config.budget.maxUsd})`;
        return;
      }
      started++;

      opts.onTrialStart?.(item, index, plan.length);
      await record(await runTrial(item, opts, adapter), index, false);
    }
  };

  const lanes = Math.max(1, Math.min(config.concurrency, plan.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  await pruneWorktrees(opts.root);

  results.sort((a, b) => a.variantId.localeCompare(b.variantId) || a.taskId.localeCompare(b.taskId));
  return {
    results,
    spentUsd,
    replayedUsd,
    runsExecuted: started,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

export function buildPlan(variants: Variant[], tasks: Task[], trials: number): RunPlanItem[] {
  const plan: RunPlanItem[] = [];
  // Trial-major order so an interrupted run still has one full pass over every
  // variant, rather than complete data for the first variant and none for the rest.
  for (let trial = 0; trial < trials; trial++) {
    for (const variant of variants) {
      for (const task of tasks) plan.push({ variant, task, trial });
    }
  }
  return plan;
}
