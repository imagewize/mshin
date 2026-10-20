# Refactoring Ideas

> *"The Wheel weaves as the Wheel wills. With patience and care, even the most tangled threads can be made straight."*

A short, honest backlog of refactoring ideas for Machin Shin — and, just as importantly, a record of the ones deliberately *not* taken. This is a working list: pick items up, do them, and prune them when done.

Keep it conservative. The codebase is small (~3,600 lines of source, ~2,450 lines of tests) and its constraints are real — most notably the near-zero-dependency rule and the four-places tool-sync rule from `CLAUDE.md`. Do not import complexity the project doesn't need.

New here? Read [Developer Onboarding](DEVELOPER-ONBOARDING.md) first — it covers the learning path and the architecture these ideas refer to.

---

## Refactoring Ideas Worth Doing

These are low-risk and pay for themselves. The `node:test` suites (see the onboarding doc) verify you didn't break anything.

### 1. Extract the two most self-contained seams of `agent.js` — only if it earns its keep

`agent.js` at 1130 lines is large, but most of it is genuinely coupled around one shared message array. The two parts that *aren't* — and could move to their own files with clean interfaces — are:
- tool-call extraction (`extractTextToolCall` and its helpers), and
- fabrication detection (`looksLikeFabricatedToolOutput`, `ungroundedToolsIn`).

If you split these out, do it because a specific change got painful, not preemptively. **Skip the "backward-compat re-export shim"** — this is an internal module with no external importers; update the imports directly.

---

## Ideas to Approach With Caution

The following were tempting but carry more cost than benefit for a project this size and shape. Recorded here so they aren't re-proposed without the counter-argument.

- **Adding Jest (or any external test framework).** The project already runs `node:test` via `npm test`, and its design philosophy is near-zero dependencies. Swapping in Jest would violate that principle to replace a runner that already works. Write more `node:test` cases instead.
- **Splitting `agent.js` into eight files behind a re-export barrel.** Trades one readable file for eight you jump between, plus a compatibility shim guarding nothing. Only the two seams named above are worth extracting, and only on demand.
- **Class hierarchies for tools / context / parsing (`BaseTool`, `ContextManager`, `ToolCallParser`).** The plain-object tool shape matches the MCP SDK and keeps validation inline as one-liners. Wrapping it in classes adds indirection without removing duplication.
- **Scattering tool definitions across category files.** Directly fights the four-places sync rule in `CLAUDE.md`: keeping every tool in one `tools.js` is what makes that rule auditable. Leave them together.

---

## Next Steps

**Completed (0.16.1):** `node:test` coverage for `compactContext()` and the fabrication heuristics — 12 cases pinning eviction order, the preserved floor, the token high-water mark, transcript non-mutation, the detector's deliberate narrowness, and `ungroundedToolsIn`'s name matching.

**Later, only if a concrete pain motivates it:**
1. Extract tool-call extraction and fabrication detection from `agent.js` (no shim).

### Success metrics

- **Coverage:** the compaction and fabrication paths gained dedicated `node:test` cases (0.16.1).
- **Restraint:** the dependency list stays at one runtime dependency.

---

Keep the safety and validation logic sacrosanct, make small testable changes, and resist adding machinery the codebase's size doesn't justify.

## See Also

- [Developer Onboarding](DEVELOPER-ONBOARDING.md) — learning path and architecture
- [CLAUDE.md](../CLAUDE.md) — repo facts, the four-places rule, commit conventions
- [AGENTS.md](../AGENTS.md) — working rules for contributors

---

*Last updated: 2026-10-20*
