import { execShell } from '../../exec.js';
import type { AgentAdapter, AgentRunOptions, AgentRunOutcome } from '../../types.js';

export interface CommandAdapterOptions {
  /**
   * A shell command line. `{{prompt}}` is substituted with a shell-quoted
   * prompt, `{{cwd}}` with the worktree path, `{{model}}` with the model name.
   */
  cmd: string;
  /** Reported per trial when the wrapped CLI cannot tell us. */
  costUsd?: number;
  /** Also feed the prompt on stdin, for CLIs that read it there. */
  promptOnStdin?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs any agent CLI. This is the escape hatch that keeps deadrules from being
 * a Claude Code tool: anything that takes a prompt and edits files in `cwd`
 * can be measured.
 *
 * The wrapped command is expected to exit non-zero only on a real failure to
 * run; whether the task was accomplished is decided by the graders, never by
 * the exit code.
 */
export function commandAdapter(opts: CommandAdapterOptions): AgentAdapter {
  return {
    name: 'command',

    async preflight() {
      if (!opts.cmd.trim()) return 'agent.cmd is empty; set it to the agent CLI to measure.';
      if (!opts.cmd.includes('{{prompt}}') && !opts.promptOnStdin) {
        return 'agent.cmd contains no {{prompt}}; set agent.promptOnStdin if the CLI reads stdin.';
      }
      return null;
    },

    async run(o: AgentRunOptions): Promise<AgentRunOutcome> {
      const line = opts.cmd
        .replace(/\{\{prompt\}\}/g, shellQuote(o.prompt))
        .replace(/\{\{cwd\}\}/g, shellQuote(o.cwd))
        .replace(/\{\{model\}\}/g, shellQuote(o.model ?? ''));

      const res = await execShell(line, {
        cwd: o.cwd,
        timeoutMs: o.timeoutMs,
        env: { ...process.env, DEADRULES_TRIAL: String(o.trial) },
        ...(opts.promptOnStdin ? { input: o.prompt } : {}),
      });

      if (res.timedOut) return { ok: false, error: `timed out after ${o.timeoutMs}ms` };
      if (res.code !== 0) {
        return {
          ok: true,
          costUsd: opts.costUsd ?? 0,
          agentReportedError: `exit ${res.code}: ${res.stderr.trim().slice(0, 200)}`,
        };
      }
      return { ok: true, costUsd: opts.costUsd ?? 0 };
    },
  };
}
