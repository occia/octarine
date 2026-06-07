/**
 * Claude Code Stop hook: the cheap presubmit gate. It refuses to let the
 * generation agent finish until its build is green (read from the build
 * response dir). The heavy fuzzing verifier runs in the orchestrator, not here.
 *
 * Invoked as `node stop-gate.js`; the Stop event JSON arrives on stdin and
 * HARNESS_GEN_BUILD_RESP points at the agent's build response dir. To block we
 * print {"decision":"block","reason":...} and exit 0; to allow we print {} exit 0.
 */

import * as path from "path";
import { readFileOr } from "../util/fs";

export interface StopGateInput {
  /** true when the agent is already continuing due to a prior block (loop guard). */
  stopHookActive: boolean;
  /** Build exit code, or null if no build response is present yet. */
  buildRetcode: number | null;
}

export function decideStopGate(i: StopGateInput): { block: boolean; reason?: string } {
  // Re-entrancy guard: never block twice in a row (avoids stop-hook loops).
  if (i.stopHookActive) return { block: false };
  if (i.buildRetcode === 0) return { block: false };
  return {
    block: true,
    reason:
      "Your harness build is not green yet. Run `libCRS build-project --response-dir " +
      "$HARNESS_GEN_BUILD_RESP --fuzz-proj-dir <harness>/fuzz-proj` until retcode is 0, then finish.",
  };
}

function readBuildRetcode(buildResp: string): number | null {
  const raw = readFileOr(path.join(buildResp, "retcode"), "").trim();
  if (raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let stopHookActive = false;
  try {
    const raw = await readStdin();
    const evt = JSON.parse(raw) as { stop_hook_active?: boolean };
    stopHookActive = evt.stop_hook_active === true;
  } catch {
    // Malformed/empty stdin → treat as not-active; still apply the build gate.
  }

  const buildResp = process.env.HARNESS_GEN_BUILD_RESP;
  // No build dir configured ⇒ never wedge the session.
  const buildRetcode = buildResp ? readBuildRetcode(buildResp) : 0;

  const decision = decideStopGate({ stopHookActive, buildRetcode });
  process.stdout.write(decision.block ? JSON.stringify({ decision: "block", reason: decision.reason }) : "{}");
  process.exit(0);
}

// Only run when executed directly (not when imported by a test).
if (require.main === module) {
  void main();
}
