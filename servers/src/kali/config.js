// Central place for the Kali MCP server's tunables. Pulled out of tools.js so
// they're discoverable in one file instead of scattered through the module;
// see docs/refactoring-ideas.md. No behavior change from moving them here --
// values and comments are carried over as-is.

// Full paths to the Kali tools as installed by apt.
export const TOOL_PATHS = {
  nmap: "/usr/bin/nmap",
  searchsploit: "/usr/bin/searchsploit",
  nikto: "/usr/bin/nikto",
  whois: "/usr/bin/whois",
  tshark: "/usr/bin/tshark",
  metasploit: "/usr/bin/msfconsole",
  hydra: "/usr/bin/hydra",
  sqlmap: "/usr/bin/sqlmap",
  gobuster: "/usr/bin/gobuster",
  masscan: "/usr/bin/masscan",
  dirb: "/usr/bin/dirb",
  arping: "/usr/bin/arping",
  dnsenum: "/usr/bin/dnsenum",
};

// Default timeout for any single tool invocation.
export const DEFAULT_TIMEOUT_MS = 300_000;

// Reject anything that looks like shell syntax.
export const SHELL_META_RE = /[;|&$()`\\<>]/;
