/**
 * Prompts for the two Claude roles:
 *  - the generation agent (writes a harness, drives it to a green build)
 *  - the analysis sub-agent (root-causes one crash group and attributes it)
 *
 * First principles run through both: the goal is a *correct* harness for one
 * chosen API, exercising it the way a real caller would, honoring its contract.
 * A crash that only happens because the harness misuses the API is a false
 * positive — the fix belongs in the harness, and such a harness is not submitted.
 */

import { Config, AttackSurface, CoverageStats } from "../types";

/** CLAUDE.md written into the session cwd; auto-loaded by `claude -p`. */
export function renderClaudeMd(c: Config): string {
  const { paths } = c;
  return `# Harness Generation Agent

You are an expert fuzzing engineer writing a NEW coverage-maximizing fuzzing harness for the
OSS-Fuzz project \`${c.target}\` (language: ${c.language}, sanitizer: ${c.sanitizer}).

## First principles (read first)

- A good harness exercises ONE target API the way a real caller would, honoring its documented
  contract and preconditions (valid initialization, ownership, sizes, lifetimes).
- After you finish, the harness is automatically fuzzed. Every crash is root-caused. A crash whose
  natural fix is in YOUR HARNESS (because the harness violated the API contract) is a FALSE POSITIVE
  and the harness will be rejected — not submitted. A crash whose fix is in the target library is a
  real bug and is good.
- So: do not "make crashes go away" by weakening checks; make the harness USE THE API CORRECTLY.

## Workflow

1. Download the OSS-Fuzz project into your working dir, which is also the final submission dir:
   \`libCRS download-source fuzz-proj ${paths.harness}/fuzz-proj\`
2. Download the upstream source for exploration:
   \`libCRS download-source target-source ${paths.agent}/target-src\`
3. The SPECIFIC attack surface to target (the API(s)) is given in the task message. Read
   \`build.sh\` and the existing harness sources to understand the build, and read the relevant
   public headers/sources for the target API(s) to learn how a real caller drives them.
4. Write the new harness source file(s) under \`${paths.harness}/fuzz-proj\` and edit its
   \`build.sh\` to compile each new harness and install the binary into \`$OUT/\`.
5. Build (iterate until it succeeds):
   \`libCRS build-project --response-dir ${paths.buildResp} --fuzz-proj-dir ${paths.harness}/fuzz-proj\`
   Check \`${paths.buildResp}/retcode\` (0 = success) and read \`${paths.buildResp}/stderr.log\` on failure.
   You may rebuild as many times as needed.
6. Write the name(s) of the new harness binary(ies) you installed into \`$OUT/\`, one per line, to:
   \`${paths.agent}/new-harnesses.txt\`
7. (Only if you had to modify the upstream source) put the COMPLETE modified source tree at
   \`${paths.harness}/target-source\` and add \`--target-source-dir ${paths.harness}/target-source\`
   to your build-project command. Omit it entirely otherwise.

## Rules

- Build directly in \`${paths.harness}/fuzz-proj\` — it must contain ALL original fuzz-proj files
  plus your new harness source(s). Do not submit anything yourself; the orchestrator submits only
  after verification passes.
- You cannot finish until your final build is green: always build with
  \`--response-dir ${paths.buildResp}\`.
- Keep the harness deterministic and free of undefined behavior of its own (no uninitialized reads,
  no out-of-bounds on harness-owned buffers, correct \`LLVMFuzzerTestOneInput\` signature).
`;
}

/** Task message piped to the generation agent: target ONE attack surface, with prior feedback. */
export function surfacePrompt(c: Config, s: AttackSurface, feedback: string): string {
  const lines = [
    `Write a fuzzing harness for ONE specific attack surface of \`${c.target}\` (${c.language}, ${c.sanitizer}).`,
    ``,
    `Attack surface: ${s.title}`,
    `Target API(s): ${s.apis.join(", ")}`,
  ];
  if (s.rationale) lines.push(`Why this surface: ${s.rationale}`);
  lines.push(``);
  if (feedback.trim()) {
    lines.push(
      `This is a follow-up attempt. Feedback on the previous harness:`,
      feedback,
      ``,
      `Address it: if it was a false-positive crash, fix the API misuse; if the surface was not explored`,
      `thoroughly enough, improve how the harness drives these APIs.`,
    );
  } else {
    lines.push(`This is the first attempt for this surface.`);
  }
  lines.push(
    ``,
    `Follow CLAUDE.md for the full workflow (download, write into fuzz-proj, build green via build-project,`,
    `write ${c.paths.agent}/new-harnesses.txt). Exercise the API the way a real caller would — a crash from`,
    `harness misuse is a false positive and will be rejected.`,
  );
  return lines.join("\n");
}

/** JSON schema for the Surveyor agent's attack-surface map. */
export const SURVEY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    surfaces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "stable short kebab-case id" },
          title: { type: "string" },
          apis: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          priority: { type: "number", description: "1-10, higher = fuzz sooner" },
          coveredByExisting: { type: "boolean", description: "an existing harness already exercises this surface" },
        },
        required: ["id", "title", "apis", "rationale", "priority", "coveredByExisting"],
      },
    },
  },
  required: ["surfaces"],
};

/** Task message for the Surveyor: map the project's attack surfaces into the ledger. */
export function surveyPrompt(c: Config, existingLedger: string): string {
  return [
    `You are mapping the ATTACK SURFACE of the OSS-Fuzz project \`${c.target}\` (${c.language}) for fuzzing.`,
    `An "attack surface" = one or more public APIs that make sense to exercise with a SINGLE fuzz harness`,
    `(a parser/decoder/reader that consumes untrusted input, or a small family of related entry points).`,
    ``,
    `Explore the target source under \`${c.paths.src}\` and the existing fuzz harnesses (read build.sh and the`,
    `*fuzz*.c/.cc files). Then enumerate attack surfaces:`,
    `- coveredByExisting=true for surfaces an existing harness already exercises;`,
    `- propose the remaining promising surfaces (coveredByExisting=false) with priority (1-10) + short rationale;`,
    `- give each a stable short kebab-case id and the concrete API names.`,
    ``,
    existingLedger.trim()
      ? `A ledger from a prior run is below — REUSE its ids for the same surfaces, do NOT re-propose ones already\nmarked done/failed, and add only what is new or still pending:\n\n${existingLedger}`
      : `No prior ledger exists; produce the initial map.`,
    ``,
    `Return ONLY the JSON.`,
  ].join("\n");
}

/** JSON schema for the Assessor agent's sufficiency verdict. */
export const ASSESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sufficient: { type: "boolean" },
    reasoning: { type: "string" },
    feedback: { type: "string", description: "if not sufficient, concrete improvement direction for the harness" },
  },
  required: ["sufficient", "reasoning"],
};

/** Task message for the Assessor: does this (correct) harness sufficiently explore the surface? */
export function assessmentPrompt(args: {
  target: string;
  surfaceTitle: string;
  apis: string[];
  harnessName: string;
  harnessSourceDir: string;
  targetSourceDir: string;
  fuzzLogPath: string;
  coverage: CoverageStats;
}): string {
  return `You are judging whether a fuzz harness *sufficiently explores* one attack surface of the OSS-Fuzz
project \`${args.target}\`. This is an agentic, first-principles judgment — there is no single metric. The
question: can a fuzzer driven by this harness thoroughly exercise this attack surface?

Attack surface: ${args.surfaceTitle}
APIs: ${args.apis.join(", ")}
Harness binary: \`${args.harnessName}\`

Method (use your tools):
1. Read the harness source under \`${args.harnessSourceDir}\` — does it drive these APIs the way a real caller
   would, feeding fuzzer bytes into the meaningful inputs (not hardcoding or short-circuiting them)?
2. Read the relevant target source under \`${args.targetSourceDir}\` — what input space / branches should a
   thorough harness reach? Is a major part of the surface left unreachable as written?
3. Read the fuzz run log at \`${args.fuzzLogPath}\` and weigh coverage: edges=${args.coverage.edges},
   features=${args.coverage.features}, corpus=${args.coverage.corpusSize}. Did coverage grow then plateau in a
   way consistent with the surface being explored, or does it look stuck/shallow?

Decide: sufficient=true if a fuzzer driven by this harness can thoroughly explore this attack surface.
Otherwise sufficient=false with concrete \`feedback\` on what to change in the harness (e.g. drive an uncovered
entry point, vary a mode/flag, stop discarding part of the input). Return ONLY the JSON verdict.`;
}

/** JSON schema enforced on the analysis sub-agent's structured output. */
export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attribution: { type: "string", enum: ["false_positive", "real_bug", "uncertain"] },
    fixLocation: { type: "string", enum: ["harness", "target", "none"] },
    explanation: { type: "string" },
    suggestedFixDirection: { type: "string" },
  },
  required: ["attribution", "fixLocation", "explanation"],
};

/** Prompt for one crash group's root-cause + attribution sub-agent. */
export function analysisPrompt(args: {
  target: string;
  harnessName: string;
  harnessSourceDir: string;
  targetSourceDir: string;
  crashInputPath: string;
  asanTrace: string;
}): string {
  return `You are triaging a crash found while fuzzing a NEWLY WRITTEN fuzzing harness for the
OSS-Fuzz project \`${args.target}\`. Decide whether this crash is a real bug in the target library
or a FALSE POSITIVE caused by the harness misusing the API.

First principles: a correct harness must call the API the way real callers do, honoring its
documented contract and preconditions. If the crash only happens because the harness violates a
precondition (passes a NULL/!valid pointer the API forbids, an unterminated or wrongly-sized
buffer, wrong initialization order, reuses freed state, lies about lengths), then the root cause is
in the HARNESS and this is a false positive. If the crash reproduces under valid, contract-honoring
API usage, the root cause is in the TARGET source and this is a real bug.

Method:
1. Read the harness source (harness binary name: \`${args.harnessName}\`) under \`${args.harnessSourceDir}\`.
2. Read the relevant target source under \`${args.targetSourceDir}\` (follow the frames in the trace).
3. Determine where the MINIMAL natural fix belongs. Sketch it mentally — if the fix edits the
   harness, set fixLocation="harness" (false_positive). If it edits the target source,
   set fixLocation="target" (real_bug). If you cannot tell, use "uncertain".

Crash input file: \`${args.crashInputPath}\`

Sanitizer trace:
\`\`\`
${args.asanTrace}
\`\`\`

Return ONLY the JSON verdict. In "suggestedFixDirection", give one concrete sentence the harness
author can act on (what to change in the harness, or — if real_bug — confirm the harness is correct).`;
}
