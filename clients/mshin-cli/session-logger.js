import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Append-only JSONL logger for a single agent session.
 *
 * Each session gets its own file under <dataDir>/sessions/<sessionId>.jsonl.
 * Events are written one per line and include a timestamp and session id, so
 * the file is self-contained enough to be replayed or converted into a report
 * long after the CLI has exited.
 *
 * This is intentionally separate from AgentMemory: memory.json is the model's
 * conversation transcript (rewritten on every turn), while the session JSONL is
 * an immutable audit trail of what the agent did and what the tools returned.
 *
 * To keep disk usage bounded, the logger prunes old session files on creation.
 * By default it keeps the 100 most recent sessions and deletes anything older
 * than 30 days. Set MSHIN_MAX_SESSIONS and MSHIN_MAX_SESSION_AGE_DAYS to
 * override, or MSHIN_NO_SESSION_LOG=1 to disable logging entirely.
 */
export class SessionLogger {
  constructor(
    dataDir = join(homedir(), ".mshin"),
    {
      maxSessions = envInt("MSHIN_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
      maxAgeDays = envInt("MSHIN_MAX_SESSION_AGE_DAYS", DEFAULT_MAX_AGE_DAYS),
    } = {}
  ) {
    this.sessionsDir = join(dataDir, "sessions");
    this.maxSessions = maxSessions;
    this.maxAgeDays = maxAgeDays;
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
    this.prune();
  }

  /**
   * Append one event to the session log.
   */
  write(sessionId, event) {
    const file = join(this.sessionsDir, `${sessionId}.jsonl`);
    const line =
      JSON.stringify({
        ...event,
        sessionId,
        timestamp: new Date().toISOString(),
      }) + "\n";
    appendFileSync(file, line);
  }

  /**
   * Remove session files that are older than maxAgeDays or beyond the
   * maxSessions most recent. Pruning happens once at logger creation so a
   * long-running CLI does not repeatedly delete files mid-session.
   */
  prune() {
    if (!existsSync(this.sessionsDir)) return;

    const entries = readdirSync(this.sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const path = join(this.sessionsDir, name);
        return { name, path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const ageCutoff =
      Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (entry.mtimeMs < ageCutoff) {
        this.remove(entry.path);
      }
    }

    const remaining = entries.filter((entry) => existsSync(entry.path));
    for (const entry of remaining.slice(this.maxSessions)) {
      this.remove(entry.path);
    }
  }

  remove(path) {
    try {
      rmSync(path);
    } catch {
      // A missing or unwritable file must not break the run.
    }
  }

  /**
   * Convenience: log a simple textual record. Useful for operator notes or
   * CLI-level events that are not part of the agent loop itself.
   */
  note(sessionId, message) {
    this.write(sessionId, { type: "note", message });
  }
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Factory that returns a file-based SessionLogger unless the operator has
 * disabled session logging with MSHIN_NO_SESSION_LOG=1.
 */
export function makeSessionLogger(dataDir) {
  if (process.env.MSHIN_NO_SESSION_LOG) {
    return null;
  }
  return new SessionLogger(dataDir);
}
