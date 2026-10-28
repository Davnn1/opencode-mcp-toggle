import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listFromInstance,
  mcpServersOf,
  normalizeV2Status,
  parsePortArg,
  postToggle,
  readConfigEnabledFlags,
  writeConfigEnabled,
  type Instance,
} from "../server/opencode";
import { isServerEnabled } from "../shared/mcp";

function instance(port: number, password: string | null = "secret"): Instance {
  return {
    port,
    pid: null,
    password,
    agentId: null,
    cwd: null,
    ephemeral: true,
    version: null,
  };
}

interface Fake {
  port: number;
  requests: { method: string; url: string; authorization?: string }[];
  close: () => Promise<void>;
}

async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fake> {
  const requests: Fake["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("parsePortArg handles ephemeral and explicit ports", () => {
  assert.equal(parsePortArg("opencode serve --hostname 127.0.0.1 --port 0"), 0);
  assert.equal(parsePortArg("opencode serve --port=40045"), 40045);
  assert.equal(parsePortArg("opencode serve"), null);
});

test("normalizeV2Status unwraps the v2 status object", () => {
  assert.equal(normalizeV2Status({ status: "connected" }), "connected");
  assert.equal(normalizeV2Status({ status: "failed", error: "boom" }), "failed");
  assert.equal(normalizeV2Status("disabled"), "disabled");
  assert.equal(normalizeV2Status(undefined), "unknown");
});

test("listFromInstance: v2 endpoint shape and Basic auth", async () => {
  const fake = await fakeServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/mcp")) {
      return json(res, 200, {
        location: { directory: "/home/user/project" },
        data: [
          { name: "figma", status: { status: "connected" } },
          { name: "postman", status: { status: "failed", error: "boom" } },
          { name: "stitch", status: { status: "disabled" }, integrationID: "x" },
        ],
      });
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const result = await listFromInstance(instance(fake.port), "/home/user/project");
    assert.equal(result?.version, "v2");
    assert.deepEqual(result?.servers.map((server) => [server.name, server.status]), [
      ["figma", "connected"],
      ["postman", "failed"],
      ["stitch", "disabled"],
    ]);
    const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    assert.equal(fake.requests[0].authorization, expected);
    assert.match(fake.requests[0].url, /directory=%2Fhome%2Fuser%2Fproject/);
  } finally {
    await fake.close();
  }
});

test("listFromInstance: falls back to the v1 flat map", async () => {
  const fake = await fakeServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/mcp")) {
      return json(res, 200, {
        figma: { status: "connected" },
        postman: { status: "disabled" },
      });
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const instanceV1 = instance(fake.port, null);
    const result = await listFromInstance(instanceV1, "/home/user/project");
    assert.equal(result?.version, "v1");
    assert.deepEqual(result?.servers.map((server) => [server.name, server.status]), [
      ["figma", "connected"],
      ["postman", "disabled"],
    ]);
    assert.equal(fake.requests[0].authorization, undefined);
  } finally {
    await fake.close();
  }
});

test("postToggle hits the v2 experimental route with the action", async () => {
  const fake = await fakeServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const target = instance(fake.port);
    await postToggle(target, "v2", "/home/user/project", "figma", false);
    assert.equal(fake.requests[0].method, "POST");
    assert.match(fake.requests[0].url, /^\/api\/experimental\/mcp\/figma\/disconnect\?directory=/);
  } finally {
    await fake.close();
  }
});

test("postToggle hits the v1 route with the action", async () => {
  const fake = await fakeServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    await postToggle(instance(fake.port, null), "v1", undefined, "figma", true);
    assert.equal(fake.requests[0].url, "/mcp/figma/connect");
  } finally {
    await fake.close();
  }
});

test("mcpServersOf detects the v2 and v1 config shapes", () => {
  const v2 = mcpServersOf({ mcp: { servers: { figma: { disabled: true } } } });
  assert.equal(v2?.version, "v2");
  assert.deepEqual(Object.keys(v2?.servers ?? {}), ["figma"]);

  const v1 = mcpServersOf({ mcp: { figma: { enabled: false } } });
  assert.equal(v1?.version, "v1");
  assert.deepEqual(Object.keys(v1?.servers ?? {}), ["figma"]);

  assert.equal(mcpServersOf({}), null);
});

function withConfig(file: string, content: string): { path: string; restore: () => void } {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
  mkdirSync(join(dir, "opencode"), { recursive: true });
  const path = join(dir, "opencode", file);
  writeFileSync(path, content);
  process.env.XDG_CONFIG_HOME = dir;
  return {
    path,
    restore: () => {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    },
  };
}

test("config: v2 reads `disabled` as the inverse enabled flag", () => {
  const config = withConfig(
    "opencode.jsonc",
    `{
  // v2 shape
  "mcp": {
    "servers": {
      "figma": { "type": "local", "disabled": true },
      "stitch": { "type": "remote", "url": "https://example.test/mcp" }
    }
  }
}`,
  );
  try {
    const flags = readConfigEnabledFlags(undefined);
    assert.equal(flags.figma, false);
    assert.equal(flags.stitch, true); // absent `disabled` keeps the v2 default (enabled)
    assert.equal(Object.hasOwn(flags, "missing"), false);
  } finally {
    config.restore();
  }
});

test("config: v2 writes `disabled` without touching other fields", () => {
  const config = withConfig(
    "opencode.json",
    `{
  "mcp": {
    "servers": {
      "figma": { "type": "local", "command": ["npx", "figma"], "disabled": false }
    }
  }
}`,
  );
  try {
    writeConfigEnabled(undefined, "figma", false);
    const parsed = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(parsed.mcp.servers.figma.disabled, true);
    assert.deepEqual(parsed.mcp.servers.figma.command, ["npx", "figma"]);
    assert.equal(readConfigEnabledFlags(undefined).figma, false);
  } finally {
    config.restore();
  }
});

test("config: v1 writes `enabled` under mcp directly", () => {
  const config = withConfig(
    "opencode.json",
    `{
  "mcp": {
    "figma": { "type": "local", "command": ["npx", "figma"], "enabled": false }
  }
}`,
  );
  try {
    writeConfigEnabled(undefined, "figma", true);
    const parsed = JSON.parse(readFileSync(config.path, "utf8"));
    assert.equal(parsed.mcp.figma.enabled, true);
    assert.equal(parsed.mcp.servers, undefined);
    assert.equal(readConfigEnabledFlags(undefined).figma, true);
  } finally {
    config.restore();
  }
});

test("config: unknown server is reported instead of silently written", () => {
  const config = withConfig("opencode.json", `{"mcp":{"servers":{"figma":{"disabled":true}}}}`);
  try {
    assert.throws(() => writeConfigEnabled(undefined, "postman", true), /not defined/);
  } finally {
    config.restore();
  }
});

test("isServerEnabled: only the disabled status means off", () => {
  for (const status of [
    "connected",
    "connecting",
    "pending",
    "starting",
    "failed",
    "needs_auth",
    "error",
  ]) {
    assert.equal(isServerEnabled({ status }), true, `${status} should read as enabled`);
  }
  assert.equal(isServerEnabled({ status: "disabled" }), false);
});
