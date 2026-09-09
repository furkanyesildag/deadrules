#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ablate, proportionFor } from './ablate/plan.js';
import { compare, minDetectableEffect, rate } from './ablate/stats.js';
import { buildAdapter, CONFIG_PATH, DEFAULT_CONFIG, loadConfig, type Config } from './config.js';
import { exec } from './exec.js';
import { isClean, repoRoot } from './git.js';
import { renderAblationReport, type ReportHeader } from './report/terminal.js';
import { discoverRuleFiles } from './rules/discover.js';
import { parseRuleSet } from './rules/parse.js';
import { baselineVariant, literalVariant } from './rules/render.js';
import { buildPlan, runPlan } from './run/runner.js';
import { loadTasks, TASKS_DIR } from './tasks/load.js';
import { detectTestCommand, mineTasks, renderTaskFile } from './tasks/mine.js';
import type { RuleFile } from './types.js';

const USAGE = `
  deadrules — measure which of your agent rules actually do anything

  deadrules rules              parse and list your rules (free, no agent runs)
  deadrules init               write a config and mine draft tasks from git history
  deadrules ablate             remove each rule, measure, report what mattered
  deadrules diff <ref>         compare your rules against their version at <ref>

  Options
    --rules <path>       rules file to measure (repeatable; default: auto-detect)
    --tasks <id,...>     only these tasks
    --trials <n>         repetitions per variant (default 3)
    --budget-runs <n>    hard cap on agent invocations
    --budget-usd <n>     hard cap on spend
    --concurrency <n>    parallel worktrees (default 2)
    --resume             reuse trials already recorded in the ledger
    --all                list every rule in the report
    --json               machine-readable output
    --yes                skip the cost confirmation
`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const repeatable = new Set(['rules']);
  const collected = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith('--');
    if (takesValue) i++;
    const value = takesValue ? (next as string) : true;
    if (repeatable.has(name) && typeof value === 'string') {
      collected.set(name, [...(collected.get(name) ?? []), value]);
    }
    flags.set(name, value);
  }
  for (const [name, values] of collected) flags.set(name, values.join(','));
  return { command: positional[0] ?? '', positional: positional.slice(1), flags };
}

function num(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return n;
}

function list(args: Args, name: string): string[] | undefined {
  const raw = args.flags.get(name);
  return typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

function applyOverrides(cfg: Config, args: Args): Config {
  const trials = num(args, 'trials');
  const maxRuns = num(args, 'budget-runs');
  const maxUsd = num(args, 'budget-usd');
  const concurrency = num(args, 'concurrency');
  const rules = list(args, 'rules');
  return {
    ...cfg,
    ...(trials !== undefined ? { trials } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(rules !== undefined ? { rules } : {}),
    budget: {
      maxRuns: maxRuns ?? cfg.budget.maxRuns,
      maxUsd: maxUsd ?? cfg.budget.maxUsd,
    },
  };
}

async function loadRuleSet(root: string, cfg: Config) {
  const files = await discoverRuleFiles(root, cfg.rules);
  if (files.length === 0) {
    throw new Error(
      'no rules files found. Looked for CLAUDE.md, AGENTS.md, .cursor/rules/*, and friends. Use --rules <path>.',
    );
  }
  const set = parseRuleSet(files);
  if (set.rules.length === 0) {
    throw new Error(`${files.map((f) => f.path).join(', ')} contains no rules to ablate.`);
  }
  return set;
}

/** Cuts at a word boundary so a listed rule never ends mid-word. */
function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  const cut = text.slice(0, width);
  const space = cut.lastIndexOf(' ');
  return `${(space > width * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

async function cmdRules(root: string, args: Args): Promise<number> {
  const cfg = applyOverrides(await loadConfig(root), args);
  const set = await loadRuleSet(root, cfg);

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(set.rules, null, 2)}\n`);
    return 0;
  }

  let current = '';
  process.stdout.write(`\n  deadrules\n\n`);
  for (const rule of set.rules) {
    const where = [rule.file, ...rule.section].join(' / ');
    if (where !== current) {
      current = where;
      process.stdout.write(`  ${where}\n`);
    }
    const head = rule.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split('\n')[0] ?? '';
    process.stdout.write(`    ${rule.id}  ${truncate(head, 66)}\n`);
  }
  process.stdout.write(
    `\n  ${set.rules.length} rules across ${set.files.length} file(s).\n` +
      `  \`deadrules ablate\` measures which of them change what the agent does.\n\n`,
  );
  return 0;
}

async function cmdInit(root: string, args: Args): Promise<number> {
  const dir = join(root, '.deadrules');
  await mkdir(join(root, TASKS_DIR), { recursive: true });

  const testCommand = await detectTestCommand(root);
  const config = {
    ...DEFAULT_CONFIG,
    rules: (await discoverRuleFiles(root, undefined)).map((f) => f.path),
  };
  await writeFile(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // Twelve rather than a handful: tasks add independent evidence, while extra
  // trials only average noise out of evidence already gathered. Twelve tasks at
  // the default three trials is what puts the detectable effect near 33pp
  // instead of 51pp.
  const count = num(args, 'mine') ?? 12;
  const tasks = await mineTasks(root, count, testCommand);
  for (const task of tasks) {
    await writeFile(join(root, TASKS_DIR, `${task.id}.md`), renderTaskFile(task), 'utf8');
  }

  process.stdout.write(
    `\n  wrote ${CONFIG_PATH}\n` +
      `  wrote ${tasks.length} draft task(s) to ${TASKS_DIR}/\n\n` +
      (testCommand
        ? `  graded with: ${testCommand}\n\n`
        : `  no test command detected — add graders to each task before running.\n\n`) +
      (tasks.length < count
        ? `  Only ${tasks.length} of the ${count} requested could be mined: most recent commits\n` +
          `  touch no code, or touch too much of it to read as one task. Write the rest\n` +
          `  by hand, or ask for more with --mine ${count * 3}.\n\n`
        : '') +
      `  Read the tasks before trusting them: they are mined from commit messages,\n` +
      `  which assume context the agent will not have. Then run \`deadrules ablate\`.\n\n`,
  );
  return tasks.length === 0 ? 1 : 0;
}

/** Reads the rules files as they were at a git ref, for the `diff` command. */
async function ruleFilesAtRef(root: string, ref: string, paths: string[]): Promise<RuleFile[]> {
  const files: RuleFile[] = [];
  for (const path of paths) {
    const res = await exec('git', ['show', `${ref}:${path}`], { cwd: root, timeoutMs: 30_000 });
    // A rules file that did not exist at that ref is an empty one, not an error:
    // "we added CLAUDE.md" is exactly the comparison people want to run.
    files.push({ path, content: res.code === 0 ? res.stdout : '' });
  }
  return files;
}

interface RunContext {
  root: string;
  cfg: Config;
  header: ReportHeader;
  ledgerPath: string;
}

async function prepare(root: string, args: Args): Promise<RunContext & { set: Awaited<ReturnType<typeof loadRuleSet>>; tasks: Awaited<ReturnType<typeof loadTasks>> }> {
  const cfg = applyOverrides(await loadConfig(root), args);
  const set = await loadRuleSet(root, cfg);
  const tasks = await loadTasks(root, list(args, 'tasks'));

  const adapter = buildAdapter(cfg);
  const problem = await adapter.preflight();
  if (problem) throw new Error(problem);

  if (!(await isClean(root))) {
    process.stderr.write(
      '  note: the working tree is dirty. Worktrees check out committed state,\n' +
        '        so uncommitted changes are not part of the measurement.\n\n',
    );
  }

  await mkdir(join(root, '.deadrules', 'runs'), { recursive: true });
  return {
    root,
    cfg,
    set,
    tasks,
    ledgerPath: join(root, '.deadrules', 'runs', 'ledger.jsonl'),
    header: {
      ruleFiles: set.files.map((f) => f.path),
      ruleCount: set.rules.length,
      taskCount: tasks.length,
      agent: adapter.name,
      ...(cfg.agent.model ? { model: cfg.agent.model } : {}),
      trials: cfg.trials,
    },
  };
}

async function confirm(message: string, args: Args): Promise<boolean> {
  if (args.flags.has('yes')) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(`${message}\n  Re-run with --yes to proceed non-interactively.\n\n`);
    return false;
  }
  process.stdout.write(`${message}\n  Continue? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()));
  });
  process.stdout.write('\n');
  return answer === 'y' || answer === 'yes';
}

async function cmdAblate(root: string, args: Args): Promise<number> {
  const ctx = await prepare(root, args);
  const { cfg, set, tasks } = ctx;

  const sweep = tasks.length * cfg.trials;
  const ok = await confirm(
    `\n  ${set.rules.length} rules · ${tasks.length} tasks · ${cfg.trials} trials\n` +
      `  Each variant costs ${sweep} agent runs. Capped at ${cfg.budget.maxRuns} runs / $${cfg.budget.maxUsd}.\n`,
    args,
  );
  if (!ok) return 1;

  const outcome = await ablate(set.rules, tasks, {
    root,
    config: cfg,
    ruleSet: set,
    adapter: buildAdapter(cfg),
    ledgerPath: ctx.ledgerPath,
    ...(args.flags.has('resume') ? { resume: true } : {}),
    onTrialStart: (item, i, total) => {
      process.stderr.write(`  [${i + 1}/${total}] ${item.variant.label} · ${item.task.id}\n`);
    },
  });

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderAblationReport(outcome, ctx.header, args.flags.has('all')));
  return 0;
}

async function cmdDiff(root: string, args: Args): Promise<number> {
  const ref = args.positional[0];
  if (!ref) throw new Error('usage: deadrules diff <git-ref>');

  const ctx = await prepare(root, args);
  const { cfg, set, tasks } = ctx;

  const before = literalVariant(
    'before',
    `rules at ${ref}`,
    await ruleFilesAtRef(root, ref, set.files.map((f) => f.path)),
  );
  const after = { ...baselineVariant(), id: 'after', label: 'rules now' };

  const sweep = tasks.length * cfg.trials;
  const ok = await confirm(
    `\n  comparing rules at ${ref} against the current ones\n` +
      `  ${tasks.length} tasks · ${cfg.trials} trials · ${sweep * 2} agent runs\n`,
    args,
  );
  if (!ok) return 1;

  const summary = await runPlan(buildPlan([before, after], tasks, cfg.trials), {
    root,
    config: cfg,
    ruleSet: set,
    adapter: buildAdapter(cfg),
    ledgerPath: ctx.ledgerPath,
    ...(args.flags.has('resume') ? { resume: true } : {}),
    onTrialStart: (item, i, total) => {
      process.stderr.write(`  [${i + 1}/${total}] ${item.variant.label} · ${item.task.id}\n`);
    },
  });

  const beforeProp = proportionFor(summary.results, 'before');
  const afterProp = proportionFor(summary.results, 'after');
  const cmp = compare(beforeProp, afterProp, cfg.alpha);

  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify({ before: beforeProp, after: afterProp, cmp }, null, 2)}\n`);
    return 0;
  }

  const verdict =
    cmp.verdict === 'better'
      ? 'the current rules do better'
      : cmp.verdict === 'worse'
        ? 'the current rules do worse'
        : 'no measurable difference';
  const mde = minDetectableEffect(beforeProp.n, rate(beforeProp) || 0.5);

  process.stdout.write(
    `\n  deadrules diff\n\n` +
      `  rules at ${ref}   ${Math.round(rate(beforeProp) * 100)}%  (${beforeProp.k}/${beforeProp.n})\n` +
      `  rules now        ${Math.round(rate(afterProp) * 100)}%  (${afterProp.k}/${afterProp.n})\n\n` +
      `  ${verdict}  (p=${cmp.pValue.toFixed(3)})\n` +
      `  spent $${summary.spentUsd.toFixed(2)} · smallest detectable swing at this budget: ${Math.round(mde * 100)}pp\n\n` +
      (summary.stoppedEarly ? `  stopped early: ${summary.stoppedEarly}\n\n` : ''),
  );
  return cmp.verdict === 'worse' ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.flags.has('help') || args.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return args.command ? 0 : 1;
  }
  if (args.flags.has('version')) {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const root = await repoRoot(process.cwd());

  switch (args.command) {
    case 'rules':
      return cmdRules(root, args);
    case 'init':
      return cmdInit(root, args);
    case 'ablate':
      return cmdAblate(root, args);
    case 'diff':
      return cmdDiff(root, args);
    default:
      process.stderr.write(`  unknown command: ${args.command}\n${USAGE}\n`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`\n  deadrules: ${err.message}\n\n`);
    process.exit(2);
  });
