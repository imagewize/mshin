import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvalHarness, loadConfig, writeReport } from "./eval-harness.js";

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

test("loadConfig defaults ollamaUrl and nodeUrl", () => {
  const dir = makeTempDir();
  const path = configFile(dir, {
    cases: [{ name: "ping", prompt: "hello" }],
  });
  const config = loadConfig(path);
  assert.equal(config.ollamaUrl, "http://localhost:11434");
  assert.equal(config.nodeUrl, "http://192.168.1.100:3000");
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
        run: () => Promise.reject(new Error("Ollama unreachable")),
      },
      sessionId: "s1",
    }),
  });

  const results = await harness.runSuite({
    models: ["mshin"],
    cases: [{ name: "fail", prompt: "go" }],
  });

  assert.equal(results[0].success, false);
  assert.equal(results[0].error, "Ollama unreachable");
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
