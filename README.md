<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Machin Shin logo" width="120" height="120">
  </picture>
</p>

<div align="center">
<h1>Machin Shin</h1>
</div>

> *"In the black corridors of the Ways, nothing moves that Machin Shin does not find. It hunts the dark without rest and lets nothing hide from it. So too does this system range the dark corners of your network, and bring back what waits there."*

**Machin Shin** is a **Wheel of Time-inspired cybersecurity AI system** that combines a **local LLM** (Mistral Small 3 by default, larger models if your hardware allows) with **Kali Linux tools** via **Model Context Protocol (MCP)**. It enables **real-time, AI-augmented penetration testing, threat analysis, and incident response**—all while keeping your data **private and offline**.

---

## Features

- **Private & Offline**: No cloud dependencies—your data stays yours.
- **Real-Time Tool Access**: LLM directly executes Kali Linux tools (Nmap, Metasploit, etc.) via MCP.
- **Scalable Architecture**: Two-machine setup for optimal performance.
- **Wheel of Time Themed**: Named for the Black Wind of the Ways—the relentless hunter that finds what hides in the dark.

---

## Architecture

```
┌──────────────────────┐          ┌─────────────────────┐
│ Machin Shin Core     │          │ Kali Node (mini PC) │
│ (32GB+ RAM, any box) │          │ (Kali Linux + MCP)  │
│ - Ollama + CLI       │ <──────> │ - Machin Shin Node  │
│ - Runs Mistral Small │          │ - Runs Kali tools   │
│   24B (or larger)    │          │ - MCP Server        │
└──────────────────────┘          └─────────────────────┘
```


| Component           | Role                    | Hardware                                              |
| ------------------- | ----------------------- | ----------------------------------------------------- |
| **Machin Shin Core** | LLM Inference Server    | Any Linux/macOS box with 32GB+ RAM — start with one you own |
| **Machin Shin Node** | Kali Linux + MCP Server | Any x86_64 mini PC / SFF ($150–350)                   |

The Core is deliberately undemanding: 32GB runs the default 24B model and everything
in this repo today. Bigger boxes buy *bigger models*, not more speed — see
[Sizing the Core](docs/architecture.md#sizing-the-core) before spending anything.


---

## Quick Start

### Prerequisites

- **Machin Shin Core**: any Linux or macOS machine with **32GB+ RAM** (an existing desktop or Mac is fine)
- **Machin Shin Node**: Any x86_64 mini PC or SFF running Kali Linux
- **Network**: Both devices on the same LAN

### Setup

1. **Set up Machin Shin Node (Kali + MCP):**
  ```bash
   # Follow the guide in docs/setup.md
  ```
2. **Set up Machin Shin Core (LLM Inference):**
  ```bash
   # Follow the guide in docs/setup.md
  ```
3. **Connect and Test:**
  ```bash
   # On Machin Shin Core, run:
   mshin <MSHIN_NODE_IP>
  ```
4. **Try a Command:**
  ```
   "Machin Shin, run an Nmap scan on 192.168.1.1 and analyze the results."
  ```

---

## Documentation

- [Master Guide](KALI-OPENLLM.md) – Complete single-file walkthrough (most comprehensive)
- [Architecture](docs/architecture.md) – System design and components
- [Setup Guide](docs/setup.md) – Step-by-step installation
- [Workflows](docs/workflows.md) – Example cybersecurity tasks
- [Lima Local Dev](docs/lima-local-dev.md) – Single-machine development environment on macOS
  - Lima templates: [`lima/mshin-kali.yaml`](lima/mshin-kali.yaml), [`lima/mshin-core.yaml`](lima/mshin-core.yaml)
- [Agent Roadmap](docs/cybersecurity-agent-roadmap.md) – Where the agent loop is headed
- [Agent Guidelines](AGENTS.md) – Rules for AI agents contributing to this repo

---

## Wheel of Time Inspiration

**Machin Shin**—the Black Wind—is the terror that haunts the Ways in the *Wheel of Time* series:

- **Relentless**: It ranges the black corridors of the Ways without rest, and nothing that enters escapes its notice
- **Blind to Nothing in the Dark**: It knows every twist of the unlit paths—much as this system ranges the dark corners of a network and surfaces what hides there
- **Beyond the Leaf-Key**: The trefoil leaf of Avendesora is the very shape of the keys that open the Waygates—and beyond those thresholds waits the Wind this project takes for its name and its mark

> *"Nothing hides from the Black Wind in the dark of the Ways. So too does Machin Shin range the dark of your networks, and let nothing hide from you."*

---

## Contributing

Contributions are welcome! Please read our [Contribution Guidelines](CONTRIBUTING.md).

Release history is tracked in the [Changelog](CHANGELOG.md).

---

## License

This project is licensed under the **MIT License** – see the [LICENSE](LICENSE) file for details.

The project logo uses the *wind* icon from [Feather Icons](https://feathericons.com/) by Cole Bemis, licensed under the [MIT License](https://github.com/feathericons/feather/blob/master/LICENSE).

This is an unofficial, non-commercial fan project. *The Wheel of Time*, "Machin Shin," and all related names and lore are the property of the Bandersnatch Group, Inc. This project is not affiliated with, endorsed by, or sponsored by the rights-holders.

---

## Acknowledgments

- Inspired by the *Wheel of Time* series by Robert Jordan
- Built with [Ollama](https://ollama.com), [MCP](https://github.com/modelcontextprotocol), and [Kali Linux](https://www.kali.org/)
- Powered by [Mistral AI](https://mistral.ai/)

---

*"The Wheel weaves as the Wheel wills. With Machin Shin, you weave with it."*