/**
 * opencode-patchflow — programmatic yet auditable file edits.
 *
 * Provides one tool, `patchflow_apply`, for anchor-based atomic batch
 * edits (the legitimate need behind `python3 <<'EOF'` heredocs), plus a
 * monitor-style permission hook that *suggests* the tool when a shell
 * command hides a file write. Nothing is ever blocked by this plugin:
 * static `deny` rules always win and are never touched.
 */
import { Plugin } from "@opencode/plugin";
import { readFile, writeFile } from "node:fs/promises";
import { applyAnchorEdits } from "./apply.ts";
import { detectCovertWrite, summarizeFindings } from "./detect.ts";
import { metricsFile, recordMetrics } from "./metrics.ts";

interface PatchflowOptions {
  /** Log covert-write observations without changing any verdict. */
  monitorOnly?: boolean;
  /** Append a suggestion when a shell request already asks/denies. */
  suggestOnAsk?: boolean;
  /**
   * Session-aggregated counters (apply vs `edit` usage, covert writes).
   * Local-only, default off. `metrics:"verbose"` is reserved for future
   * per-operation debugging and currently behaves as `true`.
   */
  metrics?: boolean | "verbose";
}

interface FileEdit {
  path: string;
  anchor: string;
  text: string;
  mode?: "insertAfter" | "replace";
  expectCount?: number;
}

const SUGGEST =
  "[patchflow] covert file write inside shell; prefer the auditable " +
  "`patchflow_apply` tool (anchor + expectCount + dry-run diff) over " +
  "python heredocs / sed -i / redirects.";

export default Plugin.define({
  id: "patchflow",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as PatchflowOptions;
    const monitorOnly = opts.monitorOnly ?? true;
    const suggestOnAsk = opts.suggestOnAsk ?? true;
    const metricsOn = opts.metrics === true || opts.metrics === "verbose";
    const store = metricsFile();
    // Staged per-call input (keyed by tool call id): committed in
    // execute.after only when the call succeeds.
    const staged = new Map<string, { dryRun: boolean; edits: number; files: number }>();

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "patchflow",
        description: "Atomic anchor-based batch file edits with dry-run diff.",
      });
      editor.add({
        name: "apply",
        description:
          "Apply anchor-based batch edits atomically; prefer over `edit` when " +
          "a stable anchor exists or batching multiple edits. Each edit asserts " +
          "its anchor occurs expectCount times (default 1), then inserts " +
          "`text` after the anchor or replaces it. Validates ALL edits " +
          "before writing ANY. Use dryRun first for a diff preview. " +
          "Prefer this over python heredocs or sed -i: same single-call " +
          "ergonomics, but the diff stays auditable.",
        input: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  anchor: { type: "string" },
                  text: { type: "string" },
                  mode: { type: "string", enum: ["insertAfter", "replace"] },
                  expectCount: { type: "number" },
                },
                required: ["path", "anchor", "text"],
                additionalProperties: false,
              },
            },
            dryRun: { type: "boolean" },
          },
          required: ["edits"],
          additionalProperties: false,
        },
        options: { namespace: "patchflow", codemode: true },
        execute: async (input) => {
          const { edits, dryRun } = input as { edits: FileEdit[]; dryRun?: boolean };
          if (!Array.isArray(edits) || edits.length === 0) {
            return { content: "patchflow: no edits provided" };
          }
          // Group by file so one read/write serves many edits.
          const byFile = new Map<string, FileEdit[]>();
          for (const e of edits) {
            if (!e?.path || typeof e.anchor !== "string" || typeof e.text !== "string") {
              return { content: "patchflow: each edit needs path, anchor, text" };
            }
            const list = byFile.get(e.path) ?? [];
            list.push(e);
            byFile.set(e.path, list);
          }
          const lines: string[] = [];
          const pending = new Map<string, string>();
          for (const [path, list] of byFile) {
            let original: string;
            try {
              original = await readFile(path, "utf8");
            } catch (err) {
              return { content: `patchflow: cannot read ${path}: ${String(err)}` };
            }
            let next: string;
            try {
              next = applyAnchorEdits(
                original,
                list.map((e) => ({
                  anchor: e.anchor,
                  text: e.text,
                  mode: e.mode ?? "insertAfter",
                  expectCount: e.expectCount ?? 1,
                })),
              ).content;
            } catch (err) {
              return { content: `patchflow: ${path}: ${String(err)}` };
            }
            const added = next.split("\n").length - original.split("\n").length;
            lines.push(`${dryRun ? "would update" : "updated"} ${path} (${list.length} edits, +${Math.max(0, added)} lines)`);
            if (!dryRun) pending.set(path, next);
          }
          if (!dryRun) {
            for (const [path, next] of pending) await writeFile(path, next, "utf8");
          }
          return { content: lines.join("\n") };
        },
      });
    });

    await ctx.permission.hook("evaluate", async (event) => {
      try {
        if (event.action !== "shell") return;
        if (event.effect === "deny") return; // static rules win
        const raw = event.resources.join(" ");
        if (!raw || !raw.trim()) return;
        const findings = detectCovertWrite(raw);
        if (findings.length === 0) return;
        console.info(`[patchflow] covert-write (${summarizeFindings(findings)}) observed`);
        if (!monitorOnly) return; // reserved: future enforce mode
        if (suggestOnAsk && event.effect === "ask") {
          event.message = event.message ? `${event.message} ${SUGGEST}` : SUGGEST;
        }
      } catch {
        // never break the permission flow
      }
    });

    await ctx.tool.hook("execute.before", async (event) => {
      try {
        if (event.tool !== "shell" && event.tool !== "bash") return;
        const args = event.input as { command?: unknown };
        if (typeof args?.command !== "string") return;
        const findings = detectCovertWrite(args.command);
        if (findings.length > 0) {
          console.info(`[patchflow] shell hides file write (${summarizeFindings(findings)}); consider patchflow_apply`);
          if (metricsOn) recordMetrics(store, event.sessionID, { covert: 1 });
        }
      } catch {
        // never break the tool call
      }
    });

    if (metricsOn) {
      await ctx.tool.hook("execute.before", async (event) => {
        try {
          if (event.tool !== "patchflow_apply") return;
          const args = event.input as { edits?: unknown; dryRun?: unknown };
          if (!Array.isArray(args?.edits)) return;
          const files = new Set<string>();
          for (const e of args.edits) {
            if (typeof (e as { path?: unknown })?.path === "string") {
              files.add((e as { path: string }).path);
            }
          }
          staged.set(event.id, {
            dryRun: args.dryRun === true,
            edits: args.edits.length,
            files: files.size,
          });
        } catch {
          // metrics never break the tool call
        }
      });

      await ctx.tool.hook("execute.after", async (event) => {
        try {
          if (event.status !== "completed") {
            if (event.tool === "patchflow_apply") {
              staged.delete(event.id);
              recordMetrics(store, event.sessionID, { errors: 1 });
            }
            return;
          }
          if (event.tool === "edit") {
            recordMetrics(store, event.sessionID, { editCalls: 1 });
            return;
          }
          if (event.tool !== "patchflow_apply") return;
          const content =
            typeof event.result?.content === "string" ? event.result.content : null;
          if (content !== null && content.startsWith("patchflow:")) {
            staged.delete(event.id);
            recordMetrics(store, event.sessionID, { errors: 1 });
            return;
          }
          const pending = staged.get(event.id);
          staged.delete(event.id);
          if (!pending) return;
          recordMetrics(store, event.sessionID, {
            [pending.dryRun ? "dryRuns" : "apply"]: 1,
            edits: pending.edits,
            files: pending.files,
          });
        } catch {
          // metrics never break the tool call
        }
      });
    }
  },
});
