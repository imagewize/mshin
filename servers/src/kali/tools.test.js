import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { tools, TOOL_PATHS, buildMsfScript, buildEnum4linuxArgs } from "./tools.js";

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

test("exposes exactly the sixteen documented tools with complete metadata", () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "arping",
    "dirb",
    "dnsenum",
    "enum4linux",
    "ffuf",
    "gobuster",
    "hydra",
    "john",
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

test("searchsploit, nikto, whois, hydra, sqlmap, gobuster, masscan, dirb, arping, dnsenum, enum4linux, ffuf and john reject shell metacharacters", async () => {
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
    ["enum4linux", (p) => ({ target: p })],
    ["ffuf", (p) => ({ url: p, wordlist: "/usr/share/wordlists/dirb/common.txt" })],
    ["john", (p) => ({ hash_file: p })],
  ];
  for (const [name, build] of cases) {
    const tool = byName(name);
    await assert.rejects(tool.handler(build("evil; reboot")), /unsafe characters/, name);
  }
});

test("buildEnum4linuxArgs puts options before the target", () => {
  // enum4linux's Getopt::Std-style parser stops looking for flags at the
  // first non-dash argument, so options after the target are silently
  // ignored — they must come first.
  assert.deepEqual(buildEnum4linuxArgs("192.168.1.100", "-a"), ["-a", "192.168.1.100"]);
  assert.deepEqual(buildEnum4linuxArgs("192.168.1.100", "-U -S"), [
    "-U",
    "-S",
    "192.168.1.100",
  ]);
  assert.deepEqual(buildEnum4linuxArgs("192.168.1.100", undefined), ["192.168.1.100"]);
});

test("buildEnum4linuxArgs still rejects shell metacharacters", () => {
  assert.throws(() => buildEnum4linuxArgs("evil; reboot", undefined), /unsafe characters/);
  assert.throws(() => buildEnum4linuxArgs("192.168.1.100", "-a; reboot"), /unsafe characters/);
});

test("ffuf accepts '&' in the url and options for multi-parameter fuzzing", async () => {
  const ffuf = byName("ffuf");
  // '&' must not be rejected as an "unsafe character" — it's the query
  // string/form-body separator ffuf's own parameter-fuzzing use case needs,
  // and execFile never invokes a shell, so it's inert argv data. The call
  // still fails past validation with "binary not found" on a host without
  // ffuf installed (e.g. this macOS authoring box), which is what proves
  // validation was cleared rather than the tool actually running.
  await assert.rejects(
    ffuf.handler({
      url: "http://192.168.1.100/login?user=FUZZ&pass=admin",
      wordlist: "/usr/share/wordlists/dirb/common.txt",
    }),
    /binary not found/
  );
  await assert.rejects(
    ffuf.handler({
      url: "http://192.168.1.100/FUZZ",
      wordlist: "/usr/share/wordlists/dirb/common.txt",
      options: "-d user=FUZZ&pass=admin",
    }),
    /binary not found/
  );
});

test("ffuf still rejects other shell metacharacters in options", async () => {
  const ffuf = byName("ffuf");
  await assert.rejects(
    ffuf.handler({
      url: "http://192.168.1.100/FUZZ",
      wordlist: "/usr/share/wordlists/dirb/common.txt",
      options: "-d evil; reboot",
    }),
    /unsafe characters/
  );
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

test("john reports a missing hash file as an error result, not a throw", async () => {
  const john = byName("john");
  const res = await john.handler({ hash_file: "/nonexistent/hashes.txt" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Hash file not found/);
});

test("john with an existing file clears validation and reaches the binary check", async () => {
  const john = byName("john");
  const existingFile = fileURLToPath(import.meta.url); // this test file certainly exists
  await assert.rejects(john.handler({ hash_file: existingFile }), /binary not found/);
});
