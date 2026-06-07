# Octarine

<img src="docs/octarine_core.png" alt="Octarine Core — Dota 2" align="right" width="92">

***Octarine*** is the color of magic — the eighth color of the spectrum (Discworld). In **Dota 2**, the
**Octarine Core** is an item that amplifies a spellcaster's abilities; *Octarine* does the same for an
LLM agent's spellcasting at **fuzz-driver generation**.

## How it works

Octarine is an [OSS-CRS](https://github.com/oss-crs) `harness-gen` CRS that **finds a project's attack
surfaces and writes a fuzz harness for each — then runs every harness and submits only the ones that hold
up.** A build-only generator ships any harness that *compiles*, so harnesses that misuse the API (crashes
that aren't real bugs) or barely touch the surface slip through. Octarine instead treats the job as a
bounded *exploration*: it maps the surfaces once, then works them one at a time behind two runtime gates.
(An *attack surface* is one or more APIs worth exercising with a single harness.)

```
survey ─▶ ledger: the project's attack surfaces, prioritized

then, for each surface — until the time / cost budget runs out:

    generate a harness for the surface
        │
        ├─ 1. VERIFY  (correctness): fuzz it; reject if a crash's real
        │             fix belongs in the harness (API misuse, not a real bug).
        │
        └─ 2. ASSESS  (only if correct): an independent judge — does the
                      harness actually exercise the surface?

    clears both  ⇒ submit it, mark the surface done
    fails either ⇒ feed the reason back, regenerate (up to a cap)
```

Two things keep the loop honest. The **ledger is the CRS's memory** — finished surfaces (done or failed)
are recorded, so work is never repeated and a run can pick up where an earlier one stopped. And the whole
exploration is **budgeted** by wall-time and LLM cost: when the budget runs out, the harnesses already
proven are kept and the rest is simply left for next time. Every step is snapshotted into a
self-contained HTML report as it happens, so even an interrupted run is fully reviewable.

It all runs in **one container** (`gcr.io/oss-fuzz-base/base-runner` + Node + Claude Code CLI + libCRS),
so the same process both *generates* a harness and *fuzzes* the ASAN binary it produces.

## Where it lives in the code

Reading the source? Here's where each part of the loop lives:

| Part of the loop | Code |
|---|---|
| Driven by OSS-CRS (build the target, run the CRS) | `oss-crs/` (`crs.yaml` + 3 Dockerfiles) · `bin/compile_target` · `bin/run_harness_gen` |
| Setup + the exploration loop | `src/orchestrator/` (`main` · `config` · `source` · `explore-loop`) |
| The LLM "spells" — survey / generate / assess / attribute | `src/agent/` (Claude-CLI roles + prompts) · `src/hooks/stop-gate.ts` (keeps one generation building-and-fixing) |
| The ledger (and cross-run memory) | `src/ledger/` |
| **VERIFY** — the correctness gate (fuzz → group crashes → attribute → verdict) | `src/verifier/` |
| The wall-time + cost budget | `src/verifier/budget.ts` |
| The HTML/JSON report + chat transcripts | `src/journal.ts` · `src/entry-html.ts` · `src/report.ts` · `src/transcript.ts` |
| libCRS bridge (build / submit-harness / download outputs) | `src/libcrs/` |

## Configuration

Every knob is optional — the defaults ship in `crs.yaml`; override per run in your compose's
`additional_env`.

| Var | Default | Meaning |
|---|---|---|
| `HARNESS_GEN_MAX_WALLTIME_SEC` | `0` | Whole-run wall-time cap, seconds (0 = unbounded) — the primary bound |
| `HARNESS_GEN_MAX_COST_USD` | `0` | Cumulative LLM-cost cap, USD (0 = none); a soft cap, checked between attempts |
| `HARNESS_GEN_FUZZ_SEC` | `180` | libFuzzer `-max_total_time` per harness |
| `HARNESS_GEN_GEN_TIMEOUT_SEC` | `0` | Cap on a single harness generation, seconds (0 = unbounded) — stops one slow surface from eating the run |
| `HARNESS_GEN_MAX_SURFACE_ATTEMPTS` | `5` | Max generate→verify→assess attempts before a surface is given up |
| `HARNESS_GEN_ANALYSIS_CONCURRENCY` | `3` | Concurrent crash-attribution sub-agents |
| `HARNESS_GEN_TREAT_UNCERTAIN_DIRTY` | `true` | Treat an `uncertain` crash as not-submittable (play it safe) |
| `HARNESS_GEN_FORK_JOBS` | `0` | libFuzzer `-fork` (0 = auto from CPUs) |

The framework injects the rest: paths (`HARNESS_GEN_WORK_DIR`, `HARNESS_GEN_SRC_DIR`, `OSS_CRS_LOG_DIR`)
and target metadata (`OSS_CRS_TARGET`, `FUZZING_LANGUAGE`, `SANITIZER`).

**LLM auth:** `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_*` to talk to Anthropic directly, or the OSS-CRS
LiteLLM proxy (`OSS_CRS_LLM_API_URL` + `OSS_CRS_LLM_API_KEY[_FILE]`) when one is configured.

## Outputs

A run produces two separate things — don't confuse them:

**1. What it submits to OSS-CRS** (the actual deliverable). Each time a surface clears *both* gates,
Octarine hands libCRS a complete harness project via `submit-harness`: an OSS-Fuzz-style `fuzz-proj/`
(harness source + `build.sh` + any seeds), plus the patched `target-source/` if the agent had to touch
the build. That is the only thing OSS-CRS consumes; `state.json` records how many were submitted.

**2. A local report** (for you, to inspect offline). Self-contained HTML+JSON under
`$OSS_CRS_LOG_DIR/report` (or `$HARNESS_GEN_WORK_DIR/report` locally) — `scp` it anywhere and open
`entry.html`; no server, no network. Agent conversations render as readable chat with the raw JSONL kept
beside each.

```
report/
├── entry.html                      the run, in execution order — start here
├── summary.md / summary.html       target/source, the surface table, counts
├── journal.json · run.jsonl · state.json     machine-readable run data
├── survey/transcript.{html,jsonl}  the Surveyor's conversation
├── ledger/                         the attack-surface ledger (md + rendered html)
├── _memory/                        snapshot of the ledger + confirmed harnesses
└── surface-<id>/
    ├── attempt-<n>/
    │   ├── conversation.{html,jsonl}             the generation agent
    │   ├── attribution-conversation.{html,jsonl} crash triage          (if it crashed)
    │   ├── assessment-conversation.{html,jsonl}  the sufficiency judge  (if it got that far)
    │   ├── generation.log · build-resp/ · verdict.json · {crash-groups,attributions,assessment}.json
    │   └── harness-<name>/  fuzz.log · coverage.json · crashes/ · crash-<id>.trace
    └── submitted/                   the harness sources that were submitted
```

## Cross-run resume

The ledger is keyed by `(project, source-hash)`, so in principle a later run can skip the survey and
continue the surfaces an earlier run left unfinished. That needs a store which persists between runs —
something OSS-CRS doesn't expose yet — so the path is **off by default** (`crs.yaml` sets
`IN_OSS_CRS_ENV`, which makes every run start fresh). It will be enabled once OSS-CRS gains first-class
cross-run persistence, tracked in [ossf/oss-crs#255](https://github.com/ossf/oss-crs/issues/255).

## Develop

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest — pure-logic unit tests (no Docker/LLM)
npm run build          # → dist/
```
