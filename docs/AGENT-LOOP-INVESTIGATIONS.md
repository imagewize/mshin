# Machin Shin Agent-Loop Investigations

> *"The Black Wind does not tire, and it does not turn back. But a wind that circles the same stone forever has gone nowhere at all, and the Ways are full of such winds."*

Open and recently closed defects in the **agent loop** (`clients/mshin-cli/agent.js`),
each found by running the evaluation harness against live inference rather than by
reading the code. This document is the working record: what was measured, what it
means, and what is still unknown.

`CHANGELOG.md` records what shipped. This file records the reasoning, including the
wrong turns — those are the expensive part to rediscover.

---

## Method

Every finding below came from `clients/mshin-cli/eval-harness.js` driving a real
Ollama model against a real MCP Node. Two facts about the local setup shape all of
it:

- **No tool executes successfully on the macOS authoring host.** `tools.js` runs
  every binary except `tshark` as `sudo -n`, which needs the Linux Node's `sudoers`
  allowlist. `tshark` skips sudo but its binary is absent. So local runs exercise
  tool **calling** and **failure handling**, never tool **output**.
- **That turned out to be useful.** A Node that cannot run its tools is exactly the
  misconfigured-sudoers case a real deployment hits, and it is what surfaced the
  three defects below.

**But the host only ever reaches the failure branch.** Because every tool fails
under `sudo -n`, a host run validates tool *calling* and unavailable-tool
*handling* and nothing else — it can never show what the loop does once a tool
*succeeds*: the happy-path multi-tool chain, or any fix whose behaviour differs
between a tool that returns output and one that does not. For that, run against the
**`mshin-node` Lima VM**, where the provisioned `/etc/sudoers.d/mshin` allowlist
lets the binaries actually execute (`sudo -n whois` returns real output). Verifying
a happy-path change on the host alone wastes the run: the code path under test is
never reached. Two gotchas when pointing the harness at the VM — its MCP server is
a long-lived systemd unit (`mshin-node.service`) that keeps the code it loaded at
start, so after editing the mounted repo you must `sudo systemctl restart
mshin-node` or the old code answers (a stale build returns `Cannot POST /mcp`
against the current harness); and the persona is a *thinking* 7-8B, which, fed a
verbose real tool result, can generate for many minutes on an M-series Mac's
CPU/GPU — well past the two-minute-per-case rule of thumb below.

Models used: `mshin` (the persona, 7B-class) and `qwen3:8b`.

---

## Addressed: the unavailable-tool guidance may prevent termination

**Status: termination fixed and live-verified; multi-tool continuation still open.**

### What the loop does now

When a tool fails for an environmental reason — `sudo: a password is required`, a
missing binary, `no new privileges` — the loop marks it unavailable for the run,
pushes a short `role: "tool"` message with the error and a retry-suppression
line, and then pushes the direction to continue as a separate `role: "user"`
message.

### What was measured

| Run | Guidance in the tool slot | Step 2 outcome |
| --- | ------------------------- | -------------- |
| Pre-fix | Raw error text, short | Completed in ~95s; model answered |
| Post-fix | Long imperative block | Never returned |

Three attempts at the two-tool `recon-chain` case (whois a registrar, then scan
`127.0.0.1`) produced no answer at all:

```
FAIL — fetch failed                          329163 ms   (300s transport ceiling)
FAIL — fetch failed                          328580 ms   (300s transport ceiling)
FAIL — Ollama request timed out after 600s   622941 ms   (raised ceiling)
```

All three died on the model call **after** the guidance message was pushed. Raising
the timeout from 300s to 600s moved the failure but did not reach an answer.

### What this rules out

The 300s ceiling was real and is fixed (see below), but it was **not** the cause
here. If step 2 merely took a long time, doubling the limit would have let it
finish. It did not.

### Leading hypothesis

The guidance is a long block of imperative prose injected into a `role: "tool"`
message — a slot the model expects to contain tool *output*, not instructions. A
7-8B model may fail to terminate on that. The pre-fix run, with short error text in
the same slot, completed the same step in ~95s.

### Fix

`clients/mshin-cli/agent.js` now splits the response:

- The `role: "tool"` message is short: the original error plus `This tool is
  unavailable for this run; do not retry it.`
- The imperative direction — continue the task, call another tool if needed, do
  not describe output no tool returned — is pushed as a `role: "user"` message
  immediately after the tool result.

This keeps the retry suppression and the explicit task continuation while putting
each kind of text in the message role it belongs in. The mock-based tests verify
that the split happens and that the tool slot no longer carries the long
instruction.

### Why it is not simply reverted

The defect the guidance fixes is real and measured: without it, both models spent
their **entire step budget re-issuing an identical failing call**. The retry
suppression itself works. It was the wording's *location*, not the instruction
itself, that was suspect.

### Measured (2026-09-07)

Re-ran the two-tool `recon-chain` case, `mshin` and `qwen3:8b`, against a live Node
whose `whois` fails under `sudo -n`:

- **Termination is fixed.** Both models returned in ~45s — 46095 ms and 44154 ms —
  with no hang. The split-message guidance no longer wedges the following turn: the
  slot-length hypothesis holds, and the 300s/600s dead-ends are gone.
- **Continuation still fails.** Neither model called `nmap` after `whois` went
  unavailable; both stopped at 2 of 6 steps and returned a placeholder — "Nmap scan
  completed. Results show [specific findings]... *(Replace bracketed text with actual
  nmap output.)*". The `role: "user"` instruction to continue the task did not
  produce continuation on this case. This is a placeholder, not concrete invented
  output, so `looksLikeFabricatedToolOutput` correctly did not flag it and
  `fabricatedOutputsBlocked` stayed 0 — but the model still asserts a scan ran that
  did not.

Termination — the defect this section is about — is resolved. The continuation
behaviour tracked under "models abandon the rest of a multi-tool goal" is **not**
confirmed fixed and is reopened below. Caveat: on the host `nmap` would also have
failed, and the happy path (both tools succeeding) does not exercise this guidance
at all, so testing continuation properly needs a **VM run where one enabled tool
fails non-retryably while another succeeds** — remove a single binary from the
sudoers allowlist and leave the rest.

---

## Closed: model turns longer than five minutes killed the run

`queryOllama` used global `fetch` with `stream: false`. Ollama sends no response
headers until the whole generation is finished, and undici — which backs `fetch` —
aborts after a default `headersTimeout` of 300s, throwing a bare `fetch failed`
that names neither a timeout nor a duration.

Established in two steps. First the symptom: two runs died at **329163 ms** and
**328580 ms** — different models, within 600 ms of each other, on an idle machine.
That is a fixed ceiling, not model behaviour. Then the mechanism, reproduced in
isolation against a server that accepts a request and never answers:

```
failed after 301.2s
message: fetch failed
cause:   UND_ERR_HEADERS_TIMEOUT
```

The request now goes through `node:http` with an explicit inactivity timeout,
configurable as `ollamaTimeoutMs`, defaulting to ten minutes. An overrun names the
timeout, the model, and the option to raise it.

**This matters on the target hardware.** A single turn on a 70B — the class of model
the roadmap's hardware decision is about — passes 300s routinely. Before this fix
that appeared as a generic network error, indistinguishable from a crash.

---

## Closed: a failed tool call disarmed the fabrication backstop

The backstop that blocks invented tool output only fired when no tool had executed
for the whole run, and the flag it read was set by any call that **returned** —
including one that failed. So a single failed call disarmed it for the rest of the
run.

Seen live: `whois` failed under sudo, `nmap` was never called, and both models
printed a placeholder block —

```
**Nmap Scan Results for 127.0.0.1:**
- Open ports and services (e.g., SSH, HTTP) will be listed here if found.
```

— while `fabricatedOutputsBlocked` stayed **0**. That is invented scan output
reaching the operator, which is the exact failure the backstop exists to prevent.

The loop now records tools that returned **without** `isError` and blocks
report-shaped output naming a tool that never returned one. A real `whois` result
does not license an invented `nmap` report; an honest error ("host appears to be
down") is not a result; and summarising output a tool genuinely returned is
untouched.

---

## Reopened: models abandon the rest of a multi-tool goal

The first wording of the unavailable-tool guidance said only that the tool could not
run and should not be retried. Both models read that as licence to give up entirely:
on `recon-chain` each announced `nmap`, printed a placeholder for its output, and
stopped at 2 of 6 steps without calling it.

The guidance was reworded to name the remaining work explicitly, then split so the
instruction sits in a `role: "user"` message (see the section above).

**Update (2026-09-07 run): still not fixed.** With the split-message guidance, both
`mshin` and `qwen3:8b` again stopped at 2 of 6 on `recon-chain`, placeholder and
all. Naming the remaining work in a `role: "user"` message did not, on this case,
get either model to the second tool. The termination fix and the continuation fix
travelled together in the same change; the first is verified, the second is not.
Reopened.

---

## Notes for the next run

- **Cost.** One model, one case, `maxSteps 6` is roughly two minutes of inference on
  an M-series Mac. Two models across four cases is fifteen or more, with the fans
  audible throughout.
- **Do not run test suites during a live eval.** Durations become meaningless. An
  early run was misdiagnosed as contention for this reason — it was the transport
  ceiling.
- **Run happy-path evals against the `mshin-node` VM, not the host.** See Method:
  the host reaches only the unavailable-tool branch. Point `nodeUrl` at the VM's
  forwarded `:3000`, keep `ollamaUrl` on the host Ollama, and `sudo systemctl
  restart mshin-node` after touching the mounted repo — otherwise the long-lived
  service serves stale in-memory code (symptom: `Cannot POST /mcp`).
- **Clean up.** Unload the model with an `/api/generate` call carrying
  `"keep_alive": 0`, and kill the Node server. Note `pkill -f
  "servers/src/kali/index.js"` misses a server started as `node index.js` from its
  own directory — the argv carries no path — so match the listening port instead
  (`lsof -ti tcp:3000 | xargs kill`). Stray Node servers from earlier runs have
  twice been left listening for over an hour.
- **`blockedToolRetries` has never fired in a live run.** Models stopped retrying on
  the guidance text alone, so the short-circuit that refuses a repeat call is
  currently unexercised outside tests.
