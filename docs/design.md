# Johnny Be Good: design

## Problem

Agent evals usually grade the final answer, often with a single LLM judge. That misses
three things that matter once an agent runs real tools:

1. **What the agent did.** A correct answer reached by calling a forbidden tool, or after
   twelve redundant searches, is a failure that answer grading cannot see.
2. **How sure the grade is.** One LLM judge gives one verdict with no confidence. It also
   costs the same on an obvious case as on a hard one.
3. **Reliability.** One passing run says little about the next one. Agents are
   nondeterministic, so evals need repeated runs and a metric that punishes flakiness.

## Model

Everything reads one normalized **trace**: a task, an ordered list of steps (messages and
tool calls with their results attached), a final answer, usage and cost. Importers
convert sources into it. The first importer reads Claude Code session transcripts and the
`claude -p` stream-json format with one parser, since both carry Messages API content
blocks. It counts usage once per message id, because transcripts repeat usage on every
content block of a message.

A **suite** lists cases. Each case has deterministic `expect` assertions and `rubric`
questions. A case run is `pass`, `fail`, `unjudged` or `error`.

## Decisions

### D1. Deterministic first

Counts, order, arguments, budgets and errors are read from the trace by code. Classifiers
and small LLMs are unreliable at counting and comparing numbers. The Jev documentation
lists arithmetic, counting and number comparison as known weaknesses. Code is free and
exact.

### D2. A confidence-routed cascade

Rubric questions go through tiers in order, and each tier sees only the questions the
earlier tiers left undecided.

- **Jev** answers every pending question for a trace in one call, with calibrated
  probabilities, at about $0.04 per million input tokens and with free output. A score or
  choice answer stands when its confidence reaches `minConfidence`. A yes/no answer stands
  when P(yes) falls outside `unsureBand`.
- **The LLM tier** answers whatever is left, with schema-constrained JSON output. Ollama is
  the default because it costs nothing. Anthropic is optional.

*Alternative:* one strong LLM judge for everything. It is simpler, but it pays full price
on easy questions and returns no confidence to act on.

*Cost:* two tiers to configure, and a threshold that needs calibrating. D4 addresses the
threshold.

### D3. Unjudged is a status

A question that no tier decides is `unjudged`. A tier that throws (no key, server down,
outage) is recorded with its error, and the cascade moves on. An undecided Jev answer with
no LLM tier behind it stays unjudged and keeps Jev's tentative value in the report. A
suite with only unjudged cases exits with code 2, which is distinct from pass (0) and fail
(1). In a baseline diff, a case that passed before and is unjudged now counts as a
regression, so a judge outage cannot hide a drop.

*Alternative:* treat a missing verdict as a pass, or retry until a verdict comes back.
Either one makes the report look complete when it is not.

### D4. Calibrate against people

`calibrate` asks every tier every labeled question with no cascade. It then replays the
cascade offline across a sweep of one strictness knob, s: the noul band is 0.5 ± s and the
minimum confidence is 0.5 + s. For each setting it reports how many questions Jev decides,
how accurate those decisions are, the cascade's accuracy, and the escalation rate. It
recommends the setting with the lowest escalation rate whose accuracy is within one point
of the best.

### D5. pass^k

Online mode runs each case k times. The summary reports pass@1 (the mean per-case pass
rate) and pass^k (the share of cases whose every run passed). The baseline diff flags a
case whose pass rate dropped, even if it was already failing.

### D6. The trace is data

Judges receive the trace as data. For Jev it is the `state` object with a note that its
contents are a recorded run. For the LLM tier it sits inside `<trace>` tags, with
`</trace>` neutralized inside the content and a system prompt that says to ignore
instructions found there. Long fields are clipped to a budget, and the clipping is marked
in the trace view. This reduces the risk from a tool result that tries to instruct the
grader. It does not eliminate it. Grade adversarial agents with assertions where you can.

### D7. Adapters never build shell strings from tasks

The `claude-code` adapter passes the task as an argument with no shell. The `command`
adapter runs a command the suite author wrote and hands it the task through
`TRACECHECK_TASK` and stdin.

## Testing

`npm run check` runs the TypeScript compiler and the Vitest suite. Judges are tested with
fake clients that implement the same interface: a fake `systemOne` for Jev and a fake
`fetch` for Ollama. One adapter test starts a real `node` subprocess to prove the task
travels through the environment.

## Limitations

- Claude Code is the only importer besides the native format.
- Calibration needs labels, and labels take a person's time. The tool cannot make
  that faster.
- The Jev price is configurable (`pricePerMillionInput`) because published prices change.
- The prompt-injection defense in D6 is a mitigation, untested against adversarial
  traces.
