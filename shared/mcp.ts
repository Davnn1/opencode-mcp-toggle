import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const mcpServerSchema = z.object({
  name: z.string(),
  /** Runtime status reported by the opencode serve instance. */
  status: z.string(),
  /** `enabled` flag in the defining opencode.json(c), null when not defined in any known config. */
  configEnabled: z.boolean().nullable(),
});

export const listMcp = defineRpc({
  name: "opencode-mcp-toggle.list",
  input: z.object({
    /** Agent id; the daemon resolves this agent's cwd server-side. Never a client path. */
    agentId: z.string().min(1),
  }),
  output: z.object({
    /** Port of the opencode serve instance serving this agent, null when none was found. */
    port: z.number().nullable(),
    servers: z.array(mcpServerSchema),
  }),
});

export const setMcp = defineRpc({
  name: "opencode-mcp-toggle.set",
  input: z.object({
    /** Agent id; the daemon resolves this agent's cwd server-side. Never a client path. */
    agentId: z.string().min(1),
    name: z.string(),
    enable: z.boolean(),
    /** Write `enabled` to the opencode.json(c) that defines this server. */
    persist: z.boolean(),
    /** Apply connect/disconnect to the live opencode serve instance. */
    runtime: z.boolean(),
  }),
  output: z.object({
    port: z.number().nullable(),
    servers: z.array(mcpServerSchema),
  }),
});

export type McpServer = z.infer<typeof mcpServerSchema>;
