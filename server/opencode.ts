import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import type { McpServer } from "../shared/mcp";

const execFileAsync = promisify(execFile);
const LIST_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 800;
/** Instances are re-scanned at most this often; the client polls every 5s. */
const DISCOVERY_TTL_MS = 2500;

type McpStatusMap = Record<string, { status?: string; error?: string }>;
type ApiVersion = "v1" | "v2";

export interface Instance {
  port: number;
  pid: number | null;
  /** OPENCODE_PASSWORD of the serve process; v2 requires Basic auth, v1 has none. */
  password: string | null;
  agentId: string | null;
  cwd: string | null;
  /** True for `opencode serve --port 0`, the runtime Paseo v2 spawns per agent. */
  ephemeral: boolean;
  version: ApiVersion | null;
}

// ---------------------------------------------------------------------------
// Instance discovery
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init?: RequestInit, timeoutMs = LIST_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function authHeaders(instance: Instance): Record<string, string> {
  if (!instance.password) return {};
  const token = Buffer.from(`opencode:${instance.password}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

/** Parse `--port <n>` out of an opencode serve command line; 0 means ephemeral. */
export function parsePortArg(cmdline: string): number | null {
  const match = /(?:^|\s)--port[=\s](\d{1,5})(?:\s|$)/.exec(cmdline);
  return match ? Number(match[1]) : null;
}

function isOpencodeServe(tokens: string[]): boolean {
  if (!tokens.includes("serve")) return false;
  return tokens.some((token) => basename(token) === "opencode");
}

function readEnviron(pid: number): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(join("/proc", String(pid), "environ"), "utf8");
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    // process vanished or /proc is restricted — env stays empty
  }
  return env;
}

function readCwd(pid: number): string | null {
  try {
    return readlinkSync(join("/proc", String(pid), "cwd"));
  } catch {
    return null;
  }
}

/**
 * Listening TCP ports owned by a pid. Needed for `opencode serve --port 0`,
 * which binds an ephemeral port that never appears on the command line.
 */
function listeningPorts(pid: number): number[] {
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(join("/proc", String(pid), "fd"))) {
      try {
        const target = readlinkSync(join("/proc", String(pid), "fd", fd));
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) inodes.add(match[1]);
      } catch {
        // fd closed between readdir and readlink
      }
    }
  } catch {
    return [];
  }
  if (inodes.size === 0) return [];

  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const [, local, , state, , , , , , inode] = fields;
      if (state !== "0A" || !inodes.has(inode)) continue; // 0A = LISTEN
      const port = Number.parseInt(local.split(":")[1], 16);
      if (Number.isFinite(port)) ports.add(port);
    }
  }
  return [...ports];
}

/** Scan /proc for every running opencode serve process (Linux). */
function scanProc(): Instance[] {
  if (process.platform !== "linux") return [];
  const instances: Instance[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let tokens: string[];
    try {
      tokens = readFileSync(join("/proc", entry, "cmdline"), "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!isOpencodeServe(tokens)) continue;

    const env = readEnviron(pid);
    const portArg = parsePortArg(tokens.join(" "));
    const ports = portArg && portArg > 0 ? [portArg] : listeningPorts(pid);
    for (const port of ports) {
      instances.push({
        port,
        pid,
        password: env.OPENCODE_PASSWORD ?? null,
        agentId: env.PASEO_AGENT_ID ?? null,
        cwd: readCwd(pid),
        ephemeral: portArg === 0,
        version: null,
      });
    }
  }
  return instances;
}

/** Fallback for non-Linux hosts: pgrep + `--port` on the command line. */
async function scanPgrep(): Promise<Instance[]> {
  const ports = new Set<number>();
  try {
    const { stdout } = await execFileAsync("pgrep", ["-af", "opencode serve"], { timeout: 5000 });
    for (const line of stdout.split("\n")) {
      const port = parsePortArg(line);
      if (port && port > 0) ports.add(port);
    }
  } catch {
    // pgrep unavailable or no match
  }
  return [...ports].map((port) => ({
    port,
    pid: null,
    password: null,
    agentId: null,
    cwd: null,
    ephemeral: false,
    version: null,
  }));
}

let discoveryCache: { at: number; instances: Instance[] } | null = null;

async function discoverInstances(): Promise<Instance[]> {
  const now = Date.now();
  if (discoveryCache && now - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.instances;
  const instances = scanProc();
  if (instances.length === 0) instances.push(...(await scanPgrep()));
  const unique = new Map<number, Instance>();
  for (const instance of instances) {
    if (!unique.has(instance.port)) unique.set(instance.port, instance);
  }
  const result = [...unique.values()];
  discoveryCache = { at: now, instances: result };
  return result;
}

// ---------------------------------------------------------------------------
// API calls (v1 + v2)
// ---------------------------------------------------------------------------

function directoryQuery(directory?: string): string {
  if (!directory) return "";
  const normalized = directory.replace(/\/+$/, "");
  if (!normalized) return "";
  return `?directory=${encodeURIComponent(normalized)}`;
}

interface ListResult {
  version: ApiVersion;
  servers: McpServer[];
}

export function normalizeV2Status(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const inner = (status as Record<string, unknown>).status;
    if (typeof inner === "string") return inner;
  }
  return "unknown";
}

/** Failure detail carried next to a v2 status, when the instance reports one. */
export function normalizeV2Error(status: unknown): string | undefined {
  if (!status || typeof status !== "object") return undefined;
  const error = (status as Record<string, unknown>).error;
  return typeof error === "string" && error ? error : undefined;
}

/** GET /api/mcp (v2) — `{ location, data: [{ name, status: { status } }] }`. */
async function listV2(instance: Instance, directory?: string): Promise<McpServer[] | null> {
  try {
    const body = (await fetchJson(
      `http://127.0.0.1:${instance.port}/api/mcp${directoryQuery(directory)}`,
      { headers: authHeaders(instance) },
    )) as { data?: unknown };
    if (!body || !Array.isArray(body.data)) return null;
    const servers: McpServer[] = [];
    for (const raw of body.data) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.name !== "string") continue;
      servers.push({
        name: record.name,
        status: normalizeV2Status(record.status),
        ...(normalizeV2Error(record.status) ? { error: normalizeV2Error(record.status) } : {}),
        configEnabled: null,
      });
    }
    return servers;
  } catch {
    return null;
  }
}

/** GET /mcp (v1) — flat `{ name: { status } }` map. */
async function listV1(instance: Instance, directory?: string): Promise<McpServer[] | null> {
  try {
    const body = (await fetchJson(
      `http://127.0.0.1:${instance.port}/mcp${directoryQuery(directory)}`,
      { headers: authHeaders(instance) },
    )) as McpStatusMap;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return Object.entries(body).map(([name, value]) => ({
      name,
      status: typeof value?.status === "string" ? value.status : "unknown",
      ...(typeof value?.error === "string" && value.error ? { error: value.error } : {}),
      configEnabled: null,
    }));
  } catch {
    return null;
  }
}

/** Try v2 first, then v1; remembers the version that answered. */
export async function listFromInstance(instance: Instance, directory?: string): Promise<ListResult | null> {
  const v2 = await listV2(instance, directory);
  if (v2) {
    instance.version = "v2";
    return { version: "v2", servers: v2 };
  }
  const v1 = await listV1(instance, directory);
  if (v1) {
    instance.version = "v1";
    return { version: "v1", servers: v1 };
  }
  return null;
}

/** Does this instance know the session the agent runs on? Proves ownership. */
async function ownsSession(instance: Instance, sessionId: string): Promise<boolean> {
  const paths =
    instance.version === "v1"
      ? [`/session/${encodeURIComponent(sessionId)}`]
      : [`/api/session/${encodeURIComponent(sessionId)}`, `/session/${encodeURIComponent(sessionId)}`];
  for (const path of paths) {
    try {
      await fetchJson(`http://127.0.0.1:${instance.port}${path}`, { headers: authHeaders(instance) }, PROBE_TIMEOUT_MS);
      return true;
    } catch {
      // wrong version or wrong instance — try the next path
    }
  }
  return false;
}

interface Target {
  instance: Instance;
  version: ApiVersion;
  servers: McpServer[];
}

/**
 * Pick the instance serving this agent. A candidate that answers for the
 * agent's session wins outright; otherwise prefer the ephemeral runtime Paseo
 * spawned, then a cwd match, then the first instance that lists MCP servers.
 */
async function resolveTarget(directory?: string, sessionId?: string): Promise<Target | null> {
  const instances = await discoverInstances();
  const listed: Target[] = [];
  for (const instance of instances) {
    const result = await listFromInstance(instance, directory);
    if (result) listed.push({ instance, version: result.version, servers: result.servers });
  }
  if (listed.length === 0) return null;
  if (listed.length === 1) return listed[0];

  if (sessionId) {
    for (const target of listed) {
      if (await ownsSession(target.instance, sessionId)) return target;
    }
  }
  const normalized = directory?.replace(/\/+$/, "");
  const byCwd = normalized ? listed.find((target) => target.instance.cwd === normalized) : undefined;
  if (byCwd) return byCwd;
  const ephemeral = listed.find((target) => target.instance.ephemeral);
  return ephemeral ?? listed[0];
}

export async function listServers(
  directory?: string,
  sessionId?: string,
): Promise<{ port: number | null; servers: McpServer[] }> {
  const target = await resolveTarget(directory, sessionId);
  if (!target) return { port: null, servers: [] };
  const configFlags = readConfigEnabledFlags(directory);
  const servers = target.servers
    .map((server) => ({ ...server, configEnabled: configFlags[server.name] ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { port: target.instance.port, servers };
}

/** POST connect/disconnect for one server on one instance (v1 or v2 path). */
export async function postToggle(
  instance: Instance,
  version: ApiVersion,
  directory: string | undefined,
  name: string,
  enable: boolean,
): Promise<void> {
  const action = enable ? "connect" : "disconnect";
  const path =
    version === "v2"
      ? `/api/experimental/mcp/${encodeURIComponent(name)}/${action}${directoryQuery(directory)}`
      : `/mcp/${encodeURIComponent(name)}/${action}${directoryQuery(directory)}`;
  await fetchJson(`http://127.0.0.1:${instance.port}${path}`, {
    method: "POST",
    headers: { ...authHeaders(instance), "content-type": "application/json" },
    body: "{}",
  });
}

/**
 * Toggle one MCP server. `persist` writes the flag into the defining config
 * (v2: `disabled`, v1: `enabled`); `runtime` connects/disconnects on the live
 * serve instance. Persist runs first: a failed config write must leave runtime
 * state untouched.
 */
export async function setServer(
  directory: string | undefined,
  name: string,
  enable: boolean,
  persist: boolean,
  runtime: boolean,
  sessionId?: string,
): Promise<{ port: number | null; servers: McpServer[] }> {
  if (persist) writeConfigEnabled(directory, name, enable);
  if (!runtime) return listServers(directory, sessionId);

  const target = await resolveTarget(directory, sessionId);
  if (!target) {
    throw new Error("No reachable opencode serve instance found for this agent");
  }
  await postToggle(target.instance, target.version, directory, name, enable);
  return listServers(directory, sessionId);
}

// ---------------------------------------------------------------------------
// Config read/write (v1 and v2 shapes)
// ---------------------------------------------------------------------------

/** Candidate opencode config files, project scope first (it wins over global). */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * MCP server map of one config file. v2 nests servers under `mcp.servers` and
 * uses `disabled`; v1 lists them directly under `mcp` and uses `enabled`.
 */
export function mcpServersOf(config: Record<string, unknown>): {
  version: ApiVersion;
  servers: Record<string, unknown>;
} | null {
  const mcp = config.mcp;
  if (!isRecord(mcp)) return null;
  if (isRecord(mcp.servers)) return { version: "v2", servers: mcp.servers };
  return { version: "v1", servers: mcp };
}

/** Effective persisted enabled flag of one server entry; absent flag = enabled. */
function enabledOf(version: ApiVersion, raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  if (version === "v2") {
    const disabled = raw.disabled;
    return typeof disabled === "boolean" ? !disabled : true;
  }
  const enabled = raw.enabled;
  return typeof enabled === "boolean" ? enabled : true;
}

/** Read the persisted `enabled` flag for every MCP server defined in known configs. */
export function readConfigEnabledFlags(directory?: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const path of configCandidates(directory)) {
    const config = readConfigFile(path);
    if (!config) continue;
    const shape = mcpServersOf(config);
    if (!shape) continue;
    for (const [name, raw] of Object.entries(shape.servers)) {
      const enabled = enabledOf(shape.version, raw);
      // Candidates are ordered project-first; the first definition wins.
      if (enabled !== null && !Object.hasOwn(flags, name)) flags[name] = enabled;
    }
  }
  return flags;
}

/** Write the enabled flag into the first config file that defines this server. */
export function writeConfigEnabled(directory: string | undefined, name: string, enabled: boolean): void {
  for (const path of configCandidates(directory)) {
    const config = readConfigFile(path);
    if (!config) continue;
    const shape = mcpServersOf(config);
    if (!shape || !Object.hasOwn(shape.servers, name)) continue;
    const text = readFileSync(path, "utf8");
    const keyPath = shape.version === "v2" ? ["mcp", "servers", name, "disabled"] : ["mcp", name, "enabled"];
    const value = shape.version === "v2" ? !enabled : enabled;
    const edits = modify(text, keyPath, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    writeFileSync(path, applyEdits(text, edits));
    return;
  }
  throw new Error(
    `MCP server "${name}" is not defined in any known opencode config — add it to opencode.json first`,
  );
}
