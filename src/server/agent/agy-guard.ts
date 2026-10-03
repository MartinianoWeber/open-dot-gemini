import path from "node:path";
import type { RuleDecision } from "@/lib/types";

// Pure checks for agy's own tools. The hook calls these before it shows a card.
// Reads and writes inside the dot's workspace stay with agy and are not reviewed.

export function pathInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const full = path.resolve(base, target);
  if (process.platform === "win32") {
    const a = base.toLowerCase();
    const b = full.toLowerCase();
    return b === a || b.startsWith(a.endsWith("\\") ? a : `${a}\\`);
  }
  const rel = path.relative(base, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type AgyReview = {
  action: string;
  detail?: string;
  fallback: RuleDecision;
};

const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

function arg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * What the PreToolUse hook should do with one of agy's tools.
 * `null` means allow immediately (workspace writes, or a tool this hook does not gate).
 */
export function classifyAgyTool(name: string, args: Record<string, unknown>, workspaceRoot: string): AgyReview | null {
  if (WRITE_TOOLS.has(name)) {
    const target = arg(args, "TargetFile", "TargetPath", "AbsolutePath", "path");
    if (!target || pathInside(workspaceRoot, target)) return null;
    return { action: `write \`${target}\` outside its workspace`, detail: target, fallback: "ask" };
  }
  if (name === "run_command") {
    const cmd = arg(args, "CommandLine", "command", "cmd") ?? "";
    const cwd = arg(args, "Cwd", "cwd");
    const outside = Boolean(cwd && !pathInside(workspaceRoot, cwd));
    return {
      action: `run \`${cmd}\` on its own computer`,
      detail: cmd || undefined,
      // Inside the workspace sandbox, rules decide. A cwd outside the workspace asks even with no rule.
      fallback: outside ? "ask" : "allow",
    };
  }
  if (name === "read_url_content") {
    const url = arg(args, "Url", "url") ?? "";
    return { action: `open ${url} in its browser`, detail: url || undefined, fallback: "allow" };
  }
  if (name === "search_web") {
    const query = arg(args, "query") ?? "";
    return { action: `search the web for ${query}`, detail: query || undefined, fallback: "allow" };
  }
  return null;
}
