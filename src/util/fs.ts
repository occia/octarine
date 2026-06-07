/** Small filesystem helpers used across the orchestrator and verifier. */

import * as fs from "fs";
import * as path from "path";

export function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file atomically (tmp + rename) so concurrent readers never see a partial write. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirp(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readFileOr(file: string, fallback: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

/** True if `dir` exists and contains at least one non-empty file (recursively). */
export function dirHasNonEmptyFile(dir: string): boolean {
  let found = false;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size > 0) found = true;
    }
  };
  walk(dir);
  return found;
}

/** Recursively copy the *contents* of `srcDir` into `dstDir` (like `cp -r src/. dst/`). */
export function copyDirContents(srcDir: string, dstDir: string): void {
  mkdirp(dstDir);
  fs.cpSync(srcDir, dstDir, { recursive: true });
}
