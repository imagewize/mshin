import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { tools, TOOL_PATHS, buildMsfScript } from "./tools.js";

// These tests exercise the tool contract and — most importantly — the shell
// injection guard, without needing the Kali binaries installed: malicious input
// is rejected before `runTool` is ever reached, and well-formed input runs
// through validation and dispatch until it hits the "binary not found" check on
// a host where the tool is absent (i.e. the macOS authoring box or CI). What is
// NOT covered here is the tools actually executing — that needs a real Node.

function byName(name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool '${name}' should exist`);
  return tool;
}

const SHELL_PAYLOADS = [
  "8.8.8.8; rm -rf /",
  "example.com && cat /etc/passwd",
  "$(reboot)",
  "`id`",
  "a|b",
  "a>b",
  "a<b",
  "a\\b",
];

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

test("exposes exactly the thirteen documented tools with complete metadata", () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "arping",
    "dirb",
    "dnsenum",
    "gobuster",
    "hydra",
    "masscan",
    "metasploit",
    "nikto",
    "nmap",
    "searchsploit",
    "sqlmap",
    "tshark",
    "whois",
  ]);
  for (const t of tools) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.handler, "function");
    // Every tool path is absolute so sudo's allowlist can match it.
    assert.ok(TOOL_PATHS[t.name].startsWith("/"), `${t.name} path must be absolute`);
  }
});

// -----------------------------------------------------------------------------
// Injection guard — the security-critical surface
// -----------------------------------------------------------------------------

test("nmap rejects shell metacharacters in the target", async () => {
  const nmap = byName("nmap");
  for (const payload of SHELL_PAYLOADS) {
    await assert.rejects(nmap.handler({ target: payload }), /unsafe characters/, payload);
  }
});

test("nmap rejects shell metacharacters in a flag", async () => {
  const nmap = byName("nmap");
  await assert.rejects(
    nmap.handler({ target: "192.168.1.1", flags: ["-sV", "; rm -rf /"] }),
    /unsafe characters/
  );
});

test("nmap rejects a non-array flags value", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ target: "192.168.1.1", flags: "-sV" }), /must be an array/);
});

test("nmap rejects a non-string target", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ target: 42 }), /must be a string/);
});

test("nmap rejects a null byte in the target", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ target: "8.8.8.8\0evil" }), /unsafe characters|null byte/);
});

test("searchsploit, nikto, whois, hydra, sqlmap, gobuster, masscan, dirb, arping and dnsenum reject shell metacharacters", async () => {
  const cases = [
    ["searchsploit", (p) => ({ query: p })],
    ["nikto", (p) => ({ host: p })],
    ["whois", (p) => ({ target: p })],
    ["hydra", (p) => ({ target: p, service: "ssh" })],
    ["sqlmap", (p) => ({ url: p })],
    ["gobuster", (p) => ({ url: p })],
    ["masscan", (p) => ({ target: p })],
    ["dirb", (p) => ({ url: p })],
    ["arping", (p) => ({ target: p })],
    ["dnsenum", (p) => ({ domain: p })],
  ];
  for (const [name, build] of cases) {
    const tool = byName(name);
    await assert.rejects(tool.handler(build("evil; reboot")), /unsafe characters/, name);
  }
});

test("metasploit rejects an injection in the module path", async () => {
  const msf = byName("metasploit");
  await assert.rejects(msf.handler({ module: "exploit/x; run" }), /unsafe characters/);
});

test("metasploit rejects a module with an otherwise-invalid character", async () => {
  const msf = byName("metasploit");
  // Passes assertSafe (no shell metachars) but fails the module charset regex.
  await assert.rejects(msf.handler({ module: "exploit windows smb" }), /invalid characters/);
});

test("metasploit rejects an injection in an option value", async () => {
  const msf = byName("metasploit");
  await assert.rejects(
    msf.handler({ module: "exploit/linux/x", options: { RHOSTS: "10.0.0.1; whoami" } }),
    /unsafe characters/
  );
});

test("buildMsfScript ends the resource script with exit so msfconsole quits", () => {
  // Without the trailing `exit`, msfconsole drops to its interactive prompt
  // under execFile (no TTY), hangs to the timeout, and exits non-zero — so the
  // run is reported as an error even though the module executed.
  const script = buildMsfScript("auxiliary/scanner/portscan/tcp", { RHOSTS: "127.0.0.1" });
  assert.equal(script, "use auxiliary/scanner/portscan/tcp; set RHOSTS 127.0.0.1; run; exit");
  assert.ok(script.endsWith("; exit"));
});

test("buildMsfScript rejects an injection in an option value", () => {
  assert.throws(
    () => buildMsfScript("exploit/linux/x", { RHOSTS: "10.0.0.1; whoami" }),
    /unsafe characters/
  );
});

test("tshark rejects a shell metacharacter in the pcap path", async () => {
  const tshark = byName("tshark");
  await assert.rejects(tshark.handler({ pcap: "/tmp/x; rm -rf /" }), /unsafe characters/);
});

// -----------------------------------------------------------------------------
// Dispatch — well-formed input passes validation and reaches execution
// -----------------------------------------------------------------------------

test("well-formed input passes validation and fails only at the missing binary", async () => {
  // On a host without the Kali tools installed, a valid call clears every guard
  // and stops at runTool's existsSync check — proving validation let it through.
  const nmap = byName("nmap");
  await assert.rejects(
    nmap.handler({ target: "scanme.nmap.org", flags: ["-sV"] }),
    /binary not found/
  );
  // Also test a new tool (hydra) to ensure its validation passes for well-formed input.
  const hydra = byName("hydra");
  await assert.rejects(
    hydra.handler({ target: "192.168.1.1", service: "ssh" }),
    /binary not found/
  );
});

test("tshark reports a missing pcap file as an error result, not a throw", async () => {
  const tshark = byName("tshark");
  const res = await tshark.handler({ pcap: "/nonexistent/capture.pcap" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /PCAP file not found/);
});

test("tshark with an existing file clears validation and reaches the binary check", async () => {
  const tshark = byName("tshark");
  const existingFile = fileURLToPath(import.meta.url); // this test file certainly exists
  await assert.rejects(tshark.handler({ pcap: existingFile }), /binary not found/);
});
