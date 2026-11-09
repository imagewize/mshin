# Security Policy

> *"A flaw kept secret festers; a flaw reported is a Pattern rewoven."*

Machin Shin orchestrates offensive-security tools, and its own surface — the MCP Node's HTTP API and bearer token, the CLI's handling of scan output, the Docker image — deserves the same care it asks of its users. This page explains how to report a vulnerability privately.

## Supported Versions

Security fixes are applied to the **latest release** only.

| Version | Supported |
| ------- | --------- |
| 0.28.x (latest) | yes |
| < 0.28 | no |

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a security vulnerability.**

Report privately through either channel:

1. **GitHub private vulnerability reporting** — on this repository's **Security** tab, open **Advisories** and choose **Report a vulnerability**. Preferred: it keeps the discussion, the fix, and the coordinated disclosure in one place.
2. **Email** — `jasper@imagewize.com` with `[mshin security]` in the subject line.

Please include, where you can:

- What the vulnerability is and its security impact
- Steps to reproduce, or the request / tool call that triggers it
- Affected component and version (`servers/src/kali/`, `clients/mshin-cli/`, or the Docker image tag)
- Any mitigation you would suggest

## What to Expect

- Acknowledgement within **72 hours**
- A status update at least every **7 days** while a fix is in progress
- Credit in the advisory and release notes, unless you ask to remain anonymous

## Scope

**In scope:** the MCP server (`servers/`), the CLI (`clients/`), the Docker image (`configs/Dockerfile`, `configs/compose*.yaml`), token handling (`MSHIN_NODE_TOKEN`), and this repository itself.

**Out of scope:** vulnerabilities in the third-party tools the Node wraps (Kali packages, nmap, Ollama) — report those to the upstream projects. Misuse of Machin Shin against systems you do not own or are not authorized to test is out of scope by design; see [Authorized use only](README.md#authorized-use-only).
