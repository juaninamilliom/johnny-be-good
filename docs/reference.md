# Configuration reference

Use the [README](../README.md) for the first run and the [HTTP example](../examples/http-app/README.md) for integration. Suites are YAML or JSON. Paths and adapter `cwd` resolve relative to the suite file.

## Exact assertions

| Assertion | Pass condition |
| --- | --- |
| `toolCalled: name` with optional `args`, `times` | Matching calls reach `min` and do not exceed `max`; default minimum is one, maximum unlimited |
| `toolNotCalled: name` | The recorded tool never ran |
| `toolOrder: [a, b]` | Recorded calls include this order; `strict: true` requires adjacency |
| `maxToolCalls`, `maxSteps`, `maxTokens`, `maxCostUsd` | Recorded facts remain inside the configured budget |
| `noToolErrors: true` | No recorded tool result is an error; `except: [tool]` excludes named tools |
| `final: <matcher>` | The final-answer text satisfies the matcher |
| `expectedFindings` | Structured findings match seeded expected findings within the configured location window and recall/false-positive limits |

A matcher is a literal string, number, boolean or null, or an object with `equals`, `contains`, `notContains`, `regex`, `oneOf`, `exists`, `gt`, `gte`, `lt`, or `lte`. Multiple object conditions must all hold. Argument matchers accept dot paths, such as `args: { "filters.0.field": status }`.

A token/tool budget evaluates the facts the app recorded. Missing instrumentation cannot establish that usage or activity was zero. `maxCostUsd` fails when trace cost is absent.

## Rubrics

| Kind | Configuration | Pass condition |
| --- | --- | --- |
| `noul` | `question`, optional `yes`, `no`, `pass` | Probability-style yes value reaches `pass` (default 0.5) |
| `score` | `question`, ordered `criteria`, `pass` | Returned expected score reaches `pass` |
| `choice` | `question`, named `criteria`, accepted `pass` labels | Chosen label is in `pass` |

Provide evidence/reference facts needed to answer the rubric. Judge values and confidence must be validated on representative labels; their names do not certify calibration or correctness.

## Judge configuration

```yaml
judges:
  jev:
    minConfidence: 0.6
    unsureBand: [0.3, 0.7]
    maxStateChars: 60000
  llm:
    provider: ollama
    model: llama3.1
    maxTraceChars: 40000
```

Jev joins when configured or when `TYPESAFE_API_KEY` is present. `jev: false` disables it. The LLM tier defaults to Ollama; `llm: false` disables it. `--no-judges` disables the cascade for a score/run action. A standalone calibration command needs judges to compare with labels; do not expect `--no-judges` to create a useful calibration experiment.

Trace text is rendered within a bounded budget. Clipping is not evidence that the missing context was irrelevant. Hosted providers receive the rendered content. Use explicit judge configuration for reproducible comparisons and privacy decisions.

## Live adapters

```yaml
adapter:
  kind: command
  command: node adapter.mjs
  timeoutMs: 35000
  cwd: .
```

The command is trusted executable configuration. The task arrives as stdin and `TRACECHECK_TASK`; case and run identifiers arrive as `TRACECHECK_CASE` and `TRACECHECK_RUN`. The legacy prefix remains compatible with the former Trace Check name. Write one native JSON trace to stdout and diagnostics to stderr.

Alternatively:

```yaml
adapter:
  kind: claude-code
  args: [--model, your-accessible-model]
  timeoutMs: 600000
```

This invokes the installed Claude Code CLI. Its authentication, provider charges, permissions and isolated test environment are separate from the evaluator. Never point an agent evaluation at production resources by accident.

## Native trace evidence

`src/trace/schema.ts` defines the schema; `src/suite.ts` defines configuration. A tool call has `type: tool_call`, `id`, `name`, `args`, and optional `result: { content, isError }`. A message has `type: message`, `role` and `text`. The trace's `final` field is the answer graded by final-answer matchers. `usage` can contain input, output and cache token counts and optional `costUsd`.

The HTTP example deliberately supplies empty steps for an answer-only endpoint. Add actual recorded calls/results/context when testing tools or grounding. An optional library interface exposes the same trace, suite, runner, assertion and judge contracts for in-process evaluation scripts.
