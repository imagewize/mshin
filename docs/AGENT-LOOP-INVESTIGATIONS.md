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

**Status: resolved. Termination fixed in 0.10.2; multi-tool continuation fixed in 0.11.0 (the loop no longer drops the model's second tool call).**

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

## Resolved: models abandon the rest of a multi-tool goal

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

### Update (2026-09-07, second run): de-confounded on the VM — and the fabrication is now concrete

The earlier reopened runs were against the **host**, where `nmap` also fails under
`sudo -n`. That left the reading ambiguous: a model that never called `nmap` could
not be distinguished from a model that called it and got nothing. This run removes
the ambiguity by pointing the harness at the **`mshin-node` VM** (`nodeUrl:
http://localhost:3000`, Lima's forward of the guest's `:3000`), where the provisioned
sudoers allowlist lets both tools actually execute — verified out of band: `sudo -n
whois example.com` returns the IANA registrar and `sudo -n nmap -p 22,80 127.0.0.1`
returns real port state (22 open).

`recon-chain`, both models, `maxSteps 6`, against that live VM:

| Model | Steps | `whois` | `nmap` | Duration | Result | `fabricatedOutputsBlocked` |
| ------- | :---: | :-----: | :----: | -------: | :----: | :-----------------------: |
| `mshin` | 2/6 | ran (real IANA data) | never called | 54003 ms | PASS | 0 |
| `qwen3:8b` | 2/6 | ran (real IANA data) | never called | 51927 ms | PASS | 0 |

Three things this run establishes that the host runs could not:

1. **The continuation failure is real, not an artifact of the host.** `whois`
   returned genuine registrar data — proof the tool executed — and `nmap` was fully
   available, yet both models stopped at 2 of 6 without calling it. The caveat on the
   first reopened run ("on the host `nmap` would also have failed") is now retired.

2. **The fabrication is no longer a placeholder — it is concrete invented output.**
   On the host both models emitted a bracketed placeholder (`[specific findings]`).
   Fed a *real* `whois` success, both instead asserted a specific `nmap` report for a
   scan that never ran — `mshin`: "22/tcp (SSH), 80/tcp (HTTP), 443/tcp (HTTPS),
   53/udp (DNS), 139/tcp (NetBIOS)"; `qwen3:8b`: the same set as `open` services. This
   is exactly what the fabrication backstop from 0.10.1 exists to catch, yet
   `fabricatedOutputsBlocked` stayed 0. `looksLikeFabricatedToolOutput` does not
   recognise this text as a tool report — a defect distinct from the continuation bug.

3. **The harness scored both runs PASS.** "missing nmap" is reported, but `Result:
   PASS`. Failing to call an expected tool — and fabricating its output — does not
   fail the case. As it stands the eval cannot guard a fix for this bug: a regression
   would stay green.

Net: one investigation has become three tracked problems — (a) get the model to
continue to the next tool, (b) make `looksLikeFabricatedToolOutput` catch a concrete
fabricated report when another tool did succeed in the same run, and (c) make a
missing expected tool (or a blocked fabrication) fail the eval case. Landing (c)
first gives a red test before (a) and (b) change behaviour.

### Resolved (2026-09-07, third run): the loop was discarding the model's second tool call

The framing above — and across 0.10.1/0.10.2 — was wrong. The models were **not**
abandoning the goal. A step-level debug trace (added this release; set `MSHIN_DEBUG=1`
or `MSHIN_DEBUG_LOG=<path>`) showed the whole failure in nine lines:

```
model.turn {"toolCalls":["whois","nmap"],"dropped":["nmap"]}   <- the model DID call nmap
tool.call  whois  ->  tool.result whois (ok)
model.turn {"toolCalls":[]}                                    <- never re-issues nmap
final.check {"ungrounded":[],"looksFabricated":false}          <- both fabrication gates miss it
final.accept
```

The model emitted `whois` **and** `nmap` in one turn. The loop's deliberate "process
only the first call and ignore the rest to keep the loop grounded" rule
(`agent.js`) then **discarded the `nmap` call the model had made**, fed back only the
whois result, and the model — believing it had already asked for the scan — wrote a
final answer describing nmap output it never got. It was not a fabrication the
detector could catch: `ungrounded` was empty (the prose said "the scan", not
"nmap") and the port shape was "Port 22 (SSH)", not "22/tcp".

None of this was visible from the metrics (`fabricatedOutputsBlocked: 0`,
`continuationNudges: 0`) or the `--verbose` tool lines. Only the transcript, then
the trace, showed it. This is the observability lesson: the loop had three tiers
(verbose stdout, aggregate metrics, the persisted `memory.json` transcript) but no
per-step decision log; the trace closes that gap.

**Fix.** The loop now runs **every** tool call in a turn, in order, rather than
keeping the first and dropping the rest. The model had already committed to those
calls; honouring them is more faithful than dropping them and hoping it asks again.
Unavailable-tool guidance is pushed once per turn as a `role: "user"` message after
all tool results, never interleaved between them (which would break tool-call/result
pairing).

**Measured.** `recon-chain`, both models, against the VM where `nmap` runs:

| Model | Steps | Tool calls | Expected tools | Overall |
| ------- | :---: | :--------: | :------------: | :-----: |
| `mshin` | 2/6 | whois + nmap | all called | PASS |
| `qwen3:8b` | 2/6 | whois + nmap | all called | PASS |

Both call `whois` then `nmap` in the first turn, and the grounded final answer
summarises the real scan (`final.check` shows `succeeded: ["whois","nmap"]`,
`ungrounded: []` — the scan-shaped text is now a legitimate summary, correctly not
blocked). The behaviour verdict from part (c) reports PASS; the suite exits 0.

The two fabrication-side changes from this investigation still stand and are still
right — the detector now catches an unfenced inline port list (b), and the harness
scores behaviour and can fail a run on it (c) — but they were guarding a symptom.
The dropped tool call was the disease. **Closed.**

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
