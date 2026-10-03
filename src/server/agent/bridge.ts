import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../db";
import { workspaceDir } from "../computer/shell";

// The MCP server and its token stay in the dot workspace. Headless agy still
// refuses every MCP call unless this allow rule is in the CLI settings file,
// because print mode cannot show the Ask prompt. The rule names the server only.

const HOOK_TIMEOUT_SEC = 900;

function tokenPath(dotId: string): string {
  return path.join(DATA_DIR, "dots", dotId, "bridge.token");
}

export function bridgeToken(dotId: string): string {
  const file = tokenPath(dotId);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function bridgeAuthOk(dotId: string, req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const expected = bridgeToken(dotId);
  if (!got || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Base URL agy's hook and MCP client can reach on this machine. */
export function bridgeOrigin(): string {
  const raw = process.env.DOTS_PUBLIC_URL ?? `http://127.0.0.1:${process.env.OPEN_DOT_PORT || process.env.PORT || 3100}`;
  const url = new URL(raw);
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

function hookSource(url: string, token: string): string {
  return `// Open Dot asks before agy runs a command, opens a URL, or writes outside this workspace.
const url = ${JSON.stringify(url)};
const token = ${JSON.stringify(token)};
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: raw || "{}",
  });
  const text = (await res.text()).trim();
  process.stdout.write(text || JSON.stringify({ decision: "deny", reason: "Open Dot returned an empty decision." }));
} catch {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "Open Dot is not reachable, so this action was blocked." }));
}
process.exitCode = 0;
`;
}

function hookRuntime(): string {
  return /(?:node|bun)(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
}

/**
 * Command agy passes to `cmd /c`. It must not contain quotes: agy wraps the string again,
 * and the extra quotes become part of the program name, so the hook never starts.
 * The launcher lives on a path without spaces and invokes Node with the real paths inside the file.
 */
function hookCommand(dotId: string, script: string): string {
  const runtime = hookRuntime();
  if (process.platform !== "win32") return `${quote(runtime)} ${quote(script)}`;
  const dir = path.join(process.env.LOCALAPPDATA || process.env.TEMP || DATA_DIR, "open-dot", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, `${dotId}.cmd`);
  fs.writeFileSync(launcher, `@echo off\r\n${quote(runtime)} ${quote(script)}\r\n`, "utf8");
  if (/[\s"]/.test(launcher)) return `${quote(runtime)} ${quote(script)}`;
  return launcher;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Plugin folder and MCP server key. agy exposes the server as `${plugin}_${server}`. */
export const AGY_PLUGIN = "open-dot";
export const AGY_MCP_ALLOW = `mcp(${AGY_PLUGIN}_${AGY_PLUGIN}/*)`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return null;
  }
}

function withAllow(allow: unknown): { allow: string[]; changed: boolean } {
  const rules = Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string") : [];
  const kept = rules.filter((rule) => rule !== "mcp(open-dot/*)" && rule !== "mcp(*)");
  const next = kept.includes(AGY_MCP_ALLOW) ? kept : [...kept, AGY_MCP_ALLOW];
  const changed = next.length !== rules.length || next.some((rule, index) => rule !== rules[index]);
  return { allow: next, changed };
}

/**
 * Print mode cannot ask, so an MCP call is auto-denied unless this grant is already stored.
 * An empty CLI project then clears the global allow list, so both files have to carry the rule.
 * agy names the plugin server `open-dot_open-dot`, not `open-dot`.
 */
function ensureCliMcpAllow(): boolean {
  const home = path.join(os.homedir(), ".gemini");
  const settingsFile = path.join(home, "antigravity-cli", "settings.json");
  const projectFile = path.join(home, "config", "projects", "default-cli-project.json");
  let changed = false;

  const settings = readJson(settingsFile);
  if (settings) {
    const permissions = { ...(asRecord(settings.permissions) ?? {}) };
    const next = withAllow(permissions.allow);
    if (next.changed) {
      permissions.allow = next.allow;
      settings.permissions = permissions;
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      changed = true;
    }
  }

  const project = readJson(projectFile);
  if (project) {
    const grants = { ...(asRecord(project.permissionGrants) ?? {}) };
    const inner = { ...(asRecord(grants.permissionGrants) ?? {}) };
    const next = withAllow(inner.allow);
    if (next.changed || grants.v2Migrated !== true) {
      inner.allow = next.allow;
      grants.permissionGrants = inner;
      grants.v2Migrated = true;
      project.permissionGrants = grants;
      if (!project.id) project.id = "default-cli-project";
      if (!project.name) project.name = "CLI Project";
      fs.mkdirSync(path.dirname(projectFile), { recursive: true });
      fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, "utf8");
      changed = true;
    }
  }

  return changed;
}

function writeText(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return true;
}

/**
 * Write `.agents/` into the dot workspace so this agy process, and not the user's global agy, sees the tools and the hook.
 * agy 1.2 loads MCP servers from a plugin under `.agents/plugins/`, not from `.agents/mcp_config.json`.
 * Returns true when a file changed, so the caller can restart a process that already started without the plugin.
 */
export function ensureAgyBridge(dotId: string): boolean {
  const allowChanged = ensureCliMcpAllow();
  const root = workspaceDir(dotId);
  const dir = path.join(root, ".agents");
  fs.mkdirSync(dir, { recursive: true });
  const token = bridgeToken(dotId);
  const origin = bridgeOrigin();
  const mcpUrl = `${origin}/api/dots/${encodeURIComponent(dotId)}/mcp`;
  const script = path.join(dir, "pretool-hook.mjs");
  const plugin = path.join(dir, "plugins", AGY_PLUGIN);
  let changed = writeText(script, hookSource(`${origin}/api/dots/${encodeURIComponent(dotId)}/hook`, token));
  changed = writeText(path.join(plugin, "plugin.json"), `${JSON.stringify({ name: AGY_PLUGIN }, null, 2)}\n`) || changed;
  changed =
    writeText(
      path.join(plugin, "mcp_config.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            [AGY_PLUGIN]: {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      )}\n`,
    ) || changed;
  changed =
    writeText(
      path.join(plugin, "rules", "AGENTS.md"),
      [
        "# The user's apps",
        "ClickUp and the user's other apps are tools on the open-dot MCP server in this workspace.",
        "Find the action with COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL.",
        "If the app is not connected, call app_connect with the toolkit slug.",
        "Search before you conclude an app is missing. There is no separate ClickUp plugin and no composio CLI in this dot.",
        "",
      ].join("\n"),
    ) || changed;
  const hooks = {
    "open-dot-gate": {
      PreToolUse: [
        {
          // MCP tool names are allowed here so agy doesn't prompt in the terminal. The MCP handler still applies rules and cards.
          matcher: "run_command|read_url_content|search_web|write_to_file|replace_file_content|multi_replace_file_content|call_mcp_tool|mcp_tool|open_url|read_page|click|type_text|sign_in|remember|forget|create_routine|delete_routine|send_update|share_file|message_dot|ask_user|app_connect|COMPOSIO_.*",
          hooks: [{ type: "command", command: hookCommand(dotId, script), timeout: HOOK_TIMEOUT_SEC }],
        },
      ],
    },
  };
  changed = writeText(path.join(dir, "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`) || changed;
  const stale = path.join(dir, "mcp_config.json");
  if (fs.existsSync(stale)) {
    fs.rmSync(stale);
    changed = true;
  }
  return changed || allowChanged;
}
