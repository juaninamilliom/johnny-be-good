# Johnny Be Good: design spec

**Date:** 2026-11-16
**Status:** Approved

## Purpose

Johnny Be Good evaluates AI agents by what they did. It reads an agent run as a trace of tool
calls, tool results, messages, and a final answer. It scores the trace against a case
file with deterministic assertions first and a judge cascade for anything rules cannot
check. It reports pass rates, reliability across repeated runs (pass^k), cost, and
regressions against a saved baseline.

## Decisions

1. **TypeScript, ESM, Node 20+.** An npm package with a `johnny-be-good` CLI and a
   programmatic API.
2. **One normalized trace format.** Importers convert sources into it. The first
   importers read Claude Code session transcripts (JSONL) and the stream-json output of
   `claude -p`. A trace in the native format is accepted as-is.
3. **Deterministic assertions run first.** Tool called or forbidden, call counts,
   ordered subsequence of tools, argument matchers, step and token budgets, tool errors,
   and final-answer matchers. Counting and comparison never go to a model.
4. **Three-tier judge cascade for rubric questions.**
   - Tier 1: deterministic assertions (above).
   - Tier 2: Jev (TypeSafe System One). It answers `noul`, `score`, and `choice`
     questions with calibrated probabilities. Its answer stands when its confidence
     clears the threshold. A `noul` answer stands outside the unsure band (0.3 to 0.7
     by default).
   - Tier 3: an LLM judge. Ollama is the default and runs locally for free. Anthropic is
     optional.
   - Every verdict records the tier that decided it, the confidence, and the cost.
   - An unavailable tier is skipped and the skip is recorded. A rubric that no tier
     could answer is reported as `unjudged`. Unjudged counts against a pass.
5. **Judges treat the trace as data.** The trace goes to Jev as `state`. The LLM judge
   receives the trace inside delimited data tags with an instruction to ignore any
   instructions found there. Tool results are truncated to a budget.
6. **Two run modes.** Offline mode scores recorded traces. Online mode drives an agent
   through an adapter k times per case and reports pass@1 and pass^k. Adapters: a
   generic `command` adapter whose command prints a trace or stream-json, and a
   `claude-code` adapter that runs `claude -p` with stream-json output.
7. **Calibration.** `johnny-be-good calibrate` takes human-labeled rubric verdicts, runs
   each judge tier on them, and reports agreement per tier and the cascade's accuracy
   and escalation rate across a sweep of thresholds.
8. **Baselines and CI.** Results are written as JSON. `--baseline` compares a run with
   a saved result and lists regressions and fixes per case. The CLI exits non-zero on a
   failed case or a regression.
9. **The harness is the first real user.** `examples/harness-review` holds a small repo
   with seeded bugs and a case that scores a review's structured findings against the
   seeded list (recall, false positives) with an `expectedFindings` assertion.

## Out of scope for v1

- A web UI.
- Importers beyond Claude Code and the native format.
- Hosted storage of results.
