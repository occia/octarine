/**
 * The run state file (state.json): written only by the orchestrator for offline
 * analysis. Atomic writes keep any reader from seeing a half-written file.
 */

import { RunState } from "../types";
import { writeFileAtomic } from "../util/fs";

export function writeState(path: string, state: RunState, nowMs: number): void {
  state.updatedAtMs = nowMs;
  writeFileAtomic(path, JSON.stringify(state, null, 2));
}
