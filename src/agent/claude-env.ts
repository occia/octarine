/**
 * One-time Claude Code setup: environment, ~/.claude.json, global gitignore for
 * CLAUDE.md, and the project .claude/settings.json that registers the Stop hook.
 * Ports the relevant parts of the Python agents/claude_code.py setup().
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Config } from "../types";
import { writeFileAtomic, mkdirp, readFileOr } from "../util/fs";
import { runCapture } from "../util/proc";
import { log } from "../util/log";

/** Build the environment for `claude` invocations (auth + hook plumbing). */
export function buildClaudeEnv(c: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, IS_SANDBOX: "1" };
  // The Stop hook (a child of claude) reads these to find build + run state.
  env.HARNESS_GEN_BUILD_RESP = c.paths.buildResp;
  env.HARNESS_GEN_STATE = c.paths.state;

  if (c.oauthToken) {
    log.info("using CLAUDE_CODE_OAUTH_TOKEN for auth");
  } else if (c.llmApiUrl && c.llmApiKey) {
    env.ANTHROPIC_BASE_URL = c.llmApiUrl;
    env.ANTHROPIC_AUTH_TOKEN = c.llmApiKey;
    env.ANTHROPIC_API_KEY = "";
    log.info("using LLM proxy for auth", { url: c.llmApiUrl });
  } else {
    log.warn("no OAuth token and no LLM url/key; claude may not authenticate");
  }
  // Diagnostic: which auth vars actually reach the claude subprocess (no secret values).
  log.info("claude auth env", {
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL
      ? env.ANTHROPIC_BASE_URL.replace(/^(https?:\/\/[^/]+).*/, "$1")
      : "",
    hasAuthToken: !!env.ANTHROPIC_AUTH_TOKEN,
    hasApiKey: !!env.ANTHROPIC_API_KEY,
    hasOssCrsLlmUrl: !!env.OSS_CRS_LLM_API_URL,
  });
  return env;
}

/** Write ~/.claude.json so the CLI skips onboarding and trusts the source dir. */
export function writeClaudeJson(srcDir: string): void {
  const cfg = {
    numStartups: 0,
    autoUpdaterStatus: "disabled",
    userID: "-",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "1.0.0",
    projects: {
      [srcDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
  const file = path.join(os.homedir(), ".claude.json");
  fs.writeFileSync(file, JSON.stringify(cfg));
  fs.chmodSync(file, 0o600);
}

/** Keep the runtime CLAUDE.md out of any generated diffs. */
export function setupGlobalGitignore(): void {
  const file = path.join(os.homedir(), ".gitignore");
  const lines = readFileOr(file, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  if (!lines.includes("CLAUDE.md")) lines.push("CLAUDE.md");
  fs.writeFileSync(file, lines.join("\n").replace(/\n+$/, "") + "\n");
  runCapture("git", ["config", "--global", "core.excludesFile", file]);
}

/** Register the Stop hook in the session's project settings. */
export function writeStopHookSettings(srcDir: string, hookScriptPath: string): void {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `node ${hookScriptPath}` }] }],
    },
  };
  const dir = path.join(srcDir, ".claude");
  mkdirp(dir);
  writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
}
