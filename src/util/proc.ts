/** Process helpers: a capturing runner, a streaming runner, and a concurrency limiter. */

import { spawn } from "child_process";
import * as fs from "fs";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdin payload to write then close. */
  input?: string;
  /** Kill after this many ms (0 = no timeout). */
  timeoutMs?: number;
}

/** A runner abstraction so callers (libCRS client, agent) can be unit-tested without spawning. */
export type ProcRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // negative pid ⇒ whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Capture stdout/stderr into memory. The default ProcRunner. */
export const runCapture: ProcRunner = (cmd, args, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true, // own process group ⇒ killTree can reap children
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid!, "SIGTERM");
        setTimeout(() => killTree(child.pid!, "SIGKILL"), 2000);
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    });
  });

/**
 * Run a command and stream both stdout and stderr to a log file, while invoking
 * `onLine` for each stderr line (used by the fuzz monitor to react to events live).
 */
export function runStreaming(
  cmd: string,
  args: string[],
  opts: RunOptions & { logFile: string; onStderrLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const out = fs.createWriteStream(opts.logFile, { flags: "a" });
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true });
    let stderr = "";
    let timedOut = false;
    let buf = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid!, "SIGTERM");
        setTimeout(() => killTree(child.pid!, "SIGKILL"), 2000);
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out.write(s);
      stderr += s;
      if (opts.onStderrLine) {
        buf += s;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          opts.onStderrLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    // Resolve only after the log stream has flushed to disk, so a caller that
    // reads logFile right after we resolve (stats parsing, snapshot copy) sees
    // the complete output rather than a truncated tail.
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      out.end(() => resolve({ code: 127, stdout: "", stderr: stderr + String(err), timedOut }));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (buf && opts.onStderrLine) opts.onStderrLine(buf);
      out.end(() => resolve({ code: code ?? 0, stdout: "", stderr, timedOut }));
    });
  });
}

/** Run async tasks with a bounded concurrency. Preserves input order in the result. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
