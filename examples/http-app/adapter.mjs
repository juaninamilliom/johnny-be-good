#!/usr/bin/env node
/** Example bridge: adapt this request/response mapping to your own application. */
import { randomUUID } from 'node:crypto';
class AdapterError extends Error {}
try {
  const endpoint = new URL(process.env.TRACECHECK_APP_URL || 'http://127.0.0.1:4318/evaluate');
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new AdapterError('App URL must use HTTP or HTTPS');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const task = Buffer.concat(chunks).toString('utf8').trim() || process.env.TRACECHECK_TASK;
  if (!task) throw new AdapterError('No task was supplied on stdin or TRACECHECK_TASK');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.TRACECHECK_APP_TOKEN ? { Authorization: `Bearer ${process.env.TRACECHECK_APP_TOKEN}` } : {}) },
    body: JSON.stringify({ input: task }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new AdapterError(`App returned HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.answer !== 'string') throw new AdapterError('App response needs a string answer field; adapt the response mapping');
  if (data.steps !== undefined && !Array.isArray(data.steps)) throw new AdapterError('Optional steps must be native trace steps');
  process.stdout.write(`${JSON.stringify({
    version: 1, id: randomUUID(), task, source: { kind: 'example-http-app' },
    steps: data.steps || [], final: data.answer,
    ...(data.model ? { model: data.model } : {}), ...(data.usage ? { usage: data.usage } : {}),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    meta: { usageProvided: data.usage !== undefined },
  })}\n`);
} catch (error) {
  // Never print credentials, private endpoint URLs or app response bodies.
  console.error(`HTTP app adapter: ${error instanceof AdapterError ? error.message : 'Request, JSON parsing, or response mapping failed; check connectivity and the expected API contract'}`);
  process.exitCode = 1;
}
