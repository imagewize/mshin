#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import readline from "node:readline";

const DEFAULT_NODE_URL = "http://192.168.1.100:3000";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "avendesora";
const MAX_TOOL_ITERATIONS = 10;

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
        console.log(`Usage: avendesora [OPTIONS] [NODE_IP]

Options:
  --node URL      Avendesora Node MCP URL (default: ${DEFAULT_NODE_URL})
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

async function chatWithOllama(ollamaUrl, model, messages, tools) {
  const body = {
    model,
    messages,
    tools,
    stream: false,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
    },
  };

  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama returned ${res.status}: ${text}`);
  }

  return res.json();
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

  console.log("Starting Avendesora Core...");
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

  // Connect to the Avendesora Node MCP server via SSE.
  const client = new Client(
    { name: "avendesora-cli", version: "1.0.0" },
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "Avendesora> ",
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

    const messages = [
      {
        role: "user",
        content: userInput,
      },
    ];

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const response = await chatWithOllama(
          ollamaUrl,
          model,
          messages,
          ollamaTools
        );

        const assistantMessage = response.message;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];
        if (toolCalls.length === 0) {
          console.log(`\n${assistantMessage.content}\n`);
          break;
        }

        for (const call of toolCalls) {
          const name = call.function?.name;
          const args = call.function?.arguments || {};
          console.log(`  [tool] ${name}(${JSON.stringify(args)})`);

          const result = await client.callTool({ name, arguments: args });
          const text = result.content
            ?.map((c) => (c.type === "text" ? c.text : ""))
            .join("\n") || "(no output)";

          messages.push({
            role: "tool",
            name,
            content: text,
          });
        }
      }
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
