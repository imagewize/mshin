import { test } from "node:test";
import assert from "node:assert/strict";

// Set the scope allowlist BEFORE importing tools.js, because config.js computes
// ALLOWED_TARGETS at module load time. This test file exercises the integrated
// behavior: handlers must reject targets outside the configured scope even when
// the input otherwise passes shell-injection validation.
process.env.MSHIN_ALLOWED_TARGETS = "192.168.1.0/24,127.0.0.1,*.example.com";

const { tools } = await import("./tools.js");

function byName(name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool '${name}' should exist`);
  return tool;
}

/**
 * Assert that a handler rejects with the scope error. The handler is expected
 * to fail validation before any binary is invoked.
 */
async function rejectsScope(tool, args) {
  await assert.rejects(tool.handler(args), /outside the configured scope/);
}

/**
 * Assert that a handler does NOT reject with the scope error. Environmental
 * failures (missing binary, sudo password, etc.) are allowed, because this test
 * file runs on hosts that may or may not have the Kali binaries installed.
 */
async function doesNotRejectScope(tool, args) {
  try {
    await tool.handler(args);
  } catch (err) {
    assert.ok(
      !/outside the configured scope/.test(err.message),
      `handler should not reject for scope reasons: ${err.message}`
    );
  }
}

test("nmap rejects an out-of-scope IP", async () => {
  await rejectsScope(byName("nmap"), { target: "8.8.8.8", flags: ["-sV"] });
});

test("nmap accepts an in-scope CIDR target", async () => {
  await doesNotRejectScope(byName("nmap"), { target: "192.168.1.100", flags: ["-sV"] });
});

test("nikto rejects an out-of-scope URL", async () => {
  await rejectsScope(byName("nikto"), { host: "http://10.0.0.1/" });
});

test("nikto accepts an in-scope URL", async () => {
  await doesNotRejectScope(byName("nikto"), { host: "http://192.168.1.100/" });
});

test("whois rejects an out-of-scope domain", async () => {
  await rejectsScope(byName("whois"), { target: "other.com" });
});

test("whois rejects a lookalike domain that is not a real subdomain", async () => {
  await rejectsScope(byName("whois"), { target: "notexample.com" });
});

test("whois accepts an in-scope domain suffix", async () => {
  await doesNotRejectScope(byName("whois"), { target: "www.example.com" });
});

test("sqlmap rejects an out-of-scope URL", async () => {
  await rejectsScope(byName("sqlmap"), { url: "http://attacker.com/login.php" });
});

test("sqlmap accepts an in-scope URL", async () => {
  await doesNotRejectScope(byName("sqlmap"), { url: "http://www.example.com/login.php" });
});

test("metasploit rejects out-of-scope RHOSTS", async () => {
  await rejectsScope(byName("metasploit"), {
    module: "auxiliary/scanner/portscan/tcp",
    options: { RHOSTS: "8.8.8.8,1.1.1.1" },
  });
});

test("metasploit accepts in-scope RHOSTS", async () => {
  await doesNotRejectScope(byName("metasploit"), {
    module: "auxiliary/scanner/portscan/tcp",
    options: { RHOSTS: "192.168.1.1,192.168.1.2" },
  });
});

test("masscan rejects an out-of-scope range", async () => {
  await rejectsScope(byName("masscan"), { target: "10.0.0.0/24" });
});

test("dirb rejects an out-of-scope URL", async () => {
  await rejectsScope(byName("dirb"), { url: "http://10.0.0.1/" });
});

test("dnsenum rejects an out-of-scope domain", async () => {
  await rejectsScope(byName("dnsenum"), { domain: "other.com" });
});

test("enum4linux rejects an out-of-scope target", async () => {
  await rejectsScope(byName("enum4linux"), { target: "10.0.0.5" });
});

test("ffuf rejects an out-of-scope URL", async () => {
  await rejectsScope(byName("ffuf"), {
    url: "http://10.0.0.1/FUZZ",
    wordlist: "/usr/share/wordlists/dirb/common.txt",
  });
});

test("hydra rejects an out-of-scope target", async () => {
  await rejectsScope(byName("hydra"), { target: "10.0.0.5", service: "ssh" });
});

test("gobuster dir mode rejects an out-of-scope URL", async () => {
  await rejectsScope(byName("gobuster"), { mode: "dir", url: "http://10.0.0.1/" });
});

test("gobuster dns mode rejects an out-of-scope domain", async () => {
  await rejectsScope(byName("gobuster"), { mode: "dns", domain: "other.com" });
});

test("arping rejects an out-of-scope target", async () => {
  await rejectsScope(byName("arping"), { target: "10.0.0.5" });
});
