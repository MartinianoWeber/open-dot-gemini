import "server-only";
import { emit } from "../bus";
import * as composio from "../composio";
import * as repo from "../repo";
import { workspaceDir } from "../computer/shell";
import type { CardData, Dot, RuleDecision } from "@/lib/types";
import { classifyAgyTool } from "./agy-guard";
import { AGY_MCP_ALLOW } from "./bridge";
import { review } from "./review";
import { findTool, type ToolCtx } from "./tools";

// Rules and approval cards, shared by the OpenAI loop and by agy (MCP tools and the PreToolUse hook).
// The OpenAI loop pauses and resumes later. agy holds the MCP call or the hook until the same card is answered.

export type CardChoice = "approve" | "deny" | "always" | "answer";
export type WaitWhy = "message" | "timeout" | "stopped";

export type CardResolution = {
  choice: CardChoice | "expired";
  answer?: string;
  approved: boolean;
  why?: WaitWhy;
};

export type PreparedCall =
  | { type: "output"; output: string }
  | { type: "run" }
  | { type: "pause"; card: CardData; arm?: (cardId: string) => void };

type CardResolver = (messageId: string, choice: CardChoice, answer?: string) => void | Promise<void>;
let cardResolver: CardResolver | null = null;

/** Connect cards resume through the same path as a click on Approve (the OpenAI loop or an agy waiter). */
export function setCardResolver(fn: CardResolver) {
  cardResolver = fn;
}

type Waiter = { dotId: string; finish: (res: CardResolution) => void };
const g = globalThis as unknown as { __dotsGateWaits?: Map<string, Waiter> };
const waiters = () => (g.__dotsGateWaits ??= new Map<string, Waiter>());

const capitalize = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function abortWhy(signal: AbortSignal): WaitWhy {
  const reason = signal.reason;
  const name = reason && typeof reason === "object" && "name" in reason ? String((reason as { name: unknown }).name) : "";
  return name === "TimeoutError" ? "timeout" : "stopped";
}

export function openCard(dotId: string, card: CardData): string {
  return repo.addMessage({ dotId, role: "card", text: card.title, card }).id;
}

function expireCard(messageId: string) {
  const card = repo.getMessage(messageId)?.card;
  if (card?.status === "pending") repo.updateMessage(messageId, { card: { ...card, status: "expired" } });
}

/** Block until the user answers `messageId`, or until `signal` aborts (stop, pause, hook timeout). */
export function beginWait(messageId: string, dotId: string, signal: AbortSignal): Promise<CardResolution> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: CardResolution) => {
      if (settled) return;
      settled = true;
      waiters().delete(messageId);
      signal.removeEventListener("abort", onAbort);
      resolve(res);
    };
    const onAbort = () => {
      expireCard(messageId);
      finish({ choice: "expired", approved: false, why: abortWhy(signal) });
    };
    waiters().set(messageId, { dotId, finish });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const hasWaiter = (messageId: string) => waiters().has(messageId);

/** Wake a hook or MCP call that is sitting on this card. Returns false if the OpenAI loop owns it. */
export function settleWaiter(messageId: string, choice: CardChoice, answer?: string): boolean {
  const waiter = waiters().get(messageId);
  if (!waiter) return false;
  const approved = choice === "approve" || choice === "always";
  waiter.finish({ choice, answer, approved });
  return true;
}

/** The user moved on, or the run was stopped. Pending agy cards expire and the hook answers deny. */
export function expireDotWaits(dotId: string, why: WaitWhy) {
  for (const [messageId, waiter] of [...waiters()]) {
    if (waiter.dotId !== dotId) continue;
    expireCard(messageId);
    waiter.finish({ choice: "expired", approved: false, why });
  }
}

export function refusalText(res: CardResolution): string {
  if (res.why === "timeout") return "Not run — the approval expired.";
  if (res.why === "stopped") return "Not run — the run was stopped.";
  return "Not run — the user sent a new message first.";
}

function noteActivity(dotId: string, label: string, detail?: string) {
  const text = detail ? `${label} · ${detail}` : label;
  const last = repo.dotMessages(dotId, 1)[0];
  if (last?.role === "activity" && last.text === text) return;
  repo.addMessage({ dotId, role: "activity", text });
}

function summarize(args: Record<string, unknown>): string | undefined {
  const v = args.command ?? args.url ?? args.path ?? args.site ?? args.fact ?? args.name ?? args.dot_name;
  if (typeof v !== "string") return undefined;
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}

/** Run a tool that the gate already allowed. */
export async function performTool(dot: Dot, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const def = findTool(name);
  if (!def?.execute) return `Unknown tool ${name}`;
  repo.setActivity(dot.id, def.label);
  noteActivity(dot.id, def.label, summarize(args));
  try {
    return await def.execute(args, { dot, signal, depth: 0 });
  } catch (err) {
    if (signal.aborted) throw err;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The same reply the OpenAI loop stores as the tool output after a card. */
export async function outputAfterCard(dot: Dot, name: string, args: Record<string, unknown>, res: CardResolution, signal: AbortSignal): Promise<string> {
  if (res.choice === "expired") return refusalText(res);
  const def = findTool(name);
  if (!def) return `Unknown tool ${name}`;
  if (def.pause === "question") return `The user answered: ${res.answer ?? ""}`;
  if (def.pause === "approval") {
    return res.approved
      ? "The user approved. Go ahead."
      : "The user denied this. Do not do it; tell them briefly what you'll do instead, if anything.";
  }
  if (def.pause === "connect") {
    return res.approved
      ? "Connected. Continue with the task."
      : "The user chose not to connect this app right now. Continue without it or tell them what you need.";
  }
  if (res.approved && def.execute) return performTool(dot, name, args, signal);
  return "The user denied this action. Don't retry it; continue without it or ask what they'd prefer.";
}

function askCard(action: string, tool: string, detail: string | undefined, ruleAction: string): CardData {
  return {
    kind: "approval",
    status: "pending",
    title: capitalize(action),
    tool,
    ruleAction,
    detail: detail || undefined,
  };
}

/** Decide a tool call. Does not run it and does not wait: the caller either executes, returns the text, or opens the card. */
export async function prepareToolCall(dot: Dot, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<PreparedCall> {
  const def = findTool(name);
  if (!def) return { type: "output", output: `Unknown tool ${name}` };

  if (def.pause === "question") {
    const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : [];
    return { type: "pause", card: { kind: "question", status: "pending", title: String(args.question ?? ""), options } };
  }
  if (def.pause === "approval") {
    return {
      type: "pause",
      card: { kind: "approval", status: "pending", title: String(args.action ?? ""), detail: String(args.details ?? ""), tool: def.name },
    };
  }
  if (def.pause === "connect") {
    const toolkit = String(args.toolkit ?? "").trim().toLowerCase();
    const started = await composio.startConnect(toolkit).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    if ("error" in started) return { type: "output", output: `Couldn't start connecting ${toolkit}: ${started.error}` };
    if (started.already) return { type: "output", output: "Already connected." };
    return {
      type: "pause",
      card: {
        kind: "connect",
        status: "pending",
        title: `Connect ${started.name}`,
        toolkit,
        url: started.url,
        detail: `${dot.name} needs access to your ${started.name} to continue. You'll sign in with ${started.name} directly; ${dot.name} never sees your password.`,
      },
      arm: (cardId) => {
        void started.wait().then(() => cardResolver?.(cardId, "approve")).catch(() => {});
      },
    };
  }

  const ctx: ToolCtx = { dot, signal, depth: 0 };
  const blocked = await def.precheck?.(args, ctx).catch(() => null);
  if (blocked) return { type: "output", output: blocked };
  if (def.describe) {
    const action = def.describe(args, ctx);
    const verdict = await verdictFor(dot, action, (await def.defaultDecision?.(ctx, args)) ?? "allow");
    if (verdict.decision === "never") {
      noteActivity(dot.id, "Blocked by your rule", verdict.rule?.action);
      return { type: "output", output: `Not allowed: the user's rule says never ${verdict.rule?.action ?? "do this"}. Don't try to work around it.` };
    }
    if (verdict.decision === "ask") {
      const extra = [def.detail?.(args), verdict.rule ? `Your rule: ask first when it wants to ${verdict.rule.action}.` : null].filter(Boolean).join("\n\n");
      return { type: "pause", card: askCard(action, def.name, extra, verdict.rule?.action ?? action) };
    }
  }
  return { type: "run" };
}

async function verdictFor(dot: Dot, action: string, fallback: RuleDecision) {
  repo.setActivity(dot.id, "Checking your rules");
  return review(dot.id, action, fallback);
}

/** Show a card and wait. Registers the waiter before `arm`, so a fast connect can't resolve first. */
export async function holdCard(dot: Dot, card: CardData, signal: AbortSignal, arm?: (cardId: string) => void): Promise<CardResolution> {
  if (signal.aborted) return { choice: "expired", approved: false, why: abortWhy(signal) };
  const messageId = openCard(dot.id, card);
  const pending = beginWait(messageId, dot.id, signal);
  arm?.(messageId);
  if (repo.getDot(dot.id)?.status !== "paused") repo.updateDot(dot.id, { status: "waiting" });
  repo.setActivity(dot.id, "Waiting for you");
  emit({
    type: "notify",
    dotId: dot.id,
    title: `${dot.name} needs you`,
    body: `Needs your approval: ${card.title}`.slice(0, 160),
  });
  const res = await pending;
  const now = repo.getDot(dot.id);
  if (now?.status === "waiting") repo.updateDot(dot.id, { status: "working" });
  return res;
}

/** MCP entry: same rules as the OpenAI loop, but the tool call stays open until the user answers. */
export async function runGatedTool(dot: Dot, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const prep = await prepareToolCall(dot, name, args, signal);
  if (prep.type === "output") return prep.output;
  if (prep.type === "run") return performTool(dot, name, args, signal);
  const res = await holdCard(dot, prep.card, signal, prep.arm);
  return outputAfterCard(dot, name, args, res, signal);
}

export type HookDecision = { decision: "allow"; permissionOverrides?: string[] } | { decision: "deny"; reason: string };

const MCP_HOOK_TOOLS = new Set(["mcp_tool", "call_mcp_tool"]);

/** Headless agy auto-denies MCP unless this grant is present. Scoped to the dot's own server. */
function allowHook(name: string): HookDecision {
  if (MCP_HOOK_TOOLS.has(name) || name.startsWith("COMPOSIO_")) {
    return { decision: "allow", permissionOverrides: [AGY_MCP_ALLOW] };
  }
  return { decision: "allow" };
}

const HOOK_WAIT_MS = 14 * 60_000;

/** PreToolUse for agy's own command, URL, and out-of-workspace write. Holds until allow or deny. */
export async function decideAgyHook(dot: Dot, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HookDecision> {
  const reviewable = classifyAgyTool(name, args, workspaceDir(dot.id));
  if (!reviewable) return allowHook(name);
  const verdict = await verdictFor(dot, reviewable.action, reviewable.fallback);
  if (verdict.decision === "allow") return allowHook(name);
  if (verdict.decision === "never") {
    noteActivity(dot.id, "Blocked by your rule", verdict.rule?.action);
    return { decision: "deny", reason: `Not allowed: the user's rule says never ${verdict.rule?.action ?? "do this"}. Don't try to work around it.` };
  }
  const extra = [reviewable.detail, verdict.rule ? `Your rule: ask first when it wants to ${verdict.rule.action}.` : null].filter(Boolean).join("\n\n");
  const timed = linkTimeout(signal, HOOK_WAIT_MS);
  try {
    const res = await holdCard(dot, askCard(reviewable.action, `agy:${name}`, extra, verdict.rule?.action ?? reviewable.action), timed.signal);
    if (res.approved) return allowHook(name);
    if (res.choice === "expired") return { decision: "deny", reason: refusalText(res) };
    return { decision: "deny", reason: "The user denied this action. Don't retry it; continue without it or ask what they'd prefer." };
  } finally {
    timed.cancel();
  }
}

/** Abort `parent` or after `ms`, whichever comes first. `cancel` drops the timer once the card is answered. */
function linkTimeout(parent: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("The approval expired.", "TimeoutError")), ms);
  const onParent = () => ctrl.abort(parent.reason);
  if (parent.aborted) ctrl.abort(parent.reason);
  else parent.addEventListener("abort", onParent, { once: true });
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParent);
    },
  };
}
