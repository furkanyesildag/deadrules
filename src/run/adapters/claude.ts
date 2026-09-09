import { tmpdir } from 'node:os';
import { exec } from '../../exec.js';
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunOutcome,
  AskOutcome,
} from '../../types.js';

export interface ClaudeAdapterOptions {
  /** Defaults to `claude` on PATH. */
  bin?: string;
  /**
   * Passed straight to `--permission-mode`. Runs happen in a throwaway git
   * worktree, so `bypassPermissions` is defensible here and is often required
   * for a task that has to run the test suite unattended.
   */
  permissionMode?: string;
  extraArgs?: string[];
}

interface ClaudeJson {
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  subtype?: string;
}

export function claudeAdapter(opts: ClaudeAdapterOptions = {}): AgentAdapter {
  const bin = opts.bin ?? 'claude';
  const permissionMode = opts.permissionMode ?? 'acceptEdits';

  return {
    name: 'claude',

    async preflight() {
      const res = await exec(bin, ['--version'], { timeoutMs: 20_000 });
      if (res.code === 0) return null;
      return `\`${bin}\` is not runnable. Install Claude Code (npm i -g @anthropic-ai/claude-code) or set agent.bin.`;
    },

    async ask(prompt: string, timeoutMs: number): Promise<AskOutcome> {
      // No tools and one turn: the judge reads the text it was handed and
      // answers. It must not be able to go looking at the repository, or it
      // would find the rules file whose effect is being measured.
      const res = await exec(
        bin,
        ['-p', prompt, '--output-format', 'json', '--max-turns', '1', '--allowed-tools', ''],
        { cwd: tmpdir(), timeoutMs },
      );
      if (res.timedOut) return { text: '', error: `judge timed out after ${timeoutMs}ms` };

      const parsed = parseJson(res.stdout);
      if (!parsed) {
        return { text: '', error: res.stderr.trim().slice(0, 200) || 'no JSON from the judge' };
      }
      return { text: parsed.result ?? '', costUsd: parsed.total_cost_usd ?? 0 };
    },

    async run(o: AgentRunOptions): Promise<AgentRunOutcome> {
      const args = [
        '-p',
        o.prompt,
        '--output-format',
        'json',
        '--permission-mode',
        permissionMode,
      ];
      if (o.model) args.push('--model', o.model);
      if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
      args.push(...(opts.extraArgs ?? []));

      const res = await exec(bin, args, { cwd: o.cwd, timeoutMs: o.timeoutMs });

      if (res.timedOut) return { ok: false, error: `timed out after ${o.timeoutMs}ms` };

      const parsed = parseJson(res.stdout);
      if (!parsed) {
        // A non-zero exit with no JSON means the CLI never got as far as a turn.
        return {
          ok: false,
          error: res.stderr.trim().slice(0, 400) || `exit ${res.code} with unparseable output`,
        };
      }

      // A refusal or a turn-cap stop is a real outcome, not an adapter fault:
      // the graders still get to look at whatever landed in the worktree.
      return {
        ok: true,
        costUsd: parsed.total_cost_usd ?? 0,
        turns: parsed.num_turns,
        ...(parsed.is_error
          ? { agentReportedError: parsed.subtype ?? 'agent reported an error' }
          : {}),
      };
    },
  };
}

/** Claude prints one JSON object, but a wrapper script may prepend noise. */
function parseJson(stdout: string): ClaudeJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeJson;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as ClaudeJson;
    } catch {
      return null;
    }
  }
}
