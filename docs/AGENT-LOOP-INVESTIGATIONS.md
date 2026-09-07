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

Models used: `mshin` (the persona, 7B-class) and `qwen3:8b`.

---

## Addressed: the unavailable-tool guidance may prevent termination

**Status: fix implemented; live verification pending.**

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

### Next diagnostic

Re-run the two-tool `recon-chain` case against a live 7-8B model. The expected
outcome is that the unavailable tool is called once, the second tool is attempted,
and the run returns an answer within the transport timeout. If it still hangs,
the problem is not the slot-length hypothesis and the transcript order needs to be
re-examined.

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

## Closed: models abandoned the rest of a multi-tool goal

The first wording of the unavailable-tool guidance said only that the tool could not
run and should not be retried. Both models read that as licence to give up entirely:
on `recon-chain` each announced `nmap`, printed a placeholder for its output, and
stopped at 2 of 6 steps without calling it.

The guidance now names the remaining work explicitly. Whether that succeeds is the
open question above.

---

## Notes for the next run

- **Cost.** One model, one case, `maxSteps 6` is roughly two minutes of inference on
  an M-series Mac. Two models across four cases is fifteen or more, with the fans
  audible throughout.
- **Do not run test suites during a live eval.** Durations become meaningless. An
  early run was misdiagnosed as contention for this reason — it was the transport
  ceiling.
- **Clean up.** `pkill -f "servers/src/kali/index.js"` and an
  `/api/generate` call with `"keep_alive": 0` to unload the model. Stray Node
  servers from earlier runs have twice been left listening for over an hour.
- **`blockedToolRetries` has never fired in a live run.** Models stopped retrying on
  the guidance text alone, so the short-circuit that refuses a repeat call is
  currently unexercised outside tests.
