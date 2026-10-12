# Proposal: first-class programmatic edits in OpenCode

## Problem

Two ways to edit files exist today, both suboptimal for agents:

1. `edit` tool: auditable, but one exact-match call per hunk. A 3-hunk patch
   costs 3+ round-trips; each can fail on whitespace/unicity, and the model
   must hold state across turns.
2. `shell` with `python3 <<'EOF'` / `sed -i` / redirects: single round-trip,
   arbitrary logic, asserts (`count(anchor) == 1`). But opaque: permission
   rules match raw strings, diffs are invisible, Plan mode is bypassed.

Agents rationally defect to (2). Program-Aided LM work (Gao et al.; ReAct /
PAL follow-ups) predicts this: keeping transformation state in code beats
chaining discrete tool calls for multi-step edits.

## Proposal (upstream PR, staged)

### Stage 1 (this plugin proves the shape): anchor batch tool

A core `patchflow_apply`-equivalent: `edits[]` with
`{ path, anchor, text, mode: insertAfter | replace, expectCount }`,
validated-then-applied atomically, with `dryRun` diff preview. One call,
many files, asserted anchors — the 80% of heredoc usage with a diff trail.

Acceptance: N-hunk patch in 1 tool call; count mismatch fails cleanly naming
the edit index; dry-run shows per-file line deltas.

### Stage 2: covert-write signal in the permission layer

Not a block: when `shell` matches structural file-write patterns (parsed
`open(w)`, `sed -i` flag, `>` target — never substring matching), attach a
machine-readable `suggestedTool` hint to the verdict. Enforcement stays with
existing rules; the hint lets harnesses and reviewers redirect.

Acceptance: `2>/dev/null`, `grep -w`, `-image` paths never flagged (regression
tests included); already-denied verdicts untouched.

### Non-goals

- No execution of arbitrary model-supplied code server-side beyond file
  transforms. The tool is data (anchors + text), not `eval`.
- No new blocking policy. This plugin ships monitor-only; any future
  enforce mode belongs to the policy engine discussion, not this PR.

## Alternatives considered

- Richer `edit` params (anchor + count): helps one hunk, still N calls for
  N hunks. Complementary, not sufficient.
- Banning shell writes via string deny rules: reproduces the false-positive
  class (`*sed *-i*` vs `-image`) the gatekeeper note already documents.
- Full sandboxed-code tool: strictly more powerful but needs execution
  isolation review; anchor edits cover observed usage without it.

## Evidence

- Included `test/detect.test.ts`: 6 true-positive families, 8 read-only
  commands plus quoted-`>` that must stay clean.
- Included `test/apply.test.ts`: unique-anchor insert, count-mismatch
  failure, multi-occurrence replace, all-before-any atomicity, and the
  motivating `mui_bridge.rs`-style anchor scenario.
- `npm test` green on Node 24; `npm run typecheck` clean.
