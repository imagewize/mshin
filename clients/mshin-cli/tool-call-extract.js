/**
 * Recovery of tool calls a model wrote as text instead of emitting through
 * the function-calling interface. Extracted from agent.js (see
 * docs/REFACTORING-IDEAS.md) so the parser is testable in isolation: it has no
 * dependency on the agent loop, only on a caller-supplied tool validator.
 */

/**
 * Recover a tool call the model wrote as text instead of emitting through the
 * function-calling interface.
 *
 * Small models given a tools array sometimes narrate the call -- "To scan
 * 127.0.0.1, I will use nmap..." followed by `[{"name":"nmap","arguments":
 * {...}}]` and, worse, an invented scan report. Ollama returns that as plain
 * `content` with no `tool_calls`, so without this the loop treats the whole
 * fabrication as the model's final answer and hands it to the operator as
 * though a scan had run. Lowering the sampling temperature makes this rarer
 * but never impossible, so the loop refuses to depend on it.
 *
 * This is a workaround for smaller models that don't reliably use the
 * function-calling API. It attempts multiple extraction strategies:
 * 1. JSON payload extraction (handles `[{...}]` and bare `{...}` objects)
 * 2. Function syntax extraction (handles `functions.nmap(...)` or `nmap(...)`)
 *
 * Returns { name, args } for the first payload naming a tool this Node
 * actually exposes, or null. Requiring a known tool name is what keeps a
 * legitimate answer that merely quotes JSON from being mistaken for a call.
 *
 * @param {string} content - The assistant message content to search for embedded tool calls
 * @param {Function} isValidTool - Function to check if a tool name is valid: (name) => boolean
 * @returns {Object|null} Extracted tool call with name and args, or null if none found
 * @returns {string} returns.name - The tool name
 * @returns {Object} returns.args - The tool arguments as a plain object
 */
export function extractTextToolCall(content, isValidTool) {
  if (!content) return null;

  // Mistral-family models wrap the payload; strip the marker if present.
  const text = content.replace("[TOOL_CALLS]", " ");

  const json = extractJsonToolCall(text, isValidTool);
  if (json) return json;

  return extractFunctionSyntaxToolCall(text, isValidTool);
}

function extractJsonToolCall(text, isValidTool) {
  // Walk every balanced {...} span rather than regexing for one shape: the
  // payload may be bare, fenced in ```json, or embedded mid-sentence.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      if (depth !== 0) continue;

      let parsed;
      try {
        parsed = JSON.parse(text.slice(i, j + 1));
      } catch {
        break; // not JSON; move the start marker along
      }
      const name = parsed?.name ?? parsed?.function?.name;
      const args =
        parsed?.arguments ?? parsed?.parameters ?? parsed?.function?.arguments ?? {};
      if (typeof name === "string" && isValidTool(name) && typeof args === "object") {
        return { name, args };
      }
      break; // valid JSON but not a call to a known tool; try the next `{`
    }
  }
  return null;
}

function extractFunctionSyntaxToolCall(text, isValidTool) {
  // Some models emit calls as text: functions.nmap(target="127.0.0.1") or
  // nmap(target="127.0.0.1", flags=['-sS']). Prefer the `functions.` prefix
  // because it is less likely to appear in ordinary prose.
  for (const { name, argString } of findFunctionCalls(text)) {
    if (!isValidTool(name)) continue;
    try {
      const args = parsePythonLikeArgs(argString);
      return { name, args };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Locate `name(...)`-style calls in free text and return each one's name
 * alongside the raw, unparsed argument string between its parentheses.
 *
 * The regex only finds the opening `name(`; everything after that is walked
 * by hand rather than matched with a closing-paren regex, because the naive
 * `\)` match breaks the moment an argument contains its own parens (a
 * nested call) or a `)` inside a quoted string (e.g. a shell flag). The scan
 * below tracks paren depth and, while inside a quote, ignores parens
 * entirely (and skips an escaped quote so it doesn't end the string early).
 */
function findFunctionCalls(text) {
  const calls = [];
  // Match optional `functions.` prefix.
  const pattern = /(?:functions\.)?([a-zA-Z_]\w*)\s*\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    let quote = null;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    if (depth === 0) {
      calls.push({ name, argString: text.slice(start, i - 1) });
    }
  }
  return calls;
}

/**
 * Parse a Python-like keyword-argument string -- `target="1.2.3.4", flags=['-sS']`
 * -- into a plain object, without a general expression parser.
 *
 * Only `key=value` pairs are collected; a bare positional value (no `=`) is
 * scanned past and dropped, since every tool this agent calls takes named
 * arguments (per its MCP schema), so a positional the model wrote has no
 * schema field to land in anyway. Each value's own syntax (string/list/
 * object/literal) is handled by `parsePythonLikeValue`.
 */
function parsePythonLikeArgs(argString) {
  const args = {};
  let i = 0;
  while (i < argString.length) {
    while (i < argString.length && /[\s,]/.test(argString[i])) i++;
    if (i >= argString.length) break;

    let key = "";
    while (i < argString.length && /[a-zA-Z0-9_]/.test(argString[i])) key += argString[i++];
    if (!key) {
      // Unexpected token; skip to next delimiter.
      while (i < argString.length && !/[,=]/.test(argString[i])) i++;
      continue;
    }

    while (i < argString.length && /\s/.test(argString[i])) i++;
    if (i >= argString.length || argString[i] !== "=") {
      // Positional argument; skip its value.
      let depth = 0;
      while (i < argString.length) {
        if (argString[i] === "(" || argString[i] === "[" || argString[i] === "{") depth++;
        else if (argString[i] === ")" || argString[i] === "]" || argString[i] === "}") depth--;
        else if (argString[i] === "," && depth === 0) break;
        i++;
      }
      continue;
    }
    i++; // skip =

    while (i < argString.length && /\s/.test(argString[i])) i++;
    const parsed = parsePythonLikeValue(argString, i);
    args[key] = parsed.value;
    i = parsed.nextIndex;
  }
  return args;
}

/**
 * Recursive-descent parser for one argument value at `text[start:]`, used by
 * `parsePythonLikeArgs`. Returns the parsed JS value and the index just past
 * what it consumed, so the caller can keep scanning the rest of the string.
 *
 * Handles the shapes a model actually emits: a quoted string (with `\`
 * escapes), a `[...]` list (elements recursively parsed, so nested
 * lists/objects/strings all work), a `{...}` object (delegated to
 * `JSON.parse` -- Python dict syntax with double-quoted keys happens to be
 * valid JSON, and this loop only needs to find the matching `}`), or a bare
 * token (number/boolean/None/word) handed to `parseLiteral`.
 */
function parsePythonLikeValue(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return { value: null, nextIndex: i };

  const ch = text[i];
  if (ch === '"' || ch === "'") {
    let str = "";
    const quote = ch;
    i++;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\\" && i + 1 < text.length) {
        str += text[i + 1];
        i += 2;
      } else {
        str += text[i];
        i++;
      }
    }
    i++; // skip closing quote
    return { value: str, nextIndex: i };
  }

  if (ch === "[") {
    const arr = [];
    i++; // skip [
    while (i < text.length && text[i] !== "]") {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i < text.length && text[i] === "]") break;
      const elem = parsePythonLikeValue(text, i);
      arr.push(elem.value);
      i = elem.nextIndex;
    }
    i++; // skip ]
    return { value: arr, nextIndex: i };
  }

  if (ch === "{") {
    let depth = 1;
    const startObj = i;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    try {
      return { value: JSON.parse(text.slice(startObj, i)), nextIndex: i };
    } catch {
      return { value: text.slice(startObj, i), nextIndex: i };
    }
  }

  let token = "";
  while (i < text.length && !/[,\)\]]/.test(text[i])) token += text[i++];
  token = token.trim();
  return { value: parseLiteral(token), nextIndex: i };
}

// Coerce a bare (unquoted) token to its likely type -- covering both
// Python's spelling (`True`/`False`/`None`) and JSON's, since the model may
// mix conventions. Anything that isn't a recognized literal or number is
// returned as-is (a plain string).
function parseLiteral(token) {
  if (token === "True" || token === "true") return true;
  if (token === "False" || token === "false") return false;
  if (token === "None" || token === "null") return null;
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  if (/^-?\d+\.\d+$/.test(token)) return parseFloat(token);
  return token;
}
