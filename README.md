# tracecheck

[![CI](https://github.com/juaninamilliom/tracecheck/actions/workflows/ci.yml/badge.svg)](https://github.com/juaninamilliom/tracecheck/actions/workflows/ci.yml)

Evaluate AI agents by what they did. tracecheck reads an agent run as a trace of tool
calls, tool results, messages and a final answer. It checks the trace with deterministic
assertions first. Questions that need judgment go to a judge cascade, and a cheap
calibrated classifier answers the ones it is sure about. Only the unsure ones reach an LLM.

```
$ tracecheck score examples/weather/suite.yaml --model qwen2.5vl:7b
tracecheck · weather-agent · offline · judges: ollama:qwen2.5vl:7b

✗ lisbon  1/2 runs
    run 2: ✗ toolCalled get_weather with args 1..1× — 0 matching call(s), expected 1..1; tools called: search_web

0/1 cases passed · 1 failed
pass@1 50% · pass^2 0% over 2 runs
rubric: 4 questions · decided by ollama:qwen2.5vl:7b 4
cost: agent 690 tokens · judges $0.00000
```

## Why

- **Counting goes to code.** Which tools ran, in what order, with what arguments, how many
  steps, how many tokens: these are facts in the trace. A model asked to count them can
  get them wrong, so tracecheck checks them directly.
- **Judges escalate by confidence.** Rubric questions go to Jev first
  ([TypeSafe](https://docs.typesafe.ai/)), which returns calibrated probabilities for
  about $0.04 per million input tokens. An answer stands when its confidence clears the
  threshold. The rest escalate to an LLM judge, which is a local Ollama model by default
  or Claude if configured. Every verdict records which tier decided it.
- **Judges get measured.** `tracecheck calibrate` runs every tier on human-labeled
  questions and tells you how often each one agrees with people. It also shows the
  cheapest threshold that keeps the cascade's accuracy.
- **Reliability is a number.** Online mode runs each case k times and reports pass^k,
  the share of cases that pass every run. An agent that passes 80% of single runs can
  pass far fewer cases three times in a row.
- **Failures are visible.** A question no judge could answer is `unjudged`. It never
  counts as a pass. A judge outage shows up in the report and in the baseline diff.

## Install

tracecheck is not on npm yet. Install it from GitHub:

```bash
npm install -g github:juaninamilliom/tracecheck
ollama pull llama3.1      # optional: the default local LLM judge
```

The Jev and Anthropic SDKs are optional dependencies and install with it. Set
`TYPESAFE_API_KEY` to turn on the Jev tier, and `ANTHROPIC_API_KEY` (or an `ant auth login`
profile) to use `--llm anthropic`. Node 20 or newer.

## Status

Version 0.1. What has run for real, and what has not:

- The importer was checked against a real 616-call Claude Code session. Its tool-call,
  result, error and token counts matched a `jq` count of the transcript.
- The Ollama judge has run live with a local model, including on that session, with the
  trace held to the judge's budget.
- The Jev and Anthropic judges are tested against fake clients that implement their SDK
  interfaces. Neither has been called live yet.
- The online `harness-review` example has not been run yet. Its scoring is tested on a
  hand-written sample.

## Quickstart

Convert a Claude Code session into a trace, or score recorded runs directly:

```bash
tracecheck import ~/.claude/projects/<project>/<session>.jsonl --out trace.json
tracecheck score examples/weather/suite.yaml
```

A suite:

```yaml
suite: weather-agent
judges:
  llm: { provider: ollama, model: llama3.1 }   # Jev joins first when TYPESAFE_API_KEY is set
defaults:
  expect:
    - maxToolCalls: 5
    - noToolErrors: true
cases:
  - id: lisbon
    task: What is the weather in Lisbon?
    traces: [traces/good.jsonl, traces/wrong-tool.jsonl]   # offline: recorded runs
    expect:
      - toolCalled: get_weather
        args: { city: Lisbon }
        times: { max: 1 }
      - toolNotCalled: send_email
      - final: { regex: "\\d+°F" }
    rubric:
      - id: answers-the-question
        kind: noul
        question: Does the final answer tell the user the current weather in the city they asked about?
      - id: grounded
        kind: score
        question: Is every fact in the final answer supported by a tool result in the run?
        criteria: [States facts no tool returned, Mostly supported, Every fact comes from a tool result]
        pass: 1.5
```

## Commands

| Command | What it does |
|---|---|
| `tracecheck score <suite>` | Scores recorded traces (`trace:` or `traces:` per case) |
| `tracecheck run <suite> --runs 3` | Runs the agent through the suite's `adapter` and scores each run |
| `tracecheck import <file>` | Converts a Claude Code transcript or `claude -p` stream-json to a trace |
| `tracecheck calibrate <labels>` | Measures each judge tier against human labels and sweeps the thresholds |

Useful flags: `--baseline results.json` (regressions fail the run), `--out results.json`,
`--only a,b`, `--no-judges`, `--llm anthropic`, `--model <name>`, `--json`, `--verbose`.

Exit codes: `0` all passed, `1` a failure, error or regression, `2` only unjudged cases
kept the suite from passing.

## Assertions

| Assertion | Passes when |
|---|---|
| `toolCalled: name` + `args`, `times` | The tool was called with matching arguments, `min..max` times (default at least once) |
| `toolNotCalled: name` | The tool never ran |
| `toolOrder: [a, b, c]` (+ `strict`) | The tools ran in this order, with other calls allowed between them (adjacent when strict) |
| `maxToolCalls`, `maxSteps`, `maxTokens`, `maxCostUsd` | The run stayed within the budget |
| `noToolErrors: true` (+ `except`) | No tool result was an error |
| `final: <matcher>` | The final answer matches |
| `expectedFindings` | Structured findings in the final answer match a list of seeded ones (recall, false positives) |

A matcher is a literal (equals) or an object with any of `equals`, `contains`,
`notContains`, `regex`, `oneOf`, `exists`, `gt`, `gte`, `lt`, `lte`. Argument matchers take
dot paths: `args: { "filters.0.field": status }`.

## Rubric questions

| Kind | Answer | Passes when |
|---|---|---|
| `noul` | P(yes) | P(yes) ≥ `pass` (default 0.5) |
| `score` | Expected score on `criteria`, lowest first | score ≥ `pass` |
| `choice` | One label from `criteria` | the label is in `pass` |

Jev settings (`judges.jev`): `minConfidence` (default 0.6) for score and choice, and
`unsureBand` (default `[0.3, 0.7]`) for noul. An answer inside the band escalates.
`jev: false` or `llm: false` turns a tier off.

Two notes from TypeSafe's [limitations page](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md):
Jev's score levels are weakly calibrated as numbers, so prefer `noul` and `choice` where a
question allows it. Jev also favors the first option in a `choice`, so calibrate any choice
question before trusting it.

Judges see the trace as data. Long fields are clipped, and the clipping is marked. The LLM
judge's prompt puts the run inside `<trace>` tags and tells it to ignore instructions it
finds there. That lowers the risk from a tool result that tries to instruct the grader, but
it does not remove it.

## Calibration

```yaml
# labels.yaml: a person read each trace and decided each question
rubrics:
  - { id: answered, kind: noul, question: Did the agent answer the question? }
items:
  - { trace: traces/run1.json, labels: { answered: true } }
  - { trace: traces/run2.json, labels: { answered: false } }
```

Output on the ten-item fixture in `test/calibrate.test.ts`, where the fallback judge is
always right:

```
$ tracecheck calibrate labels.yaml
strictness  jev decides  jev accuracy  cascade accuracy  escalated
      0.00           10           80%               80%         0%
      0.10            8           88%               90%        20%
      0.15            6          100%              100%        40%

recommended: strictness 0.15 → jev: { minConfidence: 0.65, unsureBand: [0.35, 0.65] }
```

## Online mode

```yaml
adapter:
  kind: claude-code            # runs: claude -p <task> --output-format stream-json --verbose
  args: [--model, claude-sonnet-5-5]
# or
adapter:
  kind: command
  command: ./run-my-agent.sh   # gets the task in $TRACECHECK_TASK and on stdin; prints a trace
```

The task is never put into a shell string. A command prints either a native trace (JSON
with a `steps` array) or Claude Code stream-json.

## Example: scoring a code review

`examples/harness-review` seeds three bugs (an off-by-one, a null dereference, a missing
`await`) in a throwaway repo and scores a review's findings against them. It was built to
measure [agent-harness](https://github.com/juaninamilliom/agent-harness-configs) review
workflows:

```bash
tracecheck score examples/harness-review/suite.yaml          # the hand-written sample
tracecheck run examples/harness-review/suite.yaml --runs 3   # three live reviews
```

## Library use

```ts
import { loadSuite, runSuite, recordedTraces, judgesFromConfig, formatResult } from "tracecheck";

const suite = await loadSuite("suite.yaml");
const result = await runSuite(suite, { provider: recordedTraces("."), mode: "offline", judges: judgesFromConfig(suite.judges) });
console.log(formatResult(result));
```

A `Judge` is one method, `judge(trace, rubrics)`, so another backend can be added without
touching the cascade.

## Design

[docs/design.md](docs/design.md) covers the trace model, the cascade and its failure
rules, calibration, and the tradeoffs.

## License

MIT
