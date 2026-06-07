/**
 * Turn per-crash-group attributions into the round verdict (the submit gate).
 *
 * v1 gate: build must be green and a harness must exist; then ANY false-positive
 * group ⇒ dirty; any uncertain group ⇒ dirty (when treatUncertainAsDirty);
 * otherwise clean. Real-bug groups are good (the harness found a target bug).
 * Coverage is reported but not gated.
 */

import { AttributionVerdict, CoverageStats, CrashGroup, VerifierVerdict } from "../types";

export interface DecideArgs {
  groups: AttributionVerdict[];
  groupsMeta: CrashGroup[];
  coverage?: CoverageStats;
  treatUncertainAsDirty: boolean;
  round: number;
  buildFailed: boolean;
  hadHarness: boolean;
}

export function decideVerdict(a: DecideArgs): VerifierVerdict {
  const base = { groups: a.groups, coverage: a.coverage, round: a.round };

  if (a.buildFailed) {
    return { ...base, clean: false, reason: "build_failed", findings: "The harness build did not succeed (retcode != 0). Fix the build errors in build.sh / the harness source." };
  }
  if (!a.hadHarness) {
    return { ...base, clean: false, reason: "no_harness", findings: "No new harness binary was produced. Write a harness, install it into $OUT/, and record its name in new-harnesses.txt." };
  }

  const fp = a.groups.filter((g) => g.attribution === "false_positive");
  const unc = a.groups.filter((g) => g.attribution === "uncertain");

  if (fp.length > 0) {
    return { ...base, clean: false, reason: "false_positive", findings: composeFindings(a.groups, a.groupsMeta, a.coverage) };
  }
  if (unc.length > 0 && a.treatUncertainAsDirty) {
    return { ...base, clean: false, reason: "uncertain", findings: composeFindings(a.groups, a.groupsMeta, a.coverage) };
  }
  return { ...base, clean: true, reason: "ok", findings: composeFindings(a.groups, a.groupsMeta, a.coverage) };
}

function sigText(meta: CrashGroup | undefined): string {
  if (!meta) return "(unknown signature)";
  const top = meta.signature.topFrames[0];
  const where = top ? `${top.func}${top.file ? ` @ ${top.file}${top.line ? `:${top.line}` : ""}` : ""}` : "(no frames)";
  return `${meta.signature.errorType} in ${where}`;
}

export function composeFindings(
  groups: AttributionVerdict[],
  meta: CrashGroup[],
  coverage?: CoverageStats,
): string {
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const lines: string[] = [];

  if (coverage) {
    lines.push(`Coverage observed: ${coverage.edges} edges, ${coverage.features} features, corpus ${coverage.corpusSize}.`);
  }
  if (groups.length === 0) {
    lines.push("No crashes were found during fuzzing.");
    return lines.join("\n");
  }

  for (const g of groups) {
    const m = metaById.get(g.groupId);
    const tag =
      g.attribution === "false_positive"
        ? "FALSE POSITIVE (harness bug)"
        : g.attribution === "real_bug"
          ? "REAL BUG (target)"
          : "UNCERTAIN";
    lines.push("");
    lines.push(`- [${tag}] ${sigText(m)} (group ${g.groupId})`);
    lines.push(`  fix location: ${g.fixLocation}`);
    lines.push(`  why: ${g.explanation}`);
    if (g.suggestedFixDirection) lines.push(`  do: ${g.suggestedFixDirection}`);
  }
  return lines.join("\n");
}
