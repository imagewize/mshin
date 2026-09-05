# Cybersecurity Agent Roadmap: Extending Avendesora to a Claude Code-like Experience

> *"The Wheel weaves as the Wheel wills. With Avendesora, you weave the threads of security into an unbreakable pattern."*

---

## Overview

This document outlines the path to transforming Avendesora from a **local LLM + Kali tool integration** system into a **full-fledged cybersecurity agent** akin to Claude Code but specialized for penetration testing, threat analysis, and incident response.

The existing Avendesora architecture (two-machine setup with Ollama + MCP + Kali Linux) gets the **plumbing** right: secure, local tool execution wired to an LLM. But be honest about what's done. The plumbing is maybe 80% there; the **value** of a Claude Code–style agent lives in the *harness* — the agent loop, context management, safety gating, and reporting — and that's the 80% still to build. Getting an open-weight model to tool-call reliably through long, noisy security sessions is the hard part, not the wiring.

---

## Current State vs. Target State

| **Aspect**               | **Current (Avendesora)**                          | **Target (Cybersecurity Agent)**                     |
|--------------------------|--------------------------------------------------|----------------------------------------------------|
| **Architecture**         | Two-machine (Core + Node)                        | Same, with optional cloud/hybrid                    |
| **LLM Integration**      | Ollama + MCP Client                              | Enhanced with agent loops                           |
| **Tool Execution**       | MCP Server + Kali tools                          | Sandboxed, audited, with safety constraints          |
| **User Interface**       | CLI (mcp-client)                                 | CLI + Web UI (optional)                             |
| **Workflow**             | Manual prompts                                   | Multi-step, context-aware, autonomous                |
| **State Management**     | Stateless                                       | Session persistence (Redis/PostgreSQL)             |
| **Reporting**            | Raw tool output                                  | Structured, actionable insights                     |

---

## Hardware Considerations (2026)

### RAM Pricing Surge
As of September 2026, DDR5 module prices have risen sharply on AI-driven demand (the figures below are **rough estimates**, not quoted prices — verify before purchasing):

| **Component**              | **2024 Price** | **2026 Price (est.)** | **Notes**                                    |
|----------------------------|---------------|-----------------------|----------------------------------------------|
| 128GB DDR5 DIMMs           | ~$300–400     | **~$3,000+**          | Only relevant to a build-your-own DIMM rig   |
| GMKtec EVO-X3 (128GB/2TB)  | ~$2,300       | **~$3,800**           | Current SKU, Ryzen AI Max+ 395, soldered LPDDR5X |
| RTX 4090 (24GB)            | ~$1,600       | ~$1,800               | Discrete GPU path (see caveats below)        |

> **First: don't buy anything yet.** With memory priced like this, the cheapest correct move is to run the Core on a machine you already own. A 32GB desktop or Mac runs `mistral-small` (24B) fine, and the work that remains on this roadmap — the agent loop, context management, safety gating, reporting — is **model-agnostic harness code**. You can build and test all of it against a 24B model, then let real measurements (tokens per session, context high-water mark, tool-call success rate by model) tell you which box to buy. See [Sizing the Core](architecture.md#sizing-the-core).
>
> **If you do buy, the unified-memory APU is still the right shape — even at ~$3,800.** The surge hits **memory chips across the board**, so these boxes climbed too. The current-gen **GMKtec EVO-X3** (Ryzen AI Max+ 395, 128GB, 2TB) lists around **$3,800**. It is genuinely pricey, and it is genuinely close to the best local-inference machine available at that price. But the comparison that matters is *cost per GB of model-capable memory*. A discrete build that can hold a Q4 70B needs both a 48GB-class card (or 2× 24GB) **and** a big DIMM kit — realistically **~$7,000–8,000** once you add CPU/board/PSU — and it still caps at the card's VRAM. The single ~$3,800 APU box holds a Q4 70B (and even a ~120B MoE) in its 128GB unified pool: roughly **half the cost for more model capacity**. At that tier 128GB is the floor — a 64GB SKU of the same machine loses the 70B/120B headroom that is the entire reason to buy it. But that is an argument about *which* box to buy, not about *whether* you need one.

### Model VRAM / Memory Requirements

Sizes are for a Q4_K_M quant unless noted. On a unified-memory APU, "VRAM" is drawn from the shared 128GB pool rather than a discrete card.

| **Model**                  | **Precision** | **Memory** | **Fits on**                                        |
|----------------------------|---------------|------------|----------------------------------------------------|
| Mistral Small 3 (24B)      | Q4_K_M        | ~14GB      | Any 16GB+ GPU, or the APU with room to spare       |
| Llama 3.3 70B              | Q4_K_M        | ~40GB      | RTX 6000 Ada (48GB), 2× 3090/4090, or the 128GB APU|
| gpt-oss-120b (MoE)         | native ~MXFP4 | ~65GB      | 128GB unified APU, or 2× 48GB cards                 |
| Llama 3.3 70B              | FP16          | ~140GB     | Multi-GPU only (e.g. 2× A100 80GB)                  |

**Key Insight**: the 128GB unified-memory box runs everything up to a ~120B MoE **without a discrete GPU**. A single RTX 6000 Ada (48GB) also runs a Q4 70B, but costs more and caps you at 48GB. Full-precision or >120B models need multi-GPU or cloud.

**The counter-insight, which matters more day to day**: on a ~256 GB/s memory bus a *dense* Q4 70B is bandwidth-starved — ~40GB read per token puts a hard ceiling near 6 tok/s. The 128GB pool earns its money on **MoE** models instead: `gpt-oss-120b` needs ~65GB resident but activates only ~5B parameters per token, so it is several times faster than the dense 70B on the same box. If you buy 128GB, buy it for the MoE model. And note what this implies for the low end: a 24B model on a 32GB machine is *not* slow — it reads only ~14GB per token and is the most responsive option of the lot.

---

## Cloud vs. Local: Deployment Options

### Option A: Pure Local — Hardware You Already Own (Start Here)
```
┌──────────────────────┐     ┌───────────────────┐
│ Existing desktop/Mac │     │ Kali Node         │
│ - 32GB+ RAM          │<───>│ - Kali + MCP      │
│ - Mistral Small 24B  │     │ - Static IP       │
│ - Ollama + CLI       │     │ (cheap box or VM) │
└──────────────────────┘     └───────────────────┘
```
- **Cost**: **$150–350** (the Kali Node only — the Core is hardware you have)
- **Pros**: Zero inference spend; 24B tool-callers are reliable and fast; no exposure to the RAM-price surge; proves the harness before it costs anything
- **Cons**: No 70B/120B headroom; long, noisy agent sessions will eventually pressure a 32GB context budget
- **Graduate when**: you measure context overflow, or a 24–32B model demonstrably fails the tool-calling reliability bar your loop needs — not before

### Option A′: Pure Local — Unified-Memory APU (The Upgrade Target)
```
┌──────────────────────┐     ┌───────────────────┐
│ GMKtec EVO-X3        │     │ Kali Node         │
│ - Ryzen AI Max+ 395  │<───>│ - Kali + MCP      │
│ - 128GB unified      │     │ - Static IP       │
│ - Llama 3.3 70B (Q4) │     │ (cheap box or VM) │
└──────────────────────┘     └───────────────────┘
```
- **Cost**: ~**$4,000–4,500** (EVO-X3 128GB ~$3,800 + a cheap/repurposed Kali Node)
- **Pros**: Single box holds a Q4 70B (or ~120B MoE) with no discrete GPU; lowest cost-per-capacity; air-gapped capable; low idle power
- **Cons**: Lower peak throughput than a discrete GPU (~10–20 tok/s on 70B); soldered RAM is not upgradeable

### Option A″: Pure Local — Discrete GPU (only if you need the throughput)
```
┌──────────────────────┐     ┌──────────────┐
│ Workstation          │     │ Kali Node    │
│ - RTX 6000 Ada 48GB  │<───>│ - Kali + MCP │
│ - 64–128GB DIMM RAM  │     │ - Static IP  │
│ - Llama 3.3 70B (Q4) │     └──────────────┘
└──────────────────────┘
```
- **Cost**: ~**$7,000–8,000** (48GB-class card + DIMM RAM at 2026 prices + CPU/board/PSU)
- **Pros**: Much higher throughput; upgradeable
- **Cons**: ~2× the cost for *less* memory headroom than the APU; capped at the card's VRAM; the DIMM-price surge hits this build hardest

### Option B: Hybrid Cloud + Local Tools
```
┌─────────────────┐     ┌─────────────────┐
│ RunPod/Lambda   │<───>│ Local Kali Node │
│ - A100/RTX 6000 │     │ - MCP Server    │
│ - 48–80GB VRAM  │     │ - on YOUR LAN   │
└─────────────────┘     └─────────────────┘
```
- **Cost**: ~$500–2,000/month (cloud GPU) + one-off ~$700 (local Node)
- **Pros**: Lower upfront, scalable, no RAM-pricing risk on the inference side
- **Cons**: Cloud dependency, latency, ongoing costs
- **Why the Node stays local (important):** keep the *inference* in the cloud but the *Kali tools* on your own LAN. Running nmap/Metasploit/etc. **from** a cloud provider's IP is an acceptable-use/abuse-report problem and can get the instance suspended — providers (Hetzner especially) treat outbound offensive traffic as abuse. Cloud is for the brain, not the hands.

### Option C: Full Cloud (For Teams)
```
┌─────────────────────────────────────────────────┐
│ RunPod/Lambda Labs                              │
│ - A100/H100 instance (80GB+ VRAM)               │
│ - Docker container with Kali + MCP              │
│ - Llama 3.3 70B / gpt-oss-120b (or a fine-tune) │
└─────────────────────────────────────────────────┘
```
- **Cost**: $500–2,000/month
- **Pros**: Zero hardware hassle, team access, auto-scaling
- **Cons**: Not air-gapped, recurring costs, vendor lock-in. **Kali-in-the-cloud caveat:** only viable when targets are your own cloud lab or the engagement scope explicitly permits the source IP — check the provider's AUP first, or you risk suspension for outbound offensive traffic.

---

## Cloud Provider Comparison (2026)

Prices below are **indicative ballparks** — check live pricing before committing.

| **Provider**   | **Best For**               | **Consumer GPU**   | **A100/H100 Price** | **Uptime/SLA**       | **Key Features**                |
|---------------|----------------------------|--------------------|---------------------|-----------------------|---------------------------------|
| **RunPod**    | Production inference       | ~$0.34–0.69/hr     | H200: ~$4.39/hr     | Secure Cloud: SLA     | Serverless, per-second billing  |
| **Vast.ai**   | Cheapest, interruptible    | ~$0.35/hr (spot)   | Varies              | None                  | Marketplace, variable pricing   |
| **Lambda**    | Enterprise, reliability    | N/A                | A100: ~$2.06/hr     | 99.9% SLA             | Dedicated, InfiniBand           |
| **Hetzner**   | Cheap dedicated GPU box    | RTX 4000 Ada 20GB  | Not offered         | Standard              | **Monthly** dedicated, not hourly |

**Recommendation**:
- **For production / burst inference**: RunPod (balance of cost and reliability; good VRAM options)
- **For experimentation**: Vast.ai (cheapest, but interruptible spot)
- **For enterprise**: Lambda Labs (SLA, support, InfiniBand)
- **On Hetzner specifically**: it's a *dedicated monthly* GPU server, not an hourly cloud GPU. The affordable tier is the **RTX 4000 Ada (20GB VRAM)** — fine for models up to ~24–32B, **but it cannot hold a Q4 70B**. Good as a cheap always-on box for a smaller model or as the control-plane/dashboard host; not the right tool for large-model inference or (per the AUP note above) for running Kali tools.

---

## Open-Weight Model Recommendations

For an **agent**, the thing that matters most is *reliable, repeated tool-calling* — emitting well-formed tool calls, reading results, and deciding the next step — not raw benchmark IQ. That reshuffles the usual leaderboard. The models below are all real and pullable in Ollama (`ollama pull <tag>`), ordered by how well they fit a single 128GB box.

| **Model**                | **Tag**          | **Size (active)** | **Memory (Q4/native)** | **Why it's here**                                              | **Best for**                     |
|--------------------------|------------------|-------------------|------------------------|----------------------------------------------------------------|----------------------------------|
| **Mistral Small 3**      | `mistral-small`  | 24B dense         | ~14GB                  | Strong tool-caller, low footprint, keeps the Mistral lineage   | Default / fast interactive agent |
| **Qwen3 32B**            | `qwen3:32b`      | 32B dense         | ~20GB                  | Currently one of the most dependable open tool-callers         | Balanced agent brain             |
| **Llama 3.3 70B**        | `llama3.3:70b`   | 70B dense         | ~40GB                  | Well-supported, strong general reasoning, fits the APU         | Capable general agent            |
| **gpt-oss-120b**         | `gpt-oss:120b`   | 120B MoE (~5B)    | ~65GB                  | Purpose-built for agentic tool use; MoE = fast for its size    | Best single-box agent, if it fits|
| **Qwen3 235B-A22B**      | `qwen3:235b`     | 235B MoE (22B)    | ~120GB+ / cloud        | Top-tier reasoning + tools                                     | Multi-tool workflows (cloud)     |
| **GLM-4.6**              | `glm-4.6`*       | ~200B+ MoE        | cloud                  | Excellent agentic/coding-style orchestration                   | High-level orchestration (cloud) |

<sub>Active-parameter count in parentheses for MoE models drives speed; total size drives memory. `*` GLM tag/availability varies — confirm before pulling. Memory figures are approximate Q4 unless the model ships a native low-bit format (gpt-oss uses ~MXFP4).</sub>

**Practical Recommendation**:
- **Start with `mistral-small` (24B)** for fast iteration while you build the agent loop — it tool-calls well and leaves headroom.
- **Graduate to `llama3.3:70b` or `gpt-oss-120b`** on the 128GB box once workflows get longer and noisier; gpt-oss-120b is the standout if you want the most agent-capable model that still fits a single box.
- **Fine-tuning is a later, optional step, not a starting point.** A LoRA on CVE / MITRE ATT&CK / Exploit-DB data can sharpen a base model, but a good instruction-tuned tool-caller out of the box beats a naively fine-tuned weaker model for *agent* work. Prove the harness first, then fine-tune only if you hit a concrete knowledge gap.
- Avoid the trap of reaching straight for a 235B/671B model — for this workload a reliable 24–70B tool-caller you can actually run locally beats a giant model you have to rent.

---

## Agent Architecture: What’s Missing

To transform Avendesora into a true cybersecurity agent, implement the following components:

### 1. Agent Loop (Core Component)

The agent needs an **observe-decide-act** loop. A common mistake is to have the LLM **generate a full plan up front and then execute every step**. For security recon that's the wrong shape: each result should determine the *next* call. An nmap scan that finds a web server on :8080 should make the model *decide* to run Nikto against :8080 — it can't know that at plan time. So the model chooses **one tool at a time**, sees the real result, and picks the next action (the ReAct pattern). A cheap "plan" step can still seed a rough strategy, but the loop, not a pre-baked list, drives execution.

```python
from typing import List, Dict, Optional
from mcp import Client  # Your existing MCP client

class CybersecurityAgent:
    def __init__(self, mcp_client: Client, llm_model: str = "mistral-small"):
        self.mcp = mcp_client
        self.llm = llm_model
        self.memory = []  # Running transcript: (thought, tool, args, result)

    def decide_next(self, user_goal: str, tools: List[Dict]) -> Dict:
        """Ask the LLM for the SINGLE next action, given everything seen so far.

        Returns either {"action": "tool", "tool": ..., "args": {...}}
        or {"action": "finish", "answer": ...}. Uses the model's native
        tool-calling / structured-output interface — do NOT parse free text.
        """
        return self.query_llm_structured(
            goal=user_goal,
            tools=tools,                 # full JSON schemas, not just names
            history=self._compact_history(),  # summarized to fit context
        )

    def act(self, tool: str, args: Dict) -> Dict:
        """Execute one tool call via MCP, with safety limits applied."""
        result = self.mcp.call(tool, **args)          # timeouts/sandbox enforced server-side
        self.memory.append({"tool": tool, "args": args, "result": result})
        return result

    def run(self, user_goal: str, max_steps: int = 25) -> str:
        """Interleaved observe-decide-act loop with a hard step budget."""
        tools = self.mcp.list_tools()                 # schemas, not bare names
        for _ in range(max_steps):
            step = self.decide_next(user_goal, tools)
            if step["action"] == "finish":
                return step["answer"]
            # Guardrail: gate active/destructive tools on explicit approval + scope.
            if self.is_active_tool(step["tool"]) and not self.approved(step):
                self.memory.append({"blocked": step, "reason": "needs approval / out of scope"})
                continue
            self.act(step["tool"], step["args"])
        return self._synthesize_report()              # step budget exhausted → report what we have
```

Key differences from a naive plan-then-run agent:
- **One decision per turn**, grounded in the *actual* previous result (handles branching recon).
- **Native tool-calling / structured output**, never regex over free-form model text.
- **Full tool schemas** passed to the model — constrained inputs make weaker open models far more reliable.
- **A hard step budget** and an **active-tool approval gate** so an autonomous loop can't run away or fire an exploit unprompted.

### 2. Context Management
- **Problem**: LLMs have limited context windows (~32K–128K tokens). Long-running security tasks (e.g., full network scans) generate too much data.
- **Solution**: Use **external memory** (Redis, PostgreSQL) to store:
  - Session history
  - Tool results (compressed/summarized)
  - Intermediate findings

```python
# Example: Redis-based memory
import redis

r = redis.Redis(host='localhost', port=6379, db=0)

class AgentMemory:
    def store_result(self, session_id: str, step: int, result: Dict):
        key = f"session:{session_id}:step:{step}"
        r.set(key, json.dumps(result))
        r.lpush(f"session:{session_id}:history", key)
    
    def get_context(self, session_id: str, max_tokens: int = 32000) -> str:
        """Retrieve context-aware history for the LLM."""
        history = r.lrange(f"session:{session_id}:history", 0, -1)
        # Summarize history to fit within max_tokens
        return self.summarize(history, max_tokens)
```

### 3. Tool Safety & Sandboxing
- **Problem**: Kali tools (e.g., Metasploit) are powerful and potentially destructive.
- **Solution**: Run tools in **sandboxed containers** with:
  - Network isolation
  - Resource limits (CPU, memory, timeouts)
  - Read-only filesystems (where applicable)

```yaml
# Example: Docker Compose for sandboxed Kali tools
version: '3.8'
services:
  kali-sandbox:
    image: kalilinux/kali-rolling
    container_name: avendesora-sandbox
    networks:
      - avendesora-net
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN  # Required for nmap, etc.
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid
    mem_limit: 4g
    cpu_shares: 512
```

### 4. Reporting Engine
- **Problem**: Raw tool output is hard to interpret.
- **Solution**: Parse tool results into **structured reports** with:
  - Executive summary
  - Technical findings (tables, CVEs)
  - Risk scores
  - Remediation steps

```python
# Example: Nmap report parser
import xml.etree.ElementTree as ET

def parse_nmap_xml(xml_output: str) -> Dict:
    root = ET.fromstring(xml_output)
    report = {
        "hosts": [],
        "vulnerabilities": []
    }
    for host in root.findall("host"):
        host_data = {
            "ip": host.find("address").get("addr"),
            "ports": []
        }
        for port in host.findall("ports/port"):
            service = port.find("service")
            host_data["ports"].append({
                "number": port.get("portid"),
                "state": port.get("state"),
                "service": service.get("name") if service is not None else "unknown",
                "version": service.get("version") if service is not None else None
            })
        report["hosts"].append(host_data)
    return report
```

---

## Implementation Roadmap

### Phase 1: Foundation (1–2 Weeks)
**Goal**: Harden existing setup and add basic agent capabilities.

- [ ] Fix bash scripts (`setup_mcp_server.sh`, `setup_ollama.sh`):
  - Add missing `#` prefixes to comments
  - Add `\` line continuations for multi-line commands
- [ ] Add **agent loop** (Python class as shown above)
- [ ] Implement **session memory** (SQLite is plenty for a single operator; Redis only if you go multi-user)
- [ ] Test with **`mistral-small` (24B)** (lower resource requirements, good tool-caller)

**Deliverable**: A working agent that can chain 2–3 tools together.

---

### Phase 2: Scale & Specialization (1–2 Months)
**Goal**: Scale to larger models and add security-specific features.

- [ ] **Hardware Decision** — make it *after* Phase 1, using measurements from the harness (tokens/session, context high-water mark, tool-call success rate), not before:
  - **Stay on Option A**: if a 24–32B model is clearing your reliability bar, buy nothing
  - **Option A′**: GMKtec EVO-X3, 128GB unified (~$3,800) — holds Q4 70B and up to a ~120B MoE; the right buy if you need a bigger *model*
  - **Option A″**: RTX 6000 Ada (48GB) + DIMM RAM (~$7k–8k) — only if you need raw throughput
  - **Option B**: RunPod A100 (~$2/hr, pay-as-you-go) — the cheapest way to *test* whether a 70B/120B actually helps before committing to hardware
- [ ] **Model**: evaluate `qwen3:32b` first (still fits a 64GB box); deploy `llama3.3:70b` or `gpt-oss-120b` only if the 32B tier measurably falls short
- [ ] **Fine-tuning (optional, only if a knowledge gap shows up)**:
  - Collect cybersecurity datasets (CVE, MITRE ATT&CK, Exploit-DB)
  - LoRA-tune `mistral-small` on security-specific tasks — after the harness is proven, not before
- [ ] **Tool Expansion**:
  - Add 5–10 new Kali tools to MCP server
  - Implement tool safety constraints (sudoers, sandboxing)

**Deliverable**: A scalable agent capable of running complex security workflows.

---

### Phase 3: Production-Ready (3–6 Months)
**Goal**: Build a production-grade cybersecurity agent.

- [ ] **Web UI**:
  - FastAPI backend
  - React/Vue.js frontend
  - Real-time tool output streaming
- [ ] **Multi-Node Support**:
  - Load balancing across multiple Kali Nodes
  - Distributed tool execution
- [ ] **Advanced Features**:
  - Scheduled scans
  - Automated reporting (PDF, Markdown)
  - Integration with SIEMs (Splunk, ELK)
- [ ] **Security Hardening**:
  - TLS for MCP server
  - Authentication/authorization
  - Audit logging

**Deliverable**: A full-featured cybersecurity agent ready for team use.

---

## Example Workflows

### Workflow 1: Automated Vulnerability Assessment
```
User Input: "Avendesora, perform a full vulnerability assessment on 192.168.1.0/24."

Agent Plan:
1. Run nmap -sV --script vuln 192.168.1.0/24
2. Parse results for open services and versions
3. For each service, query Searchsploit for known exploits
4. Run Nikto on any web servers found
5. Generate a prioritized report with CVSS scores

Output:
- Structured report with:
  - List of vulnerable hosts
  - CVE IDs and CVSS scores
  - Recommended remediation steps
```

### Workflow 2: Incident Response
```
User Input: "Avendesora, investigate this suspicious IP: 203.0.113.45."

Agent Plan:
1. Run whois 203.0.113.45
2. Query AbuseIPDB for threat intelligence
3. Run nmap -A 203.0.113.45 (if authorized)
4. Check for open proxies or VPNs
5. Generate threat assessment

Output:
- Threat actor attribution (if possible)
- Malicious activity indicators
- Recommended firewall rules
```

### Workflow 3: Exploit Development
```
User Input: "Avendesora, help me develop an exploit for CVE-2026-1234."

Agent Plan:
1. Look up CVE-2026-1234 in local database
2. Search Searchsploit for existing exploits
3. If no exploit exists, generate Metasploit module scaffolding
4. Provide testing guidance (sandboxed!)

Output:
- Exploit code template
- Testing instructions
- Safety warnings
```

---

## Success Metrics

| **Metric**               | **Phase 1 Goal** | **Phase 2 Goal** | **Phase 3 Goal** |
|--------------------------|------------------|------------------|------------------|
| Tools Supported          | 5+               | 20+              | 50+              |
| Concurrent Users         | 1                | 3                | 10+              |
| Inference Latency (70B, first token) | N/A     | <5s              | <2s              |
| Workflow Steps           | 2–3              | 5–10             | 20+              |
| Uptime                    | 90%              | 95%              | 99.9%            |
| Mean Time Between Errors | 1 day            | 1 week           | 1 month          |

---

## Risk Mitigation

| **Risk**                          | **Impact**       | **Mitigation**                                  |
|-----------------------------------|------------------|-----------------------------------------------|
| Tool misuse (e.g., accidental DoS)| High             | Sandboxing, timeouts, user confirmation prompts |
| LLM hallucinations                | Medium           | Ground responses in tool outputs, citations    |
| Hardware failure                 | High             | Redundant Nodes, cloud fallback                |
| Data exfiltration                 | Critical        | Air-gapped option, encryption, access controls  |
| Model bias                       | Medium           | Fine-tuning on diverse datasets               |
| Cost overruns (cloud)             | Medium           | Budget alerts, spot instance checks            |

---

## Resources & References

### Datasets for Fine-Tuning
- [CVE Details](https://www.cvedetails.com/)
- [MITRE ATT&CK](https://attack.mitre.org/)
- [Exploit-DB](https://www.exploit-db.com/)
- [OSV (Open Source Vulnerabilities)](https://osv.dev/)

### Frameworks & Libraries
- [LangGraph](https://github.com/langchain-ai/langgraph) – Agent workflows
- [CrewAI](https://github.com/joaomdmoura/crewAI) – Multi-agent orchestration
- [MCP Servers](https://github.com/modelcontextprotocol/servers) – Tool integration
- [FastAPI](https://fastapi.tiangolo.com/) – Web backend
- [Redis](https://redis.io/) – Session memory

### Cloud Providers
- [RunPod](https://runpod.io/) – Recommended for production
- [Vast.ai](https://vast.ai/) – Cheapest for experimentation
- [Lambda Labs](https://lambdalabs.com/) – Enterprise-grade
- [Hetzner](https://www.hetzner.com/) – Budget-friendly

---

## Conclusion

Avendesora has the **foundation** right — the Ollama + MCP + Kali architecture is a sound, extensible base. But the agent *brain* is the real work: don't mistake working plumbing for a finished agent. The remaining effort is the harness (loop, memory, safety gating, reporting), and getting a local open-weight model to drive it reliably.

**Key Takeaways**:
1. **Hardware**: start on a 32GB machine you already own — RAM buys model *capacity*, not speed, and a 24B tool-caller runs the whole system today. When you outgrow it, the 128GB unified-memory APU (GMKtec EVO-X3, ~$3,800) is the cost-per-capacity winner — roughly half the price of a discrete-GPU 70B build for *more* headroom — and at that tier it's 128GB or don't bother. Buy it for the MoE model (`gpt-oss-120b`), not for the bandwidth-starved dense 70B.
2. **Models**: there is no "Mistral 13B/70B" — use real, tool-calling open weights. Start with `mistral-small` (24B), graduate to `llama3.3:70b` or `gpt-oss-120b`. Fine-tune later, only if a knowledge gap appears.
3. **Cloud**: RunPod/Lambda for burst inference; keep the **Kali Node local** (running offensive tools from a cloud IP is an AUP problem). Hetzner's cheap GPU tier is 20GB VRAM — too small for a 70B.
4. **Agent**: the hard 80%. Focus on an **interleaved observe-decide-act loop** (one tool at a time), **context management**, **safety gating**, and **structured reporting**.

> *"The Avendesora tree grew from a single seed. So too does this system grow from a solid foundation into a mighty force for security."*

---

*Document Status: Draft*
*Last Updated: 2026-09-05*
*Author: Jasper Frumau (with Mistral Vibe)*
