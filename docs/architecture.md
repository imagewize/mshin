# Avendesora Architecture 🏗️

> *"The Pattern of an Age, the great tapestry of fate, is woven from the threads of every life. Avendesora weaves the threads of your cybersecurity into a shield against the Dark One's storms."*

---

## 🌳 **System Overview**

Avendesora is designed as a **modular, two-node architecture** to balance performance, scalability, and security. The system separates **LLM inference** (resource-intensive) from **tool execution** (Kali Linux), allowing each component to operate at peak efficiency.

```
┌───────────────────────────────────────────────────────────────┐
│                        AVENDESORA SYSTEM                          │
├───────────────────────────┬───────────────────────────────────┤
│   AVENDESORA CORE          │        AVENDESORA NODE            │
│  (GMKtec EVO-X2)           │      (MINISFORUM Mini PC)         │
│                            │                                   │
│  ┌─────────────────────┐  │  ┌─────────────────────────────┐  │
│  │  Ollama              │  │  │  Kali Linux                  │  │
│  │  - Mistral 13B/70B  │◄─┼─►│  - Nmap, Metasploit, etc.      │  │
│  │  - Local Inference   │  │  │  - MCP Server                │  │
│  └─────────────────────┘  │  │  - Tool Execution             │  │
│                            │  └─────────────────────────────┘  │
│  ┌─────────────────────┐  │                                   │
│  │  MCP Client          │◄─┼───────────────────────────────┘  │
│  │  - Bridges LLM and   │  │                                   │
│  │    MCP Server        │  │                                   │
│  └─────────────────────┘  │                                   │
└───────────────────────────┴───────────────────────────────────┘
```

---

## 🧩 **Components**

---

### **1. Avendesora Core (GMKtec EVO-X2)**

**Role:** LLM Inference Server


| **Aspect**      | **Details**                                                      |
| --------------- | ---------------------------------------------------------------- |
| **Hardware**    | GMKtec EVO-X2 (Ryzen AI Max+ 395, 128GB RAM, 2TB SSD)            |
| **Purpose**     | Runs the LLM (Mistral 13B/70B) and handles inference requests    |
| **Software**    | Ollama, MCP Client                                               |
| **Models**      | Mistral 13B (Q4_K_M, ~8GB), Mistral 70B (Q4_K_M, ~40GB)          |
| **Performance** | 10–20 tokens/sec for 70B models, 20–30 tokens/sec for 13B models |
| **Network**     | Connects to Avendesora Node via MCP (port 3000)                  |


**Why This Hardware?**

- **128GB RAM**: Allows running **70B models** with quantization.
- **Ryzen AI Max+ 395**: High-performance CPU with **Radeon 8060S iGPU** for inference acceleration.
- **2TB SSD**: Stores multiple LLM models and datasets.

---

### **2. Avendesora Node (MINISFORUM Mini PC)**

**Role:** Kali Linux + MCP Server


| **Aspect**   | **Details**                                                          |
| ------------ | -------------------------------------------------------------------- |
| **Hardware** | MINISFORUM UM790 Pro (Ryzen 7 8845HS, 32GB RAM, 1TB SSD)             |
| **Purpose**  | Runs Kali Linux tools and exposes them via MCP to the LLM            |
| **Software** | Kali Linux, MCP Server, Nmap, Metasploit, Searchsploit, Nikto, WHOIS |
| **Tools**    | Any Kali tool can be exposed via MCP (customizable)                  |
| **Network**  | Hosts MCP server on port 3000, accessible by Avendesora Core         |


**Why This Hardware?**

- **32GB RAM**: More than enough for Kali Linux and MCP server.
- **Ryzen 7 8845HS**: Fast CPU for tool execution.
- **Compact**: Fits anywhere, low power consumption.

---

### **3. Model Context Protocol (MCP)**

**Role:** Bridge Between LLM and Tools

MCP is an **open protocol** that allows LLMs to interact with external tools and data sources. In Avendesora:

- The **MCP Server** runs on the Avendesora Node and exposes Kali tools as callable functions.
- The **MCP Client** runs on the Avendesora Core and lets the LLM call these functions.

**Example Flow:**

```
User → LLM (Avendesora Core) → MCP Client → MCP Server (Avendesora Node) → Kali Tool → Response
```

**Supported Tools (Default):**

- `nmap` (Network scanning)
- `metasploit` (Exploit framework)
- `searchsploit` (Exploit database)
- `nikto` (Web server scanner)
- `whois` (Domain information)
- Custom tools can be added by extending the MCP server.

---

## 🔄 **Data Flow**

```mermaid
graph TD
    A[User Prompt] -->|Sent to| B[Avendesora Core]
    B -->|Processes with| C[LLM: Mistral 13B/70B]
    C -->|Needs tool?| D{MCP Client}
    D -->|Calls| E[MCP Server on Avendesora Node]
    E -->|Executes| F[Kali Tool: Nmap/Metasploit/etc.]
    F -->|Returns result| E
    E -->|Sends back| D
    D -->|Receives| C
    C -->|Generates response| B
    B -->|Returns to| A
```

---

### **Example: Vulnerability Scan Workflow**

1. **User Input:**
  ```
   "Avendesora, scan 192.168.1.1 for vulnerabilities and suggest exploits."
  ```
2. **Avendesora Core (LLM):**
  - Analyzes the request and determines it needs to run `nmap` and `searchsploit`.
  - Sends a request to the MCP Client.
3. **MCP Client:**
  - Forwards the request to the MCP Server on Avendesora Node.
4. **Avendesora Node (MCP Server):**
  - Executes `nmap -sV 192.168.1.1` via the `nmap` tool.
  - Parses the output and identifies `OpenSSH 8.9`.
  - Executes `searchsploit openssh 8.9` via the `searchsploit` tool.
  - Returns the results (e.g., CVE-2026-1234) to the MCP Client.
5. **Avendesora Core (LLM):**
  - Receives the tool outputs and generates a response:
6. **User Output:**
  - Receives the analysis and recommended actions.

---

## 🔧 **Customization**

### **Adding New Tools to MCP Server**

To expose additional Kali tools via MCP:

1. Edit the MCP server configuration on the Avendesora Node:
  ```bash
   node index.js --tools nmap,metasploit,searchsploit,nikto,whois,new_tool
  ```
2. Ensure the new tool is installed on the Avendesora Node:
  ```bash
   sudo apt install new_tool
  ```
3. Restart the MCP server:
  ```bash
   sudo systemctl restart avendesora-node
  ```

### **Switching LLM Models**

To use a different model on the Avendesora Core:

```bash
# Pull a new model
ollama pull llama2:70b

# Update the MCP client command
mcp-client --llm cmd:ollama --llm-args llama2:70b --mcp-server http://192.168.1.100:3000
```

---

## 🛡️ **Security Considerations**

### **Network Isolation**

- **Recommended:** Place the Avendesora Node on a **separate VLAN** if handling sensitive data.
- **Firewall Rules:** Restrict access to the MCP server (port 3000) to only the Avendesora Core’s IP.

### **User Permissions**

- **Avendesora Node:** Create a dedicated user (`avendesora`) with restricted `sudo` access for tools.
- **SSH Access:** Use SSH keys (disable password authentication) for remote access.

### **Data Privacy**

- **No Cloud Dependencies:** All data and tools run locally.
- **Offline Mode:** The system can operate entirely offline after initial setup.

---

## 📊 **Performance Metrics**


| **Task**              | **Avendesora Core (EVO-X2)** | **Avendesora Node (UM790 Pro)** | **End-to-End Latency** |
| --------------------- | ---------------------------- | ------------------------------- | ---------------------- |
| Mistral 13B Inference | 20–30 tokens/sec             | N/A                             | <1 sec                 |
| Mistral 70B Inference | 10–20 tokens/sec             | N/A                             | <2 sec                 |
| Nmap Scan             | N/A                          | ~5–10 sec (depends on target)   | <15 sec                |
| Searchsploit Query    | N/A                          | ~1–2 sec                        | <5 sec                 |
| Metasploit Command    | N/A                          | ~3–5 sec                        | <10 sec                |


---

## 🌳 **Wheel of Time Parallels**


| **Avendesora System**  | **Wheel of Time Lore**                | **Symbolism**                                       |
| ---------------------- | ------------------------------------- | --------------------------------------------------- |
| **Avendesora Core**    | The **Avendesora Tree**               | Roots = Stability, Branches = Growth                |
| **Avendesora Node**    | **Rhuidean** (City of the Aiel)       | Center of wisdom and resilience                     |
| **MCP Protocol**       | The **One Power**                     | Channels tools like Aes Sedai channel the One Power |
| **LLM + Tools**        | **Ta’veren** (Shapers of the Pattern) | Your system shapes the "Pattern" of cybersecurity   |
| **Network Connection** | The **Threads of the Pattern**        | Data flows like threads in the Pattern              |


---

## 🔮 **Future Extensions**

### **1. Multi-Node Support**

- Add more **Avendesora Nodes** for distributed tool execution (e.g., one for network scanning, one for exploit development).

### **2. Custom LLM Fine-Tuning**

- Fine-tune Mistral 7B/13B on cybersecurity datasets for **domain-specific knowledge** (see `docs/fine-tuning.md` in future updates).

### **3. Web Interface**

- Build a **React-based dashboard** to interact with Avendesora via a browser.

### **4. Automated Workflows**

- Create **scripts** to automate common tasks (e.g., daily vulnerability scans).

---

## 📚 **References**

- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/specification)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Kali Linux Tools](https://www.kali.org/tools/)
- [Wheel of Time Wiki: Avendesora](https://wot.fandom.com/wiki/Avendesora)

---

*"The Wheel weaves as the Wheel wills. With Avendesora, you weave with it."*