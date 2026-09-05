<p align="center">
  <img src="assets/logo.svg" alt="Avendesora logo" width="120" height="120">
</p>

<div align="center">
<h1>Avendesora</h1>
</div>

> *"The Avendesora tree stood unbroken through the Breaking of the World, its roots deep in the Pattern, its branches reaching toward the future. So too does this system stand resilient against the storms of cyber threats."*

**Avendesora** is a **Wheel of Time-inspired cybersecurity AI system** that combines a **local LLM** (Mistral 13B/70B) with **Kali Linux tools** via **Model Context Protocol (MCP)**. It enables **real-time, AI-augmented penetration testing, threat analysis, and incident response**—all while keeping your data **private and offline**.

---

## Features

- **Private & Offline**: No cloud dependencies—your data stays yours.
- **Real-Time Tool Access**: LLM directly executes Kali Linux tools (Nmap, Metasploit, etc.) via MCP.
- **Scalable Architecture**: Two-machine setup for optimal performance.
- **Wheel of Time Themed**: Inspired by the unbreakable Avendesora tree—symbolizing resilience and wisdom.

---

## Architecture

```
┌─────────────────────┐       ┌─────────────────────┐
│   GMKtec EVO-X2      │       │   MINISFORUM Mini PC │
│  (128GB RAM, 2TB)    │◄──────►│  (Kali Linux + MCP)   │
│ - Avendesora Core    │       │ - Avendesora Node    │
│ - Runs Mistral 13B/  │       │ - Runs Kali tools     │
│   70B locally         │       │ - MCP Server          │
└─────────────────────┘       └─────────────────────┘
```


| Component           | Role                    | Hardware                  |
| ------------------- | ----------------------- | ------------------------- |
| **Avendesora Core** | LLM Inference Server    | GMKtec EVO-X2 (128GB RAM) |
| **Avendesora Node** | Kali Linux + MCP Server | MINISFORUM UM790 Pro      |


---

## Quick Start

### Prerequisites

- **Avendesora Core**: GMKtec EVO-X2 (or any PC with 32GB+ RAM)
- **Avendesora Node**: MINISFORUM mini PC (or any Linux-compatible machine)
- **Network**: Both devices on the same LAN

### Setup

1. **Set up Avendesora Node (Kali + MCP):**
  ```bash
   # Follow the guide in docs/setup.md
  ```
2. **Set up Avendesora Core (LLM Inference):**
  ```bash
   # Follow the guide in docs/setup.md
  ```
3. **Connect and Test:**
  ```bash
   # On Avendesora Core, run:
   mcp-client --llm cmd:ollama --llm-args mistral:13b --mcp-server http://<AVENDESORA_NODE_IP>:3000
  ```
4. **Try a Command:**
  ```
   "Avendesora, run an Nmap scan on 192.168.1.1 and analyze the results."
  ```

---

## Documentation

- [Master Guide](KALI-OPENLLM.md) – Complete single-file walkthrough (most comprehensive)
- [Architecture](docs/architecture.md) – System design and components
- [Setup Guide](docs/setup.md) – Step-by-step installation
- [Workflows](docs/workflows.md) – Example cybersecurity tasks

---

## Wheel of Time Inspiration

**Avendesora** is named after the legendary tree in the *Wheel of Time* series:

- **Unbreakable**: Survived the Breaking of the World
- **Rooted in the Pattern**: Symbolizes deep knowledge and stability
- **Source of Ter’angreal**: Created powerful artifacts, much like how this system empowers your cybersecurity workflows

> *"The tree’s roots run deep, and its branches stretch toward the future. So too does Avendesora weave the threads of your security."*

---

## Contributing

Contributions are welcome! Please read our [Contribution Guidelines](CONTRIBUTING.md).

---

## License

This project is licensed under the **MIT License** – see the [LICENSE](LICENSE) file for details.

The project logo uses the *Entypo* leaf pictogram by [Daniel Bruce](https://www.entypo.com/), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

---

## Acknowledgments

- Inspired by the *Wheel of Time* series by Robert Jordan
- Built with [Ollama](https://ollama.com), [MCP](https://github.com/modelcontextprotocol), and [Kali Linux](https://www.kali.org/)
- Powered by [Mistral AI](https://mistral.ai/)

---

*"The Wheel weaves as the Wheel wills. With Avendesora, you weave with it."*