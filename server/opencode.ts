import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { McpServer } from "../shared/mcp";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 2500;

type McpStatusMap = Record<string, { status?: string }>;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`opencode HTTP ${response.status} for ${url}`);
    }
    // POST endpoints may answer 204 No Content — no JSON body to parse.
    if (response.status === 204) return {};
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `--port <n>` out of an opencode serve command line. */
function parsePort(cmdline: string): number | null {
  const match = /(?:^|\s)--port[=\s](\d{2,5})(?:\s|$)/.exec(cmdline);
  return match ? Number(match[1]) : null;
}

/** Find ports of every running `opencode serve` process via pgrep, falling back to /proc scanning. */
async function discoverServePorts(): Promise<number[]> {
  const ports = new Set<number>();
  try {
    const { stdout } = await execFileAsync("pgrep", ["-af", "opencode serve"], {
      timeout: 5000,
    });
    for (const line of stdout.split("\n")) {
      const port = parsePort(line);
      if (port) ports.add(port);
    }
  } catch {
    // pgrep unavailable or no match — try /proc below.
  }
  if (ports.size === 0) {
    try {
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          // cmdline is NUL-joined argv; split on the raw separator so tokens
          // ("opencode", "serve") can be matched exactly, not as substrings.
          const raw = readFileSync(join("/proc", pid, "cmdline"), "utf8");
          const tokens = raw.split("\0").filter(Boolean);
          const isOpencode = tokens.some(
            (t) => t === "opencode" || t.endsWith("/opencode"),
          );
          if (!isOpencode || !tokens.includes("serve")) continue;
          const port = parsePort(tokens.join(" "));
          if (port) ports.add(port);
        } catch {
          // process vanished — ignore
        }
      }
    } catch {
      // /proc unavailable — nothing else we can do
    }
  }
  return [...ports];
}

function statusQuery(directory?: string): string {
  if (!directory) return "";
  const normalized = directory.replace(/\/+$/, "");
  if (!normalized) return "";
  return `?directory=${encodeURIComponent(normalized)}`;
}

/**
 * Find the opencode serve instance for this agent and return its /mcp payload.
 * Directory-scoped answers always win over bare answers: scan every port for a
 * successful directory-scoped GET first (return immediately on hit), remembering
 * only the first bare fallback. A later port that honors the directory query must
 * not lose to an earlier port that merely answered the bare GET.
 */
async function queryMcp(directory?: string): Promise<{ port: number; body: McpStatusMap } | null> {
  const ports = await discoverServePorts();
  let any: { port: number; body: McpStatusMap } | null = null;
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}/mcp`;
    const query = statusQuery(directory);
    if (query) {
      try {
        const body = (await fetchJson(base + query)) as McpStatusMap;
        return { port, body }; // scoped success wins outright
      } catch {
        // this instance ignores/rejects the directory query — try bare next
      }
    }
    try {
      const body = (await fetchJson(base)) as McpStatusMap;
      if (!any) any = { port, body };
    } catch {
      // instance not reachable — try the next port
    }
  }
  return any;
}

export async function listServers(directory?: string): Promise<{
  port: number | null;
  servers: McpServer[];
}> {
  const found = await queryMcp(directory);
  if (!found) return { port: null, servers: [] };
  const configFlags = readConfigEnabledFlags(directory);
  const servers = Object.entries(found.body).map(([name, value]) => ({
    name,
    status: value.status ?? "unknown",
    configEnabled: configFlags[name] ?? null,
  }));
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { port: found.port, servers };
}

/**
 * Toggle one MCP server. `persist` writes `enabled` into the defining config;
 * `runtime` connects/disconnects on the live serve instance. Persist runs first:
 * a failed config write must leave runtime state untouched.
 */
export async function setServer(
  directory: string | undefined,
  name: string,
  enable: boolean,
  persist: boolean,
  runtime: boolean,
): Promise<{ port: number | null; servers: McpServer[] }> {
  if (persist) writeConfigEnabled(directory, name, enable);
  if (!runtime) return listServers(directory);
  const found = await queryMcp(directory);
  if (!found) {
    throw new Error("No reachable opencode serve instance found for this agent");
  }
  const action = enable ? "connect" : "disconnect";
  await fetchJson(
    `http://127.0.0.1:${found.port}/mcp/${encodeURIComponent(name)}/${action}${statusQuery(directory)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  return listServers(directory);
}

/** Candidate opencode config files, project scope first (it wins over global in opencode). */
function configCandidates(directory?: string): string[] {
  const candidates: string[] = [];
  if (directory) {
    const normalized = directory.replace(/\/+$/, "");
    if (normalized) {
      candidates.push(join(normalized, "opencode.json"));
      candidates.push(join(normalized, "opencode.jsonc"));
    }
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  candidates.push(join(configHome, "opencode", "opencode.json"));
  candidates.push(join(configHome, "opencode", "opencode.jsonc"));
  return candidates;
}

function readConfigFile(path: string): Record<string, unknown> | null {
  try {
    if (!statSync(path).isFile()) return null;
    const text = readFileSync(path, "utf8");
    const parsed: unknown = parseJsonc(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // unreadable or invalid — treat as absent
  }
  return null;
}

function configMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  const mcp = config.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    return mcp as Record<string, unknown>;
  }
  return {};
}

/** Read the persisted `enabled` flag for every MCP server defined in known configs. */
function readConfigEnabledFlags(directory?: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const path of configCandidates(directory)) {
    const config = readConfigFile(path);
    if (!config) continue;
    for (const [name, raw] of Object.entries(configMcpServers(config))) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const enabled = (raw as Record<string, unknown>).enabled;
        // Candidates are ordered project-first; the first definition wins.
        if (typeof enabled === "boolean" && !Object.hasOwn(flags, name)) flags[name] = enabled;
      }
    }
  }
  return flags;
}

/** Write `mcp.<name>.enabled` into the first config file that defines this server. */
function writeConfigEnabled(directory: string | undefined, name: string, enabled: boolean): void {
  for (const path of configCandidates(directory)) {
    const config = readConfigFile(path);
    if (!config) continue;
    if (!Object.hasOwn(configMcpServers(config), name)) continue;
    const text = readFileSync(path, "utf8");
    const edits = modify(text, ["mcp", name, "enabled"], enabled, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    writeFileSync(path, applyEdits(text, edits));
    return;
  }
  throw new Error(
    `MCP server "${name}" is not defined in any known opencode config — add it to opencode.json first`,
  );
}
