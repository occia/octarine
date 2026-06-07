/** Deduplicate crash signatures into groups keyed by error type + top frames. */

import { createHash } from "crypto";
import { CrashGroup, CrashSignature } from "../types";

/** Stable key: error type + up to the top 3 meaningful frames. */
export function signatureKey(sig: CrashSignature): string {
  const frames = sig.topFrames.slice(0, 3).map((f) => `${f.func}@${f.file ?? "?"}`);
  return [sig.errorType, ...frames].join("|");
}

export function groupId(sig: CrashSignature): string {
  return createHash("sha1").update(signatureKey(sig)).digest("hex").slice(0, 12);
}

export interface CrashItem {
  sig: CrashSignature;
  artifact: string;
  tsMs: number;
}

export function groupCrashes(items: CrashItem[]): CrashGroup[] {
  const byId = new Map<string, CrashGroup>();
  for (const it of items) {
    const id = groupId(it.sig);
    const existing = byId.get(id);
    if (existing) {
      existing.artifacts.push(it.artifact);
      existing.firstSeenMs = Math.min(existing.firstSeenMs, it.tsMs);
    } else {
      byId.set(id, { id, signature: it.sig, artifacts: [it.artifact], firstSeenMs: it.tsMs });
    }
  }
  return [...byId.values()].sort((a, b) => a.firstSeenMs - b.firstSeenMs);
}
