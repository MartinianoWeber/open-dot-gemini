import path from "node:path";
import type { RuleDecision } from "@/lib/types";

// Pure checks for agy's own tools. The hook calls these before it shows a card.
// Reads and writes inside the dot's workspace stay with agy and are not reviewed.
// A write outside the workspace is allowed unless a user rule says ask or never.

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

/** Grant agy needs in a hook allow, or the write stays inside the workspace. */
export function agyWriteGrant(name: string): string | null {
  return WRITE_TOOLS.has(name) ? "write_file(*)" : null;
}

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
    return { action: `write \`${target}\` outside its workspace`, detail: target, fallback: "allow" };
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

/** How many times the Stop hook may push one turn back into the loop. */
export const MAX_STOP_CONTINUES = 16;

export const STOP_CONTINUE_REASON =
  "The task is not finished. Do the next step yourself and keep going until it is done. Reply with the result when it is finished. If a command was denied, don't retry that command; use another approach, or ask the user once if you are blocked.";

export type StopDecision = { decision: "continue"; reason: string } | { decision: "allow" };

/**
 * Whether the last planner step in an agy transcript already said something to the user.
 * A tail that starts mid-line is skipped. No planner step counts as not spoken.
 */
export function plannerSpoke(jsonl: string): boolean {
  let spoke = false;
  for (const raw of jsonl.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let row: { type?: string; content?: unknown };
    try {
      row = JSON.parse(line) as { type?: string; content?: unknown };
    } catch {
      continue;
    }
    if (row.type !== "PLANNER_RESPONSE") continue;
    spoke = typeof row.content === "string" && row.content.trim().length > 0;
  }
  return spoke;
}

/** Only a transcript under the user's `.gemini` directory is readable from the Stop hook. */
export function transcriptPathOk(candidate: string, home: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const expanded = trimmed.replace(/^~(?=$|[/\\])/, home);
  const full = path.resolve(expanded);
  const root = path.resolve(home, ".gemini");
  if (!pathInside(root, full)) return null;
  if (path.basename(full).toLowerCase() !== "transcript.jsonl") return null;
  return full;
}

/**
 * The Stop hook's answer. Continue only when the model quit without a reply.
 * `spoke: null` means the transcript could not be read, so the turn is allowed to end.
 */
export function stopDecision(input: {
  terminationReason?: string;
  executionNum?: number;
  fullyIdle?: boolean;
  spoke: boolean | null;
}): StopDecision {
  if (input.fullyIdle === false) return { decision: "allow" };
  const reason = (input.terminationReason ?? "").trim();
  if (reason === "error" || reason === "max_steps_exceeded") return { decision: "allow" };
  if ((input.executionNum ?? 0) >= MAX_STOP_CONTINUES) return { decision: "allow" };
  if (input.spoke !== false) return { decision: "allow" };
  if (reason && reason !== "model_stop") return { decision: "allow" };
  return { decision: "continue", reason: STOP_CONTINUE_REASON };
}
