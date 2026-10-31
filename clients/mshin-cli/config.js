// Central place for the mshin-cli agent loop's tunables. Pulled out of
// agent.js so they're discoverable in one file instead of scattered through
// the module; see docs/REFACTORING-IDEAS.md. No behavior change from moving
// them here -- values and comments are carried over as-is.

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_MAX_HISTORY_MESSAGES = 40;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000;

// One model turn, not one run. Ten minutes is generous for an 8B on a laptop
// and still finite, so a genuinely wedged request surfaces instead of hanging
// the operator's session.
export const DEFAULT_OLLAMA_TIMEOUT_MS = 600_000;

// Long tool results (nmap/masscan/whois output) can dominate the context window.
// Compression keeps the first and last N lines and omits the middle, rather
// than dropping the whole message. The full output remains in AgentMemory.
export const DEFAULT_MAX_TOOL_RESULT_LINES = 60;
export const DEFAULT_TOOL_RESULT_HEAD_LINES = 25;
export const DEFAULT_TOOL_RESULT_TAIL_LINES = 25;

// One retry after this delay catches most transient MCP failures (connection
// resets, tool timeouts). Failures that no retry can fix (missing binary,
// sudoers gap) are filtered out before the retry, so the operator never waits
// on a call that will fail identically.
export const DEFAULT_TOOL_RETRY_DELAY_MS = 2_000;

// Marker prefix identifying the findings-summary message compactContext()
// maintains (Option B). Used both to find and refresh that single message
// and to keep it out of eviction.
export const FINDINGS_SUMMARY_MARKER = "[Findings Summary";

// Tools that can alter state, launch exploits, or reveal credentials require
// explicit user approval before each invocation. hydra brute-forces live
// credentials (can lock out real accounts), sqlmap actively exploits SQL
// injection (can read or modify database contents), and john cracks password
// hashes offline, so all three carry the same real-world risk as metasploit.
export const ACTIVE_TOOLS = new Set(["metasploit", "hydra", "sqlmap", "john"]);

// Tool failures no retry can fix. Every one of these is environmental -- the
// binary is absent, the sudoers allowlist does not cover it, or systemd blocks
// the privilege transition -- so an identical second call fails identically.
// Measured on a live run: given a whois the Node could not execute, both
// mistral- and qwen-class models spent their entire step budget re-issuing the
// same call, then gave up. The loop now marks the tool unavailable after the
// first such failure instead.
export const NON_RETRYABLE_TOOL_ERROR_RE = new RegExp(
  [
    "sudo: a password is required",
    "no new privileges",
    "Tool binary not found",
    "Unknown tool:",
    "is not enabled",
    "command not found",
    "permission denied",
  ].join("|"),
  "i"
);
