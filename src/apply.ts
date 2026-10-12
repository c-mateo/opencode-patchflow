/**
 * apply.ts — pure anchor-based batch editing.
 *
 * Rationale (Program-Aided LM literature): an LLM fails less when it can
 * express "find this anchor, assert it occurs N times, insert/replace this
 * text" as data in ONE call than when it must chain N `edit` calls with a
 * round-trip each. `patchflow_apply` is that one call, with the diff kept
 * auditable (unlike an opaque `python3 <<'EOF'` heredoc doing the same).
 */

export type EditMode = "insertAfter" | "replace";

export interface AnchorEdit {
  /** Anchor text that must occur `expectCount` times (default 1). */
  anchor: string;
  /** Text to insert after the anchor, or replacement when mode is replace. */
  text: string;
  mode?: EditMode;
  expectCount?: number;
}

export interface ApplyResult {
  content: string;
  /** Per-edit occurrence counts, in input order. */
  counts: number[];
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

/**
 * Validate every edit against the ORIGINAL content first, then apply all.
 * Atomic: on any count mismatch nothing is applied and an Error naming
 * the failing edit index is thrown.
 */
export function applyAnchorEdits(content: string, edits: AnchorEdit[]): ApplyResult {
  const counts = edits.map((e) => countOccurrences(content, e.anchor));
  for (let i = 0; i < edits.length; i++) {
    const expected = edits[i].expectCount ?? 1;
    if (counts[i] !== expected) {
      throw new Error(
        `patchflow: edit ${i} anchor occurs ${counts[i]}x, expected ${expected}x`,
      );
    }
    if (!edits[i].anchor) throw new Error(`patchflow: edit ${i} has an empty anchor`);
  }
  let out = content;
  for (let i = 0; i < edits.length; i++) {
    const { anchor, text, mode = "insertAfter" } = edits[i];
    out =
      mode === "replace"
        ? out.split(anchor).join(text)
        : out.split(anchor).join(anchor + text);
  }
  return { content: out, counts };
}

/** Minimal unified-ish preview: added line counts per edit. */
export function previewStats(before: string, after: string): { addedLines: number } {
  const b = before.split("\n").length;
  const a = after.split("\n").length;
  return { addedLines: Math.max(0, a - b) };
}
