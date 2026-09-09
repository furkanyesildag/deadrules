/** One atomic, independently removable instruction found in a rules file. */
export interface Rule {
  /** Short display id, assigned in document order: R01, R02, ... */
  id: string;
  /** Content hash — stable across reordering, so results survive edits elsewhere. */
  hash: string;
  /** Rules file this came from, relative to the repo root. */
  file: string;
  /** 1-based line where the rule starts. */
  line: number;
  /** Number of source lines the rule occupies (a bullet plus its continuations). */
  span: number;
  /** The rule text, normalised for display (bullet marker and indent stripped). */
  text: string;
  kind: 'bullet' | 'paragraph';
  /** Headings the rule sits under, outermost first. Used for grouping. */
  section: string[];
}

export interface RuleFile {
  /** Path relative to the repo root. */
  path: string;
  content: string;
}

export interface RuleSet {
  files: RuleFile[];
  rules: Rule[];
}

/** A rules configuration to measure: the full set minus some rules. */
export interface Variant {
  /** Stable id, e.g. `baseline`, `empty`, `minus-R01+R07`. */
  id: string;
  label: string;
  /** Rule ids removed from the baseline set. */
  removed: string[];
  /**
   * Verbatim rules files, used instead of `removed` when the variant is a whole
   * other version of the document — the `diff` command comparing two git refs,
   * for instance, where the change is not expressible as a set of deletions.
   */
  files?: RuleFile[];
}

export type Grader =
  | { type: 'run'; cmd: string; timeoutMs?: number; label?: string }
  /** `flags` defaults to none, as in a bare regex literal. Pass "i" to ignore case. */
  | { type: 'file-contains'; path: string; pattern: string; flags?: string }
  | { type: 'file-absent'; path: string }
  | { type: 'no-new-pattern'; pattern: string; flags?: string }
  | { type: 'diff-files-max'; max: number }
  /**
   * Paths are matched exactly or as a trailing path segment, so `users.ts`
   * accepts any file of that name anywhere. Give a repo-relative path to pin it.
   */
  | { type: 'touched'; paths: string[] }
  /**
   * Asks a model whether the change meets a rubric. The only grader that can
   * see style, tone, comment quality or commit-message shape -- the rules
   * people argue about most, and the ones every other grader here reads as
   * dead. Opt-in: it costs a model call per trial.
   */
  | { type: 'judge'; rubric: string; label?: string };

export interface Task {
  id: string;
  /** What the agent is asked to do. */
  prompt: string;
  /** Git ref the worktree starts from. Defaults to the config's base. */
  base?: string;
  /** Shell commands run in the worktree before the agent, e.g. `npm ci`. */
  setup?: string[];
  grade: Grader[];
  /** Relative importance when averaging scores across tasks. */
  weight: number;
  /** Where the task came from, for the report. */
  origin?: string;
}

export interface GradeResult {
  label: string;
  pass: boolean;
  detail?: string;
  /** Spend this grader itself incurred. Only the `judge` grader costs anything. */
  costUsd?: number;
  /**
   * The grader could not reach a verdict, as opposed to reaching a negative
   * one. Such a trial is excluded from the statistics rather than counted as a
   * failure: a judge that timed out says nothing about what the agent did, and
   * judge failures correlate with rate limits and parallel load, so counting
   * them as failures would cluster on whichever variants happened to run
   * during a slow patch.
   */
  errored?: boolean;
}

/** One (variant, task, trial) measurement. Agents are not seedable, so a
 * trial is a plain repetition: the only defence against run-to-run noise. */
export interface RunResult {
  variantId: string;
  taskId: string;
  trial: number;
  /** True only when every grader passed. */
  pass: boolean;
  grades: GradeResult[];
  costUsd: number;
  durationMs: number;
  turns?: number;
  /** Set when the agent itself failed to run; such trials are excluded, not failed. */
  error?: string;
}

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  trial: number;
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
}

export interface AgentRunOutcome {
  /**
   * Whether the adapter got the agent to run at all. False means an
   * infrastructure fault (binary missing, timeout, unparseable output) and the
   * trial is excluded from the statistics rather than counted as a failure.
   */
  ok: boolean;
  costUsd?: number;
  turns?: number;
  /** Why the adapter could not run the agent. Only meaningful when `ok` is false. */
  error?: string;
  /**
   * The agent ran but reported a problem of its own (hit the turn cap, refused,
   * gave up). That is a legitimate failure, so the graders still run.
   */
  agentReportedError?: string;
}

export interface AskOutcome {
  text: string;
  costUsd?: number;
  error?: string;
}

export interface AgentAdapter {
  name: string;
  /** Throws only on programmer error; agent failures come back as `ok: false`. */
  run(opts: AgentRunOptions): Promise<AgentRunOutcome>;
  /** Human-readable reason the adapter cannot run here, or null when it can. */
  preflight(): Promise<string | null>;
  /**
   * One-shot question with a text answer and no file access, used by the
   * `judge` grader. Adapters that cannot answer questions omit this, and
   * judge graders then fail closed rather than silently passing.
   */
  ask?(prompt: string, timeoutMs: number): Promise<AskOutcome>;
}
