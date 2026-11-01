# Contributing to Machin Shin

> *"The Aiel say, 'The way of the leaf is the way of the coward.' But in the world of code, the way of the leaf is the way of collaboration. Together, we weave a stronger Pattern."*

We welcome contributions to **Machin Shin**! Whether you're fixing bugs, adding new tools, or improving documentation, your help is valuable. Here's how to get started.

---

## **Code of Conduct**

By participating in this project, you agree to abide by the **[Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/0/code_of_conduct.html)**. Be respectful, inclusive, and collaborative.

---

## **How to Contribute**

### **1. Reporting Bugs**

If you find a bug, please [open an issue](https://github.com/imagewize/mshin/issues) with:

- A **clear title** describing the issue.
- A **detailed description** of the problem, including:
  - Steps to reproduce.
  - Expected vs. actual behavior.
  - Screenshots or logs (if applicable).
- Your **environment** (OS, hardware, versions of Machin Shin components).

### **2. Suggesting Features**

Have an idea for a new feature or tool integration? Open an issue with:

- A **detailed description** of the feature.
- The **use case** or problem it solves.
- Any **examples or mockups** (if applicable).

### **3. Submitting Pull Requests**

1. **Fork the repository** and create a new branch:
  ```bash
   git checkout -b feature/your-feature-name
  ```
2. **Make your changes** and ensure they follow the project's coding style.
3. **Test your changes** thoroughly.
4. **Commit your changes** with a clear, descriptive message:
  ```bash
   git commit -m "Add feature: your feature description"
  ```
5. **Run the review skill** if you work with [Mistral Vibe](https://docs.mistral.ai/vibe/) in this folder: ask for `/code-review` on your branch before opening the PR. The skill is referenced, not vendored — `.vibe/config.toml` points `skill_paths` at the [mistral-agents](https://github.com/imagewize/mistral-agents) repo's `skills/` directory, so clone that repo to `~/code/mistral-agents` (or add the same `skill_paths` line to your `~/.vibe/config.toml`) and the skill is available here.
6. **Push to your fork** and submit a pull request to the `main` branch.

---

## **Development Setup**

### **Prerequisites**

- **Machin Shin Node:** Any x86_64 mini PC or SFF with Kali Linux.
- **Machin Shin Core:** any Linux/macOS machine with 32GB+ RAM (a GMKtec EVO-X3 or similar 128GB box is optional headroom, not a requirement).
- **Basic knowledge** of Linux, networking, and Git.

### **Setting Up a Development Environment**

1. Clone the repository:
  ```bash
   git clone https://github.com/imagewize/mshin.git
   cd mshin
  ```
2. Set up the **Machin Shin Node** and **Machin Shin Core** as described in the [Setup Guide](docs/SETUP.md).
3. Test your changes locally before submitting a pull request.

---

## **Project Structure**

```
mshin/
├── README.md                  # Project overview
├── LICENSE                    # MIT License
├── CONTRIBUTING.md            # This file
├── AGENTS.md                  # Guidelines for AI agents
├── .vibe/
│   └── config.toml            # Vibe project config: loads the shared /code-review skill from the mistral-agents repo
├── KALI-OPENLLM.md            # Complete single-file master guide
├── docs/
│   ├── ARCHITECTURE.md        # System architecture
│   ├── SETUP.md               # Setup instructions
│   ├── WORKFLOWS.md           # Example workflows
│   ├── LIMA-LOCAL-DEV.md      # Lima VM setup on macOS (maintenance mode; bridged LAN guest)
│   ├── DOCKER-LOCAL-DEV.md    # Docker local development (default local path)
│   ├── DEVELOPER-ONBOARDING.md # Learning path and architecture
│   ├── REFACTORING-IDEAS.md    # Cleanups worth doing (and ones avoided)
│   ├── CYBERSECURITY-AGENT-ROADMAP.md  # Agent roadmap
│   ├── AGENT-LOOP-INVESTIGATIONS.md    # Agent-loop defects and open questions
│   ├── AGENT-PERFORMANCE.md            # Making mshin-cli faster: streaming, parallel tools, caching
│   ├── EVAL-RUN-2026-10-20.md         # First model-comparison eval measurements
│   ├── EVAL-RUN-2026-10-21.md         # Same suite against the Docker Node
│   ├── RASPBERRY-PI-NODE.md            # Raspberry Pi Node guide
│   ├── VPS-NODE.md                    # VPS Node guide (internet targets, not your LAN)
│   └── MAC-MINI-M4-CORE.md             # Mac Mini M4 Pro Core guide
├── scripts/
│   ├── setup_mcp_server.sh    # MCP server setup script
│   ├── setup_mcp_auth.sh      # One-shot token sync for Docker Node / Vibe / OpenCode
│   ├── probe_mcp_server.sh    # Host-side Node health/transport probe (minimal MCP client)
│   ├── lan_inventory.py       # Cross-platform LAN inventory (macOS/Windows/Linux)
│   ├── lan_inventory.sh       # Host-side LAN inventory (macOS, legacy): live IPs, MACs, names
│   ├── setup_bridged_node.sh  # One-command bridged Lima Node (real LAN discovery on a Mac)
│   └── setup_ollama.sh        # Ollama / Core setup script
├── configs/
│   ├── mcp-kali.service       # systemd service for MCP server
│   ├── ollama-modelfile       # Custom Ollama model configuration
│   ├── Dockerfile             # Sandboxed Node image (Kali + 16 tools)
│   ├── compose.yaml           # Docker Compose: the Node, sandboxed
│   └── compose.local.yaml     # macOS override (bridge network, published :3000)
├── lima/
│   ├── mshin-node.yaml     # Lima template: Node guest (Debian + offensive tools)
│   └── mshin-core.yaml     # Lima template: Core guest (Ollama + CLI)
├── servers/
│   └── src/kali/              # Custom Kali MCP server
│       ├── package.json
│       ├── index.js
│       ├── tools.js
│       ├── tools.test.js
│       ├── transport.test.js
│       └── wordlists/
│           └── sensitive-paths.txt  # High-signal upload/WordPress/dotfile probe list
├── clients/
│   └── mshin-cli/             # MCP client harness: interactive agent loop + single-tool caller
│       ├── package.json
│       ├── index.js           # interactive Ollama-driven agent (mshin)
│       ├── call.js            # single-tool MCP caller (mshin-call)
│       ├── agent.js
│       ├── agent.test.js
│       ├── findings-memory.js
│       ├── findings-memory.test.js
│       ├── session-logger.js
│       ├── eval-harness.js
│       ├── eval-harness.test.js
│       ├── eval-config.example.json
│       └── README.md
└── assets/
    └── logo.txt               # ASCII logo
```

---

## **Contribution Guidelines**

### **1. Code Style**

- Follow **consistent indentation** (4 spaces for Bash/Python, 2 spaces for YAML/JSON).
- Use **descriptive variable and function names**.
- Include **comments** for complex logic or non-obvious steps.
- Keep **commit messages** clear and concise.

### **2. Documentation**

- Update documentation (e.g., `README.md`, `docs/`) for any changes that affect setup or usage.
- Use **clear, step-by-step instructions** with examples.
- Include **screenshots or ASCII diagrams** where helpful.

### **3. Testing**

- Test your changes **locally** before submitting.
- Ensure **backward compatibility** where possible.
- If adding new tools to MCP, verify they work as expected.

### **4. Security**

- **Never commit sensitive data** (e.g., passwords, API keys, private IPs).
- Follow **least privilege principles** for user permissions.
- If adding network-facing features, ensure they are **secure by default**.

---

## **Ways to Contribute**


| Type               | Examples                                   | How to Start                        |
| ------------------ | ------------------------------------------ | ----------------------------------- |
| **Bug Fixes**      | Fix typos, broken scripts, or logic errors | Open an issue or submit a PR        |
| **New Tools**      | Add support for new Kali tools in MCP      | Extend the MCP server configuration |
| **Documentation**  | Improve guides, add examples, or tutorials | Edit files in `/docs`               |
| **Scripts**        | Automate setup or common tasks             | Add to `/scripts`                   |
| **Configurations** | Add new model files or service configs     | Add to `/configs`                   |
| **Workflows**      | Share example prompts or use cases         | Add to `/docs/WORKFLOWS.md`         |


---

## **Acknowledgments**

Thank you to all contributors who help make **Machin Shin** better! Your efforts are woven into the Pattern of this project.

---

## **License**

By contributing to Machin Shin, you agree that your contributions will be licensed under the **MIT License** (see [LICENSE](LICENSE)).

---

*"The Flame of Tar Valon burns bright, but the light of Machin Shin is fueled by its community."*