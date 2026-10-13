/**
 * Session-aggregated, opt-in metrics for patchflow.
 *
 * Only counters are stored — never commands, paths, anchors, or file
 * contents. Layout: per-session buckets (capped, LRU by lastSeen) plus
 * cumulative totals. Atomic write (temp + rename); every failure is
 * swallowed by the caller so metrics never break the tool call.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const METRICS_VERSION = 1;
export const MAX_SESSIONS = 20;
export const METRICS_FILENAME = "patchflow-metrics.json";

export interface SessionCounters {
  lastSeen: string;
  /** Successful non-dry-run apply calls. */
  apply: number;
  /** Successful dry-run calls. */
  dryRuns: number;
  /** Edits applied (sum of input lengths). */
  edits: number;
  /** Distinct files touched. */
  files: number;
  /** Apply calls that returned an error. */
  errors: number;
  /** Shell commands observed hiding a file write. */
  covert: number;
  /** Built-in `edit` tool calls — the comparison baseline. */
  editCalls: number;
}

export interface Totals {
  apply: number;
  dryRuns: number;
  edits: number;
  files: number;
  errors: number;
  covert: number;
  editCalls: number;
}

export interface MetricsFile {
  version: typeof METRICS_VERSION;
  sessions: Record<string, SessionCounters>;
  totals: Totals;
}

export function defaultMetrics(): MetricsFile {
  return {
    version: METRICS_VERSION,
    sessions: {},
    totals: { apply: 0, dryRuns: 0, edits: 0, files: 0, errors: 0, covert: 0, editCalls: 0 },
  };
}

function zeroSession(now: string): SessionCounters {
  return {
    lastSeen: now,
    apply: 0, dryRuns: 0, edits: 0, files: 0,
    errors: 0, covert: 0, editCalls: 0,
  };
}

/** Default store location: alongside OpenCode's own logs. */
export function metricsFile(dataDir?: string): string {
  const base = dataDir ?? join(homedir(), ".local", "share", "opencode", "log");
  return join(base, METRICS_FILENAME);
}

export function loadMetrics(file: string): MetricsFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MetricsFile>;
    if (parsed?.version !== METRICS_VERSION) throw new Error("bad version");
    if (typeof parsed.sessions !== "object" || typeof parsed.totals !== "object") {
      throw new Error("bad shape");
    }
    return parsed as MetricsFile;
  } catch {
    return defaultMetrics();
  }
}

export type Delta = Partial<Omit<SessionCounters, "lastSeen">>;

/**
 * Add `delta` to `sessionID`'s bucket and to totals, evicting the
 * least-recently-seen sessions beyond MAX_SESSIONS. Never throws.
 */
export function recordMetrics(
  file: string,
  sessionID: string,
  delta: Delta,
  now = new Date().toISOString(),
): boolean {
  try {
    if (!sessionID || typeof sessionID !== "string") return false;
    const metrics = loadMetrics(file);
    const session = metrics.sessions[sessionID] ?? zeroSession(now);
    session.lastSeen = now;
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const k = key as keyof Totals;
      if (!(k in metrics.totals)) continue;
      session[k] += value;
      metrics.totals[k] += value;
    }
    metrics.sessions[sessionID] = session;
    const ids = Object.keys(metrics.sessions).sort(
      (a, b) => metrics.sessions[a].lastSeen.localeCompare(metrics.sessions[b].lastSeen),
    );
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) {
      delete metrics.sessions[id];
    }
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(metrics, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
