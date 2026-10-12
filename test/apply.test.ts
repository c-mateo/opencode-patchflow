import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAnchorEdits, countOccurrences } from "../src/apply.ts";

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    assert.equal(countOccurrences("aaa", "aa"), 1);
    assert.equal(countOccurrences("aXaXa", "a"), 3);
    assert.equal(countOccurrences("hi", ""), 0);
  });
});

describe("applyAnchorEdits", () => {
  const base = 'line1\nassert!(patch_mesh(&sphere, "kind", "nonsense").is_none());\nline3\n';

  it("inserts after a unique anchor", () => {
    const anchor = 'assert!(patch_mesh(&sphere, "kind", "nonsense").is_none());\n';
    const { content, counts } = applyAnchorEdits(base, [{ anchor, text: "// added\n" }]);
    assert.deepEqual(counts, [1]);
    assert.ok(content.includes(anchor + "// added\n"));
  });

  it("throws on count mismatch and applies nothing", () => {
    assert.throws(() =>
      applyAnchorEdits(base, [{ anchor: "missing", text: "x" }]),
    );
    assert.throws(() =>
      applyAnchorEdits("a a a", [{ anchor: "a", text: "b", expectCount: 2 }]),
    );
  });

  it("replaces in all occurrences", () => {
    const { content } = applyAnchorEdits("v=1; v=1", [
      { anchor: "v=1", text: "v=2", mode: "replace", expectCount: 2 },
    ]);
    assert.equal(content, "v=2; v=2");
  });

  it("validates all edits before applying any (atomic)", () => {
    const edits = [
      { anchor: "line1\n", text: "X" },
      { anchor: "missing", text: "Y" },
    ];
    assert.throws(() => applyAnchorEdits(base, edits));
  });

  it("reproduces the morph mui_bridge scenario", () => {
    const anchor = '        assert!(patch_mesh(&sphere, "kind", "nonsense").is_none());\n';
    const src = `fn t() {\n    let sphere = 1;\n${anchor}}\n`;
    const add = `        // UV comment\n`;
    const { content } = applyAnchorEdits(src, [{ anchor, text: add }]);
    assert.ok(content.includes(anchor + add));
  });
});
