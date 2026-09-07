import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  FindingsMemory,
  parseNmapOutput,
  parseWhoisOutput,
  parseSearchsploitOutput,
  parseNiktoOutput,
} from "./findings-memory.js";

// ============================================================================
// FindingsMemory class tests
// ============================================================================

describe("FindingsMemory", () => {
  describe("constructor", () => {
    it("initializes with empty state", () => {
      const fm = new FindingsMemory();
      assert.deepEqual(fm.getAggregatedFindings(), {
        hosts: [],
        ports: [],
        services: [],
        cves: [],
        vulnerabilities: [],
        osInfo: [],
      });
      assert.ok(!fm.hasFindings());
    });
  });

  describe("processToolResult", () => {
    it("processes nmap results", () => {
      const fm = new FindingsMemory();
      const nmapOutput = `
Nmap scan report for 192.168.1.1
Host is up (0.045s latency).
PORT    STATE SERVICE     VERSION
22/tcp  open  ssh       OpenSSH 8.9p1 Ubuntu
80/tcp  open  http      Apache httpd 2.4.52
443/tcp open  https     Apache httpd 2.4.52
`;
      fm.processToolResult("nmap", nmapOutput);
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.hosts.length, 1);
      assert.equal(findings.hosts[0].ip, "192.168.1.1");
      assert.equal(findings.ports.length, 3);
      assert.ok(findings.ports.some((p) => p.port === 22));
      assert.ok(findings.ports.some((p) => p.port === 80));
      assert.ok(findings.ports.some((p) => p.port === 443));
      assert.ok(fm.hasFindings());
    });

    it("processes whois results", () => {
      const fm = new FindingsMemory();
      const whoisOutput = `
Domain Name: example.com
Registrar: Example Registrar, Inc.
Creation Date: 2020-01-01T00:00:00Z
Expiration Date: 2027-01-01T00:00:00Z
Name Server: ns1.example.com
Name Server: ns2.example.com
`;
      fm.processToolResult("whois", whoisOutput);
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.hosts.length, 1);
      assert.ok(findings.hosts.some((h) => h.domain === "example.com"));
    });

    it("processes searchsploit results", () => {
      const fm = new FindingsMemory();
      const searchsploitOutput = `
-------------------------------------------------------------------- ----------------------------------------
Exploit Title                                                     | Path
-------------------------------------------------------------------- ----------------------------------------
WordPress Plugin Duplicate Post 1.0 - Authentication Bypass     | webapps/49654.txt
OpenSSH 8.9 - Remote Code Execution (CVE-2024-1234)           | linux/remote/50001.py
`;
      fm.processToolResult("searchsploit", searchsploitOutput);
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.vulnerabilities.length, 2);
      assert.ok(findings.vulnerabilities.some((v) => v.title.includes("Authentication Bypass")));
      assert.ok(findings.vulnerabilities.some((v) => v.cves.includes("CVE-2024-1234")));
    });

    it("processes nikto results", () => {
      const fm = new FindingsMemory();
      const niktoOutput = `
- Nikto v2.5.0
+ Target IP: 192.168.1.1
+ Server: Apache/2.4.52
+ 200 OSVDB-877 - GET /phpinfo.php: phpinfo() is exposed
+ 200 CVE-2021-41773 - Path traversal vulnerability
`;
      fm.processToolResult("nikto", niktoOutput);
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.hosts.length, 1);
      assert.equal(findings.hosts[0].ip, "192.168.1.1");
      assert.equal(findings.hosts[0].server, "Apache/2.4.52");
      assert.equal(findings.vulnerabilities.length, 2);
    });

    it("processes generic tool output", () => {
      const fm = new FindingsMemory();
      const genericOutput = `
Scanning 192.168.1.1...
Found open port 22/tcp on 192.168.1.1
Potential vulnerability: CVE-2024-5678
`;
      fm.processToolResult("custom_tool", genericOutput);
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.hosts.length, 1);
      assert.equal(findings.hosts[0].ip, "192.168.1.1");
      assert.equal(findings.hosts[0].source, "custom_tool");
      assert.equal(findings.cves.length, 1);
      assert.ok(findings.cves.includes("CVE-2024-5678"));
    });

    it("accumulates findings from multiple tool results", () => {
      const fm = new FindingsMemory();
      
      // First nmap scan
      fm.processToolResult("nmap", "Nmap scan report for 192.168.1.1\n22/tcp open ssh");
      
      // Second nmap scan on different host
      fm.processToolResult("nmap", "Nmap scan report for 192.168.1.2\n80/tcp open http");
      
      const findings = fm.getAggregatedFindings();
      assert.equal(findings.hosts.length, 2);
      assert.equal(findings.ports.length, 2);
    });
  });

  describe("getSummary", () => {
    it("returns summary with no findings", () => {
      const fm = new FindingsMemory();
      const summary = fm.getSummary();
      assert.ok(summary.includes("No findings recorded yet"));
    });

    it("returns formatted summary with findings", () => {
      const fm = new FindingsMemory();
      fm.processToolResult("nmap", "Nmap scan report for 192.168.1.1\n22/tcp open ssh\n80/tcp open http");
      
      const summary = fm.getSummary();
      assert.ok(summary.includes("## Discovered Hosts"));
      assert.ok(summary.includes("192.168.1.1"));
      assert.ok(summary.includes("## Open Ports"));
      assert.ok(summary.includes("22/tcp"));
      assert.ok(summary.includes("80/tcp"));
    });

    it("respects maxTokens limit", () => {
      const fm = new FindingsMemory();
      // Add many findings
      for (let i = 0; i < 100; i++) {
        fm.processToolResult("nmap", `Nmap scan report for 192.168.1.${i}\n22/tcp open ssh`);
      }
      
      const summary = fm.getSummary(100); // Very small budget
      assert.ok(summary.length < 100 * 4); // Rough token estimate
    });
  });

  describe("clear", () => {
    it("resets all findings", () => {
      const fm = new FindingsMemory();
      fm.processToolResult("nmap", "Nmap scan report for 192.168.1.1\n22/tcp open ssh");
      
      assert.ok(fm.hasFindings());
      
      fm.clear();
      
      assert.ok(!fm.hasFindings());
      assert.deepEqual(fm.getAggregatedFindings(), {
        hosts: [],
        ports: [],
        services: [],
        cves: [],
        vulnerabilities: [],
        osInfo: [],
      });
    });
  });

  describe("getToolFindings", () => {
    it("returns findings for a specific tool", () => {
      const fm = new FindingsMemory();
      fm.processToolResult("nmap", "output1");
      fm.processToolResult("nmap", "output2");
      fm.processToolResult("whois", "output3");
      
      const nmapFindings = fm.getToolFindings("nmap");
      assert.equal(nmapFindings.length, 2);
      
      const whoisFindings = fm.getToolFindings("whois");
      assert.equal(whoisFindings.length, 1);
      
      const unknownFindings = fm.getToolFindings("unknown");
      assert.equal(unknownFindings.length, 0);
    });
  });
});

// ============================================================================
// Parser tests
// ============================================================================

describe("parseNmapOutput", () => {
  it("parses nmap text output", () => {
    const output = `
Nmap scan report for 192.168.1.1
Host is up (0.045s latency).
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 8.9p1 Ubuntu
80/tcp  open  http     Apache httpd 2.4.52
443/tcp open  https    Apache httpd 2.4.52
MAC Address: 00:11:22:33:44:55 (Intel Corp.)
`;
    const findings = parseNmapOutput(output);
    
    assert.equal(findings.hosts.length, 1);
    assert.equal(findings.hosts[0].ip, "192.168.1.1");
    assert.equal(findings.hosts[0].ports.length, 3);
    assert.equal(findings.hosts[0].ports[0].number, 22);
    assert.equal(findings.hosts[0].ports[0].service, "ssh");
    assert.equal(findings.hosts[0].mac, "00:11:22:33:44:55");
    assert.equal(findings.hosts[0].vendor, "Intel Corp.");
  });

  it("parses simplified nmap text output", () => {
    const output = `
Nmap scan report for 192.168.1.1
22/tcp open ssh
80/tcp open http
`;
    const findings = parseNmapOutput(output);
    
    assert.equal(findings.hosts.length, 1);
    assert.equal(findings.hosts[0].ip, "192.168.1.1");
    assert.equal(findings.hosts[0].ports.length, 2);
    assert.equal(findings.hosts[0].ports[0].number, 22);
    assert.equal(findings.hosts[0].ports[0].service, "ssh");
    assert.equal(findings.hosts[0].ports[1].number, 80);
    assert.equal(findings.hosts[0].ports[1].service, "http");
  });

  it("records the real host IP for open ports parsed from XML output", () => {
    const output = `<?xml version="1.0"?>
<nmaprun>
<host><address addr="10.0.0.5" addrtype="ipv4"/>
<ports><port protocol="tcp" portid="22"><state state="open"/><service name="ssh"/></port></ports>
</host>
</nmaprun>`;
    const findings = parseNmapOutput(output);

    assert.equal(findings.openPorts.length, 1);
    assert.equal(findings.openPorts[0].host, "10.0.0.5");
    assert.equal(findings.openPorts[0].port, 22);
  });

  it("handles empty output", () => {
    const findings = parseNmapOutput("");
    assert.deepEqual(findings.hosts, []);
    assert.deepEqual(findings.openPorts, []);
  });
});

describe("parseWhoisOutput", () => {
  it("parses domain whois output", () => {
    const output = `
Domain Name: example.com
Registrar: Example Registrar, Inc.
Creation Date: 2020-01-01
Expiration Date: 2027-01-01
Name Server: ns1.example.com
Name Server: ns2.example.com
Registrant Organization: Example Corp
Registrant Email: admin@example.com
`;
    const findings = parseWhoisOutput(output);
    
    assert.equal(findings.domain, "example.com");
    assert.equal(findings.registrar, "Example Registrar, Inc.");
    assert.equal(findings.creationDate, "2020-01-01");
    assert.equal(findings.expirationDate, "2027-01-01");
    assert.deepEqual(findings.nameServers, ["ns1.example.com", "ns2.example.com"]);
    assert.deepEqual(findings.contacts.Registrant, { organization: "Example Corp", email: "admin@example.com" });
  });

  it("handles empty output", () => {
    const findings = parseWhoisOutput("");
    assert.equal(findings.domain, null);
    assert.deepEqual(findings.nameServers, []);
  });
});

describe("parseSearchsploitOutput", () => {
  it("parses searchsploit tabular output", () => {
    const output = `
-------------------------------------------------------------------- ----------------------------------------
Exploit Title                                                     | Path
-------------------------------------------------------------------- ----------------------------------------
WordPress Plugin Duplicate Post 1.0 - Authentication Bypass     | webapps/49654.txt
OpenSSH 8.9 - Remote Code Execution (CVE-2024-1234)           | linux/remote/50001.py
`;
    const findings = parseSearchsploitOutput(output);
    
    assert.equal(findings.results.length, 2);
    assert.equal(findings.results[0].title, "WordPress Plugin Duplicate Post 1.0 - Authentication Bypass");
    assert.equal(findings.results[0].path, "webapps/49654.txt");
    assert.equal(findings.results[0].edbId, "49654");
    assert.equal(findings.results[1].cves.length, 1);
    assert.equal(findings.results[1].cves[0], "CVE-2024-1234");
  });

  it("handles empty output", () => {
    const findings = parseSearchsploitOutput("");
    assert.deepEqual(findings.results, []);
  });
});

describe("parseNiktoOutput", () => {
  it("parses nikto output", () => {
    const output = `
- Nikto v2.5.0
+ Target IP: 192.168.1.1
+ Server: Apache/2.4.52
+ 200 OSVDB-877 - GET /phpinfo.php: phpinfo() is exposed
+ 200 CVE-2021-41773 - Path traversal vulnerability
+ 200 GET /admin/ - Directory indexing enabled
`;
    const findings = parseNiktoOutput(output);
    
    assert.equal(findings.host, "192.168.1.1");
    assert.equal(findings.server, "Apache/2.4.52");
    assert.equal(findings.vulnerabilities.length, 2);
    assert.ok(findings.vulnerabilities.some((v) => v.type === "OSVDB-877"));
    assert.ok(findings.vulnerabilities.some((v) => v.type === "CVE-2021-41773"));
    assert.equal(findings.interestingItems.length, 1);
  });

  it("handles empty output", () => {
    const findings = parseNiktoOutput("");
    assert.equal(findings.host, null);
    assert.equal(findings.server, null);
    assert.deepEqual(findings.vulnerabilities, []);
  });
});
