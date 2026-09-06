#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import readline from "node:readline";
import { Agent, AgentMemory, askYesNo } from "./agent.js";

const DEFAULT_NODE_URL = "http://192.168.1.100:3000";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "mshin";

function parseArgs() {
  const args = process.argv.slice(2);
  let nodeUrl = DEFAULT_NODE_URL;
  let ollamaUrl = DEFAULT_OLLAMA_URL;
  let model = DEFAULT_MODEL;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--node":
        nodeUrl = args[++i];
        break;
      case "--ollama":
        ollamaUrl = args[++i];
        break;
      case "--model":
        model = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`Usage: mshin [OPTIONS] [NODE_IP]

Options:
  --node URL      Machin Shin Node MCP URL (default: ${DEFAULT_NODE_URL})
  --ollama URL    Ollama base URL (default: ${DEFAULT_OLLAMA_URL})
  --model NAME    Ollama model name (default: ${DEFAULT_MODEL})

The positional NODE_IP argument can be used as a shortcut for --node.
`);
        process.exit(0);
        break;
      default:
        if (!args[i].startsWith("-") && i === args.length - 1) {
          nodeUrl = `http://${args[i]}:3000`;
        }
        break;
    }
  }

  return { nodeUrl, ollamaUrl, model };
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

async function main() {
  const { nodeUrl, ollamaUrl, model } = parseArgs();

  console.log("Starting Machin Shin Core...");
  console.log(`  Ollama:  ${ollamaUrl}`);
  console.log(`  Model:   ${model}`);
  console.log(`  Node:    ${nodeUrl}`);
  console.log("");

  // Verify Ollama is reachable.
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error("Ollama /api/tags returned non-OK");
  } catch (err) {
    console.error(`[ERROR] Cannot reach Ollama at ${ollamaUrl}: ${err.message}`);
    console.error("        Is 'ollama serve' running on the Core?");
    process.exit(1);
  }

  // Connect to the Machin Shin Node MCP server via SSE.
  const client = new Client(
    { name: "mshin-cli", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const sseUrl = new URL("/sse", nodeUrl);
  const transport = new SSEClientTransport(sseUrl);
  await client.connect(transport);

  const mcpTools = await client.listTools();
  const ollamaTools = mcpToolsToOllama(mcpTools.tools);

  console.log(`Connected. Node is exposing ${ollamaTools.length} tool(s):`);
  console.log(`  ${ollamaTools.map((t) => t.function.name).join(", ")}`);
  console.log("");
  console.log('Type a prompt, or "exit" to quit.\n');

  const memory = new AgentMemory();
  const agent = new Agent({
    mcpClient: client,
    ollamaUrl,
    model,
    tools: ollamaTools,
    memory,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "Machin Shin> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const userInput = line.trim();
    if (!userInput) {
      rl.prompt();
      return;
    }
    if (userInput.toLowerCase() === "exit") {
      rl.close();
      return;
    }

    // Each prompt is its own session for now. A future UI can let the user
    // continue a prior session by ID.
    const sessionId = `cli-${Date.now()}`;

    try {
      await agent.run({
        sessionId,
        userGoal: userInput,
        onToolCall: (name, args) => {
          console.log(`  [tool] ${name}(${JSON.stringify(args)})`);
        },
        onToolResult: (name, text) => {
          // Keep the UI tidy; full results live in memory.
          const preview = text.split("\n").slice(0, 3).join("\n");
          console.log(`  [result] ${preview}${text.length > preview.length ? " ..." : ""}`);
        },
        onApproval: async (name, args) => {
          const argSummary = JSON.stringify(args, null, 2);
          return askYesNo(
            `\n  [approval] The agent wants to run the active tool '${name}' with:\n  ${argSummary}\n  Allow this execution?`
          );
        },
        onComplete: (answer) => {
          console.log(`\n${answer}\n`);
        },
      });
    } catch (err) {
      console.error(`\n[ERROR] ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    await client.close();
    console.log("\nThe Wheel weaves as the Wheel wills.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
