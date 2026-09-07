#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, AgentMemory } from "./agent.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_NODE_URL = "http://192.168.1.100:3000";
const DEFAULT_OUTPUT_DIR = "./eval-results";
const FORMATS = new Map([
  ["json", "json"],
  ["md", "md"],
  ["markdown", "md"],
  ["csv", "csv"],
]);

/**
 * Resolve a report format alias, throwing on anything unknown. Called from
 * parseArgs so a typo costs nothing: a suite can run for many minutes across
 * several models, and discovering the bad flag only at write time would throw
 * all of that away.
 */
function normalizeFormat(format) {
  const resolved = FORMATS.get(format);
  if (!resolved) {
    throw new Error(
      `Unknown output format: ${format}. Expected one of: ${[...FORMATS.keys()].join(", ")}.`
    );
  }
  return resolved;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let configPath = null;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let format = "json";
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config":
      case "-c":
        configPath = args[++i];
        break;
      case "--output-dir":
      case "-o":
        outputDir = args[++i];
        break;
      case "--format":
      case "-f":
        format = args[++i];
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (!args[i].startsWith("-") && !configPath) {
          configPath = args[i];
        }
        break;
    }
  }

  if (!configPath) {
    printUsage();
    process.exit(1);
  }

  try {
    format = normalizeFormat(format);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }

  return { configPath, outputDir, format, verbose };
}

function printUsage() {
  console.log(`Usage: eval-harness [OPTIONS] <config.json>

Evaluate Machin Shin agent behaviour across models and prompts.

Options:
  -c, --config PATH      Evaluation config (JSON)
  -o, --output-dir PATH  Where to write results (default: ${DEFAULT_OUTPUT_DIR})
  -f, --format FORMAT    Output format: json, md, csv (default: json)
  -v, --verbose          Print each tool call as it happens
  -h, --help             Show this help
`);
}

function loadConfig(configPath) {
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);

  if (!config.cases || !Array.isArray(config.cases) || config.cases.length === 0) {
    throw new Error("Config must contain a non-empty 'cases' array.");
  }

  for (const testCase of config.cases) {
    if (!testCase.name || typeof testCase.prompt !== "string") {
      throw new Error("Every case needs a 'name' and a 'prompt'.");
    }
  }

  const models = Array.isArray(config.models)
    ? config.models
    : config.model
      ? [config.model]
      : ["mshin"];

  return {
    ollamaUrl: config.ollamaUrl || DEFAULT_OLLAMA_URL,
    nodeUrl: config.nodeUrl !== undefined ? config.nodeUrl : DEFAULT_NODE_URL,
    models,
    cases: config.cases,
  };
}

function mcpToolsToOllama(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

async function createMcpClient(nodeUrl) {
  const client = new Client(
    { name: "mshin-eval", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const mcpUrl = new URL("/mcp", nodeUrl);
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await client.connect(transport);
  return client;
}

/**
 * Run a set of evaluation cases against one or more models and collect
 * measurable agent behaviour: steps, tool-call success, narrated calls,
 * fabricated output, context high-water mark, and wall-clock time.
 */
class EvalHarness {
  constructor({ outputDir, createAgent, verbose = false }) {
    this.outputDir = outputDir;
    this.createAgent = createAgent;
    this.verbose = verbose;
  }

  async runSuite(config) {
    const results = [];

    for (const model of config.models) {
      for (const testCase of config.cases) {
        const result = await this.runCase(model, testCase);
        results.push(result);
      }
    }

    return results;
  }

  async runCase(model, testCase) {
    const startTime = Date.now();
    const toolCalls = [];
    let finalAnswer = null;
    let success = true;
    let error = null;

    const { agent, sessionId } = this.createAgent(model, testCase);

    try {
      finalAnswer = await agent.run({
        sessionId,
        userGoal: testCase.prompt,
        onToolCall: (name, args) => {
          toolCalls.push({ name, args, time: Date.now() });
          if (this.verbose) {
            console.log(`  [tool] ${name}(${JSON.stringify(args)})`);
          }
        },
        onToolResult: (name, text) => {
          const last = toolCalls[toolCalls.length - 1];
          if (last && last.name === name) {
            last.resultPreview = text.split("\n").slice(0, 3).join("\n");
          }
        },
        onNarratedToolCall: (name) => {
          if (this.verbose) {
            console.log(`  [recovered] ${name} was narrated instead of called`);
          }
        },
        onApproval: async (name, args) => {
          if (this.verbose) {
            console.log(`  [approval] auto-${testCase.approveActiveTools === false ? "deny" : "approve"} ${name}`);
          }
          return testCase.approveActiveTools !== false;
        },
        onComplete: (answer) => {
          finalAnswer = answer;
        },
      });
    } catch (err) {
      success = false;
      error = err.message;
    }

    const endTime = Date.now();

    // expectedTools is a behavioural expectation, not a harness assertion: a
    // model that skips a tool is a result worth recording, not a broken run.
    // It is scored separately from `success` so the two never blur together.
    const expectedTools = testCase.expectedTools || null;
    const calledTools = toolCalls.map((c) => c.name);
    const missingTools = expectedTools
      ? expectedTools.filter((name) => !calledTools.includes(name))
      : [];

    // Two verdicts, kept apart on purpose. `success` is run health: did the
    // loop finish without throwing. `behaviourPass` is whether the model did
    // what the case asked — every expected tool called, no output blocked as
    // fabricated. `overallPass` fails if either does, so a green run that skips
    // a tool and invents its output no longer reads as a pass.
    const behaviourPass = behaviourVerdict({
      expectedTools,
      missingTools,
      fabricatedOutputsBlocked: agent.metrics.fabricatedOutputsBlocked,
    });
    const overallPass = success && behaviourPass !== false;

    return {
      model,
      case: testCase.name,
      prompt: testCase.prompt,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationMs: endTime - startTime,
      success,
      error,
      finalAnswer,
      steps: agent.metrics.steps,
      toolCalls,
      toolCallCount: agent.metrics.toolCalls,
      narratedToolCallCount: agent.metrics.narratedToolCalls,
      fabricatedOutputsBlocked: agent.metrics.fabricatedOutputsBlocked,
      continuationNudges: agent.metrics.continuationNudges,
      approvalRequests: agent.metrics.approvalRequests,
      approvalGranted: agent.metrics.approvalGranted,
      approvalDenied: agent.metrics.approvalDenied,
      contextHighWaterTokens: agent.metrics.contextHighWaterTokens,
      nonRetryableToolErrors: agent.metrics.nonRetryableToolErrors,
      blockedToolRetries: agent.metrics.blockedToolRetries,
      errors: agent.metrics.errors,
      expectedTools,
      missingTools,
      expectedToolsMet: expectedTools ? missingTools.length === 0 : null,
      behaviourPass,
      overallPass,
      maxSteps: testCase.maxSteps || 25,
    };
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeJsonReport(results, outputDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outputDir, `eval-${timestamp}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  return path;
}

/**
 * Behavioural verdict, separate from run health (`success`). Null when the case
 * asserts nothing behavioural (no expected tools, and no fabrication to catch);
 * otherwise true only when every expected tool was called and no output was
 * blocked as fabricated. A fabrication the backstop *did* catch still fails the
 * case — the model tried to invent a result.
 */
export function behaviourVerdict({
  expectedTools,
  missingTools = [],
  fabricatedOutputsBlocked = 0,
}) {
  const fabricated = fabricatedOutputsBlocked > 0;
  if (!expectedTools && !fabricated) return null;
  const toolsMet = expectedTools ? missingTools.length === 0 : true;
  return toolsMet && !fabricated;
}

function verdictLabel(pass) {
  return pass ? "PASS" : "FAIL";
}

function behaviourLabel(result) {
  if (result.behaviourPass === true) return "PASS";
  if (result.behaviourPass === false) return "FAIL";
  return "—";
}

// Report rows may be minimal (some tests pass a bare object). Fall back to run
// health minus any explicit behaviour failure when the field is absent.
function overallPassOf(result) {
  if (typeof result.overallPass === "boolean") return result.overallPass;
  return result.success !== false && result.behaviourPass !== false;
}

function expectedLabel(result) {
  if (!result.expectedTools) return "—";
  return result.expectedToolsMet ? "met" : `missing ${result.missingTools.join(", ")}`;
}

function expectedDetail(result) {
  if (!result.expectedTools) return "_(none declared)_";
  if (result.expectedToolsMet) {
    return `all called (${result.expectedTools.join(", ")})`;
  }
  const missed = `never called: ${result.missingTools.join(", ")}`;
  // Only worth naming the full expectation when part of it was met.
  if (result.missingTools.length === result.expectedTools.length) return missed;
  return `${missed} (expected ${result.expectedTools.join(", ")})`;
}

function writeMarkdownReport(results, outputDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outputDir, `eval-${timestamp}.md`);

  const summaryRows = results
    .map(
      (r) =>
        `| ${r.model} | ${r.case} | ${verdictLabel(overallPassOf(r))} | ${verdictLabel(r.success !== false)} | ${behaviourLabel(r)} | ${expectedLabel(r)} | ${r.durationMs} | ${r.steps} | ${r.toolCallCount} | ${r.narratedToolCallCount} | ${r.fabricatedOutputsBlocked} | ${r.contextHighWaterTokens} |`
    )
    .join("\n");

  const details = results
    .map(
      (r) => `
### ${r.model} / ${r.case}

- **Prompt:** ${r.prompt}
- **Overall:** ${verdictLabel(overallPassOf(r))}\n- **Run:** ${verdictLabel(r.success !== false)}${r.error ? ` — ${r.error}` : ""}\n- **Behaviour:** ${behaviourLabel(r)}
- **Duration:** ${r.durationMs} ms
- **Steps:** ${r.steps} / ${r.maxSteps}
- **Tool calls:** ${r.toolCallCount} (${r.narratedToolCallCount} narrated)
- **Fabricated outputs blocked:** ${r.fabricatedOutputsBlocked}\n- **Continuation nudges:** ${r.continuationNudges ?? 0}
- **Approval requests:** ${r.approvalRequests} granted / ${r.approvalDenied} denied
- **Context high-water:** ${r.contextHighWaterTokens} tokens
- **Unavailable tools:** ${r.nonRetryableToolErrors} non-retryable error(s), ${r.blockedToolRetries} retry/retries refused
- **Expected tools:** ${expectedDetail(r)}

**Final answer:**
${r.finalAnswer ? "```\n" + r.finalAnswer + "\n```" : "_(none)_"}
`
    )
    .join("\n");

  const markdown = `# Machin Shin Model Evaluation Report

| Model | Case | Overall | Run | Behaviour | Expected Tools | Duration (ms) | Steps | Tool Calls | Narrated | Fabricated | Context Tokens |
|-------|------|---------|-----|-----------|----------------|--------------:|------:|-----------:|---------:|-----------:|---------------:|
${summaryRows}

${details}
`;

  writeFileSync(path, markdown);
  return path;
}

/**
 * RFC 4180 cell: quote only when the value carries a comma, quote or newline,
 * so plain values stay readable. Model and case names are author-supplied and
 * a comma in either used to shift every column that followed it.
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsvReport(results, outputDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outputDir, `eval-${timestamp}.csv`);

  const headers = [
    "model",
    "case",
    "success",
    "error",
    "durationMs",
    "steps",
    "maxSteps",
    "toolCallCount",
    "narratedToolCallCount",
    "fabricatedOutputsBlocked",
    "continuationNudges",
    "approvalRequests",
    "approvalGranted",
    "approvalDenied",
    "contextHighWaterTokens",
    "nonRetryableToolErrors",
    "blockedToolRetries",
    "errors",
    "expectedTools",
    "expectedToolsMet",
    "missingTools",
    "behaviourPass",
    "overallPass",
  ];

  const rows = results.map((r) =>
    [
      r.model,
      r.case,
      r.success,
      r.error,
      r.durationMs,
      r.steps,
      r.maxSteps,
      r.toolCallCount,
      r.narratedToolCallCount,
      r.fabricatedOutputsBlocked,
      r.continuationNudges,
      r.approvalRequests,
      r.approvalGranted,
      r.approvalDenied,
      r.contextHighWaterTokens,
      r.nonRetryableToolErrors,
      r.blockedToolRetries,
      r.errors,
      r.expectedTools ? r.expectedTools.join(",") : "",
      r.expectedToolsMet === null ? "" : r.expectedToolsMet,
      r.missingTools ? r.missingTools.join(",") : "",
      r.behaviourPass === null || r.behaviourPass === undefined
        ? ""
        : r.behaviourPass,
      overallPassOf(r),
    ]
      .map(csvCell)
      .join(",")
  );

  writeFileSync(path, [headers.join(","), ...rows].join("\n"));
  return path;
}

function writeReport(results, { outputDir, format }) {
  ensureDir(outputDir);

  switch (normalizeFormat(format)) {
    case "json":
      return writeJsonReport(results, outputDir);
    case "md":
      return writeMarkdownReport(results, outputDir);
    default:
      return writeCsvReport(results, outputDir);
  }
}

async function main() {
  const { configPath, outputDir, format, verbose } = parseArgs();
  const config = loadConfig(configPath);

  console.log("Machin Shin Model Evaluation Harness");
  console.log(`  Config:  ${configPath}`);
  console.log(`  Ollama:  ${config.ollamaUrl}`);
  console.log(`  Node:    ${config.nodeUrl}`);
  console.log(`  Models:  ${config.models.join(", ")}`);
  console.log(`  Cases:   ${config.cases.map((c) => c.name).join(", ")}`);
  console.log("");

  let client = null;
  let ollamaTools = [];

  if (config.nodeUrl) {
    client = await createMcpClient(config.nodeUrl);
    const mcpTools = await client.listTools();
    ollamaTools = mcpToolsToOllama(mcpTools.tools);
    console.log(`Connected. Node exposes ${ollamaTools.length} tool(s).\n`);
  }

  const memoryDir = join(outputDir, ".mshin-eval");
  const createAgent = (model, testCase) => {
    const memory = new AgentMemory(memoryDir);
    const sessionId = `eval-${model}-${testCase.name}-${Date.now()}`;
    const agent = new Agent({
      mcpClient: client,
      ollamaUrl: config.ollamaUrl,
      model,
      tools: ollamaTools,
      memory,
      maxSteps: testCase.maxSteps || 25,
    });
    return { agent, sessionId };
  };

  const harness = new EvalHarness({ outputDir, createAgent, verbose });
  const results = await harness.runSuite(config);

  if (client) {
    await client.close();
  }

  const reportPath = writeReport(results, { outputDir, format });
  console.log(`\nWrote ${format} report: ${reportPath}`);

  const missed = results.filter((r) => r.expectedToolsMet === false);
  if (missed.length > 0) {
    console.log(`\n${missed.length} case(s) did not call every expected tool:`);
    for (const r of missed) {
      console.log(`  ${r.model} / ${r.case}: missing ${r.missingTools.join(", ")}`);
    }
  }

  // Two exit codes, matching the two verdicts. A run that threw (harness or
  // transport) is exit 2 — the measurement never completed. A run that
  // completed but failed on behaviour (skipped an expected tool, or invented a
  // result) is exit 3, so the suite can guard a behavioural fix while staying
  // distinguishable from a broken run.
  const runFailures = results.filter((r) => !r.success);
  const behaviourFailures = results.filter(
    (r) => r.success && r.overallPass === false
  );

  if (behaviourFailures.length > 0) {
    console.log(`\n${behaviourFailures.length} case(s) failed on behaviour:`);
    for (const r of behaviourFailures) {
      const why =
        r.missingTools && r.missingTools.length > 0
          ? `missing ${r.missingTools.join(", ")}`
          : "fabricated output";
      console.log(`  ${r.model} / ${r.case}: ${why}`);
    }
  }

  if (runFailures.length > 0) {
    console.log(`\n${runFailures.length} case(s) failed to run.`);
    process.exit(2);
  }

  if (behaviourFailures.length > 0) {
    process.exit(3);
  }

  console.log("\nAll cases passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[FATAL]", err.message);
    process.exit(1);
  });
}

export { EvalHarness, loadConfig, writeReport, mcpToolsToOllama, normalizeFormat };
