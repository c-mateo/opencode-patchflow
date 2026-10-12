import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCovertWrite } from "../src/detect.ts";

describe("detectCovertWrite: true positives", () => {
  it("flags python heredoc with open(w) + write", () => {
    const cmd = `cd /tmp && python3 - <<'EOF'
p = 'a.txt'
s = open(p, encoding='utf-8').read()
open(p, 'w', encoding='utf-8').write(s)
print('ok')
EOF`;
    const kinds = detectCovertWrite(cmd).map((f) => f.kind);
    assert.ok(kinds.includes("python-write"));
  });

  it("flags python write_text", () => {
    const kinds = detectCovertWrite(`python3 -c "Path('x').write_text('hi')"`).map((f) => f.kind);
    assert.ok(kinds.includes("python-write"));
  });

  it("flags sed -i", () => {
    const kinds = detectCovertWrite(`sed -i 's/a/b/' file.txt`).map((f) => f.kind);
    assert.ok(kinds.includes("inline-edit"));
  });

  it("flags perl -pi", () => {
    const kinds = detectCovertWrite(`perl -pi -e 's/a/b/' f`).map((f) => f.kind);
    assert.ok(kinds.includes("inline-edit"));
  });

  it("flags echo redirect and tee", () => {
    assert.ok(detectCovertWrite(`echo hi > out.txt`).some((f) => f.kind === "redirect-write"));
    assert.ok(detectCovertWrite(`echo hi >> out.txt`).some((f) => f.kind === "redirect-write"));
    assert.ok(detectCovertWrite(`cat src | tee out.txt`).some((f) => f.kind === "pipe-write"));
  });

  it("flags heredoc redirect", () => {
    const kinds = detectCovertWrite(`cat > f.txt <<'EOF'\nhi\nEOF`).map((f) => f.kind);
    assert.ok(kinds.includes("heredoc-redirect") || kinds.includes("redirect-write"));
  });
});

describe("detectCovertWrite: no false positives", () => {
  const reads = [
    "ls -la && grep -rn 'foo' src | head -20",
    "cargo test -p morph-render --lib 2>&1 | grep 'test result'",
    "echo hello 2>/dev/null",
    "cat file.txt > /dev/null",
    "grep -w image file.txt",
    "ls assets/-image/foo.png",
    "ps aux | grep python",
    "git log --oneline -5",
  ];
  for (const cmd of reads) {
    it(`allows: ${cmd.slice(0, 48)}`, () => {
      assert.deepEqual(detectCovertWrite(cmd), []);
    });
  }

  it("ignores > inside quotes", () => {
    assert.deepEqual(detectCovertWrite(`grep "a > b" file.txt`), []);
  });
});
