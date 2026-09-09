import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Cap on captured output per stream; keeps a runaway agent from eating memory. */
  maxBuffer?: number;
}

/**
 * Runs a command without a shell where possible and always with a timeout.
 *
 * A timed-out child is killed with SIGTERM and then SIGKILL, because agent CLIs
 * routinely ignore the first signal while a model request is in flight.
 */
export function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs = 120_000, env, input, maxBuffer = 4 * 1024 * 1024 } = opts;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    let killTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxBuffer) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxBuffer) stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Runs a command line through the user's shell. Used for task setup and graders. */
export function execShell(line: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return exec('/bin/sh', ['-c', line], opts);
}
