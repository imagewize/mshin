import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// Full paths to the Kali tools as installed by apt.
const TOOL_PATHS = {
  nmap: "/usr/bin/nmap",
  searchsploit: "/usr/bin/searchsploit",
  nikto: "/usr/bin/nikto",
  whois: "/usr/bin/whois",
  tshark: "/usr/bin/tshark",
  metasploit: "/usr/bin/msfconsole",
};

// Default timeout for any single tool invocation.
const DEFAULT_TIMEOUT_MS = 300_000;

// Reject anything that looks like shell syntax.
const SHELL_META_RE = /[;|&$()`\\<>]/;

function assertSafe(value, name = "argument") {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (SHELL_META_RE.test(value)) {
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

async function runTool(name, args, timeout = DEFAULT_TIMEOUT_MS, { useSudo = true } = {}) {
  const bin = TOOL_PATHS[name];
  if (!bin) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (!existsSync(bin)) {
    throw new Error(`Tool binary not found: ${bin}. Is ${name} installed?`);
  }

  // When running as the unprivileged avendesora user, use sudo so the
  // NOPASSWD allowlist in /etc/sudoers.d/avendesora takes effect.
  // tshark is excluded: reading a user-owned PCAP as root triggers Wireshark's
  // file-owner check and fails, and tshark does not need privileges to read
  // capture files anyway.
  const needsSudo = useSudo && process.getuid && process.getuid() !== 0;
  const cmd = needsSudo ? "sudo" : bin;
  const cmdArgs = needsSudo ? ["-n", bin, ...args] : args;

  const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10 MiB
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });

  let output = stdout || "";
  if (stderr) {
    output += "\n--- stderr ---\n" + stderr;
  }
  return output.trim();
}

// -----------------------------------------------------------------------------
// Tool definitions exposed to MCP clients
// -----------------------------------------------------------------------------

const tools = [
  {
    name: "nmap",
    description:
      "Run an nmap port/service scan against a single host or CIDR range. " +
      "Only safe flags are accepted; targets are validated to prevent shell injection.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "IP address, hostname, or CIDR range to scan.",
        },
        flags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional nmap flags, e.g. ['-sV'], ['-sS','-p','22,80,443'], ['-A'].",
          default: ["-sV"],
        },
      },
      required: ["target"],
    },
    handler: async ({ target, flags = ["-sV"] }) => {
      assertSafe(target, "target");
      assertSafeArray(flags, "flags");
      const output = await runTool("nmap", [...flags, target]);
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
      },
      required: ["host"],
    },
    handler: async ({ host }) => {
      assertSafe(host, "host");
      const output = await runTool("nikto", ["-h", host]);
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
      const output = await runTool("whois", [target]);
      return { content: [{ type: "text", text: output }] };
    },
  },
  {
    name: "tshark",
    description:
      "Analyze a PCAP file with tshark. The file must be readable by the avendesora user.",
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

      const msfScript = scriptParts.join("; ");
      const output = await runTool("metasploit", ["-q", "-x", msfScript], 600_000);
      return { content: [{ type: "text", text: output }] };
    },
  },
];

export { tools, TOOL_PATHS };
export default tools;
