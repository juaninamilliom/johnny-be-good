import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
const cli = ["node_modules/vite-node/vite-node.mjs", "src/cli/main.ts"];
function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...cli, ...args], { env });
    let out = "", err = "";
    child.stdout.on("data", c => out += String(c)); child.stderr.on("data", c => err += String(c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI test timed out")); }, 10000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", status => { clearTimeout(timer); resolve({ status, out, err }); });
  });
}
describe("actual source CLI", () => {
  it("keeps JSON clean even with forced color and disabled judges", async () => {
    const r = await run(["score", "examples/weather/suite.yaml", "--no-judges", "--json", "--color", "always"]);
    expect(r.status).toBe(1); expect(r.err).toBe(""); expect(r.out).not.toContain("\x1b");
    const result = JSON.parse(r.out) as { summary: { failed: number }; judges: string[] };
    expect(result.summary.failed).toBe(1); expect(result.judges).toEqual([]);
  });
  it("rejects unsupported flags before a calibration could call a provider", async () => {
    const r = await run(["calibrate", "test/fixtures/labels/labels.yaml", "--no-judges"]);
    expect(r.status).toBe(1); expect(r.err).toContain("--no-judges is not supported by calibrate");
  });
  it("wires held-out labels, saved JSON and overlap rejection through a local fake judge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jbg-cli-"));
    for (const [id, final] of [["tune", "tuning response"], ["held", "different held-out response"]]) {
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ version: 1, id, steps: [], final }));
      await writeFile(join(dir, `${id}.yaml`), `rubrics:\n  - { id: answered, kind: noul, question: Did the agent answer? }\nitems:\n  - { trace: ${id}.json, labels: { answered: true } }\n`);
    }
    let calls = 0;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls++; res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: { content: JSON.stringify({ answers: [{ id: "answered", reason: "Synthetic fixture", verdict: "yes" }] }) }, prompt_eval_count: 200, eval_count: 5 }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env, TYPESAFE_API_KEY: "", OLLAMA_HOST: `http://127.0.0.1:${port}` };
    try {
      const args = ["calibrate", join(dir, "tune.yaml"), "--llm", "ollama", "--model", "fixture", "--json"];
      const output = join(dir, "report.json");
      const r = await run([...args, "--held-out", join(dir, "held.yaml"), "--out", output], env);
      expect(r.status, r.err).toBe(0);
      const report = JSON.parse(r.out) as { kind: string; validation: { agreement: number; questions: number } };
      expect(report.kind).toBe("held-out"); expect(report.validation.agreement).toBe(1); expect(report.validation.questions).toBe(1);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report); expect(calls).toBe(2);
      const overlap = await run([...args, "--held-out", join(dir, "tune.yaml")], env);
      expect(overlap.status).toBe(1); expect(overlap.err).toMatch(/overlap|duplicate/i); expect(calls).toBe(2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("validates a baseline before creating artifacts or starting a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jbg-baseline-"));
    await writeFile(join(dir, "bad.json"), JSON.stringify({cases: []}));
    const r = await run(["score", "examples/weather/suite.yaml", "--no-judges", "--baseline", join(dir, "bad.json"), "--artifacts", join(dir, "not-created")]);
    expect(r.status).toBe(1); expect(r.err).toContain("Baseline must be a nonempty evaluation report");
    await expect(readFile(join(dir, "not-created", "manifest.json"))).rejects.toThrow();
  });

  it("provides an easy npm source entry point without a build", async () => {
    const r = await exec("npm", ["run", "--silent", "cli", "--", "--help"], { timeout: 10000 });
    expect(r.stdout).toContain("Johnny Be Good"); expect(r.stdout).toContain("replay <experiment-dir>");
  });
});
