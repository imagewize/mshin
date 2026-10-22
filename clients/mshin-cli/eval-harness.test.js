import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvalHarness, loadConfig, writeReport, normalizeFormat, behaviourVerdict } from "./eval-harness.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix = "mshin-eval-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function configFile(dir, contents) {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** A result row with sensible defaults, for tests about report rendering. */
function makeResult(overrides = {}) {
  return {
    model: "mshin",
    case: "scan",
    prompt: "scan it",
    success: true,
    error: null,
    durationMs: 100,
    steps: 1,
    maxSteps: 25,
    toolCallCount: 1,
    narratedToolCallCount: 0,
    fabricatedOutputsBlocked: 0,
    approvalRequests: 0,
    approvalGranted: 0,
    approvalDenied: 0,
    contextHighWaterTokens: 120,
    nonRetryableToolErrors: 0,
    blockedToolRetries: 0,
    errors: 0,
    finalAnswer: "done",
    expectedTools: null,
    missingTools: [],
    expectedToolsMet: null,
    behaviourPass: null,
    ...overrides,
  };
}

/** Stand-in agent that replays a scripted interaction. */
class MockAgent {
  constructor(behaviour) {
    this.behaviour = behaviour;
    this.metrics = {
      toolCalls: 0,
      narratedToolCalls: 0,
      fabricatedOutputsBlocked: 0,
      approvalRequests: 0,
      approvalGranted: 0,
      approvalDenied: 0,
      contextHighWaterTokens: 0,
      nonRetryableToolErrors: 0,
      blockedToolRetries: 0,
      steps: 0,
      errors: 0,
    };
  }

  async run({ onToolCall, onToolResult, onNarratedToolCall, onApproval, onComplete }) {
    const steps = this.behaviour.steps || [];

    for (const step of steps) {
      this.metrics.steps++;

      if (step.tool) {
        this.metrics.toolCalls++;
        onToolCall(step.tool.name, step.tool.args);
        onToolResult(step.tool.name, step.tool.result);
      }

      if (step.narrated) {
        this.metrics.narratedToolCalls++;
        onNarratedToolCall(step.narrated);
      }

      if (step.activeTool) {
        this.metrics.approvalRequests++;
        const approved = await onApproval(step.activeTool.name, step.activeTool.args);
        if (!approved) {
          this.metrics.approvalDenied++;
          continue;
        }
        this.metrics.approvalGranted++;
        this.metrics.toolCalls++;
        onToolCall(step.activeTool.name, step.activeTool.args);
        onToolResult(step.activeTool.name, step.activeTool.result || "ok");
      }

      if (step.fabricated) {
        this.metrics.fabricatedOutputsBlocked++;
        const warning = "The model produced output that looks like a tool result, but no tool executed.";
        onComplete(warning);
        return warning;
      }
    }

    if (this.behaviour.contextHighWaterTokens) {
      this.metrics.contextHighWaterTokens = this.behaviour.contextHighWaterTokens;
    }

    const answer = this.behaviour.answer || "done";
    onComplete(answer);
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

test("loadConfig rejects a config with no cases", () => {
  const dir = makeTempDir();
  const path = configFile(dir, { models: ["mshin"] });
  assert.throws(() => loadConfig(path), /cases/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig rejects a case missing a prompt", () => {
  const dir = makeTempDir();
  const path = configFile(dir, { cases: [{ name: "bad" }] });
  assert.throws(() => loadConfig(path), /prompt/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig normalizes a single model string into an array", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    model: "mistral-small",
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const config = loadConfig(path);
  assert.deepEqual(config.models, ["mistral-small"]);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig defaults backend, apiBase and nodeUrl", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const config = loadConfig(path);
  assert.equal(config.backend, "ollama");
  assert.equal(config.apiBase, "http://localhost:11434");
  // Backwards-compatible alias retained for existing configs.
  assert.equal(config.ollamaUrl, "http://localhost:11434");
  assert.equal(config.nodeUrl, "http://192.168.1.100:3000");
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig reads nodeToken from the config file", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    nodeToken: "from-config",
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const config = loadConfig(path);
  assert.equal(config.nodeToken, "from-config");
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig falls back to MSHIN_NODE_TOKEN, then null", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const saved = process.env.MSHIN_NODE_TOKEN;
  try {
    process.env.MSHIN_NODE_TOKEN = "from-env";
    assert.equal(loadConfig(path).nodeToken, "from-env");
    delete process.env.MSHIN_NODE_TOKEN;
    assert.equal(loadConfig(path).nodeToken, null);
  } finally {
    if (saved !== undefined) process.env.MSHIN_NODE_TOKEN = saved;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig prefers the config file's nodeToken over the environment", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    nodeToken: "from-config",
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const saved = process.env.MSHIN_NODE_TOKEN;
  try {
    process.env.MSHIN_NODE_TOKEN = "from-env";
    assert.equal(loadConfig(path).nodeToken, "from-config");
  } finally {
    if (saved !== undefined) process.env.MSHIN_NODE_TOKEN = saved;
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness execution
// ---------------------------------------------------------------------------

test("harness records metrics for a single tool call", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({
        steps: [{ tool: { name: "nmap", args: { target: "127.0.0.1" }, result: "22/tcp open ssh" } }],
        answer: "SSH is open.",
      }),
      sessionId: "s1",
    }),
  });

  const results = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "scan", prompt: "scan localhost" }],
  });

  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.model, "mshin");
  assert.equal(r.case, "scan");
  assert.equal(r.success, true);
  assert.equal(r.steps, 1);
  assert.equal(r.toolCallCount, 1);
  assert.equal(r.toolCalls[0].name, "nmap");
  assert.equal(r.finalAnswer, "SSH is open.");
  rmSync(dir, { recursive: true, force: true });
});

test("harness runs every model against every case", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({ answer: "ok" }),
      sessionId: "s1",
    }),
  });

  const results = await harness.runSuite({
    models: ["a", "b"],
    cases: [{ name: "x", prompt: "p" }, { name: "y", prompt: "q" }],
  });

  assert.equal(results.length, 4);
  assert.ok(results.some((r) => r.model === "a" && r.case === "x"));
  assert.ok(results.some((r) => r.model === "a" && r.case === "y"));
  assert.ok(results.some((r) => r.model === "b" && r.case === "x"));
  assert.ok(results.some((r) => r.model === "b" && r.case === "y"));
  rmSync(dir, { recursive: true, force: true });
});

test("harness captures narrated calls, fabricated output, and approvals", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({
        steps: [
          { narrated: "nmap" },
          { tool: { name: "nmap", args: { target: "x" }, result: "ok" } },
          { activeTool: { name: "metasploit", args: { module: "exploit/x" } } },
        ],
        answer: "finished",
      }),
      sessionId: "s1",
    }),
  });

  const results = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "full-run", prompt: "do it", approveActiveTools: true }],
  });

  const r = results[0];
  assert.equal(r.narratedToolCallCount, 1);
  assert.equal(r.approvalRequests, 1);
  assert.equal(r.approvalGranted, 1);
  assert.equal(r.approvalDenied, 0);
  assert.equal(r.toolCallCount, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("harness marks failures and records error messages", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: {
        metrics: {
          toolCalls: 0,
          narratedToolCalls: 0,
          fabricatedOutputsBlocked: 0,
          approvalRequests: 0,
          approvalGranted: 0,
          approvalDenied: 0,
          contextHighWaterTokens: 0,
          steps: 0,
          errors: 1,
        },
        run: () => Promise.reject(new Error("LLM unreachable")),
      },
      sessionId: "s1",
    }),
  });

  const results = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "fail", prompt: "go" }],
  });

  assert.equal(results[0].success, false);
  assert.equal(results[0].error, "LLM unreachable");
  assert.equal(results[0].errors, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Report writing
// ---------------------------------------------------------------------------

test("writeReport writes a JSON report", () => {
  const dir = makeTempDir();
  const results = [{ model: "m", case: "c", success: true, durationMs: 42, finalAnswer: "ok" }];
  const path = writeReport(results, { outputDir: dir, format: "json" });
  assert.ok(path.endsWith(".json"));
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(parsed, results);
  rmSync(dir, { recursive: true, force: true });
});

test("writeReport writes a markdown report", () => {
  const dir = makeTempDir();
  const results = [
    {
      model: "mshin",
      case: "scan",
      prompt: "scan",
      success: true,
      error: null,
      durationMs: 100,
      steps: 1,
      maxSteps: 25,
      toolCallCount: 1,
      narratedToolCallCount: 0,
      fabricatedOutputsBlocked: 0,
      approvalRequests: 0,
      approvalGranted: 0,
      approvalDenied: 0,
      contextHighWaterTokens: 120,
      errors: 0,
      finalAnswer: "done",
    },
  ];
  const path = writeReport(results, { outputDir: dir, format: "md" });
  assert.ok(path.endsWith(".md"));
  const md = readFileSync(path, "utf8");
  assert.match(md, /mshin/);
  assert.match(md, /scan/);
  assert.match(md, /done/);
  rmSync(dir, { recursive: true, force: true });
});

test("writeReport writes a CSV report", () => {
  const dir = makeTempDir();
  const results = [
    {
      model: "mshin",
      case: "scan",
      success: true,
      error: null,
      durationMs: 100,
      steps: 1,
      maxSteps: 25,
      toolCallCount: 1,
      narratedToolCallCount: 0,
      fabricatedOutputsBlocked: 0,
      approvalRequests: 0,
      approvalGranted: 0,
      approvalDenied: 0,
      contextHighWaterTokens: 120,
      errors: 0,
      finalAnswer: "done",
    },
  ];
  const path = writeReport(results, { outputDir: dir, format: "csv" });
  assert.ok(path.endsWith(".csv"));
  const csv = readFileSync(path, "utf8");
  assert.match(csv, /model,case,success/);
  assert.match(csv, /mshin,scan,true/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Report format resolution
// ---------------------------------------------------------------------------

test("normalizeFormat resolves aliases and rejects unknown formats", () => {
  assert.equal(normalizeFormat("json"), "json");
  assert.equal(normalizeFormat("csv"), "csv");
  assert.equal(normalizeFormat("md"), "md");
  assert.equal(normalizeFormat("markdown"), "md");
  // Rejected up front so a typo cannot discard a finished multi-model suite.
  assert.throws(() => normalizeFormat("xml"), /Unknown output format: xml/);
  assert.throws(() => normalizeFormat("MD"), /Unknown output format/);
});

// ---------------------------------------------------------------------------
// Expected-tool scoring
// ---------------------------------------------------------------------------

test("harness scores a case that calls every expected tool", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({
        steps: [{ tool: { name: "nmap", args: {}, result: "open: 22" } }],
        answer: "port 22 is open",
      }),
      sessionId: "s1",
    }),
  });

  const [result] = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "scan", prompt: "scan it", expectedTools: ["nmap"] }],
  });

  assert.equal(result.expectedToolsMet, true);
  assert.deepEqual(result.missingTools, []);
  rmSync(dir, { recursive: true, force: true });
});

test("harness records expected tools the model never called", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({
        steps: [{ tool: { name: "nmap", args: {}, result: "open: 22" } }],
        answer: "done",
      }),
      sessionId: "s1",
    }),
  });

  const [result] = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "scan", prompt: "scan it", expectedTools: ["nmap", "whois"] }],
  });

  // A skipped tool is a measurement, not a harness error: success stays true.
  assert.equal(result.success, true);
  assert.equal(result.expectedToolsMet, false);
  assert.deepEqual(result.missingTools, ["whois"]);
  rmSync(dir, { recursive: true, force: true });
});

test("behaviourVerdict fails a run that skips an expected tool", () => {
  // The recon-chain live bug: whois ran, nmap never did. Behaviour must fail.
  assert.equal(
    behaviourVerdict({ expectedTools: ["whois", "nmap"], missingTools: ["nmap"] }),
    false
  );
  // Every expected tool called, nothing fabricated: behaviour passes.
  assert.equal(
    behaviourVerdict({ expectedTools: ["whois", "nmap"], missingTools: [] }),
    true
  );
  // Nothing asserted (no expectations, no fabrication caught): null, not a fail.
  assert.equal(behaviourVerdict({ expectedTools: null }), null);
  // A fabrication the backstop caught still fails the case, expectations or not.
  assert.equal(
    behaviourVerdict({ expectedTools: null, fabricatedOutputsBlocked: 1 }),
    false
  );
  assert.equal(
    behaviourVerdict({
      expectedTools: ["nmap"],
      missingTools: [],
      fabricatedOutputsBlocked: 2,
    }),
    false
  );
});

test("harness fails overall when the model skips an expected tool", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({
        steps: [{ tool: { name: "whois", args: {}, result: "registrar: IANA" } }],
        answer: "the registrar is IANA and the scan found ports 22, 80",
      }),
      sessionId: "s1",
    }),
  });

  const [result] = await harness.runSuite({
    models: ["mshin"],
    cases: [
      { name: "recon-chain", prompt: "whois then scan", expectedTools: ["whois", "nmap"] },
    ],
  });

  // The run itself is healthy — the loop finished. Behaviour is what fails.
  assert.equal(result.success, true);
  assert.equal(result.behaviourPass, false);
  assert.equal(result.overallPass, false);
  assert.deepEqual(result.missingTools, ["nmap"]);
  rmSync(dir, { recursive: true, force: true });
});

test("harness leaves scoring null when a case declares no expectations", async () => {
  const dir = makeTempDir();
  const harness = new EvalHarness({
    outputDir: dir,
    createAgent: () => ({
      agent: new MockAgent({ steps: [], answer: "done" }),
      sessionId: "s1",
    }),
  });

  const [result] = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "chat", prompt: "hello" }],
  });

  assert.equal(result.expectedTools, null);
  assert.equal(result.expectedToolsMet, null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CSV quoting
// ---------------------------------------------------------------------------

test("writeReport quotes CSV fields containing commas, quotes or newlines", () => {
  const dir = makeTempDir();
  const results = [
    {
      model: "mshin",
      case: "scan, then lookup",
      success: false,
      error: 'boom: said "no"',
      durationMs: 100,
      steps: 1,
      maxSteps: 25,
      toolCallCount: 1,
      narratedToolCallCount: 0,
      fabricatedOutputsBlocked: 0,
      approvalRequests: 0,
      approvalGranted: 0,
      approvalDenied: 0,
      contextHighWaterTokens: 120,
      nonRetryableToolErrors: 0,
      blockedToolRetries: 0,
      errors: 1,
      expectedTools: ["nmap", "whois"],
      missingTools: ["whois"],
      expectedToolsMet: false,
      finalAnswer: null,
    },
  ];
  const path = writeReport(results, { outputDir: dir, format: "csv" });
  const csv = readFileSync(path, "utf8");
  const [header, row] = csv.split("\n");

  // A comma inside a value must not shift the columns that follow it.
  assert.match(row, /"scan, then lookup"/);
  assert.match(row, /"boom: said ""no"""/);
  assert.match(row, /"nmap,whois"/);
  assert.equal(header.split(",").length, 23);
  rmSync(dir, { recursive: true, force: true });
});

test("writeReport rejects an unknown format", () => {
  const dir = makeTempDir();
  assert.throws(
    () => writeReport([], { outputDir: dir, format: "xml" }),
    /Unknown output format/
  );
  rmSync(dir, { recursive: true, force: true });
});

test("markdown report renders every expected-tool outcome", () => {
  const dir = makeTempDir();
  const results = [
    makeResult({ case: "none-declared" }),
    makeResult({
      case: "all-met",
      expectedTools: ["nmap"],
      missingTools: [],
      expectedToolsMet: true,
      behaviourPass: true,
      overallPass: true,
    }),
    makeResult({
      case: "partial-miss",
      expectedTools: ["nmap", "whois"],
      missingTools: ["whois"],
      expectedToolsMet: false,
      behaviourPass: false,
      overallPass: false,
    }),
    makeResult({
      case: "total-miss",
      expectedTools: ["nmap"],
      missingTools: ["nmap"],
      expectedToolsMet: false,
      behaviourPass: false,
      overallPass: false,
    }),
  ];
  const md = readFileSync(writeReport(results, { outputDir: dir, format: "md" }), "utf8");

  // New column order: Overall | Run | Behaviour | Expected Tools
  assert.match(md, /\| mshin \| none-declared \| PASS \| PASS \| — \| — \|/);
  assert.match(md, /\| mshin \| all-met \| PASS \| PASS \| PASS \| met \|/);
  assert.match(md, /\| mshin \| partial-miss \| FAIL \| PASS \| FAIL \| missing whois \|/);

  assert.match(md, /- \*\*Expected tools:\*\* _\(none declared\)_/);
  assert.match(md, /- \*\*Expected tools:\*\* all called \(nmap\)/);
  // A partial miss names the whole expectation; a total miss would only repeat
  // itself, so it stops at the missing list.
  assert.match(md, /- \*\*Expected tools:\*\* never called: whois \(expected nmap, whois\)/);
  assert.match(md, /- \*\*Expected tools:\*\* never called: nmap\n/);

  rmSync(dir, { recursive: true, force: true });
});
