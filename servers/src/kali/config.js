// Central place for the Kali MCP server's tunables. Pulled out of tools.js so
// they're discoverable in one file instead of scattered through the module;
// see docs/REFACTORING-IDEAS.md. No behavior change from moving them here --
// values and comments are carried over as-is.

import { createHash, timingSafeEqual } from "node:crypto";

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
  // arp-scan installs to /usr/sbin on Kali and Debian alike (it is an admin
  // tool); every other tool here is /usr/bin. The sudoers allowlist entries
  // match these paths exactly.
  "arp-scan": "/usr/sbin/arp-scan",
  dnsenum: "/usr/bin/dnsenum",
  enum4linux: "/usr/bin/enum4linux",
  ffuf: "/usr/bin/ffuf",
  john: "/usr/bin/john",
  wpscan: "/usr/bin/wpscan",
};

// Default timeout for any single tool invocation.
export const DEFAULT_TIMEOUT_MS = 300_000;

// Reject anything that looks like shell syntax.
export const SHELL_META_RE = /[;|&$()`\\<>]/;

// Same set, minus '&'. Every tool call goes through execFile with no shell,
// so '&' is never interpreted as a background/AND operator here — it's inert
// argv data. ffuf's url/options legitimately contain '&' as the query-string
// and form-body parameter separator (its whole "parameter fuzzing" use case
// depends on it), so it validates against this instead of SHELL_META_RE.
export const SHELL_META_RE_ALLOW_AMP = /[;|$()`\\<>]/;

// ---------------------------------------------------------------------------
// Target scope allowlist
// ---------------------------------------------------------------------------
//
// When MSHIN_ALLOWED_TARGETS is set, every network-facing tool argument is
// checked against it before execution. This prevents an LLM with tool access
// from scanning or attacking hosts outside the engagement scope.
//
// Format: comma-separated list of IPs, CIDR ranges, or hostnames. Examples:
//   MSHIN_ALLOWED_TARGETS="192.168.1.0/24,10.0.0.5,scanme.nmap.org"
//   MSHIN_ALLOWED_TARGETS="127.0.0.1,::1"
//
// An empty or unset allowlist means "allow all targets" — the default behavior
// before this feature existed, so existing deployments keep working.
//
// Hostname matching: "example.com" matches only "example.com". Use
// "*.example.com" to match any single-level subdomain (e.g. "www.example.com").
// IP matching supports exact matches and CIDR ranges.

function parseIp(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function ipInCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNum = parseIp(ip);
  const networkNum = parseIp(network);
  if (ipNum === null || networkNum === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (networkNum & mask);
}

function hostnameMatches(value, allowed) {
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(2);
    return value === suffix || value.endsWith(`.${suffix}`);
  }
  return value === allowed;
}

function valueMatchesAllowedTarget(value, allowed) {
  if (allowed.includes("/")) {
    // Treat as CIDR only if it parses as a valid IPv4 CIDR. If it doesn't,
    // fall through to hostname matching so targets like "foo/bar" are not
    // silently rejected.
    if (ipInCidr(value, allowed)) return true;
  }
  const ipNum = parseIp(value);
  if (ipNum !== null) {
    // Exact IP match.
    if (parseIp(allowed) === ipNum) return true;
  }
  // Hostname match (suffix-based).
  return hostnameMatches(value.toLowerCase(), allowed.toLowerCase());
}

export function parseAllowedTargets() {
  const raw = process.env.MSHIN_ALLOWED_TARGETS;
  if (!raw || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const ALLOWED_TARGETS = parseAllowedTargets();

/**
 * Check whether a single target value is within the configured scope.
 * Returns true when no allowlist is configured.
 */
export function isTargetAllowed(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (!ALLOWED_TARGETS || ALLOWED_TARGETS.length === 0) return true;

  // Extract hostname from URLs like "http://192.168.1.1/path" or
  // "http://example.com:8080/foo". If parsing fails, use the raw value.
  let host = value;
  try {
    const url = new URL(value);
    host = url.hostname;
  } catch {
    // Not a URL; keep the raw value.
  }

  return ALLOWED_TARGETS.some((allowed) => valueMatchesAllowedTarget(host, allowed));
}

/**
 * Throw if a target value is outside the configured scope.
 */
export function assertTargetInScope(value, name = "target") {
  if (!isTargetAllowed(value)) {
    const list = ALLOWED_TARGETS.join(", ");
    throw new Error(
      `${name} '${value}' is outside the configured scope: ${list}`
    );
  }
}

/**
 * Throw if any value in a comma-separated target list is outside scope.
 * Useful for tools that accept multiple hosts in one argument.
 */
export function assertTargetListInScope(value, name = "target") {
  if (!ALLOWED_TARGETS || ALLOWED_TARGETS.length === 0) return;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  for (const item of value.split(",")) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    assertTargetInScope(trimmed, name);
  }
}

// ---------------------------------------------------------------------------
// Bearer-token authentication
// ---------------------------------------------------------------------------
//
// When MSHIN_NODE_TOKEN is set, every /mcp request must carry
// `Authorization: Bearer <token>` or the server answers 401 before the MCP
// layer sees it. The Node exposes destructive tools (metasploit, hydra,
// sqlmap, john) on the LAN, so this stops any other host from driving them.
// The scope allowlist above constrains *targets*; this constrains *callers*.
//
// An empty or unset token means "no authentication" — the behavior before
// this feature existed, so existing deployments keep working.
//
// Generate one with: openssl rand -hex 32

export function parseAuthToken() {
  const raw = process.env.MSHIN_NODE_TOKEN;
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}

export const AUTH_TOKEN = parseAuthToken();

/**
 * Constant-time comparison of the presented token against the expected one.
 * Both sides are hashed first so timingSafeEqual always compares
 * equal-length buffers and the comparison leaks neither the expected token's
 * value nor its length.
 */
export function tokensMatch(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") {
    return false;
  }
  if (presented === "" || expected === "") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * True when a request may proceed: always when no token is configured,
 * otherwise only on an exact match.
 */
export function isValidAuthToken(presented) {
  if (AUTH_TOKEN === null) return true;
  return tokensMatch(presented, AUTH_TOKEN);
}
