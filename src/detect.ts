/**
 * detect.ts — pure, dependency-free detection of covert file writes
 * hidden inside a shell command string.
 *
 * Goal: notice when an agent edits files through `shell` (python heredoc,
 * `sed -i`, output redirection, ...) instead of the auditable `edit` tool
 * or the `patchflow_apply` tool this plugin provides. Detection never
 * blocks: it only labels, so the permission hook can suggest the better
 * path without adding friction.
 *
 * Deliberately conservative: `2>/dev/null`, `grep -w`, paths containing
 * `-image`, and read-only pipelines must NOT match.
 */

export interface CovertFinding {
  kind: string;
  detail: string;
}

/** A shell segment split that respects single/double quotes and escapes. */
function splitSegments(input: string): { segments: string[]; exotic: boolean } {
  const segments: string[] = [];
  let cur = "";
  let sq = false;
  let dq = false;
  let esc = false;
  let exotic = false;
  const push = () => {
    if (cur.trim() !== "") segments.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (esc) {
      if (ch !== "\n") cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      cur += ch;
      continue;
    }
    if (ch === "'" && !dq) {
      sq = !sq;
      cur += ch;
      continue;
    }
    if (ch === '"' && !sq) {
      dq = !dq;
      cur += ch;
      continue;
    }
    if (sq || dq) {
      cur += ch;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") exotic = true;
    if (ch === "`") exotic = true;
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  if (sq || dq || esc) exotic = true;
  return { segments, exotic };
}

/** Remove quoted spans so `">"` inside strings does not count as redirect. */
function dequote(s: string): string {
  return s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "");
}

/** True when a `>` in the dequoted segment targets a real file. */
function hasFileRedirect(dequotedSegment: string): boolean {
  // Strip fd sinks: `2>/dev/null`, `>&2`, `>/dev/null`, `2>&1`.
  let s = dequotedSegment
    .replace(/\b\d*\s*>&\d+/g, " ")
    .replace(/>\s*\/dev\/null/g, " ");
  // Any remaining `>` / `>>` followed by a non-empty target is a file write.
  const m = s.match(/>{1,2}\s*(\S+)/);
  if (!m) return false;
  const target = m[1];
  // A lone `&N` remnant or empty target is not a file write.
  if (/^&\d+$/.test(target)) return false;
  return true;
}

const PYTHON_WRITE = [
  /\bopen\s*\([^)]*['"][wa]['"]/i,
  /\bopen\s*\([^)]*,\s*[^)]*['"]w/i,
  /\.write(_text|_bytes)?\s*\(/,
  /pathlib/i,
];

const INLINE_EDIT_EX = [/(^|\s|\/)ed\b/i, /(^|\s|\/)ex\b/i];

/**
 * Option-token scan: `sed -i` / `perl -pi` carry the in-place flag as a
 * short `-...i...` token (or `--in-place`). Token-based so a path like
 * `-image/foo.png` never matches — substring regexes (`-i`) do.
 */
function hasInPlaceFlag(hay: string, cmd: string): boolean {
  for (const seg of hay.split("\n")) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const base = tokens[i].split("/").pop() ?? "";
      if (base !== cmd) continue;
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (!t.startsWith("-") || t === "-" || t === "--") break;
        if (/^-[\w.]*i[\w.]*$/.test(t) || t === "--in-place") return true;
      }
    }
  }
  return false;
}

const PIPE_TO_WRITE = [/(^|\s)(tee| sponge)\b/i, /\|\s*sudo\s+tee\b/i];

const HEREDOC_WRITE = [/<<\s*['"]?EOF['"]?/];

/**
 * Scan a full shell command for covert file-write techniques.
 * Returns one finding per technique family (stable order).
 */
export function detectCovertWrite(command: string): CovertFinding[] {
  if (!command || !command.trim()) return [];
  const normalized = command.replace(/\.exe\b/g, "");
  const { segments } = splitSegments(normalized);
  const hay = segments.map(dequote).join("\n");
  const raw = segments.join("\n");
  const findings: CovertFinding[] = [];

  const isPython = /(^|\s|\/)(python3?|python3?\.\d+|uv\s+run\s+python|pypy)(\s|$)/i.test(hay);
  if (isPython && PYTHON_WRITE.some((re) => re.test(raw) || re.test(hay))) {
    findings.push({ kind: "python-write", detail: "python open(w/a)/write/write_text" });
  }
  if (isPython && /<<\s*['"]?EOF['"]?/.test(raw) && PYTHON_WRITE.some((re) => re.test(raw))) {
    // heredoc + python write is the same family; keep single label.
  } else if (HEREDOC_WRITE.some((re) => re.test(raw)) && hasFileRedirect(hay)) {
    findings.push({ kind: "heredoc-redirect", detail: "heredoc piped into a file redirect" });
  }
  if (hasInPlaceFlag(hay, "sed") || hasInPlaceFlag(hay, "perl")) {
    findings.push({ kind: "inline-edit", detail: "sed -i / perl -pi in-place edit" });
  }
  if (INLINE_EDIT_EX.some((re) => re.test(hay))) {
    findings.push({ kind: "inline-edit", detail: "ed/ex in-place edit" });
  }
  if (PIPE_TO_WRITE.some((re) => re.test(hay))) {
    findings.push({ kind: "pipe-write", detail: "pipeline into tee/sponge" });
  }
  // Plain `>` / `>>` file writes (heredoc-less): `echo x > f`, `cat > f`.
  // Exotic `$( )`/backtick commands are still labelled when they redirect.
  if (!findings.some((f) => f.kind === "heredoc-redirect")) {
    const anyRedirect = segments.map(dequote).some(hasFileRedirect);
    if (anyRedirect) findings.push({ kind: "redirect-write", detail: "> or >> to a file" });
  }
  // `dd`, `install`, `mv/cp > target` handled by core permissions; only
  // flag `dd` here because it is almost always a raw write.
  if (/(^|\s)dd\b/i.test(hay)) findings.push({ kind: "raw-write", detail: "dd raw write" });

  return findings;
}

/** One-line human summary, stable for logs (no command text). */
export function summarizeFindings(findings: CovertFinding[]): string {
  return findings.map((f) => f.kind).join(",");
}
