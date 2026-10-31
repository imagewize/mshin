/**
 * Detection of model output that invents tool results instead of running the
 * tool. Extracted from agent.js (see docs/REFACTORING-IDEAS.md) so the
 * heuristics are testable in isolation: they are pure functions of the
 * assistant content, the tool list, and which tools actually returned results.
 */

/**
 * Heuristic check for a model that invented tool output instead of calling a
 * tool -- e.g. writing its own fake nmap report rather than emitting a call
 * the tool-call extractor could have recovered. Pair it with the grounding
 * check at the call site: text like this is a summary when the tool it
 * describes actually returned a result, and a fabrication when it did not.
 *
 * Looks for two shapes: a fenced code block, or a "Result:" label, either of
 * which is followed by text that reads like genuine scan output (an
 * `<port>/tcp` or `<port>/udp` token near "open"/"closed"/"filtered"). This
 * is deliberately narrow -- it is meant to catch confident fabrication, not
 * to flag every code block or every use of the word "result".
 *
 * Detection strategies (in order):
 * 1. Fenced code blocks containing "Result:", "Results:", or scan-like signatures
 * 2. "Result:" label followed by port/protocol or state keywords
 * 3. Unfenced scan-like signatures (port/protocol near state keywords)
 *
 * The scan signature specifically looks for patterns like "22/tcp open" or
 * "443/tcp closed" which are characteristic of nmap and similar tool outputs.
 *
 * @param {string} content - The message content to check for fabricated tool output
 * @returns {boolean} true if the content looks like fabricated tool output, false otherwise
 */
export function looksLikeFabricatedToolOutput(content) {
  if (!content) return false;

  // A port/proto token next to a port-state word is the signature of scan
  // output wherever it appears -- fenced, labelled, or loose in prose.
  const scanSignature = (text) =>
    /\d+\/(tcp|udp)\b/i.test(text) && /\b(open|closed|filtered)\b/i.test(text);

  // Fenced code block containing "Result:" or scan-like output.
  const fenced = content.match(/```[\s\S]*?```/g) || [];
  for (const block of fenced) {
    const inner = block.slice(3, -3).toLowerCase();
    if (
      inner.includes("result:") ||
      inner.includes("results:") ||
      scanSignature(inner)
    ) {
      return true;
    }
  }

  // "Result:" followed by output that looks like a tool report.
  const resultIdx = content.toLowerCase().indexOf("result:");
  if (resultIdx !== -1) {
    const tail = content.slice(resultIdx);
    if (
      /\d+\/(tcp|udp)\b/i.test(tail) ||
      /\b(open|closed|filtered)\b/i.test(tail)
    ) {
      return true;
    }
  }

  // Unfenced, unlabelled scan output. The live recon-chain fabrication took
  // exactly this shape -- an inline markdown list ("- 22/tcp (SSH)") under the
  // prose "the nmap scan revealed the following open ports", with no code fence
  // and no "Result:" label for the two checks above to catch. The call site
  // only blocks this when the tool it reads like never returned a result, so a
  // genuine scan summary stays untouched.
  if (scanSignature(content)) {
    return true;
  }

  return false;
}

/**
 * Known tools the content talks about that never returned a result. This is
 * what separates a summary from a fabrication once some other tool has run:
 * a real whois result does not license an invented nmap report.
 *
 * @param {string} content - The assistant message content to scan
 * @param {Array<string>} toolNames - Tool names the Node exposes
 * @param {Set<string>} succeededTools - Tools that returned without isError this run
 * @returns {Array<string>} Names of known tools mentioned but never successful
 */
export function ungroundedToolsIn(content, toolNames, succeededTools) {
  if (!content) return [];
  return toolNames.filter(
    (name) =>
      !succeededTools.has(name) &&
      new RegExp(`\\b${name}\\b`, "i").test(content)
  );
}
