#!/usr/bin/env node
//
// mshin-call — single-tool MCP caller for the Machin Shin Node.
//
// Usage:
//   mshin-call --node http://192.168.1.100:3000 --token <token> nmap '{"target":"127.0.0.1"}'
//   mshin-call --list --node http://192.168.1.100:3000
//
// Environment:
//   MSHIN_NODE_URL    default --node value
//   MSHIN_NODE_TOKEN  default --token value
//
// Unlike the interactive mshin-cli, this tool does not need Ollama or a model.
// It speaks MCP directly to the Node, calls one tool, prints the result, and exits.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_NODE_URL = "http://192.168.1.100:3000";

function parseArgs(argv) {
    const args = argv.slice(2);
    let nodeUrl = process.env.MSHIN_NODE_URL || DEFAULT_NODE_URL;
    let token = process.env.MSHIN_NODE_TOKEN || "";
    let list = false;
    let help = false;
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--node":
                nodeUrl = args[++i];
                break;
            case "--token":
                token = args[++i];
                break;
            case "--list":
            case "-l":
                list = true;
                break;
            case "--help":
            case "-h":
                help = true;
                break;
            default:
                positional.push(args[i]);
                break;
        }
    }

    return { nodeUrl, token, list, help, positional };
}

function usage() {
    console.log(`Usage: mshin-call [OPTIONS] [TOOL] [ARGS_JSON]

Options:
  --node URL      Machin Shin Node MCP URL (default: ${DEFAULT_NODE_URL})
  --token TOKEN   Bearer token for Node authentication (or set MSHIN_NODE_TOKEN)
  --list, -l      List tools exposed by the Node
  --help, -h      Show this help

Environment:
  MSHIN_NODE_URL    default --node value
  MSHIN_NODE_TOKEN  default --token value

Examples:
  mshin-call --node http://192.168.1.100:3000 --token <token> nmap '{"target":"127.0.0.1"}'
  mshin-call --list
`);
}

function fail(message) {
    console.error(`[ERROR] ${message}`);
    process.exit(1);
}

async function connect(nodeUrl, token) {
    const client = new Client(
        { name: "mshin-call", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    const mcpUrl = new URL("/mcp", nodeUrl);
    const transportOptions = token
        ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
        : {};
    const transport = new StreamableHTTPClientTransport(mcpUrl, transportOptions);

    try {
        await client.connect(transport);
    } catch (err) {
        fail(`Could not connect to the Machin Shin Node at ${nodeUrl}: ${err.message}`);
    }

    return { client, transport };
}

async function listTools(client) {
    const { tools } = await client.listTools();
    console.log(`Tools exposed by the Node (${tools.length}):`);
    for (const tool of tools) {
        console.log(`  ${tool.name}`);
        if (tool.description) {
            const firstLine = tool.description.split("\n")[0];
            console.log(`    ${firstLine}`);
        }
    }
}

async function callTool(client, name, argsJson) {
    let args = {};
    if (argsJson !== undefined) {
        try {
            args = JSON.parse(argsJson);
        } catch (err) {
            fail(`Invalid JSON arguments: ${err.message}`);
        }
    }

    const result = await client.callTool({ name, arguments: args });

    if (result.isError) {
        console.error("Tool returned an error:");
    }

    for (const item of result.content || []) {
        if (item.type === "text" && typeof item.text === "string") {
            console.log(item.text);
        } else {
            console.log(JSON.stringify(item));
        }
    }

    return result.isError ? 1 : 0;
}

export { parseArgs };

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        fail(err.message);
    });
}

async function main() {
    const { nodeUrl, token, list, help, positional } = parseArgs(process.argv);

    if (help) {
        usage();
        process.exit(0);
    }

    const { client, transport } = await connect(nodeUrl, token);

    let exitCode = 0;
    try {
        if (list) {
            await listTools(client);
        } else {
            if (positional.length < 1) {
                usage();
                fail("Provide a tool name, or use --list.");
            }
            const [toolName, argsJson] = positional;
            exitCode = await callTool(client, toolName, argsJson);
        }
    } finally {
        try {
            await transport.close();
        } catch {
            // best effort
        }
    }

    process.exit(exitCode);
}
