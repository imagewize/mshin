import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  TOOL_PATHS,
  DEFAULT_TIMEOUT_MS,
  SHELL_META_RE,
  SHELL_META_RE_ALLOW_AMP,
  assertTargetInScope,
  assertTargetListInScope,
} from "./config.js";

const execFileAsync = promisify(execFile);

function assertSafe(value, name = "argument", { pattern = SHELL_META_RE } = {}) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (pattern.test(value)) {
    throw new Error(`${name} contains unsafe characters`);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} contains null byte`);
  }
}

function assertSafeArray(arr, name = "argument") {
  if (!Array.isArray(arr)) {
    throw new Error(`${name} must be an array`);
  }
  for (const item of arr) {
    assertSafe(item, name);
  }
}

// Build the `-x` resource script for a Metasploit run: select the module, set
// each option, run it, then `exit`. The trailing `exit` is essential: under
// execFile there is no TTY, so without it msfconsole drops to its interactive
// prompt, never gets input, hangs until the 600s timeout, and exits non-zero —
// so runTool rejects even though the module ran. Verified on the Lima node:
// without `exit` the call hangs; with it a portscan of 127.0.0.1 returns in ~2s.
function buildMsfScript(module, options = {}) {
  assertSafe(module, "module");
  if (!/^[-_/a-zA-Z0-9]+$/.test(module)) {
    throw new Error("module contains invalid characters");
  }

  const scriptParts = [`use ${module}`];
  for (const [key, value] of Object.entries(options)) {
    const k = String(key);
    const v = String(value);
    assertSafe(k, "option key");
    assertSafe(v, "option value");
    scriptParts.push(`set ${k} ${v}`);
  }
  scriptParts.push("run");
  scriptParts.push("exit");
  return scriptParts.join("; ");
}

// enum4linux's CLI is `enum4linux [options] ip` — its Getopt::Std-style
// parser stops scanning for flags at the first non-dash argument, so options
// must precede the target or they're silently ignored.
function buildEnum4linuxArgs(target, options) {
  assertSafe(target, "target");
  const args = [];
  if (options) {
    assertSafe(options, "options");
    args.push(...options.split(/\s+/));
  }
  args.push(target);
  return args;
}

async function runTool(name, args, timeout = DEFAULT_TIMEOUT_MS, { useSudo = true, cwd } = {}) {
  const bin = TOOL_PATHS[name];
  if (!bin) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (!existsSync(bin)) {
    throw new Error(`Tool binary not found: ${bin}. Is ${name} installed?`);
  }

  // When running as the unprivileged mshin user, use sudo so the
  // NOPASSWD allowlist in /etc/sudoers.d/mshin takes effect.
  // tshark is excluded: reading a user-owned PCAP as root triggers Wireshark's
  // file-owner check and fails, and tshark does not need privileges to read
  // capture files anyway.
  // dirb and ffuf are excluded: sudo's env_reset hands them HOME=/root, which
  // ProtectHome=read-only in the unit makes unwritable — dirb dies writing
  // its $HOME/.cache/dirb resume dump on every run, and ffuf fails creating
  // $HOME/.config/ffuf on its first. Neither needs root, and unsudoed they
  // inherit the service user's writable home.
  // wpscan is excluded for the same reason: it caches its database under
  // $HOME/.wpscan, and it is a plain network scanner that needs no
  // privileges.
  // writable-probe's binaries (curl, showmount, smbclient) are excluded too:
  // all three are ordinary network clients that need no privileges, and its
  // curl calls write markers to /tmp, which sudo's env_reset is not needed for.
  const needsSudo = useSudo && process.getuid && process.getuid() !== 0;
  const cmd = needsSudo ? "sudo" : bin;
  const cmdArgs = needsSudo ? ["-n", bin, ...args] : args;

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MiB
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    }));
  } catch (err) {
    // execFile kills the child with SIGTERM when `timeout` elapses. Without
    // this the caller sees a bare "Command failed" and cannot tell a wedged
    // scan from a crashed one.
    if (err.killed || err.signal === "SIGTERM") {
      throw new Error(
        `${name} timed out after ${Math.round(timeout / 1000)}s. Narrow the ` +
          "scan (fewer ports, a smaller wordlist, nikto -Tuning) or raise " +
          "MSHIN_TOOL_TIMEOUT_MS on the Node."
      );
    }
    throw err;
  }

  let output = stdout || "";
  if (stderr) {
    output += "\n--- stderr ---\n" + stderr;
  }
  return output.trim();
}

// Tool-specific timeout ceilings. DEFAULT_TIMEOUT_MS (300s, or the
// MSHIN_TOOL_TIMEOUT_MS override) stays the floor for every tool; tools whose
// legitimate runs are longer get a higher ceiling here. Raising
// MSHIN_TOOL_TIMEOUT_MS raises the floor for all of them — the higher of the
// two always applies.
//
// Measured 2026-10-22 against a remote VPS through the Docker Node:
// nmap -p- on a firewalled host (most ports filtered, so each probe waits out
// a retransmission timeout) does not fit 300s; nikto's full default test set
// and wpscan --enumerate against a remote site do not either.
const NMAP_TIMEOUT_MS = 600_000;
const NIKTO_TIMEOUT_MS = 900_000;
const WPSCAN_TIMEOUT_MS = 900_000;

function toolTimeout(ceilingMs) {
  return Math.max(DEFAULT_TIMEOUT_MS, ceilingMs);
}

// dnsenum's stock wordlist is ~1500 entries. Through a container's DNS
// forwarder that brute force cannot finish inside any sane per-call timeout
// (measured: 280s+ and still running on the Docker Node). The handler
// defaults to this shipped small list instead.
const DEFAULT_DNSENUM_WORDLIST = fileURLToPath(
  new URL("./wordlists/subdomains.txt", import.meta.url)
);

// Host-discovery fabrication guard.
//
// Docker Desktop's NAT (and other virtualization fabrics) answer discovery
// probes on behalf of every address in a scanned range, dead or alive — a
// container-side `nmap -sn <LAN>/24` through the bridge returned all 256
// addresses "up" at sub-millisecond latency when the real segment had 5 live
// hosts (measured 2026-10-21; see docs/DOCKER-LOCAL-DEV.md, Troubleshooting).
// On a real segment that result is impossible: the network and broadcast
// addresses never answer ARP, and sleeping phones do not answer anything.
//
// So instead of handing the model a fabricated host list, the nmap handler
// throws. The heuristic applies only to range scans (`/` in a spec) where
// every single address answered, and only from 17 addresses up — an
// enumerated list of live hosts may legitimately be all-up, and no real /27
// or larger has ever been measured with 100% response.
const FABRICATED_DISCOVERY_THRESHOLD = 17;
const NMAP_DONE_RE = /Nmap done: (\d+) IP addresses? \((\d+) hosts? up\)/;

function assertDiscoveryNotFabricated(flags, specs, output) {
  const isDiscoveryScan = flags.includes("-sn") || flags.includes("-sP");
  if (!isDiscoveryScan) return;
  if (!specs.some((s) => s.includes("/"))) return;
  const m = NMAP_DONE_RE.exec(output);
  if (!m) return;
  const total = parseInt(m[1], 10);
  const up = parseInt(m[2], 10);
  if (total >= FABRICATED_DISCOVERY_THRESHOLD && up === total) {
    throw new Error(
      `Refusing to return a fabricated discovery result: all ${total} addresses ` +
      `in the scanned range reported "up", which is the signature of a NAT'd ` +
      `network position answering probes on behalf of every address, dead or ` +
      `alive (measured on Docker Desktop's bridge). Host discovery from this ` +
      `Node is not trustworthy. Get the live host list from a machine on the ` +
      `physical network (on macOS: scripts/lan_inventory.sh, or ipconfig ` +
      `getifaddr en0, a ping sweep, then arp -a), then scan those hosts ` +
      `individually through this Node — targeted scans are faithful. See ` +
      `docs/DOCKER-LOCAL-DEV.md, Troubleshooting.`
    );
  }
}

// -----------------------------------------------------------------------------
// Tool definitions exposed to MCP clients
// -----------------------------------------------------------------------------

const tools = [
  {
    name: "nmap",
    description:
      "Run an nmap port/service scan against one or more hosts or CIDR ranges. " +
      "Only safe flags are accepted; targets are validated to prevent shell injection.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "IP address, hostname, or CIDR range to scan. A comma-separated list is accepted.",
        },
        targets: {
          type: "array",
          items: { type: "string" },
          description:
            "Multiple IPs/hostnames/CIDR ranges to scan in one call, e.g. a discovered host list. Prefer this over 'target' when scanning several hosts.",
        },
        flags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional nmap flags, e.g. ['-sV'], ['-sS','-p','22,80,443'], ['-A'].",
          default: ["-sV"],
        },
      },
      required: [],
    },
    handler: async ({ target, targets, flags = ["-sV"] }) => {
      assertSafeArray(flags, "flags");
      // nmap takes host specs as separate arguments — a single comma-joined
      // argv is parsed as a hostname and fails with "Failed to resolve"
      // (verified against Kali's nmap 7.991). Accept a single spec, a
      // comma-separated list, or an array, and hand nmap one argv per spec.
      const specs = [];
      const pushSpec = (value, name) => {
        // assertSafe carries the house error messages for non-strings,
        // metacharacters and null bytes; the empty check is separate so
        // assertSafe's /must be a string/ contract tests keep passing.
        assertSafe(value, name);
        // Scope-check every host in the list, not the raw string, so an
        // allowlist of individual IPs admits a discovered host list.
        assertTargetListInScope(value, name);
        specs.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      };
      if (target !== undefined) pushSpec(target, "target");
      if (targets !== undefined) {
        if (!Array.isArray(targets)) {
          throw new Error("targets must be an array of IPs/hostnames/CIDR ranges.");
        }
        for (const t of targets) pushSpec(t, "targets");
      }
      if (specs.length === 0) {
        throw new Error("Provide 'target' or 'targets' — nothing to scan.");
      }
      const output = await runTool("nmap", [...flags, ...specs], toolTimeout(NMAP_TIMEOUT_MS));
      assertDiscoveryNotFabricated(flags, specs, output);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "searchsploit",
    description:
      "Search the Exploit-DB archive for known exploits matching a term.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term, e.g. 'openssh 8.9'.",
        },
      },
      required: ["query"],
    },
    handler: async ({ query }) => {
      assertSafe(query, "query");
      const output = await runTool("searchsploit", [query]);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "nikto",
    description: "Run a Nikto web scanner against a target host or URL.",
    inputSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Target host or URL, e.g. 'http://192.168.1.100'.",
        },
        options: {
          type: "string",
          description:
            "Additional Nikto options, e.g. '-Tuning 1,2,3' or '-timeout 10'. " +
            "The full default test set can outlast the per-call timeout on a " +
            "remote site; -Tuning trims which tests run.",
        },
      },
      required: ["host"],
    },
    handler: async ({ host, options }) => {
      assertSafe(host, "host");
      assertTargetInScope(host, "host");
      const args = ["-h", host];
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("nikto", args, toolTimeout(NIKTO_TIMEOUT_MS));
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "whois",
    description: "Perform a WHOIS lookup for a domain or IP address.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Domain or IP address, e.g. 'example.com'.",
        },
      },
      required: ["target"],
    },
    handler: async ({ target }) => {
      assertSafe(target, "target");
      assertTargetInScope(target, "target");
      const output = await runTool("whois", [target]);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "tshark",
    description:
      "Analyze a PCAP file with tshark. The file must be readable by the mshin user.",
    inputSchema: {
      type: "object",
      properties: {
        pcap: {
          type: "string",
          description: "Absolute path to the PCAP file to analyze.",
        },
        display_filter: {
          type: "string",
          description:
            "Optional Wireshark display filter, e.g. 'ip.dst==203.0.113.45'.",
        },
      },
      required: ["pcap"],
    },
    handler: async ({ pcap, display_filter }) => {
      assertSafe(pcap, "pcap");
      if (!existsSync(pcap)) {
        return {
          content: [
            { type: "text", text: `Error: PCAP file not found: ${pcap}` },
          ],
          isError: true,
        };
      }
      const args = ["-r", pcap, "-T", "fields", "-e", "ip.src", "-e", "ip.dst", "-e", "_ws.col.Protocol", "-e", "_ws.col.Info"];
      if (display_filter) {
        assertSafe(display_filter, "display_filter");
        args.push("-Y", display_filter);
      }
      const output = await runTool("tshark", args, DEFAULT_TIMEOUT_MS, { useSudo: false });
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "metasploit",
    description:
      "Run a constrained Metasploit module. Only module paths and option " +
      "values matching safe patterns are accepted.",
    inputSchema: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description:
            "Metasploit module path, e.g. 'exploit/linux/ssh/cve_2026_1234'.",
        },
        options: {
          type: "object",
          description:
            "Module options as key/value pairs, e.g. { RHOSTS: '192.168.1.1' }.",
        },
      },
      required: ["module"],
    },
    handler: async ({ module, options = {} }) => {
      if (options.RHOSTS) {
        assertTargetListInScope(options.RHOSTS, "RHOSTS");
      }
      if (options.RHOST) {
        assertTargetInScope(options.RHOST, "RHOST");
      }
      const msfScript = buildMsfScript(module, options);
      const output = await runTool("metasploit", ["-q", "-x", msfScript], 600_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "hydra",
    description:
      "Run Hydra password cracking against a service. Target and service must be specified.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target host IP or hostname.",
        },
        service: {
          type: "string",
          description: "Service type, e.g. 'ssh', 'ftp', 'http-post-form'.",
        },
        user: {
          type: "string",
          description: "Optional username or user list file (prefixed with -L for file).",
        },
        password: {
          type: "string",
          description: "Optional password or password list file (prefixed with -P for file).",
        },
        options: {
          type: "string",
          description: "Optional additional Hydra options, e.g. '-s 22 -t 4'.",
        },
      },
      required: ["target", "service"],
    },
    handler: async ({ target, service, user, password, options }) => {
      assertSafe(target, "target");
      assertTargetInScope(target, "target");
      assertSafe(service, "service");
      const args = [target, service];
      if (user) {
        assertSafe(user, "user");
        args.push(user);
      }
      if (password) {
        assertSafe(password, "password");
        args.push(password);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("hydra", args, 60_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "sqlmap",
    description:
      "Run SQLMap to detect and exploit SQL injection vulnerabilities. URL is required.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target URL to test for SQL injection, e.g. 'http://192.168.1.100/login.php'.",
        },
        data: {
          type: "string",
          description: "Optional POST data for the request, e.g. 'id=1&user=test'.",
        },
        risk: {
          type: "string",
          description: "Risk level: 1 (low) to 3 (high). Default is 1.",
          default: "1",
        },
        level: {
          type: "string",
          description: "Test level: 1 (basic) to 5 (deep). Default is 1.",
          default: "1",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, data, risk = "1", level = "1" }) => {
      assertSafe(url, "url");
      assertTargetInScope(url, "url");
      const args = ["-u", url, "--risk", risk, "--level", level];
      if (data) {
        assertSafe(data, "data");
        args.push("--data", data);
      }
      args.push("--batch");
      const output = await runTool("sqlmap", args, DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "gobuster",
    description:
      "Run Gobuster for directory/file brute forcing or DNS enumeration.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "Mode: 'dir' for directory brute forcing, 'dns' for DNS.",
          default: "dir",
        },
        url: {
          type: "string",
          description: "Base URL for dir mode, e.g. 'http://192.168.1.100'.",
        },
        domain: {
          type: "string",
          description: "Domain for DNS mode, e.g. 'example.com'.",
        },
        wordlist: {
          type: "string",
          description: "Path to wordlist file, e.g. '/usr/share/dirb/wordlists/common.txt' — valid on both Kali and plain Debian; the '/usr/share/wordlists/dirb/...' alias exists only on Kali. For a fast, high-signal probe (upload dirs, WordPress paths, dotfiles) the Node ships '/opt/mshin/servers/src/kali/wordlists/sensitive-paths.txt'.",
        },
        options: {
          type: "string",
          description: "Additional Gobuster options, e.g. '-t 50 -x .php,.txt'.",
        },
      },
      required: [],
    },
    handler: async ({ mode = "dir", url, domain, wordlist, options }) => {
      assertSafe(mode, "mode");
      const args = [mode];
      if (mode === "dir" && url) {
        assertSafe(url, "url");
        assertTargetInScope(url, "url");
        args.push("-u", url);
      } else if (mode === "dns" && domain) {
        assertSafe(domain, "domain");
        assertTargetInScope(domain, "domain");
        args.push("-d", domain);
      } else {
        return {
          content: [{ type: "text", text: "Error: url required for dir mode, domain required for dns mode" }],
          isError: true,
        };
      }
      if (wordlist) {
        assertSafe(wordlist, "wordlist");
        args.push("-w", wordlist);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("gobuster", args, 120_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "masscan",
    description:
      "Run Masscan for fast port scanning across large ranges.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target IP address, range, or CIDR, e.g. '192.168.1.0/24'.",
        },
        ports: {
          type: "string",
          description: "Ports to scan, e.g. '80,443' or '1-1000'. Default is '1-65535'.",
          default: "1-65535",
        },
        rate: {
          type: "string",
          description: "Packets per second rate, e.g. '1000'.",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, ports = "1-65535", rate }) => {
      assertSafe(target, "target");
      assertTargetInScope(target, "target");
      assertSafe(ports, "ports");
      const args = [target, "-p", ports];
      if (rate) {
        assertSafe(rate, "rate");
        args.push("--rate", rate);
      }
      args.push("--banners", "-n");
      const output = await runTool("masscan", args, 120_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "dirb",
    description:
      "Run DirB directory brute forcer against a web server.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Base URL to scan, e.g. 'http://192.168.1.100'.",
        },
        wordlist: {
          type: "string",
          description: "Path to wordlist file. Default is '/usr/share/dirb/wordlists/common.txt'. For a fast, high-signal probe (upload dirs, WordPress paths, dotfiles) the Node ships '/opt/mshin/servers/src/kali/wordlists/sensitive-paths.txt'.",
          default: "/usr/share/dirb/wordlists/common.txt",
        },
        options: {
          type: "string",
          description: "Additional DirB options, e.g. '-S -e .php'.",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, wordlist = "/usr/share/dirb/wordlists/common.txt", options }) => {
      assertSafe(url, "url");
      assertTargetInScope(url, "url");
      assertSafe(wordlist, "wordlist");
      const args = [url, wordlist];
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("dirb", args, 120_000, { useSudo: false });
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "arping",
    description:
      "Run arping to discover hosts on the local network via ARP.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target IP or host to ping, e.g. '192.168.1.1' or '192.168.1.0/24'.",
        },
        iface: {
          type: "string",
          description: "Network interface to use, e.g. 'eth0'.",
        },
        count: {
          type: "string",
          description: "Number of packets to send. Default is '3'.",
          default: "3",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, iface, count = "3" }) => {
      assertSafe(target, "target");
      assertTargetInScope(target, "target");
      const args = [target];
      if (iface) {
        assertSafe(iface, "iface");
        args.push("-I", iface);
      }
      args.push("-c", count);
      const output = await runTool("arping", args, 30_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "arp-scan",
    description:
      "ARP-scan a local network segment for live hosts, reporting IP, MAC and vendor. " +
      "Truthful only from a real position on the segment (bare-metal Node, host-mode " +
      "container, bridged guest); from behind NAT it returns nothing or fabricates — " +
      "discover from a machine on the physical network instead.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "CIDR range or comma-separated IP list to ARP-scan, e.g. '192.168.1.0/24'.",
        },
        iface: {
          type: "string",
          description: "Network interface to scan on, e.g. 'eth0'. Optional.",
        },
        options: {
          type: "string",
          description: "Additional arp-scan options, e.g. '--retry 5 --interval 100'.",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, iface, options }) => {
      assertSafe(target, "target");
      assertTargetListInScope(target, "target");
      const args = [target];
      if (iface) {
        assertSafe(iface, "iface");
        args.push("--interface", iface);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("arp-scan", args, 60_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "dnsenum",
    description:
      "Run DNSEnum for DNS enumeration and reconnaissance. Defaults to the " +
      "shipped small subdomain wordlist so a run finishes inside the " +
      "per-call timeout; pass '-f <file>' in options for a deeper list.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to enumerate, e.g. 'example.com'.",
        },
        options: {
          type: "string",
          description: "Additional DNSEnum options, e.g. '--noreverse'.",
        },
      },
      required: ["domain"],
    },
    handler: async ({ domain, options }) => {
      assertSafe(domain, "domain");
      assertTargetInScope(domain, "domain");
      const args = [domain];
      // Default to the shipped small wordlist unless the caller brings their
      // own -f — the stock ~1500-entry list cannot finish inside the
      // per-call timeout (see DEFAULT_DNSENUM_WORDLIST above).
      const hasOwnWordlist = options
        ?.split(/\s+/)
        .some((a) => a === "-f" || a === "--file");
      if (!hasOwnWordlist && existsSync(DEFAULT_DNSENUM_WORDLIST)) {
        args.push("-f", DEFAULT_DNSENUM_WORDLIST);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      // dnsenum writes `<domain>_ips.txt` to its working directory, which is
      // read-only in the Docker Node's WORKDIR — it exits 30 when it cannot,
      // and the non-zero exit fails the call even though the scan itself ran
      // (measured 2026-10-22). Run it from the tmp dir instead.
      const output = await runTool("dnsenum", args, DEFAULT_TIMEOUT_MS, {
        cwd: tmpdir(),
      });
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "enum4linux",
    description:
      "Enumerate SMB shares, users, and groups on a Windows or Samba target.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target IP address or hostname, e.g. '192.168.1.100'.",
        },
        options: {
          type: "string",
          description: "Optional enum4linux options, e.g. '-a' or '-U -S'.",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, options }) => {
      assertTargetInScope(target, "target");
      const args = buildEnum4linuxArgs(target, options);
      const output = await runTool("enum4linux", args, 120_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "ffuf",
    description:
      "Fast web fuzzer for directory and file discovery, virtual hosts, and parameter fuzzing.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target URL with or without FUZZ keyword, e.g. 'http://192.168.1.100/FUZZ'.",
        },
        wordlist: {
          type: "string",
          description: "Path to wordlist file, e.g. '/usr/share/dirb/wordlists/common.txt' — valid on both Kali and plain Debian; the '/usr/share/wordlists/dirb/...' alias exists only on Kali. For a fast, high-signal probe (upload dirs, WordPress paths, dotfiles) the Node ships '/opt/mshin/servers/src/kali/wordlists/sensitive-paths.txt'.",
        },
        options: {
          type: "string",
          description: "Optional ffuf options, e.g. '-t 50 -mc 200,204'.",
        },
      },
      required: ["url", "wordlist"],
    },
    handler: async ({ url, wordlist, options }) => {
      // '&' is allowed here: ffuf's own CLI syntax needs it as the
      // query-string/form-body parameter separator for multi-parameter
      // fuzzing, and execFile never invokes a shell, so it's inert argv data.
      assertSafe(url, "url", { pattern: SHELL_META_RE_ALLOW_AMP });
      assertTargetInScope(url, "url");
      assertSafe(wordlist, "wordlist");
      const args = ["-u", url, "-w", wordlist];
      if (options) {
        assertSafe(options, "options", { pattern: SHELL_META_RE_ALLOW_AMP });
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("ffuf", args, 120_000, { useSudo: false });
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "john",
    description:
      "Run John the Ripper for offline password hash cracking.",
    inputSchema: {
      type: "object",
      properties: {
        hash_file: {
          type: "string",
          description: "Absolute path to the file containing password hashes.",
        },
        format: {
          type: "string",
          description: "Optional hash format, e.g. 'raw-md5' or 'nt'.",
        },
        options: {
          type: "string",
          description: "Optional John options, e.g. '--wordlist=/usr/share/wordlists/rockyou.txt'.",
        },
      },
      required: ["hash_file"],
    },
    handler: async ({ hash_file, format, options }) => {
      assertSafe(hash_file, "hash_file");
      if (!existsSync(hash_file)) {
        return {
          content: [{ type: "text", text: `Error: Hash file not found: ${hash_file}` }],
          isError: true,
        };
      }
      const args = [hash_file];
      if (format) {
        assertSafe(format, "format");
        args.push("--format", format);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("john", args, DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "wpscan",
    description:
      "Run WPScan against a WordPress site: enumerate the WordPress version, " +
      "themes, plugins, users and backups, and flag known vulnerabilities in " +
      "them. Set WPSCAN_API_TOKEN in the Node's environment for full " +
      "vulnerability data — without one the scan still enumerates but reports " +
      "fewer vulnerabilities.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "WordPress site URL, e.g. 'http://192.168.1.100' or 'https://example.com/blog'.",
        },
        enumerate: {
          type: "string",
          description:
            "Comma-separated enumeration targets, e.g. 'vp,vt,u' (vulnerable plugins, vulnerable themes, users). Default enumerates nothing.",
        },
        options: {
          type: "string",
          description: "Additional WPScan options, e.g. '--threads 10 --random-user-agent'.",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, enumerate, options }) => {
      assertSafe(url, "url");
      assertTargetInScope(url, "url");
      const args = ["--no-banner", "--url", url];
      if (enumerate) {
        assertSafe(enumerate, "enumerate");
        args.push("--enumerate", enumerate);
      }
      if (options) {
        assertSafe(options, "options");
        args.push(...options.split(/\s+/));
      }
      const output = await runTool("wpscan", args, toolTimeout(WPSCAN_TIMEOUT_MS), { useSudo: false });
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "writable-probe",
    description:
      "Audit what can be written to on a target from the network, without a " +
      "login. Four checks, each answering one write path: 'http_put' (PUT a " +
      "marker over HTTP(S) and try to clean it up), 'ftp_anon' (upload as " +
      "anonymous FTP), 'nfs_exports' (list NFS exports and flag rw ones), " +
      "'smb_write' (list SMB shares anonymously; with 'share', try a marker " +
      "upload there). Markers are benign text files and every check attempts " +
      "its own cleanup. Use only against systems you own or are authorized " +
      "to test.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Target host or IP, e.g. '192.168.1.100'.",
        },
        checks: {
          type: "string",
          description:
            "Comma-separated checks to run: 'http_put', 'ftp_anon', 'nfs_exports', 'smb_write'. Default runs all four.",
        },
        url: {
          type: "string",
          description:
            "Base URL for the http_put check, e.g. 'http://192.168.1.100/uploads'. Defaults to 'http://<target>/'.",
        },
        share: {
          type: "string",
          description:
            "SMB share name for the smb_write upload attempt, e.g. 'public'. Without it the check only lists shares.",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, checks, url, share }) => {
      assertSafe(target, "target");
      assertTargetInScope(target, "target");

      const KNOWN_CHECKS = ["http_put", "ftp_anon", "nfs_exports", "smb_write"];
      const selected = checks
        ? checks.split(",").map((s) => s.trim()).filter(Boolean)
        : KNOWN_CHECKS;
      if (selected.length === 0) {
        throw new Error("Provide at least one check: 'http_put', 'ftp_anon', 'nfs_exports', 'smb_write'.");
      }
      for (const check of selected) {
        if (!KNOWN_CHECKS.includes(check)) {
          throw new Error(`Unknown check '${check}'. Valid: ${KNOWN_CHECKS.join(", ")}.`);
        }
      }
      if (url !== undefined) {
        assertSafe(url, "url");
        assertTargetInScope(url, "url");
      }
      if (share !== undefined) {
        assertSafe(share, "share");
        if (!/^[A-Za-z0-9_.-]+$/.test(share)) {
          throw new Error("share contains invalid characters");
        }
      }

      // The marker is one benign text file, shared by every check; written to
      // /tmp (HOME for the containerized Node) and removed when the probe ends.
      const markerPath = "/tmp/mshin-writable-probe.txt";
      const markerName = "mshin-writable-probe.txt";
      writeFileSync(markerPath, `mshin writable-probe marker ${new Date().toISOString()}\n`);

      const httpBase = (url || `http://${target}/`).replace(/\/+$/, "");

      async function probeHttpPut() {
        const markerUrl = `${httpBase}/${markerName}`;
        const code = (await runTool(
          "curl",
          ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", "--data-binary", `@${markerPath}`, markerUrl],
          30_000,
          { useSudo: false }
        )).trim();
        if (/^[23]\d\d$/.test(code)) {
          let cleanup = `cleanup DELETE returned ${(await runTool(
            "curl",
            ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "DELETE", markerUrl],
            30_000,
            { useSudo: false }
          )).trim()}`;
          return `WRITABLE: HTTP ${code} on PUT ${markerUrl}\n${cleanup}\nRemove the marker file if DELETE was refused.`;
        }
        const verdict =
          code === "405" ? "server refuses PUT (405) — not writable" :
          code === "401" || code === "403" ? `write refused (${code}) — authentication or authorization required` :
          code === "404" ? "no such path (404)" :
          `HTTP ${code}`;
        return `Not writable: ${verdict} on PUT ${markerUrl}`;
      }

      async function probeFtpAnon() {
        const upload = await runTool(
          "curl",
          ["-sS", "--user", "anonymous:mshin-writable-probe", "-T", markerPath, `ftp://${target}/`],
          30_000,
          { useSudo: false }
        );
        const verify = await runTool(
          "curl",
          ["-sS", `ftp://${target}/${markerName}`],
          30_000,
          { useSudo: false }
        );
        let cleanup = "cleanup failed";
        try {
          await runTool(
            "curl",
            ["-sS", "-Q", `-DELE ${markerName}`, `ftp://${target}/`],
            30_000,
            { useSudo: false }
          );
          cleanup = "marker deleted";
        } catch {
          // The DELE failing is itself a finding; report it as such below.
        }
        const verified = verify.includes("mshin writable-probe marker");
        return `WRITABLE: anonymous upload to ftp://${target}/ succeeded (${upload.trim() || "no errors"}; verification ${verified ? "read the marker back" : "could not read it back"}; ${cleanup}).` +
          (cleanup === "marker deleted" ? "" : " Remove the marker file manually.");
      }

      async function probeNfsExports() {
        const output = await runTool("showmount", ["-e", target], 30_000, { useSudo: false });
        const lines = output.split("\n").filter(Boolean);
        const rw = lines.filter((l) => /\(rw[,)]/.test(l) || /,rw[,)]/.test(l));
        const summary = lines.length <= 1
          ? "No NFS exports (or the mount service did not answer)."
          : rw.length > 0
            ? `FOUND ${rw.length} writable (rw) export(s): ${rw.join("; ")}`
            : "Exports found, none marked rw.";
        return `${summary}\n${output}`;
      }

      async function probeSmbWrite() {
        const listing = await runTool(
          "smbclient",
          ["-L", `//${target}`, "-N"],
          30_000,
          { useSudo: false }
        );
        if (!share) {
          return `Share listing for ${target} (no upload attempted; pass 'share' to try one):\n${listing}`;
        }
        const upload = await runTool(
          "smbclient",
          [`//${target}/${share}`, "-N", "-c", `put ${markerPath} ${markerName}`],
          30_000,
          { useSudo: false }
        );
        let cleanup = "cleanup failed";
        try {
          await runTool(
            "smbclient",
            [`//${target}/${share}`, "-N", "-c", `rm ${markerName}`],
            30_000,
            { useSudo: false }
          );
          cleanup = "marker deleted";
        } catch {
          // A failed rm is itself part of the finding.
        }
        return `WRITABLE: anonymous upload to \\\\${target}\\${share} succeeded (${upload.trim() || "no errors"}; ${cleanup}).` +
          (cleanup === "marker deleted" ? "" : " Remove the marker file manually.");
      }

      const CHECK_FNS = {
        http_put: probeHttpPut,
        ftp_anon: probeFtpAnon,
        nfs_exports: probeNfsExports,
        smb_write: probeSmbWrite,
      };

      const sections = [];
      for (const check of selected) {
        try {
          sections.push(`[${check}]\n${await CHECK_FNS[check]()}`);
        } catch (err) {
          sections.push(`[${check}]\nNot writable or unreachable: ${err.message}`);
        }
      }

      if (existsSync(markerPath)) {
        try { unlinkSync(markerPath); } catch { /* best effort */ }
      }

      return {
        content: [
          { type: "text", text: `== writable-probe of ${target} ==\n\n${sections.join("\n\n")}` },
        ],
      };
    },
  },
];

export { tools, TOOL_PATHS, buildMsfScript, buildEnum4linuxArgs, assertDiscoveryNotFabricated };
export default tools;
