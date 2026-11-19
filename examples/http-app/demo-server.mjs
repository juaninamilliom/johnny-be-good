#!/usr/bin/env node
/** Deterministic fictional endpoint for checking wiring. No LLM or provider calls. */
import { createServer } from 'node:http';
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' || req.url !== '/evaluate') { res.writeHead(404).end(JSON.stringify({ error: 'Use POST /evaluate' })); return; }
  if (process.env.DEMO_MALFORMED_JSON === '1') { res.end('private-response-sentinel-not-json'); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error('Request too large'); }
    const { input } = JSON.parse(body);
    if (typeof input !== 'string') throw new Error('input must be a string');
    const answers = { 'What is 2 + 2? Reply with only the number.': '4', 'What is 3 + 3? Reply with only the number.': '6' };
    const answer = process.env.DEMO_WRONG_ANSWER === '1' ? 'wrong' : Object.hasOwn(answers, input) ? answers[input] : undefined;
    if (answer === undefined) { res.writeHead(400).end(JSON.stringify({ error: 'Unknown demo task' })); return; }
    res.end(JSON.stringify({ answer, steps: [], model: 'deterministic-demo-not-an-llm', usage: { inputTokens: 0, outputTokens: 0 } }));
  } catch { res.writeHead(400).end(JSON.stringify({ error: 'Invalid demo request' })); }
});
server.on('error', () => { console.error('Demo server could not start; check the local port and permissions.'); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => {
  console.error(`Fictional demo app listening on http://127.0.0.1:${server.address().port}/evaluate; no LLM calls`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
