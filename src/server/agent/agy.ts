import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emit } from "../bus";
import { ensureAgyBridge } from "./bridge";
import { workspaceDir } from "../computer/shell";
import * as repo from "../repo";
import type { Attachment, Dot } from "@/lib/types";

// Antigravity's `agy` CLI, beside OpenAI and OpenRouter. A dot whose model id starts with
// "agy:" keeps one headless process per conversation and streams its text into the chat.
// agy reads and writes inside the workspace. Open Dot's browser, apps, and approvals are the
// MCP server and PreToolUse hook written into that workspace (`.agents/`). The only thing
// written under ~/.gemini is the MCP allow rule, and that happens on whatever machine runs the server.

export const AGY_PREFIX = "agy:";
/** CLI default: no `--model` flag, so agy picks its own. */
export const AGY_DEFAULT_ID = "agy:default";

const PRO_HIGH = "Gemini 3.1 Pro (High)";
const PRO_LOW = "Gemini 3.1 Pro (Low)";
const MODELS_TIMEOUT_MS = 15_000;
const PERMISSION_STALL_MS = 20_000;
const BIN_TTL_MS = 30_000;

const PERMISSION_NOTE =
  "Antigravity asked to approve a command or a page, and this chat can't answer that yet. The turn stopped. Work inside the workspace can continue; approvals come later.";
const AUTH_NOTE = "Antigravity isn't signed in. Run agy once in a terminal to sign in, then try again. Open Dot doesn't store that login.";

export const isAgyModel = (model: string) => model.startsWith(AGY_PREFIX);

/** Name passed to `--model`, or null to leave the CLI default. */
export function agyModelName(model: string): string | null {
  if (!isAgyModel(model) || model === AGY_DEFAULT_ID) return null;
  return model.slice(AGY_PREFIX.length);
}

type Entry = { slug: string; label: string };

// A model slug has at least one hyphen (`gemini-3.1-pro-high`). A display name's first word (`Gemini`) does not.
const SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i;

/** Pull `slug  Display Name` rows out of `agy models`. Banners and blanks are skipped. */
export function parseAgyModelList(stdout: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const wide = line.split(/\s{2,}|\t+/);
    if (wide.length >= 2 && SLUG.test(wide[0])) {
      out.push({ slug: wide[0], label: wide.slice(1).join(" ").trim() });
      continue;
    }
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (m && SLUG.test(m[1]) && /[A-Za-z]/.test(m[2])) {
      out.push({ slug: m[1], label: m[2].trim() });
      continue;
    }
    if (SLUG.test(line) && /flash|gemini|claude|gpt/i.test(line)) {
      out.push({ slug: line, label: line });
      continue;
    }
    if (/^(Gemini|Claude|GPT)/.test(line)) out.push({ slug: "", label: line });
  }
  return out;
}

/**
 * Short fixed catalog: Gemini 3.1 Pro (High/Low) when the CLI lists them, plus every Flash
 * row it confirms. The caller adds the CLI default. An empty parse means the listing failed.
 */
export function catalogFromModelsOutput(stdout: string): string[] {
  const entries = parseAgyModelList(stdout);
  if (!entries.length) return [];
  const ids: string[] = [];
  const push = (label: string) => {
    const id = AGY_PREFIX + label;
    if (label && !ids.includes(id)) ids.push(id);
  };
  const has = (pred: (e: Entry) => boolean) => entries.some(pred);
  if (has((e) => e.label === PRO_HIGH || /gemini-3\.1-pro-high|gemini-pro-agent/i.test(e.slug))) push(PRO_HIGH);
  if (has((e) => e.label === PRO_LOW || /gemini-3\.1-pro-low/i.test(e.slug))) push(PRO_LOW);
  for (const e of entries) {
    if (/flash/i.test(e.slug) || /flash/i.test(e.label)) push(e.label || e.slug);
  }
  return ids;
}

type Probe = { at: number; bin: string | null };
const g = globalThis as unknown as { __dotsAgyBin?: Probe; __dotsAgySessions?: Map<string, Session> };

function lookupBin(): string | null {
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32" ? ["agy.cmd", "agy"] : ["agy"];
  for (const name of names) {
    const r = spawnSync(cmd, [name], { encoding: "utf8", timeout: 4000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) continue;
    const line = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("INFO:"));
    if (line) return line;
  }
  return null;
}

/** Full path to `agy` (on Windows, `agy.cmd`), or null when it isn't on PATH. Cached briefly. */
export function agyBin(): string | null {
  const hit = g.__dotsAgyBin;
  if (hit && Date.now() - hit.at < BIN_TTL_MS) return hit.bin;
  const bin = lookupBin();
  g.__dotsAgyBin = { at: Date.now(), bin };
  return bin;
}

export const agyInstalled = () => Boolean(agyBin());

function quoteCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&()<>^|!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnAgy(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  if (process.platform === "win32") {
    // Node won't execute a .cmd without cmd.exe. /s strips one outer quote pair, so the inner quotes stay.
    const inner = [quoteCmd(bin), ...args.map(quoteCmd)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${inner}"`], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
}

function killChild(child: ChildProcess) {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function runCapture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawnAgy(bin, args, process.cwd());
    let stdout = "";
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      killChild(child);
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.resume();
    child.stdin?.end();
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
  });
}

/** Model ids for the picker. Always the CLI default when agy is installed; Pro and Flash only if `agy models` answers. */
export async function agyModelIds(): Promise<string[]> {
  const bin = agyBin();
  if (!bin) return [];
  const { code, stdout } = await runCapture(bin, ["models"], MODELS_TIMEOUT_MS);
  const listed = catalogFromModelsOutput(stdout);
  if (!listed.length && code !== 0) return [AGY_DEFAULT_ID];
  return [AGY_DEFAULT_ID, ...listed];
}

// ---------------------------------------------------------------- headless session

type AgyEvent = {
  event?: string;
  conversation_id?: string;
  init?: { conversation_id?: string };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    tool_name?: string;
    text_delta?: string;
    tool_info?: { name?: string; parameters?: Record<string, unknown> };
  };
  result?: { conversation_id?: string; status?: string; response?: string; error?: string };
};

type TurnEnd =
  | { kind: "result"; result: NonNullable<AgyEvent["result"]>; hadText: boolean }
  | { kind: "permission" }
  | { kind: "aborted" }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string };

type Turn = {
  done: boolean;
  draft: { id: string; text: string } | null;
  hadText: boolean;
  sawPermission: boolean;
  stall: ReturnType<typeof setTimeout> | null;
  /** step_index → activity message, so a later DONE event can fill in the command or path. */
  tools: Map<number, string>;
  resolve: (end: TurnEnd) => void;
};

type Session = {
  key: string;
  dotId: string;
  modelArg: string | null;
  personaPending: boolean;
  child: ChildProcess;
  buf: string;
  turn: Turn | null;
  dead: boolean;
};

const sessions = () => (g.__dotsAgySessions ??= new Map<string, Session>());

const cleaned = globalThis as unknown as { __dotsAgyCleanup?: boolean };
if (!cleaned.__dotsAgyCleanup) {
  cleaned.__dotsAgyCleanup = true;
  // Detached processes survive the server. Kill them on the way out so a restart can resume with --conversation.
  process.on("exit", () => {
    for (const session of sessions().values()) killChild(session.child);
  });
}

function rememberConversation(dotId: string, id: string | null) {
  if (!id) return;
  const thread = AGY_PREFIX + id;
  if (repo.getThread(dotId).thread === thread) return;
  repo.setThread(dotId, thread, null);
}

function idOf(ev: AgyEvent): string | null {
  const nested = ev.conversation_id || ev.result?.conversation_id || ev.step_update?.conversation_id || ev.init?.conversation_id;
  return nested || null;
}

function persistDraft(turn: Turn) {
  if (!turn.draft) return;
  repo.updateMessage(turn.draft.id, { text: turn.draft.text || "…" });
  turn.draft = null;
}

function settle(session: Session, end: TurnEnd) {
  const turn = session.turn;
  if (!turn || turn.done) return;
  turn.done = true;
  if (turn.stall) clearTimeout(turn.stall);
  persistDraft(turn);
  session.turn = null;
  turn.resolve(end);
}

function armPermissionStall(session: Session) {
  const turn = session.turn;
  if (!turn || turn.done) return;
  turn.sawPermission = true;
  if (turn.stall) clearTimeout(turn.stall);
  turn.stall = setTimeout(() => {
    settle(session, { kind: "permission" });
    killSession(session);
  }, PERMISSION_STALL_MS);
}

const PERMISSION_RE = /requires approval|permission request|waiting for approval|ask_permission|soft-denied|denied by permission/i;

function toolLabel(name: string | undefined, params: Record<string, unknown> | undefined): { label: string; detail?: string } {
  const n = (name ?? "").toLowerCase();
  const detailOf = (...keys: string[]) => {
    for (const k of keys) {
      const v = params?.[k];
      if (typeof v === "string" && v.trim()) return v.trim().length > 80 ? `${v.trim().slice(0, 77)}…` : v.trim();
    }
    return undefined;
  };
  if (n.includes("command") || n === "bash" || n === "shell") return { label: "Running a command", detail: detailOf("CommandLine", "command", "cmd") };
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return { label: "Writing a file", detail: detailOf("TargetFile", "TargetPath", "AbsolutePath", "path", "file_path") };
  if (n.includes("read") || n.includes("view") || n.includes("grep")) return { label: "Reading a file", detail: detailOf("TargetFile", "TargetPath", "AbsolutePath", "path", "file_path") };
  return { label: "Using a tool", detail: name };
}

function noteActivity(dotId: string, label: string, detail?: string): string {
  repo.setActivity(dotId, label);
  const text = detail ? `${label} · ${detail}` : label;
  const last = repo.dotMessages(dotId, 1)[0];
  if (last?.conversationId === repo.currentConversation(dotId) && last.role === "activity" && last.text === text) return last.id;
  return repo.addMessage({ dotId, role: "activity", text }).id;
}

function pushDelta(session: Session, turn: Turn, delta: string) {
  if (!delta) return;
  if (!turn.draft) {
    const m = repo.addMessage({ dotId: session.dotId, role: "dot", text: "" });
    turn.draft = { id: m.id, text: "" };
  }
  turn.hadText = true;
  turn.draft.text += delta;
  repo.setActivity(session.dotId, "Writing");
  emit({ type: "message_delta", id: turn.draft.id, dotId: session.dotId, delta });
}

function onLine(session: Session, line: string) {
  let ev: AgyEvent;
  try {
    ev = JSON.parse(line) as AgyEvent;
  } catch {
    return;
  }
  rememberConversation(session.dotId, idOf(ev));
  const turn = session.turn;
  if (turn?.sawPermission) armPermissionStall(session);
  if (ev.event === "step_update" && turn && !turn.done) {
    const step = ev.step_update;
    if (!step) return;
    if (step.step_type === "agent_response" && step.text_delta) pushDelta(session, turn, step.text_delta);
    if (step.step_type === "tool") {
      const name = step.tool_name || step.tool_info?.name;
      const { label, detail } = toolLabel(name, step.tool_info?.parameters);
      const text = detail ? `${label} · ${detail}` : label;
      const index = step.step_index;
      const prior = index == null ? undefined : turn.tools.get(index);
      if (!prior) {
        persistDraft(turn);
        const id = noteActivity(session.dotId, label, detail);
        if (index != null) turn.tools.set(index, id);
      } else if (detail) {
        const prev = repo.getMessage(prior);
        if (prev?.role === "activity" && prev.text !== text) {
          repo.setActivity(session.dotId, label);
          repo.updateMessage(prior, { text });
        }
      }
      if (/permission/i.test(name ?? "")) armPermissionStall(session);
    }
    return;
  }
  if (ev.event === "result" && ev.result) {
    const status = ev.result.status ?? "";
    const err = ev.result.error ?? "";
    if (status === "WAITING" || PERMISSION_RE.test(err)) {
      settle(session, { kind: "permission" });
      killSession(session);
      return;
    }
    settle(session, { kind: "result", result: ev.result, hadText: turn?.hadText ?? false });
  }
}

function bind(session: Session) {
  session.child.stdout?.setEncoding("utf8");
  session.child.stdout?.on("data", (chunk: string) => {
    session.buf += chunk;
    let nl = session.buf.indexOf("\n");
    while (nl >= 0) {
      const line = session.buf.slice(0, nl).trim();
      session.buf = session.buf.slice(nl + 1);
      if (line) onLine(session, line);
      nl = session.buf.indexOf("\n");
    }
  });
  session.child.stderr?.setEncoding("utf8");
  session.child.stderr?.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) console.warn("[dots] agy:", text);
    if (PERMISSION_RE.test(text)) armPermissionStall(session);
  });
  session.child.on("error", (err) => {
    session.dead = true;
    sessions().delete(session.key);
    settle(session, { kind: "error", message: err.message });
  });
  session.child.on("exit", (code) => {
    session.dead = true;
    sessions().delete(session.key);
    settle(session, { kind: "exit", code: code ?? null });
  });
  session.child.stdin?.on("error", () => {});
}

function killSession(session: Session) {
  if (session.dead) return;
  session.dead = true;
  sessions().delete(session.key);
  killChild(session.child);
}

function resumeId(dotId: string): string | null {
  const thread = repo.getThread(dotId).thread;
  if (!thread?.startsWith(AGY_PREFIX) || thread === AGY_DEFAULT_ID) return null;
  return thread.slice(AGY_PREFIX.length);
}

function openSession(dot: Dot, model: string): Session {
  const key = repo.currentConversation(dot.id);
  const modelArg = agyModelName(model);
  const bin = agyBin();
  if (!bin) throw new Error("agy is not on your PATH.");
  const ws = workspaceDir(dot.id);
  // Print mode only loads a project `.agents/` when the directory is added by absolute path.
  const bridgeChanged = ensureAgyBridge(dot.id);
  const existing = sessions().get(key);
  if (existing && !existing.dead && existing.modelArg === modelArg && !bridgeChanged) return existing;
  if (existing) killSession(existing);
  const resume = resumeId(dot.id);
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--add-dir", ws, "--sandbox"];
  if (modelArg) args.push("--model", modelArg);
  if (resume) args.push("--conversation", resume);
  const child = spawnAgy(bin, args, ws);
  const session: Session = { key, dotId: dot.id, modelArg, personaPending: !resume, child, buf: "", turn: null, dead: false };
  sessions().set(key, session);
  bind(session);
  return session;
}

function withPersona(dot: Dot, text: string): string {
  const head: string[] = [];
  if (dot.purpose.trim()) head.push(`Your job: ${dot.purpose.trim()}`);
  if (dot.instructions.trim()) head.push(`How the user wants you to work:\n${dot.instructions.trim()}`);
  head.push(
    dot.creator
      ? "Open Dot tools cover the browser (the Computer tab: open_url, read_page, click, type_text, sign_in), the user's apps, memory, routines, share_file, message_dot, create_dot, open_room, and ask_user. When the work needs companions, invent only the ones it needs with create_dot, then open_room so they discuss. Don't create extra dots. Reading, writing, and commands inside this workspace stay with your own tools."
      : "Open Dot tools cover the browser (the Computer tab: open_url, read_page, click, type_text, sign_in), the user's apps, memory, routines, share_file, message_dot, and ask_user. Reading, writing, and commands inside this workspace stay with your own tools.",
  );
  return `${head.join("\n\n")}\n\n${text}`;
}

function sendTurn(session: Session, content: string, signal: AbortSignal): Promise<TurnEnd> {
  return new Promise((resolve) => {
    const turn: Turn = { done: false, draft: null, hadText: false, sawPermission: false, stall: null, tools: new Map(), resolve };
    session.turn = turn;
    const onAbort = () => {
      settle(session, { kind: "aborted" });
      killSession(session);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const line = `${JSON.stringify({ event: "user", message: { content } })}\n`;
    session.child.stdin?.write(line, (err) => {
      if (err && !turn.done) settle(session, { kind: "error", message: err.message });
    });
  });
}

/** One user turn on the conversation's agy process. The caller has already routed the dot to that conversation. */
export async function runAgyTurn(opts: { dot: Dot; model: string; text: string; attachments: Attachment[]; signal: AbortSignal }): Promise<void> {
  const { dot, model, attachments, signal } = opts;
  if (signal.aborted) return;
  if (attachments.length) {
    repo.addMessage({
      dotId: dot.id,
      role: "system",
      text: "Antigravity doesn't receive attachments yet. The files stay in this chat, but they were not sent to agy.",
    });
  }
  const text = opts.text.trim() || (attachments.length ? "(The user attached files. They were not included in this message.)" : "");
  if (!text) return;

  let session: Session;
  try {
    session = openSession(dot, model);
  } catch (err) {
    repo.addMessage({ dotId: dot.id, role: "system", text: `Couldn't start Antigravity: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (session.dead) {
    repo.addMessage({ dotId: dot.id, role: "system", text: "Couldn't start Antigravity (agy exited immediately)." });
    return;
  }

  const content = session.personaPending ? withPersona(dot, text) : text;
  session.personaPending = false;
  repo.setActivity(dot.id, "Thinking");
  const end = await sendTurn(session, content, signal);
  if (end.kind === "aborted" || signal.aborted) return;

  if (end.kind === "permission") {
    repo.addMessage({ dotId: dot.id, role: "system", text: PERMISSION_NOTE });
    return;
  }
  if (end.kind === "error") {
    repo.addMessage({ dotId: dot.id, role: "system", text: `Antigravity stopped: ${end.message}` });
    return;
  }
  if (end.kind === "exit") {
    repo.addMessage({ dotId: dot.id, role: "system", text: "Antigravity closed before it finished this reply." });
    return;
  }

  const status = end.result.status ?? "";
  const err = end.result.error ?? "";
  const response = end.result.response ?? "";
  if (!end.hadText && response.trim()) repo.addMessage({ dotId: dot.id, role: "dot", text: response });
  if (status === "SUCCESS" || status === "") {
    if (!end.hadText && !response.trim()) repo.addMessage({ dotId: dot.id, role: "dot", text: "(no reply)" });
    return;
  }
  // The process may still be up after an error, but its stream session is done. The next turn starts clean.
  killSession(session);
  if (/auth|sign in|not authenticated/i.test(err)) {
    repo.addMessage({ dotId: dot.id, role: "system", text: AUTH_NOTE });
    return;
  }
  repo.addMessage({ dotId: dot.id, role: "system", text: `Antigravity stopped: ${err || status}` });
}

const SPEAK_TIMEOUT_MS = 75_000;

type AgyPrint = {
  status?: string;
  response?: string;
  error?: string;
  denied_actions?: { action?: string; display_name?: string }[];
};

/** The print-mode JSON object. Warnings may sit on earlier lines. */
export function parseAgyPrint(stdout: string): AgyPrint | null {
  const trimmed = stdout.trim();
  const at = trimmed.lastIndexOf("\n{");
  const blob = (at >= 0 ? trimmed.slice(at + 1) : trimmed).trim();
  const from = blob.indexOf("{");
  if (from < 0) return null;
  try {
    return JSON.parse(blob.slice(from)) as AgyPrint;
  } catch {
    return null;
  }
}

/** Spoken text from a print result. */
export function lineFromPrint(parsed: AgyPrint | null): string {
  return parsed?.response?.trim() ?? "";
}

const SPEAK_RULES = [
  "You are voicing one character. You are not a software architect unless the character card says so.",
  "You have no tools. Never call a tool, never run a command, never read a file.",
  "Do not ask what to build. Do not greet as an assistant.",
  "Follow the character card. Reply with only the spoken line.",
].join("\n");

/** A home whose GEMINI.md is only this character, so the user's architect rules are not inherited. */
function speakHome(rules: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "open-dot-speak-"));
  const gemini = path.join(home, ".gemini");
  fs.mkdirSync(gemini);
  const realCli = path.join(os.homedir(), ".gemini", "antigravity-cli");
  const link = path.join(gemini, "antigravity-cli");
  if (fs.existsSync(realCli)) {
    try {
      fs.symlinkSync(realCli, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // The login files stay on the real home. The call can still reach Antigravity.
    }
  }
  fs.writeFileSync(path.join(gemini, "GEMINI.md"), `${SPEAK_RULES}\n\n# Character\n${rules.trim()}\n`, "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
  if (process.platform === "win32") {
    env.HOMEDRIVE = path.win32.parse(home).root.slice(0, 2);
    env.HOMEPATH = home.slice(2);
  }
  return { home, env };
}

function removeSpeakHome(home: string) {
  const link = path.join(home, ".gemini", "antigravity-cli");
  // Unlink the login junction first. A recursive delete must not follow it into the real home.
  for (const rm of [() => fs.unlinkSync(link), () => fs.rmdirSync(link)]) {
    try {
      rm();
    } catch {
      // Already gone, or this removal doesn't apply to a junction.
    }
  }
  try {
    fs.lstatSync(link);
    return;
  } catch {
    // The link is gone.
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // The reply is already in hand. A leftover temp dir is harmless.
  }
}

function speakOnce(bin: string, model: string, rules: string, cue: string, signal: AbortSignal): Promise<AgyPrint> {
  const { home, env } = speakHome(rules);
  const args = ["--output-format", "json", "--sandbox", "--print-timeout", "70s"];
  const modelArg = agyModelName(model);
  if (modelArg) args.push("--model", modelArg);
  args.push("--print", "-");

  return new Promise((resolve, reject) => {
    const child = spawnAgy(bin, args, home, env);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      removeSpeakHome(home);
      fn();
    };
    const onAbort = () => {
      killChild(child);
      const reason = signal.reason;
      done(() => reject(reason instanceof Error ? reason : new Error("The run was stopped.")));
    };
    const timer = setTimeout(() => {
      killChild(child);
      done(() => reject(new Error("Antigravity took too long to answer.")));
    }, SPEAK_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => done(() => reject(err)));
    child.on("exit", (code) => {
      done(() => {
        const parsed = parseAgyPrint(stdout);
        const response = parsed?.response?.trim() ?? "";
        if (parsed && (parsed.status === "SUCCESS" || parsed.status === "" || (parsed.status == null && response))) {
          resolve(parsed);
          return;
        }
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
        reject(new Error(parsed?.error?.trim() || tail || `Antigravity exited ${code ?? "unknown"}`));
      });
    });
    child.stdin?.write(cue, "utf8", (err) => {
      if (err) {
        killChild(child);
        done(() => reject(err));
        return;
      }
      child.stdin?.end();
    });
  });
}

/**
 * One short reply from Antigravity, with no workspace and no Open Dot tools.
 * The character card is the only GEMINI.md, so a user's architect rules are not inherited.
 * Headless mode denies shell commands; if that swallows the line, it asks once more.
 */
export async function agySpeak(opts: { model: string; prompt: string; cue?: string; signal: AbortSignal }): Promise<string> {
  const prompt = opts.prompt.trim();
  const cue = opts.cue?.trim() || "Your turn. Reply with only the spoken line.";
  if (!prompt) throw new Error("Antigravity was asked to speak with an empty prompt.");
  const bin = agyBin();
  if (!bin) throw new Error("agy is not on your PATH.");
  if (opts.signal.aborted) {
    const reason = opts.signal.reason;
    throw reason instanceof Error ? reason : new Error("The run was stopped.");
  }

  const first = await speakOnce(bin, opts.model, prompt, cue, opts.signal);
  const spoken = lineFromPrint(first);
  if (spoken) return spoken;
  if (!first.denied_actions?.length) throw new Error("Antigravity finished without a spoken line.");

  const second = await speakOnce(
    bin,
    opts.model,
    `${prompt}\n\nTools are unavailable. Reply with only the spoken line.`,
    cue,
    opts.signal,
  );
  const again = lineFromPrint(second);
  if (again) return again;
  const denied = second.denied_actions?.[0]?.display_name || first.denied_actions?.[0]?.display_name || "a tool";
  throw new Error(`Antigravity stopped on ${denied} and didn't speak.`);
}

/** Drop the live process for one conversation (a trigger run starts clean, or the model changed). */
export function endAgySession(convId: string) {
  const session = sessions().get(convId);
  if (session) killSession(session);
}

/** Stop every agy process this dot still has open. */
export function endAgyForDot(dotId: string) {
  for (const session of sessions().values()) {
    if (session.dotId === dotId) killSession(session);
  }
}
