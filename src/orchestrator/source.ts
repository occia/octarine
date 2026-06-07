/**
 * Prepare the reference source tree: download the build-output `src` and make it
 * a git repo (so libCRS can diff modified dirs against it). Port of setup_source()
 * in the Python harness_gen.py.
 */

import * as fs from "fs";
import * as path from "path";
import { LibCrs } from "../libcrs/client";
import { SourceVersion } from "../types";
import { runCapture } from "../util/proc";
import { log } from "../util/log";

/** File written by compile_target (bin/compile_target) holding each $SRC repo's real git provenance. */
export const SOURCE_VERSION_FILE = ".crs-source-version.json";

/** OSS-Fuzz fuzzing-engine repos that also live under $SRC; never the project's own source. */
const ENGINE_DIRS = new Set(["aflplusplus", "honggfuzz", "libfuzzer", "fuzztest"]);

/** Normalize a git remote/main_repo for comparison: drop scheme, `.git`, trailing slashes, case. */
function normRepo(u: string): string {
  return (u || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/:/g, "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

interface RawRepo {
  dir?: string;
  commit?: string;
  branch?: string;
  remote?: string;
  describe?: string;
}

/** Pick the project's own repo (the one whose remote == main_repo, else the sole non-engine repo). */
export function pickSourceVersion(repos: RawRepo[], mainRepo: string): SourceVersion | undefined {
  if (!Array.isArray(repos) || repos.length === 0) return undefined;
  const want = normRepo(mainRepo);
  let pick = want ? repos.find((r) => normRepo(r.remote ?? "") === want) : undefined;
  if (!pick) {
    const nonEngine = repos.filter((r) => !ENGINE_DIRS.has((r.dir ?? "").toLowerCase()));
    if (nonEngine.length === 1) pick = nonEngine[0];
  }
  if (!pick) pick = repos[0];
  const commit = (pick.commit ?? "").trim();
  if (!commit) return undefined;
  return {
    repoUrl: (pick.remote ?? mainRepo ?? "").trim(),
    branch: (pick.branch ?? "").trim() || "HEAD",
    commit,
    shortCommit: commit.slice(0, 12),
    describe: (pick.describe ?? "").trim() || undefined,
  };
}

/** Read the build-time provenance file from the delivered source tree; undefined if absent/empty. */
export function readSourceVersion(srcDir: string, mainRepo: string): SourceVersion | undefined {
  let parsed: { repos?: RawRepo[] };
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(srcDir, SOURCE_VERSION_FILE), "utf8"));
  } catch {
    return undefined; // older build outputs (pre-capture) won't have it
  }
  return pickSourceVersion(parsed.repos ?? [], mainRepo);
}

export async function setupSource(libcrs: LibCrs, srcDir: string): Promise<boolean> {
  // Best-effort: let git operate on container-owned trees.
  await runCapture("git", ["config", "--global", "--add", "safe.directory", "*"]);

  try {
    await libcrs.downloadBuildOutput("src", srcDir);
  } catch (e) {
    log.error("failed to download build-output src", { error: String(e) });
    return false;
  }

  if (fs.existsSync(path.join(srcDir, ".git"))) return true;

  log.info("no .git in source; initializing repo", { srcDir });
  await runCapture("git", ["init"], { cwd: srcDir });
  await runCapture("git", ["add", "-A"], { cwd: srcDir });
  // Make this synthetic commit DETERMINISTIC: fixed author/committer + fixed dates, so the resulting
  // HEAD hash depends only on the source-tree content. Cross-run memory is keyed by this commit, so a
  // re-download of the same source must produce the same key (otherwise resume would never match).
  const FIXED_DATE = "2000-01-01T00:00:00 +0000";
  const commit = await runCapture(
    "git",
    [
      "-c", "user.name=octarine", "-c", "user.email=crs@local",
      "commit", "-q", "--no-gpg-sign", "--date", FIXED_DATE, "-m", "initial source",
    ],
    { cwd: srcDir, env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE } },
  );
  if (commit.code !== 0) {
    log.error("failed to create initial commit", { stderr: commit.stderr.trim() });
    return false;
  }
  return true;
}
