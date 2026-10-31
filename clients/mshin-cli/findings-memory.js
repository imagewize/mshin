/**
 * FindingsMemory - Structured findings extraction and storage for Machin Shin.
 *
 * Extracts key facts from tool output into a separate, queryable summary that
 * survives context compaction. This is Option B from the roadmap's Context
 * Management section.
 *
 * The LLM prompt includes both the recent raw transcript and the findings summary,
 * so an early nmap result is still addressable ten steps later without consuming
 * the entire context window with raw tool output.
 */

/**
 * Parse an nmap XML or text output and extract structured findings.
 * Handles both XML (-oX) and standard text output formats.
 *
 * For XML output: extracts host information, open ports with service details,
 * OS detection results, and vulnerability data from the structured XML elements.
 *
 * For text output: parses the human-readable format looking for patterns like
 * "22/tcp open ssh" and "Nmap scan report for host", extracting hosts, ports,
 * services, and OS information.
 *
 * @param {string} output - Raw nmap output in either XML or text format
 * @returns {Object} Structured findings object
 * @returns {Array<Object>} returns.hosts - Discovered hosts with IP/hostname and port details
 * @returns {Array<Object>} returns.openPorts - All open ports found
 * @returns {Array<Object>} returns.services - Detected services
 * @returns {Array<Object>} returns.osMatches - OS detection results with confidence scores
 * @returns {Array<Object>} returns.vulnerabilities - Extracted vulnerability information
 * @returns {string} returns.raw - The original raw output
 */
function parseNmapOutput(output) {
  const findings = {
    hosts: [],
    openPorts: [],
    services: [],
    osMatches: [],
    vulnerabilities: [],
    raw: output,
  };

  if (!output) return findings;

  // Try to parse as XML first
  if (output.trim().startsWith("<?xml") || output.includes("<nmaprun")) {
    try {
      // Simple XML parsing - look for host/ports/port elements
      const hostMatches = output.match(/<host[^>]*>.*?<\/host>/gis) || [];
      for (const hostMatch of hostMatches) {
        const ipMatch = hostMatch.match(/addr="([^"]+)"/);
        const hostnameMatch = hostMatch.match(/<hostname[^>]*name="([^"]+)"/);
        
        if (ipMatch) {
          const host = {
            ip: ipMatch[1],
            hostname: hostnameMatch ? hostnameMatch[1] : null,
            ports: [],
          };

          // Extract ports from this host
          const portMatches = hostMatch.match(/<port[^>]*>.*?<\/port>/gis) || [];
          for (const portMatch of portMatches) {
            const portIdMatch = portMatch.match(/portid="(\d+)"/);
            const protocolMatch = portMatch.match(/protocol="([^"]+)"/);
            const stateMatch = portMatch.match(/<state[^>]*state="([^"]+)"/);
            const serviceMatch = portMatch.match(/<service[^>]*name="([^"]+)"/);
            const versionMatch = portMatch.match(/version="([^"]+)"/);
            const productMatch = portMatch.match(/product="([^"]+)"/);

            if (portIdMatch) {
              const port = {
                number: parseInt(portIdMatch[1], 10),
                protocol: protocolMatch ? protocolMatch[1] : "tcp",
                state: stateMatch ? stateMatch[1] : "unknown",
                service: serviceMatch ? serviceMatch[1] : null,
                version: versionMatch ? versionMatch[1] : null,
                product: productMatch ? productMatch[1] : null,
              };

              if (stateMatch && stateMatch[1] === "open") {
                host.ports.push(port);
                findings.openPorts.push({
                  host: host.ip,
                  port: port.number,
                  protocol: port.protocol,
                  service: port.service,
                  version: port.version,
                });
                findings.services.push({
                  host: host.ip,
                  port: port.number,
                  name: port.service,
                  version: port.version,
                  product: port.product,
                });
              }
            }
          }

          // Extract OS matches
          const osMatch = hostMatch.match(/<osmatch[^>]*>.*?<\/osmatch>/gis);
          if (osMatch) {
            const osNameMatch = osMatch[0].match(/name="([^"]+)"/);
            const osAccuracyMatch = osMatch[0].match(/accuracy="([^"]+)"/);
            if (osNameMatch) {
              findings.osMatches.push({
                host: host.ip,
                name: osNameMatch[1],
                accuracy: osAccuracyMatch ? parseInt(osAccuracyMatch[1], 10) : null,
              });
            }
          }

          if (host.ports.length > 0 || findings.osMatches.length > 0) {
            findings.hosts.push(host);
          }
        }
      }
    } catch (e) {
      // XML parsing failed, fall through to text parsing
    }
  }

  // Parse text format nmap output
  // Looks for lines like: "22/tcp open  ssh     OpenSSH 8.9p1 Ubuntu"
  const lines = output.split("\n");
  let currentHost = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Nmap text output: "Nmap scan report for host" or "Host is up"
    const hostUpMatch = trimmed.match(/Nmap scan report for (.+)/);
    if (hostUpMatch) {
      currentHost = hostUpMatch[1];
      // Add host if not already present
      if (!findings.hosts.some((h) => h.ip === currentHost || h.hostname === currentHost)) {
        findings.hosts.push({
          ip: currentHost,
          hostname: null,
          ports: [],
        });
      }
      continue;
    }

    // Port line: "22/tcp open  ssh     OpenSSH 8.9p1 Ubuntu"
    // The format is: port/protocol state service (version/product info)
    // We need to match port/protocol first, then state. The trailing group
    // captures the version/product remainder -- an earlier `\s*($|.*)` shape
    // swallowed it into the match, leaving the version always null.
    const portLineMatch = trimmed.match(
      /^(\d+)\/(\w+)\s+(\w+)\s+(\S+)(?:\s+(.*))?$/
    );
    
    if (portLineMatch) {
      const [, portNum, protocol, state, service] = portLineMatch;
      
      // Only process open ports
      if (state === "open") {
        // The rest of the line after service might contain version info
        const restOfLine = (portLineMatch[5] || "").trim();
        let version = null;
        let product = null;
        
        // Try to extract version and product from the rest
        if (restOfLine) {
          // Common pattern: "OpenSSH 8.9p1 Ubuntu" or "Apache httpd 2.4.52"
          version = restOfLine;
          product = null;
        }
        
        const port = {
          number: parseInt(portNum, 10),
          protocol,
          state,
          service: service !== "unknown" ? service : null,
          version: version && version !== "unknown" ? version : null,
          product: product && product !== "unknown" ? product : null,
        };

        if (currentHost) {
          const host = findings.hosts.find(
            (h) => h.ip === currentHost || h.hostname === currentHost
          );
          if (host) {
            host.ports.push(port);
          }
        }

        findings.openPorts.push({
          host: currentHost,
          port: port.number,
          protocol: port.protocol,
          service: port.service,
          version: port.version,
        });

        findings.services.push({
          host: currentHost,
          port: port.number,
          name: port.service,
          version: port.version,
          product: port.product,
        });
      }
    }

    // OS detection lines
    const osMatch = trimmed.match(/^OS details:\s+(.+)/i);
    if (osMatch) {
      findings.osMatches.push({
        host: currentHost,
        name: osMatch[1],
        accuracy: null,
      });
    }

    // MAC address lines
    const macMatch = trimmed.match(/^MAC Address:\s+(.+)\s+\((.+)\)/i);
    if (macMatch && currentHost) {
      const host = findings.hosts.find(
        (h) => h.ip === currentHost || h.hostname === currentHost
      );
      if (host) {
        host.mac = macMatch[1];
        host.vendor = macMatch[2];
      }
    }
  }

  return findings;
}

/**
 * Parse whois output to extract domain/IP information.
 *
 * Handles both domain and IP whois output formats, extracting registry
 * information, contact details, dates, and name servers from the semi-structured
 * text output.
 *
 * @param {string} output - Raw whois command output
 * @returns {Object} Structured findings object
 * @returns {string|null} returns.domain - The domain name
 * @returns {string|null} returns.ip - IP address (for IP whois)
 * @returns {string|null} returns.registrar - Registrar organization
 * @returns {string|null} returns.creationDate - Domain registration date
 * @returns {string|null} returns.expirationDate - Domain expiration date
 * @returns {Array<string>} returns.nameServers - List of name servers
 * @returns {Object} returns.contacts - Contact information grouped by type (Registrant, Admin, Tech, Billing)
 * @returns {string} returns.raw - The original raw output
 */
function parseWhoisOutput(output) {
  const findings = {
    domain: null,
    ip: null,
    registrar: null,
    creationDate: null,
    expirationDate: null,
    nameServers: [],
    contacts: {},
    raw: output,
  };

  if (!output) return findings;

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Domain name
    if (/^Domain Name:\s*(.+)/i.test(trimmed)) {
      findings.domain = trimmed.split(":")[1].trim();
    }

    // IP address (for IP whois)
    if (/^inetnum:\s*(.+)/i.test(trimmed)) {
      const match = trimmed.match(/^inetnum:\s*([\d.]+)/);
      if (match) findings.ip = match[1];
    }

    // Registrar
    if (/^(Registrar|Sponsoring Registrar):\s*(.+)/i.test(trimmed)) {
      findings.registrar = trimmed.split(":")[1].trim();
    }

    // Creation date
    if (/^(Creation Date|Registered on|created):\s*(.+)/i.test(trimmed)) {
      findings.creationDate = trimmed.split(":")[1].trim();
    }

    // Expiration date
    if (/^(Expiration Date|Registry Expiry Date|expires):\s*(.+)/i.test(trimmed)) {
      findings.expirationDate = trimmed.split(":")[1].trim();
    }

    // Name servers
    if (/^(Name Server|nserver|Nameservers?):\s*(.+)/i.test(trimmed)) {
      const ns = trimmed.split(":")[1].trim();
      findings.nameServers.push(ns);
    }

    // Contacts (registrant, admin, tech, billing)
    if (/^(Registrant|Admin|Tech|Billing) (Organization|Name|Email|Phone):\s*(.+)/i.test(trimmed)) {
      const match = trimmed.match(/^(Registrant|Admin|Tech|Billing) (\w+):\s*(.+)/i);
      if (match) {
        const [, contactType, field, value] = match;
        findings.contacts[contactType] = findings.contacts[contactType] || {};
        findings.contacts[contactType][field.toLowerCase()] = value.trim();
      }
    }
  }

  return findings;
}

/**
 * Parse searchsploit output to extract exploit information.
 *
 * Extracts exploit database entries from searchsploit's tabular output format,
 * identifying exploits by title, path, EDB-ID, and associated CVE references.
 * Handles the characteristic table format with "Exploit Title" and "Path" headers.
 *
 * @param {string} output - Raw searchsploit command output
 * @returns {Object} Structured findings object
 * @returns {string|null} returns.query - The search query used
 * @returns {Array<Object>} returns.results - List of exploit results
 * @returns {string} returns.results[].title - Exploit title
 * @returns {string} returns.results[].path - Exploit path in the database
 * @returns {string|null} returns.results[].edbId - Exploit Database ID
 * @returns {Array<string>} returns.results[].cves - Associated CVE identifiers
 * @returns {string} returns.raw - The original raw output
 */
function parseSearchsploitOutput(output) {
  const findings = {
    query: null,
    results: [],
    raw: output,
  };

  if (!output) return findings;

  const lines = output.split("\n");
  
  // First line is typically the query
  if (lines[0]) {
    findings.query = lines[0].trim();
  }

  // Parse exploit results
  // searchsploit output format:
  // -------------------------------------------------------------------- ----------------------------------------
  // Exploit Title                                                                     | Path
  // -------------------------------------------------------------------- ----------------------------------------
  // WordPress Plugin Duplicate Post 1.0 - Authentication Bypass             | webapps/49654.txt
  // ...
  
  let inResults = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of results table
    if (trimmed.startsWith("-----") || trimmed.includes("Exploit Title")) {
      inResults = true;
      continue;
    }

    if (inResults && trimmed) {
      // Skip empty lines and separators
      if (trimmed === "" || trimmed.startsWith("=") || trimmed.startsWith("-")) {
        continue;
      }

      // Parse exploit line: "Title | path"
      const pipeIndex = trimmed.indexOf("|");
      if (pipeIndex > 0) {
        const title = trimmed.slice(0, pipeIndex).trim();
        const path = trimmed.slice(pipeIndex + 1).trim();

        // Extract EDB-ID from path if present
        const edbMatch = path.match(/(\d+)\.txt/);
        const cveMatch = title.match(/(CVE-\d{4}-\d+)/g);

        findings.results.push({
          title,
          path,
          edbId: edbMatch ? edbMatch[1] : null,
          cvss: null,
          cves: cveMatch || [],
          type: null,
          platform: null,
        });
      }
    }
  }

  return findings;
}

/**
 * Parse nikto output to extract vulnerability findings.
 *
 * Extracts server information, vulnerability indicators, and interesting
 * security items from nikto's scan output. Identifies CVEs, OSVDB entries,
 * and other security findings from the characteristic "+ " prefixed lines.
 *
 * @param {string} output - Raw nikto command output
 * @returns {Object} Structured findings object
 * @returns {string|null} returns.host - Target host IP address
 * @returns {string|null} returns.server - Server software and version
 * @returns {Array<Object>} returns.vulnerabilities - Detected vulnerabilities with type and description
 * @returns {Array<Object>} returns.interestingItems - Other notable findings
 * @returns {string} returns.raw - The original raw output
 */
function parseNiktoOutput(output) {
  const findings = {
    host: null,
    server: null,
    vulnerabilities: [],
    interestingItems: [],
    raw: output,
  };

  if (!output) return findings;

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Server info: "+ Server: Apache/2.4.41"
    const serverMatch = trimmed.match(/\+ Server:\s*(.+)/i);
    if (serverMatch) {
      findings.server = serverMatch[1].trim();
      continue;
    }

    // Host info
    const hostMatch = trimmed.match(/\+ Target IP:\s*(\d+\.\d+\.\d+\.\d+)/i);
    if (hostMatch) {
      findings.host = hostMatch[1];
      continue;
    }

    // Vulnerability indicators
    const vulnMatch = trimmed.match(/^\+ \d+\s+(\S+)\s+(.+)/);
    if (vulnMatch) {
      const [, type, description] = vulnMatch;
      
      // Common nikto item types: OSVDB, CVE, etc.
      const isVulnerability = ["OSVDB", "CVE", "MSF", "VULNERABLE"].some((t) =>
        type.toUpperCase().includes(t)
      );

      if (isVulnerability) {
        findings.vulnerabilities.push({
          type,
          description,
        });
      } else {
        // Other interesting items
        findings.interestingItems.push({
          type,
          description,
        });
      }
    }
  }

  return findings;
}

/**
 * Parse generic text output and try to extract any IP addresses, ports, CVEs.
 *
 * Fallback parser for tools without dedicated parsers. Uses regex patterns
 * to extract common cybersecurity entities: IPv4 addresses, port/protocol
 * combinations, and CVE identifiers. Also captures interesting lines that
 * contain these entities for context.
 *
 * This provides a safety net ensuring that even unstructured tool output
 * contributes to the findings memory with basic entity extraction.
 *
 * @param {string} output - Raw tool output text
 * @param {string} toolName - Name of the tool that produced this output
 * @returns {Object} Structured findings object
 * @returns {string} returns.tool - The tool name
 * @returns {Array<string>} returns.hosts - Extracted IPv4 addresses (deduplicated)
 * @returns {Array<Object>} returns.ports - Extracted port/protocol pairs
 * @returns {Array<string>} returns.cves - Extracted CVE identifiers (deduplicated)
 * @returns {Array<string>} returns.interestingLines - Lines containing important entities
 * @returns {string} returns.raw - The original raw output
 */
function parseGenericOutput(output, toolName) {
  const findings = {
    tool: toolName,
    hosts: [],
    ports: [],
    cves: [],
    interestingLines: [],
    raw: output,
  };

  if (!output) return findings;

  const lines = output.split("\n");

  // Extract IP addresses (IPv4)
  const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const ipMatches = output.match(ipRegex) || [];
  findings.hosts = [...new Set(ipMatches)]; // Deduplicate

  // Extract port numbers
  const portRegex = /\b(\d{1,5})\/(tcp|udp)\b/g;
  const portMatches = output.match(portRegex) || [];
  findings.ports = portMatches.map((m) => {
    const [port, protocol] = m.split("/");
    return { port: parseInt(port, 10), protocol };
  });

  // Extract CVE references
  const cveRegex = /(CVE-\d{4}-\d+)/g;
  const cveMatches = output.match(cveRegex) || [];
  findings.cves = [...new Set(cveMatches)]; // Deduplicate

  // If we found important items, save the lines that contain them
  if (findings.cves.length > 0 || findings.ports.length > 0) {
    for (const line of lines) {
      if (
        findings.cves.some((cve) => line.includes(cve)) ||
        findings.ports.some((p) => line.includes(`${p.port}/${p.protocol}`))
      ) {
        findings.interestingLines.push(line.trim());
      }
    }
  }

  return findings;
}

/**
 * Tool-specific parsers mapping.
 */
const PARSERS = {
  nmap: parseNmapOutput,
  whois: parseWhoisOutput,
  searchsploit: parseSearchsploitOutput,
  nikto: parseNiktoOutput,
};

/**
 * Render one tool's raw output as compact structured "signal" — the facts a
 * model actually reasons about (host/port/service/version for nmap, registrar
 * and dates for whois, exploit paths and CVEs for searchsploit) — dropping the
 * prose boilerplate. Used by context compression so a 200-line nmap output
 * can reach the LLM as ~10 lines of signal instead of a head/tail window.
 *
 * Returns null when the parser extracts nothing structured, so the caller can
 * fall back to plain head/tail truncation rather than replacing real output
 * with an empty summary.
 *
 * @param {string} toolName - Name of the tool that produced the output
 * @param {string} output - Raw tool output
 * @param {number} [maxLines] - Cap on rendered signal lines before an omitted marker
 * @returns {string|null} Compact multi-line signal, or null if nothing was extracted
 */
function summarizeToolOutput(toolName, output, maxLines = 40) {
  if (!output) return null;
  const parser = PARSERS[toolName] || parseGenericOutput;
  const findings = parser(output, toolName);
  const lines = [];

  switch (toolName) {
    case "nmap": {
      const hosts = findings.hosts || [];
      const open = findings.openPorts || [];
      if (hosts.length === 0 && open.length === 0) return null;
      lines.push(`nmap: ${hosts.length} host(s), ${open.length} open port(s)`);
      for (const port of open) {
        const svc = [port.service, port.version].filter(Boolean).join(" ");
        lines.push(`  ${port.host}:${port.port}/${port.protocol} open ${svc}`.trimEnd());
      }
      for (const host of hosts) {
        if (host.mac) {
          lines.push(`  host ${host.ip} MAC ${host.mac}${host.vendor ? ` (${host.vendor})` : ""}`);
        }
      }
      for (const os of findings.osMatches || []) {
        lines.push(`  OS ${os.host}: ${os.name}${os.accuracy ? ` (${os.accuracy}%)` : ""}`);
      }
      break;
    }
    case "whois": {
      if (!findings.domain && !findings.ip) return null;
      const parts = [];
      if (findings.domain) parts.push(`domain ${findings.domain}`);
      if (findings.ip) parts.push(`ip ${findings.ip}`);
      if (findings.registrar) parts.push(`registrar ${findings.registrar}`);
      if (findings.creationDate) parts.push(`created ${findings.creationDate}`);
      if (findings.expirationDate) parts.push(`expires ${findings.expirationDate}`);
      lines.push(`whois: ${parts.join(", ")}`);
      for (const ns of findings.nameServers || []) lines.push(`  NS ${ns}`);
      break;
    }
    case "searchsploit": {
      const results = findings.results || [];
      if (results.length === 0) return null;
      lines.push(`searchsploit ${findings.query || ""}: ${results.length} result(s)`.trimEnd());
      for (const r of results) {
        const cves = r.cves?.length ? ` ${r.cves.join(", ")}` : "";
        const edb = r.edbId ? ` (EDB-${r.edbId})` : "";
        lines.push(`  ${r.title} | ${r.path}${edb}${cves}`);
      }
      break;
    }
    case "nikto": {
      const vulns = findings.vulnerabilities || [];
      const items = findings.interestingItems || [];
      if (!findings.host && vulns.length === 0 && items.length === 0) return null;
      lines.push(`nikto: host ${findings.host || "?"}, server ${findings.server || "?"}`);
      for (const v of vulns) lines.push(`  [${v.type}] ${v.description}`);
      for (const it of items) lines.push(`  ${it.type}: ${it.description}`);
      break;
    }
    default: {
      const hosts = findings.hosts || [];
      const ports = findings.ports || [];
      const cves = findings.cves || [];
      const interesting = findings.interestingLines || [];
      if (hosts.length === 0 && ports.length === 0 && cves.length === 0 && interesting.length === 0) {
        return null;
      }
      if (hosts.length > 0) lines.push(`${toolName}: hosts ${hosts.join(", ")}`);
      if (ports.length > 0) {
        lines.push(`${toolName}: ports ${ports.map((p) => `${p.port}/${p.protocol}`).join(", ")}`);
      }
      if (cves.length > 0) lines.push(`${toolName}: CVEs ${cves.join(", ")}`);
      for (const line of interesting) lines.push(`  ${line}`);
      break;
    }
  }

  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    return [
      ...lines.slice(0, maxLines),
      `... (${omitted} more signal lines omitted; full output in session memory) ...`,
    ].join("\n");
  }
  return lines.join("\n");
}

/**
 * FindingsMemory - Maintains a structured summary of findings extracted from tool outputs.
 * 
 * This summary persists even when the raw tool output is compressed or dropped during
 * context management, ensuring that critical findings (hosts, ports, services, CVEs) remain
 * addressable by the LLM throughout a long session.
 */
class FindingsMemory {
  constructor() {
    // All findings stored by tool name
    this.findingsByTool = {};
    
    // Aggregated findings for easy querying
    this.aggregated = {
      hosts: new Map(),      // ip -> host info
      ports: new Map(),      // "ip:port/protocol" -> port info
      services: new Map(),   // "ip:port" -> service info
      cves: new Set(),       // CVE strings
      vulnerabilities: [],   // Aggregated vulnerability info
      osInfo: [],            // OS detection results
    };
    
    // Track which tool results have been processed
    this.processedTools = new Set();
  }

  /**
   * Process a tool result and extract structured findings.
   * 
   * @param {string} toolName - Name of the tool
   * @param {string} output - Tool output text
   * @param {Object} toolArgs - Arguments passed to the tool (optional)
   */
  processToolResult(toolName, output, toolArgs = {}) {
    const parser = PARSERS[toolName] || parseGenericOutput;
    const findings = parser(output, toolName);
    
    // Store raw findings by tool
    this.findingsByTool[toolName] = this.findingsByTool[toolName] || [];
    this.findingsByTool[toolName].push({
      output: findings.raw,
      findings,
      args: toolArgs,
      timestamp: Date.now(),
    });

    // Mark this tool result as processed
    this.processedTools.add(`${toolName}:${Date.now()}`);

    // Aggregate findings
    this._aggregateFindings(findings, toolName);
  }

  /**
   * Aggregate findings from a single tool result into the global view.
   */
  _aggregateFindings(findings, toolName) {
    switch (toolName) {
      case "nmap":
        for (const host of findings.hosts) {
          this.aggregated.hosts.set(host.ip || host.hostname, host);
        }
        for (const port of findings.openPorts) {
          const key = `${port.host}:${port.port}/${port.protocol}`;
          this.aggregated.ports.set(key, port);
          
          const serviceKey = `${port.host}:${port.port}`;
          this.aggregated.services.set(serviceKey, {
            name: port.service,
            version: port.version,
          });
        }
        this.aggregated.osInfo.push(...findings.osMatches);
        break;

      case "whois":
        if (findings.ip) {
          this.aggregated.hosts.set(findings.ip, {
            ip: findings.ip,
            domain: findings.domain,
            registrar: findings.registrar,
            type: "whois",
          });
        }
        if (findings.domain) {
          this.aggregated.hosts.set(findings.domain, {
            domain: findings.domain,
            ip: findings.ip,
            registrar: findings.registrar,
            creationDate: findings.creationDate,
            expirationDate: findings.expirationDate,
            nameServers: findings.nameServers,
            type: "whois",
          });
        }
        break;

      case "searchsploit":
        for (const result of findings.results) {
          if (result.cves && result.cves.length > 0) {
            result.cves.forEach((cve) => this.aggregated.cves.add(cve));
          }
          this.aggregated.vulnerabilities.push({
            source: "searchsploit",
            query: findings.query,
            title: result.title,
            edbId: result.edbId,
            cves: result.cves,
            path: result.path,
          });
        }
        break;

      case "nikto":
        if (findings.host) {
          this.aggregated.hosts.set(findings.host, {
            ip: findings.host,
            server: findings.server,
            type: "nikto",
          });
        }
        for (const vuln of findings.vulnerabilities) {
          this.aggregated.vulnerabilities.push({
            source: "nikto",
            host: findings.host,
            type: vuln.type,
            description: vuln.description,
          });
          // Extract CVEs from description
          const cveMatches = vuln.description.match(/(CVE-\d{4}-\d+)/g) || [];
          cveMatches.forEach((cve) => this.aggregated.cves.add(cve));
        }
        break;

      default:
        // Generic aggregation
        for (const host of findings.hosts) {
          this.aggregated.hosts.set(host, { ip: host, source: toolName });
        }
        for (const cve of findings.cves) {
          this.aggregated.cves.add(cve);
        }
        break;
    }
  }

  /**
   * Generate a human-readable summary of all findings for inclusion in LLM context.
   * 
   * @param {number} maxTokens - Maximum tokens for the summary
   * @returns {string} Formatted findings summary
   */
  getSummary(maxTokens = 2000) {
    const parts = [];

    // Hosts
    if (this.aggregated.hosts.size > 0) {
      parts.push("## Discovered Hosts");
      parts.push("");
      for (const [key, host] of this.aggregated.hosts) {
        const lineParts = [];
        if (host.ip) lineParts.push(`IP: ${host.ip}`);
        if (host.domain) lineParts.push(`Domain: ${host.domain}`);
        if (host.hostname) lineParts.push(`Hostname: ${host.hostname}`);
        if (host.registrar) lineParts.push(`Registrar: ${host.registrar}`);
        if (host.server) lineParts.push(`Server: ${host.server}`);
        
        if (host.ports && host.ports.length > 0) {
          const portStr = host.ports
            .map((p) => `${p.number}/${p.protocol} (${p.service || "?"})`)
            .join(", ");
          lineParts.push(`Ports: ${portStr}`);
        }
        
        if (lineParts.length > 0) {
          parts.push(`- ${lineParts.join("; ")}`);
        }
      }
      parts.push("");
    }

    // Open Ports
    if (this.aggregated.ports.size > 0) {
      parts.push("## Open Ports");
      parts.push("");
      for (const [key, port] of this.aggregated.ports) {
        const serviceInfo = this.aggregated.services.get(`${port.host}:${port.port}`) || {};
        const portLine = [
          `${port.host}:${port.port}/${port.protocol}`,
          port.service ? `Service: ${port.service}` : null,
          serviceInfo.version ? `Version: ${serviceInfo.version}` : null,
        ].filter(Boolean).join(", ");
        parts.push(`- ${portLine}`);
      }
      parts.push("");
    }

    // Services
    if (this.aggregated.services.size > 0 && this.aggregated.ports.size === 0) {
      parts.push("## Detected Services");
      parts.push("");
      for (const [key, service] of this.aggregated.services) {
        const [host, port] = key.split(":");
        parts.push(`- ${host}:${port} - ${service.name}${service.version ? ` (${service.version})` : ""}`);
      }
      parts.push("");
    }

    // Vulnerabilities
    if (this.aggregated.vulnerabilities.length > 0) {
      parts.push("## Vulnerabilities");
      parts.push("");
      for (const vuln of this.aggregated.vulnerabilities) {
        // searchsploit entries carry title/cves/edbId; nikto entries carry
        // host/type/description instead. Render whichever fields are present
        // so nikto findings aren't reduced to a bare "nikto" line.
        const vulnLine = [
          vuln.source,
          vuln.host,
          vuln.title,
          vuln.type,
          vuln.description,
          vuln.cves?.join(", "),
          vuln.edbId ? `EDB-${vuln.edbId}` : null,
        ].filter(Boolean).join(" | ");
        parts.push(`- ${vulnLine}`);
      }
      parts.push("");
    }

    // CVEs
    if (this.aggregated.cves.size > 0) {
      parts.push("## Known CVEs");
      parts.push("");
      parts.push(`- ${[...this.aggregated.cves].join(", ")}`);
      parts.push("");
    }

    // OS Info
    if (this.aggregated.osInfo.length > 0) {
      parts.push("## OS Detection");
      parts.push("");
      for (const os of this.aggregated.osInfo) {
        parts.push(`- ${os.host}: ${os.name}${os.accuracy ? ` (${os.accuracy}% confidence)` : ""}`);
      }
      parts.push("");
    }

    // If no findings yet
    if (parts.length === 0) {
      return "No findings recorded yet.";
    }

    const summary = parts.join("\n");
    
    // Token estimation and truncation
    const estimatedTokens = Math.ceil(summary.length / 4);
    if (estimatedTokens > maxTokens) {
      // Truncate from the end, keeping the most recent/important sections
      return this._truncateSummary(summary, maxTokens);
    }
    
    return summary;
  }

  /**
   * Truncate summary to fit token budget, keeping the most important sections.
   */
  _truncateSummary(summary, maxTokens) {
    // Split by double newline to get sections
    const sections = summary.split("\n\n");
    const maxChars = maxTokens * 4;
    
    let result = [];
    let currentLength = 0;
    
    // Prioritize sections: vulnerabilities, CVEs, then hosts, then ports
    const priorityOrder = [
      "## Vulnerabilities",
      "## Known CVEs", 
      "## Discovered Hosts",
      "## Open Ports",
      "## Detected Services",
      "## OS Detection",
    ];
    
    // First, include priority sections in order
    for (const priority of priorityOrder) {
      const prioritySections = sections.filter((s) => s.startsWith(priority));
      for (const section of prioritySections) {
        const sectionLength = section.length + 2; // +2 for the \n\n we removed
        if (currentLength + sectionLength <= maxChars) {
          result.push(section);
          currentLength += sectionLength;
        }
      }
    }
    
    // If still room, add remaining sections
    if (currentLength < maxChars) {
      for (const section of sections) {
        if (!priorityOrder.some((p) => section.startsWith(p)) && section.trim()) {
          const sectionLength = section.length + 2;
          if (currentLength + sectionLength <= maxChars) {
            result.push(section);
            currentLength += sectionLength;
          }
        }
      }
    }
    
    return result.join("\n\n");
  }

  /**
   * Get findings for a specific tool.
   */
  getToolFindings(toolName) {
    return this.findingsByTool[toolName] || [];
  }

  /**
   * Get aggregated findings.
   */
  getAggregatedFindings() {
    return {
      hosts: [...this.aggregated.hosts.values()],
      ports: [...this.aggregated.ports.values()],
      services: [...this.aggregated.services.entries()].map(([key, val]) => ({
        key,
        ...val,
      })),
      cves: [...this.aggregated.cves],
      vulnerabilities: [...this.aggregated.vulnerabilities],
      osInfo: [...this.aggregated.osInfo],
    };
  }

  /**
   * Reset all findings.
   */
  clear() {
    this.findingsByTool = {};
    this.aggregated = {
      hosts: new Map(),
      ports: new Map(),
      services: new Map(),
      cves: new Set(),
      vulnerabilities: [],
      osInfo: [],
    };
    this.processedTools = new Set();
  }

  /**
   * Check if any findings have been recorded.
   */
  hasFindings() {
    return (
      this.aggregated.hosts.size > 0 ||
      this.aggregated.ports.size > 0 ||
      this.aggregated.cves.size > 0 ||
      this.aggregated.vulnerabilities.length > 0
    );
  }
}

export { FindingsMemory, parseNmapOutput, parseWhoisOutput, parseSearchsploitOutput, parseNiktoOutput, summarizeToolOutput };
export default FindingsMemory;
