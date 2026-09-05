# Contributing to Avendesora

> *"The Aiel say, 'The way of the leaf is the way of the coward.' But in the world of code, the way of the leaf is the way of collaboration. Together, we weave a stronger Pattern."*

We welcome contributions to **Avendesora**! Whether you're fixing bugs, adding new tools, or improving documentation, your help is valuable. Here's how to get started.

---

## **Code of Conduct**

By participating in this project, you agree to abide by the **[Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/0/code_of_conduct.html)**. Be respectful, inclusive, and collaborative.

---

## **How to Contribute**

### **1. Reporting Bugs**

If you find a bug, please [open an issue](https://github.com/your-repo/avendesora/issues) with:

- A **clear title** describing the issue.
- A **detailed description** of the problem, including:
  - Steps to reproduce.
  - Expected vs. actual behavior.
  - Screenshots or logs (if applicable).
- Your **environment** (OS, hardware, versions of Avendesora components).

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
5. **Push to your fork** and submit a pull request to the `main` branch.

---

## **Development Setup**

### **Prerequisites**

- **Avendesora Node:** MINISFORUM mini PC (or equivalent) with Kali Linux.
- **Avendesora Core:** GMKtec EVO-X3 (or equivalent) with Ubuntu/Debian.
- **Basic knowledge** of Linux, networking, and Git.

### **Setting Up a Development Environment**

1. Clone the repository:
  ```bash
   git clone https://github.com/your-repo/avendesora.git
   cd avendesora
  ```
2. Set up the **Avendesora Node** and **Avendesora Core** as described in the [Setup Guide](docs/setup.md).
3. Test your changes locally before submitting a pull request.

---

## **Project Structure**

```
avendesora/
├── README.md               # Project overview
├── LICENSE                  # MIT License
├── CONTRIBUTING.md         # This file
├── KALI-OPENLLM.md         # Complete single-file master guide
├── docs/
│   ├── architecture.md     # System architecture
│   ├── setup.md           # Setup instructions
│   └── workflows.md        # Example workflows
├── scripts/
│   ├── setup_mcp_server.sh # MCP server setup script
│   └── setup_ollama.sh      # Ollama setup script
├── configs/
│   ├── mcp-kali.service     # systemd service for MCP server
│   └── ollama-modelfile     # Custom Ollama model configuration
└── assets/
    └── logo.txt            # ASCII logo
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
| **Workflows**      | Share example prompts or use cases         | Add to `/docs/workflows.md`         |


---

## **Acknowledgments**

Thank you to all contributors who help make **Avendesora** better! Your efforts are woven into the Pattern of this project.

---

## **License**

By contributing to Avendesora, you agree that your contributions will be licensed under the **MIT License** (see [LICENSE](LICENSE)).

---

*"The Flame of Tar Valon burns bright, but the light of Avendesora is fueled by its community."*