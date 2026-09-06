# Avendesora CLI Client

An interactive terminal harness that connects a local Ollama instance to the Avendesora Kali MCP server.

## Features

- Discovers tools from the MCP server.
- Sends the user prompt to Ollama with native tool support.
- Executes tool calls on the Avendesora Node and feeds results back to the model.
- Runs a simple observe-decide-act loop until the model produces a final answer.

## Install

```bash
cd /opt/avendesora/clients/avendesora-cli
npm install
```

## Usage

```bash
# Connect to the default Node IP:
avendesora 192.168.1.100

# Or run the client directly:
./index.js --node http://192.168.1.100:3000 --model avendesora

# Use a different model:
avendesora --model llama3.3:70b 192.168.1.100
```

## Requirements

- Node.js 20+
- Ollama running locally with the requested model pulled.
- The `avendesora` model created from `configs/ollama-modelfile`.
