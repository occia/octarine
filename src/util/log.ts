/** Minimal structured logger: one JSON line per event on stdout (and an optional file sink). */

import * as fs from "fs";

type Fields = Record<string, unknown>;

let sink: fs.WriteStream | undefined;

/** Mirror every log line to `file` (the run report's run.jsonl) in addition to stdout. */
export function initLogFile(file: string): void {
  try {
    sink = fs.createWriteStream(file, { flags: "a" });
  } catch {
    /* best-effort: never fail the run over logging */
  }
}

function emit(level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  process.stdout.write(line + "\n");
  try {
    sink?.write(line + "\n");
  } catch {
    /* best-effort */
  }
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
