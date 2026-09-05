<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Avendesora logo" width="120" height="120">
  </picture>
</p>

<div align="center">
<h1>Avendesora</h1>
</div>

> *"When the Breaking shattered the world, Avendesora endured—carried to safety as a cutting by the Aiel and rooted anew, its branches reaching toward the future. So too does this system stand resilient against the storms of cyber threats."*

**Avendesora** is a **Wheel of Time-inspired cybersecurity AI system** that combines a **local LLM** (Mistral Small 3 / Llama 3.3 70B) with **Kali Linux tools** via **Model Context Protocol (MCP)**. It enables **real-time, AI-augmented penetration testing, threat analysis, and incident response**—all while keeping your data **private and offline**.

---

## Features

- **Private & Offline**: No cloud dependencies—your data stays yours.
- **Real-Time Tool Access**: LLM directly executes Kali Linux tools (Nmap, Metasploit, etc.) via MCP.
- **Scalable Architecture**: Two-machine setup for optimal performance.
- **Wheel of Time Themed**: Inspired by the enduring Avendesora tree—symbolizing resilience and wisdom.

---

## Architecture

```
┌──────────────────────┐          ┌─────────────────────┐
│ Avendesora Core      │          │ Kali Node (mini PC) │
│ (32GB+ RAM, any box) │          │ (Kali Linux + MCP)  │
│ - Ollama + CLI       │ <──────> │ - Avendesora Node   │
│ - Runs Mistral Small │          │ - Runs Kali tools   │
│   24B (or larger)    │          │ - MCP Server        │
└──────────────────────┘          └─────────────────────┘
```


| Component           | Role                    | Hardware                                              |
| ------------------- | ----------------------- | ----------------------------------------------------- |
| **Avendesora Core** | LLM Inference Server    | Any Linux/macOS box with 32GB+ RAM — start with one you own |
| **Avendesora Node** | Kali Linux + MCP Server | Any x86_64 mini PC / SFF ($150–350)                   |

The Core is deliberately undemanding: 32GB runs the default 24B model and everything
in this repo today. Bigger boxes buy *bigger models*, not more speed — see
[Sizing the Core](docs/architecture.md#sizing-the-core) before spending anything.


---

## Quick Start

### Prerequisites

- **Avendesora Core**: any Linux or macOS machine with **32GB+ RAM** (an existing desktop or Mac is fine)
- **Avendesora Node**: Any x86_64 mini PC or SFF running Kali Linux
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
   avendesora <AVENDESORA_NODE_IP>
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

- **Enduring**: The only chora tree to survive the Breaking of the World, preserved as a cutting the Aiel carried to safety
- **Rooted in the Pattern**: Symbolizes deep knowledge and stability
- **A Key in Its Leaf**: The trefoil leaf of Avendesora is the very shape of the keys to the Ways—much like this system unlocks powerful cybersecurity workflows

> *"The tree’s roots run deep, and its branches stretch toward the future. So too does Avendesora weave the threads of your security."*

---

## Contributing

Contributions are welcome! Please read our [Contribution Guidelines](CONTRIBUTING.md).

Release history is tracked in the [Changelog](CHANGELOG.md).

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