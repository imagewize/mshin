#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import readline from "node:readline";
import { Agent, AgentMemory, askYesNo } from "./agent.js";
import { SessionLogger } from "./session-logger.js";

const DEFAULT_NODE_URL = "http://192.168.1.100:3000";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "mshin";

function parseArgs() {
  const args = process.argv.slice(2);
  let nodeUrl = DEFAULT_NODE_URL;
  let ollamaUrl = DEFAULT_OLLAMA_URL;
  let model = DEFAULT_MODEL;
  let nodeToken = "";

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
      case "--token":
        nodeToken = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`Usage: mshin [OPTIONS] [NODE_IP]

Options:
  --node URL      Machin Shin Node MCP URL (default: ${DEFAULT_NODE_URL})
  --ollama URL    Ollama base URL (default: ${DEFAULT_OLLAMA_URL})
  --model NAME    Ollama model name (default: ${DEFAULT_MODEL})
  --token TOKEN   Bearer token for Node authentication (or set MSHIN_NODE_TOKEN)

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

  return { nodeUrl, ollamaUrl, model, nodeToken };
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
  const { nodeUrl, ollamaUrl, model, nodeToken: tokenArg } = parseArgs();
  // The flag wins over the environment; both are optional. When the Node has
  // MSHIN_NODE_TOKEN set, every MCP request must carry it as a bearer token.
  const authToken = tokenArg || process.env.MSHIN_NODE_TOKEN || "";

  console.log("Starting Machin Shin Core...");
  console.log(`  Ollama:  ${ollamaUrl}`);
  console.log(`  Model:   ${model}`);
  console.log(`  Node:    ${nodeUrl}`);
  console.log(`  Token:   ${authToken ? "provided" : "none"}`);
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

  // Connect to the Machin Shin Node MCP server over Streamable HTTP.
  const client = new Client(
    { name: "mshin-cli", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const mcpUrl = new URL("/mcp", nodeUrl);
  const transportOptions = authToken
    ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } }
    : {};
  const transport = new StreamableHTTPClientTransport(mcpUrl, transportOptions);
  try {
    await client.connect(transport);
  } catch (err) {
    console.error(
      `[ERROR] Could not connect to the Machin Shin Node at ${nodeUrl}: ${err.message}`
    );
    if (!authToken) {
      console.error(
        "        If the Node requires authentication, pass --token <token> or set MSHIN_NODE_TOKEN."
      );
    }
    process.exit(1);
  }

  const mcpTools = await client.listTools();
  const ollamaTools = mcpToolsToOllama(mcpTools.tools);

  console.log(`Connected. Node is exposing ${ollamaTools.length} tool(s):`);
  console.log(`  ${ollamaTools.map((t) => t.function.name).join(", ")}`);
  console.log("");
  const dataDir = process.env.MSHIN_DATA_DIR;
  const memory = new AgentMemory(dataDir);
  const sessionLogger = new SessionLogger(memory.dataDir);

  console.log('Type a prompt, or "exit" to quit.\n');
  console.log(`Session logs: ${sessionLogger.sessionsDir}\n`);

  const agent = new Agent({
    mcpClient: client,
    ollamaUrl,
    model,
    tools: ollamaTools,
    memory,
    sessionLogger,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "Machin Shin> ",
  });

  // This interface is the only consumer of stdin for the whole session.
  // Every line is routed from here: to a waiting approval question if the
  // agent asked one, otherwise as a new prompt. Opening a second interface
  // for the approval would leave two `data` listeners racing for the reply.
  let pendingAnswer = null;
  // A run is in flight. readline does not await an async `line` handler, so
  // without this guard a line typed mid-scan starts a second concurrent
  // agent.run() against the same Agent and the same session memory.
  let busy = false;
  // Set once the interface has closed, so a run that outlives it does not
  // write a prompt to a dead interface.
  let closed = false;
  // The in-flight run, so `close` can wait for it instead of exiting and
  // discarding a tool result that has already cost a real scan.
  let activeRun = null;

  function askLine(prompt) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      pendingAnswer = resolve;
    });
  }

  rl.prompt();

  rl.on("line", (line) => {
    const userInput = line.trim();

    if (pendingAnswer) {
      const resolve = pendingAnswer;
      pendingAnswer = null;
      resolve(userInput);
      return;
    }

    if (busy) {
      console.log(
        "  [busy] Machin Shin is still working. Wait for the answer, or press Ctrl-C to abort."
      );
      return;
    }

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

    busy = true;
    activeRun = runPrompt(sessionId, userInput).finally(() => {
      busy = false;
      activeRun = null;
      if (!closed) rl.prompt();
    });
  });

  async function runPrompt(sessionId, userInput) {
    try {
      await agent.run({
        sessionId,
        userGoal: userInput,
        onToolCall: (name, args) => {
          console.log(`  [tool] ${name}(${JSON.stringify(args)})`);
        },
        onNarratedToolCall: (name) => {
          // Worth showing: the model wrote the call out instead of emitting
          // it, which usually means the persona was built with a sampling
          // temperature above 0. The loop recovered, but the model is a step
          // away from inventing results instead.
          console.log(
            `  [recovered] '${name}' was written as text, not called. Running it anyway.`
          );
        },
        onToolResult: (name, text) => {
          // Keep the UI tidy; full results live in memory.
          const preview = text.split("\n").slice(0, 3).join("\n");
          console.log(`  [result] ${preview}${text.length > preview.length ? " ..." : ""}`);
        },
        onApproval: async (name, args) => {
          const argSummary = JSON.stringify(args, null, 2);
          return askYesNo(
            `\n  [approval] The agent wants to run the active tool '${name}' with:\n  ${argSummary}\n  Allow this execution?`,
            askLine
          );
        },
        onComplete: (answer) => {
          console.log(`\n${answer}\n`);
        },
      });
    } catch (err) {
      console.error(`\n[ERROR] ${err.message}\n`);
    }
  }

  rl.on("close", async () => {
    closed = true;
    // An approval question outlives the stdin that was meant to answer it
    // whenever input is piped. Deny it: no answer is not a yes, and waiting
    // for one that can never arrive would hang the exit.
    if (pendingAnswer) {
      const resolve = pendingAnswer;
      pendingAnswer = null;
      resolve("n");
    }
    // EOF or Ctrl-D can land mid-run -- and always does when a prompt is
    // piped in, since stdin ends the moment it is read. Exiting here would
    // kill the agent before it answers.
    if (activeRun) {
      try {
        await activeRun;
      } catch {
        // runPrompt already reported it.
      }
    }
    await client.close();
    console.log("\nThe Wheel weaves as the Wheel wills.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
