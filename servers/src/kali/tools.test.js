import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { tools, TOOL_PATHS, buildMsfScript, buildEnum4linuxArgs, parseNmapText, assertDiscoveryNotFabricated } from "./tools.js";
import { isTargetAllowed, assertTargetInScope } from "./config.js";

// These tests exercise the tool contract and — most importantly — the shell
// injection guard, without needing the Kali binaries installed: malicious input
// is rejected before `runTool` is ever reached, and well-formed input runs
// through validation and dispatch until it hits the "binary not found" check on
// a host where the tool is absent (i.e. the macOS authoring box or CI). What is
// NOT covered here is the tools actually executing — that needs a real Node.

// NOTE: this file is loaded without MSHIN_ALLOWED_TARGETS set, so config.js
// computes an empty allowlist. Tests for allowlist behavior live in
// scope.test.js, which sets the env var before importing tools.js.

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

test("exposes exactly the nineteen documented tools with complete metadata", () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "arp-scan",
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
    "wpscan",
    "writable-probe",
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

// -----------------------------------------------------------------------------
// nmap target lists — one call, several hosts (see the handler for why the
// specs are split into separate argvs rather than joined with commas)
// -----------------------------------------------------------------------------

test("nmap schema accepts both a single target and a targets array", () => {
  const nmap = byName("nmap");
  assert.ok(nmap.inputSchema.properties.target, "target property");
  assert.ok(nmap.inputSchema.properties.targets, "targets property");
  assert.deepEqual(nmap.inputSchema.required, []);
});

test("nmap dispatches a targets array", async () => {
  const nmap = byName("nmap");
  // On a host without the binary, a well-formed call passes validation and
  // dispatch and fails only at the binary lookup — the established
  // success-path pattern for this suite.
  await assert.rejects(
    nmap.handler({ targets: ["192.168.1.1", "192.168.1.2"] }),
    /Tool binary not found/
  );
});

test("nmap dispatches a comma-separated target list", async () => {
  const nmap = byName("nmap");
  await assert.rejects(
    nmap.handler({ target: "192.168.1.1,192.168.1.2" }),
    /Tool binary not found/
  );
});

test("nmap rejects shell metacharacters in a targets entry", async () => {
  const nmap = byName("nmap");
  for (const payload of SHELL_PAYLOADS) {
    await assert.rejects(
      nmap.handler({ targets: ["192.168.1.1", payload] }),
      /unsafe characters/,
      payload
    );
  }
});

test("nmap rejects a non-array targets value", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ targets: "192.168.1.1" }), /must be an array/);
});

test("nmap rejects a call with neither target nor targets", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({}), /nothing to scan/);
  await assert.rejects(nmap.handler({ target: "" }), /nothing to scan/);
});

test("nmap rejects a non-string target", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ target: 42 }), /must be a string/);
});

test("nmap rejects a null byte in the target", async () => {
  const nmap = byName("nmap");
  await assert.rejects(nmap.handler({ target: "8.8.8.8\0evil" }), /unsafe characters|null byte/);
});

// parseNmapText — the structuredContent the nmap handler returns next to the
// raw text (see the parser comment in tools.js)

const SAMPLE_NMAP = [
  "Starting Nmap 7.991 ( https://nmap.org ) at 2026-10-31 04:35 +0000",
  "Nmap scan report for imagewize.com (188.245.200.144)",
  "Host is up (0.25s latency).",
  "Not shown: 990 closed tcp ports (conn-refused)",
  "",
  "PORT    STATE  SERVICE  VERSION",
  "22/tcp  open   ssh      OpenSSH 9.6p1 (protocol 2.0)",
  "53/tcp  open   domain   (generic dns response: NXDOMAIN)",
  "80/tcp  open   http     nginx",
  "443/tcp open   ssl/http nginx",
  "9999/tcp closed abyss",
  "",
  "Nmap done: 1 IP address (1 host up) scanned in 56.03 seconds",
].join("\n");

test("parseNmapText extracts hosts, ports, states, services and versions", () => {
  const parsed = parseNmapText(SAMPLE_NMAP);
  assert.equal(parsed.tool, "nmap");
  assert.equal(parsed.hosts.length, 1);
  const host = parsed.hosts[0];
  assert.equal(host.target, "imagewize.com");
  assert.equal(host.address, "188.245.200.144");
  assert.deepEqual(
    host.ports.map((p) => [p.port, p.protocol, p.state, p.service, p.version]),
    [
      [22, "tcp", "open", "ssh", "OpenSSH 9.6p1 (protocol 2.0)"],
      [53, "tcp", "open", "domain", "(generic dns response: NXDOMAIN)"],
      [80, "tcp", "open", "http", "nginx"],
      [443, "tcp", "open", "ssl/http", "nginx"],
      [9999, "tcp", "closed", "abyss", null],
    ]
  );
});

test("parseNmapText handles a bare-IP host line and multiple hosts", () => {
  const parsed = parseNmapText(
    "Nmap scan report for 192.0.2.1\nHost is up.\n80/tcp open http nginx\n" +
      "Nmap scan report for 192.0.2.2\nHost is up.\n22/tcp open ssh OpenSSH 9.6p1\n"
  );
  assert.deepEqual(
    parsed.hosts.map((h) => [h.target, h.address, h.ports.length]),
    [
      ["192.0.2.1", "192.0.2.1", 1],
      ["192.0.2.2", "192.0.2.2", 1],
    ]
  );
});

test("parseNmapText ignores header/boilerplate lines and empty output", () => {
  const parsed = parseNmapText("PORT STATE SERVICE VERSION\nNmap done: 0 IP addresses scanned\n");
  assert.deepEqual(parsed.hosts, []);
  assert.deepEqual(parseNmapText(""), { tool: "nmap", hosts: [] });
  assert.deepEqual(parseNmapText(undefined), { tool: "nmap", hosts: [] });
});

// -----------------------------------------------------------------------------
// Discovery fabrication guard — see the guard's comment in tools.js for the
// measured failure it exists to stop (Docker Desktop's NAT answers probes for
// every address in a scanned range, dead or alive).
// -----------------------------------------------------------------------------

const ALL_UP_256 =
  "Host is up (0.0067s latency).\nNmap done: 256 IP addresses (256 hosts up) scanned in 9.32 seconds";

test("fabrication guard refuses an all-up CIDR discovery scan", () => {
  assert.throws(
    () => assertDiscoveryNotFabricated(["-sn"], ["192.168.0.0/24"], ALL_UP_256),
    /fabricated discovery result/
  );
  // -sP is nmap's legacy alias for -sn and must be guarded too.
  assert.throws(
    () => assertDiscoveryNotFabricated(["-sP"], ["192.168.0.0/24"], ALL_UP_256),
    /fabricated discovery result/
  );
});

test("fabrication guard passes a truthful discovery result", () => {
  const fiveUp =
    "Host is up (0.0048s latency).\nNmap done: 256 IP addresses (5 hosts up) scanned in 9.32 seconds";
  assertDiscoveryNotFabricated(["-sn"], ["192.168.0.0/24"], fiveUp);
});

test("fabrication guard leaves enumerated host lists alone", () => {
  // An all-up result is legitimate for a targets list of live hosts the
  // caller already knows about; only range scans can be fabricated.
  const twentyUp =
    "Nmap done: 20 IP addresses (20 hosts up) scanned in 9.32 seconds";
  assertDiscoveryNotFabricated(
    ["-sn"],
    ["192.168.0.1", "192.168.0.2", "192.168.0.3"],
    twentyUp
  );
});

test("fabrication guard ignores small ranges and non-discovery scans", () => {
  const sixteenUp =
    "Nmap done: 16 IP addresses (16 hosts up) scanned in 2.00 seconds";
  // A /28 is below the threshold — tiny ranges stay out of the heuristic.
  assertDiscoveryNotFabricated(["-sn"], ["192.168.0.0/28"], sixteenUp);
  // Port/service scans report hosts too, but the guard is about discovery.
  assertDiscoveryNotFabricated(["-sV"], ["192.168.0.0/24"], ALL_UP_256);
});

test("searchsploit, nikto, whois, hydra, sqlmap, gobuster, masscan, dirb, arping, arp-scan, dnsenum, enum4linux, ffuf, john, wpscan and writable-probe reject shell metacharacters", async () => {
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
    ["arp-scan", (p) => ({ target: p })],
    ["dnsenum", (p) => ({ domain: p })],
    ["enum4linux", (p) => ({ target: p })],
    ["ffuf", (p) => ({ url: p, wordlist: "/usr/share/wordlists/dirb/common.txt" })],
    ["john", (p) => ({ hash_file: p })],
    ["wpscan", (p) => ({ url: p })],
    ["writable-probe", (p) => ({ target: p })],
  ];
  for (const [name, build] of cases) {
    const tool = byName(name);
    await assert.rejects(tool.handler(build("evil; reboot")), /unsafe characters/, name);
  }
});

test("nikto rejects shell metacharacters in options", async () => {
  const nikto = byName("nikto");
  await assert.rejects(
    nikto.handler({ host: "http://192.168.1.100", options: "-Tuning 1,2; reboot" }),
    /unsafe characters/
  );
});

test("wpscan with well-formed input clears validation and reaches the binary check", async () => {
  const wpscan = byName("wpscan");
  await assert.rejects(
    wpscan.handler({ url: "http://192.168.1.100", enumerate: "u,vp,vt" }),
    /binary not found/
  );
});

test("writable-probe rejects shell metacharacters in the share name", async () => {
  const probe = byName("writable-probe");
  await assert.rejects(
    probe.handler({ target: "192.168.1.100", share: "public; rm -rf /" }),
    /unsafe characters/
  );
  // Passes assertSafe (no shell metachars) but fails the share charset regex.
  await assert.rejects(
    probe.handler({ target: "192.168.1.100", share: "public share" }),
    /invalid characters/
  );
});

test("writable-probe rejects an unknown check name", async () => {
  const probe = byName("writable-probe");
  await assert.rejects(
    probe.handler({ target: "192.168.1.100", checks: "http_put,reboot" }),
    /Unknown check 'reboot'/
  );
});

test("writable-probe rejects an empty checks list", async () => {
  const probe = byName("writable-probe");
  await assert.rejects(
    probe.handler({ target: "192.168.1.100", checks: " , " }),
    /at least one check/
  );
});

// No well-formed dispatch test for writable-probe: unlike the other tools,
// its primary binary is curl, which exists on the macOS authoring box, so a
// dispatch here would perform a real network probe from the test suite.

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

// -----------------------------------------------------------------------------
// Scope allowlist — default behavior when no allowlist is configured
// -----------------------------------------------------------------------------

test("isTargetAllowed returns true when no allowlist is configured", () => {
  assert.equal(isTargetAllowed("8.8.8.8"), true);
  assert.equal(isTargetAllowed("http://evil.example.com/"), true);
  assert.equal(isTargetAllowed(""), false);
});

test("assertTargetInScope does not throw when no allowlist is configured", () => {
  assert.doesNotThrow(() => assertTargetInScope("10.0.0.1", "target"));
});

test("nmap still reaches the missing-binary check for any target when no allowlist is set", async () => {
  const nmap = byName("nmap");
  await assert.rejects(
    nmap.handler({ target: "scanme.nmap.org", flags: ["-sV"] }),
    /binary not found/
  );
});
