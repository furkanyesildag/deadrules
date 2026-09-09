import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeAdapter } from './run/adapters/claude.js';
import { commandAdapter } from './run/adapters/command.js';
import type { AgentAdapter } from './types.js';

export interface AgentConfig {
  kind: 'claude' | 'command';
  /** Binary for `kind: claude`. */
  bin?: string;
  /** Shell template for `kind: command`. */
  cmd?: string;
  promptOnStdin?: boolean;
  /** Flat per-trial cost for `kind: command`, which cannot report its own. */
  costUsd?: number;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  permissionMode?: string;
  extraArgs?: string[];
}

export interface BudgetConfig {
  /** Hard cap on agent invocations for one command. */
  maxRuns: number;
  /** Hard cap on reported spend; the run stops cleanly when it is reached. */
  maxUsd: number;
}

export interface Config {
  /** Git ref every worktree starts from unless a task overrides it. */
  base: string;
  /** Rules files to ablate. Empty means auto-discover. */
  rules: string[];
  agent: AgentConfig;
  /** Repetitions per (variant, task). More trials, narrower intervals. */
  trials: number;
  concurrency: number;
  gradeTimeoutMs: number;
  budget: BudgetConfig;
  /** Significance level for the pass-rate tests, after FDR correction. */
  alpha: number;
}

export const CONFIG_DIR = '.deadrules';
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: Config = {
  base: 'HEAD',
  rules: [],
  agent: {
    kind: 'claude',
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 30,
    timeoutMs: 600_000,
    permissionMode: 'acceptEdits',
  },
  trials: 3,
  concurrency: 2,
  gradeTimeoutMs: 300_000,
  budget: { maxRuns: 80, maxUsd: 15 },
  alpha: 0.05,
};

export async function loadConfig(root: string): Promise<Config> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(join(root, CONFIG_PATH), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return mergeConfig(DEFAULT_CONFIG, raw as Partial<Config>);
}

export function mergeConfig(base: Config, over: Partial<Config>): Config {
  return {
    ...base,
    ...over,
    agent: { ...base.agent, ...(over.agent ?? {}) },
    budget: { ...base.budget, ...(over.budget ?? {}) },
    rules: over.rules ?? base.rules,
  };
}

export function buildAdapter(cfg: Config): AgentAdapter {
  if (cfg.agent.kind === 'command') {
    return commandAdapter({
      cmd: cfg.agent.cmd ?? '',
      ...(cfg.agent.costUsd !== undefined ? { costUsd: cfg.agent.costUsd } : {}),
      ...(cfg.agent.promptOnStdin !== undefined
        ? { promptOnStdin: cfg.agent.promptOnStdin }
        : {}),
    });
  }
  return claudeAdapter({
    ...(cfg.agent.bin !== undefined ? { bin: cfg.agent.bin } : {}),
    ...(cfg.agent.permissionMode !== undefined
      ? { permissionMode: cfg.agent.permissionMode }
      : {}),
    ...(cfg.agent.extraArgs !== undefined ? { extraArgs: cfg.agent.extraArgs } : {}),
  });
}
