import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SESSIONS,
  defaultMetrics,
  loadMetrics,
  recordMetrics,
} from "../src/metrics.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchflow-metrics-"));
  file = join(dir, "patchflow-metrics.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadMetrics", () => {
  it("starts empty on missing or corrupt files", () => {
    assert.deepEqual(loadMetrics(file), defaultMetrics());
    writeFileSync(file, "not json");
    assert.deepEqual(loadMetrics(file), defaultMetrics());
  });
});

describe("recordMetrics", () => {
  it("aggregates per session and into totals", () => {
    assert.equal(recordMetrics(file, "s1", { apply: 1, edits: 3, files: 2 }), true);
    assert.equal(recordMetrics(file, "s1", { dryRuns: 1 }), true);
    assert.equal(recordMetrics(file, "s2", { editCalls: 2, covert: 1 }), true);
    const m = loadMetrics(file);
    assert.equal(m.sessions["s1"].apply, 1);
    assert.equal(m.sessions["s1"].edits, 3);
    assert.equal(m.sessions["s1"].dryRuns, 1);
    assert.equal(m.sessions["s2"].editCalls, 2);
    assert.equal(m.totals.apply, 1);
    assert.equal(m.totals.edits, 3);
    assert.equal(m.totals.editCalls, 2);
    assert.equal(m.totals.covert, 1);
    assert.ok(m.sessions["s1"].lastSeen);
  });
  it("ignores unknown keys and empty session ids", () => {
    assert.equal(recordMetrics(file, "", { apply: 1 }), false);
    assert.equal(recordMetrics(file, "s1", { nope: 5 } as never), true);
    assert.deepEqual(loadMetrics(file).totals, defaultMetrics().totals);
  });
  it("evicts oldest sessions beyond the cap, keeps totals", () => {
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      const now = `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
      assert.equal(recordMetrics(file, `s${i}`, { apply: 1 }, now), true);
    }
    const m = loadMetrics(file);
    assert.equal(Object.keys(m.sessions).length, MAX_SESSIONS);
    assert.equal(m.sessions["s0"], undefined);
    assert.ok(m.sessions[`s${MAX_SESSIONS + 4}`]);
    assert.equal(m.totals.apply, MAX_SESSIONS + 5);
  });
  it("persists valid JSON", () => {
    recordMetrics(file, "s1", { apply: 1 });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.version, 1);
  });
});
