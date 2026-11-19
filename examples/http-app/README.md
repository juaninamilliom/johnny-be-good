# Connect an HTTP application

Johnny Be Good runs outside your app. Its command adapter launches a bridge for each test; the bridge calls your API and prints a normalized trace. You must adapt the request/response mapping to your app's contract. `TRACECHECK_*` is the retained environment-variable prefix for compatibility with existing adapters.

## 1. Prove the wiring without an LLM

From the Johnny Be Good repository root, start the fictional endpoint:

```sh
node examples/http-app/demo-server.mjs
```

In another terminal, from the same repository root:

```sh
npm run --silent cli -- run examples/http-app/suite.yaml --no-judges --verbose
```

Both cases should pass. This checks the bridge, trace parsing and exact assertions. The endpoint returns hard-coded arithmetic answers and makes no model calls; it does not establish model quality. Stop it with Ctrl-C.

To test the failure path, stop it and restart it with deliberately wrong answers:

```sh
DEMO_WRONG_ANSWER=1 node examples/http-app/demo-server.mjs
```

Run the same evaluation again. Both cases should fail with exit code 1. Do not run two servers on the same port.

## 2. Point the bridge at your development app

The example API contract is:

```http
POST /evaluate
Content-Type: application/json

{"input":"What is 2 + 2? Reply with only the number."}
```

```json
{"answer":"4","steps":[],"model":"your-model-id","usage":{"inputTokens":12,"outputTokens":1}}
```

`answer` is required. `steps`, `model`, `usage` and `durationMs` are optional. Supplied steps must be native trace steps. Do not invent internal tool calls. Missing usage is not measured usage; the bridge records `meta.usageProvided: false`. The current trace schema supplies zero counters when usage is omitted, so zero counters alone do not prove zero billing.

Set the endpoint in the terminal running the evaluation:

```sh
export TRACECHECK_APP_URL="http://127.0.0.1:8000/your-test-endpoint"
```

If authentication is required, supply `TRACECHECK_APP_TOKEN` securely in that environment. Do not hard-code it into suites, traces or source. The bridge sends it as a Bearer token. This example reads process environment variables; it does not load `.env` automatically.

Open [adapter.mjs](adapter.mjs) and adapt `JSON.stringify({ input: task })` and `data.answer`. Streaming APIs and internal application functions need their own mapping; this is not automatic support for every protocol. Diagnostics go to stderr; exactly one native JSON trace goes to stdout.

## 3. Use meaningful application cases

Edit [suite.yaml](suite.yaml) with representative questions and correct expectations for your application. Exact comparisons fit exact-output tasks. Open-ended responses need rubrics and sufficient reference facts, rather than one required wording. Configure judges explicitly when adding rubric questions.

Run the same command. `--runs 3` makes three live calls per case. To save a report:

```sh
mkdir -p .johnny-be-good
npm run --silent cli -- run examples/http-app/suite.yaml --no-judges --out .johnny-be-good/http-results.json
```

The demo disables judges. Your actual app can still call a paid model when judges are off. Tool-use, retrieval, grounding and token checks require corresponding evidence from your app; an answer-only endpoint does not reveal hidden internal actions.

For saved-response scoring, use [offline.yaml](offline.yaml):

```sh
npm run --silent cli -- score examples/http-app/offline.yaml --no-judges --verbose
```

One saved trace is deliberately wrong, so this exits 1. Replaying a saved response tests the evaluator against that response; it does not make a fresh call to the app.

## 4. Archive and replay actual app evidence

While the demo app or your development app is running:

```sh
npm run --silent cli -- run examples/http-app/suite.yaml --no-judges --target-version demo-v1 --artifacts .johnny-be-good/http-001
```

Use a new artifact directory; existing directories are refused. Stop the app, then:

```sh
npm run --silent cli -- replay .johnny-be-good/http-001 --no-judges
```

Replay grades archived normalized responses without calling the application. It does not prove the application would produce the same response again. Default replay does not call model judges; explicitly choosing a model can send saved evidence to that judge. Artifacts can contain private answers and tool payloads; capture/redact deliberately and do not commit them to a public repository.
