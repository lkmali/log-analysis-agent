import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@/backend/scheduler/logger";
import { anthropic } from "./client";

type SessionEvent =
  | Anthropic.Beta.Sessions.Events.BetaManagedAgentsSessionEvent
  | Anthropic.Beta.Sessions.Events.BetaManagedAgentsStreamSessionEvents;
type CreateParams = Anthropic.Beta.Sessions.SessionCreateParams;

/** A host-side tool handler. Its return value is sent back to the agent as the tool result. */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

export class ToolError extends Error {}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionResult {
  sessionId: string;
  /** end_turn | retries_exhausted | budget_reached | refusal | terminated | timeout | error */
  outcome: string;
  usage: SessionUsage;
  /** Concatenated agent.message text, for logs and debugging. */
  transcript: string;
  error?: string;
}

/** Decision for an MCP tool call that paused for approval (always_ask). */
export type McpDecision = { allow: true } | { allow: false; reason: string };
export type McpPolicy = (call: { server: string; name: string; input: Record<string, unknown> }) => McpDecision;

export interface RunSessionOptions {
  create: CreateParams;
  tools: Record<string, ToolHandler>;
  /** Approves or denies MCP tool calls that pause for confirmation. Without it every such call is denied. */
  mcpPolicy?: McpPolicy;
  log: Logger;
  timeoutMinutes: number;
  consoleWorkspace: string;
  apiKey: string | undefined;
}

const MAX_RECONNECTS = 5;

/**
 * Runs one Managed Agents session to completion:
 *  - kicks off via `initial_events` on create;
 *  - answers `agent.custom_tool_use` by running the host-side handler;
 *  - answers MCP calls that pause for approval with `mcpPolicy`, and denies any other paused call;
 *  - reconnects losslessly (history replay + dedupe) if the SSE stream drops;
 *  - stops on a terminal idle, termination, or the wall-clock timeout (interrupts the agent).
 */
export async function runAgentSession(opts: RunSessionOptions): Promise<SessionResult> {
  const client = anthropic(opts.apiKey);
  const { log } = opts;
  const session = await client.beta.sessions.create(opts.create);
  log.info("agent session started", {
    sessionId: session.id,
    trace: `https://platform.claude.com/workspaces/${opts.consoleWorkspace}/sessions/${session.id}`,
  });

  const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const seen = new Set<string>();
  const answered = new Set<string>(); // custom tool uses / confirmations we already responded to
  const transcript: string[] = [];
  let outcome: string | undefined;
  let error: string | undefined;

  const deadline = Date.now() + opts.timeoutMinutes * 60_000;
  let interrupted = false;
  const timer = setInterval(() => {
    if (Date.now() < deadline || interrupted) return;
    interrupted = true;
    log.warn("agent session timed out; interrupting", { sessionId: session.id });
    client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] }).catch(() => {});
  }, 5_000);

  const send = (events: Anthropic.Beta.Sessions.Events.EventSendParams["events"]) =>
    client.beta.sessions.events.send(session.id, { events });

  async function handle(event: SessionEvent) {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) if (block.type === "text") transcript.push(block.text);
        break;
      case "span.model_request_end":
        usage.inputTokens += event.model_usage.input_tokens;
        usage.outputTokens += event.model_usage.output_tokens;
        usage.cacheReadTokens += event.model_usage.cache_read_input_tokens;
        usage.cacheWriteTokens += event.model_usage.cache_creation_input_tokens;
        break;
      // Our own responses echoed back (also present in history after a reconnect).
      case "user.custom_tool_result":
        answered.add(event.custom_tool_use_id);
        break;
      case "user.tool_confirmation":
        answered.add(event.tool_use_id);
        break;
      case "agent.custom_tool_use": {
        if (answered.has(event.id)) break;
        answered.add(event.id);
        const handler = opts.tools[event.name];
        let text: string;
        let isError = false;
        try {
          if (!handler) throw new ToolError(`Unknown tool: ${event.name}`);
          text = await handler(event.input);
        } catch (err) {
          isError = true;
          text = err instanceof ToolError ? err.message : "The tool failed on the server. Try a different approach.";
          if (!(err instanceof ToolError)) log.error("agent tool failed", { tool: event.name, error: String(err) });
        }
        log.debug("agent tool call", { tool: event.name, isError });
        await send([
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text }],
            ...(isError ? { is_error: true } : {}),
          },
        ]);
        break;
      }
      case "agent.mcp_tool_use":
        if (event.evaluated_permission === "ask" && !answered.has(event.id)) {
          answered.add(event.id);
          const decision: McpDecision = opts.mcpPolicy
            ? opts.mcpPolicy({ server: event.mcp_server_name, name: event.name, input: event.input })
            : { allow: false, reason: "This run is unattended, so calls that need approval are denied. Find another way." };
          log.info("mcp tool call", { server: event.mcp_server_name, tool: event.name, allowed: decision.allow });
          await send([
            decision.allow
              ? { type: "user.tool_confirmation", tool_use_id: event.id, result: "allow" }
              : { type: "user.tool_confirmation", tool_use_id: event.id, result: "deny", deny_message: decision.reason },
          ]);
        }
        break;
      case "agent.tool_use":
        if (event.evaluated_permission === "ask" && !answered.has(event.id)) {
          answered.add(event.id);
          await send([
            {
              type: "user.tool_confirmation",
              tool_use_id: event.id,
              result: "deny",
              deny_message: "This run is unattended, so calls that need approval are denied. Find another way.",
            },
          ]);
        }
        break;
      case "session.error":
        log.warn("agent session error event", { sessionId: session.id, event: JSON.stringify(event).slice(0, 500) });
        break;
    }
  }

  /** Returns true when the session reached a state where we stop listening. */
  function isTerminal(event: SessionEvent): boolean {
    if (event.type === "session.status_terminated") {
      outcome ??= "terminated";
      return true;
    }
    if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") {
      outcome = interrupted ? "timeout" : event.stop_reason.type;
      return true;
    }
    return false;
  }

  try {
    for (let attempt = 0; attempt <= MAX_RECONNECTS && !outcome; attempt++) {
      try {
        // Open the stream first, then replay history, then tail (lossless reconnect).
        const stream = await client.beta.sessions.events.stream(session.id);
        let done = false;
        for await (const event of client.beta.sessions.events.list(session.id)) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          await handle(event);
          if (isTerminal(event)) done = true;
        }
        if (done) break;
        for await (const event of stream) {
          if (!("id" in event) || typeof event.id !== "string") continue; // delta preview events
          if (!seen.has(event.id)) {
            seen.add(event.id);
            await handle(event);
          }
          if (isTerminal(event)) break;
        }
        if (!outcome) log.warn("agent stream ended early; reconnecting", { sessionId: session.id });
      } catch (err) {
        if (err instanceof Anthropic.APIError && err.status && err.status < 500 && err.status !== 429) throw err;
        log.warn("agent stream dropped; reconnecting", { sessionId: session.id, error: String(err) });
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      }
    }
    outcome ??= "error";
    if (outcome === "error") error = "lost connection to the agent session";
  } catch (err) {
    outcome = "error";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(timer);
  }

  log.info("agent session finished", { sessionId: session.id, outcome, ...usage });
  return { sessionId: session.id, outcome, usage, transcript: transcript.join("\n").slice(-20_000), error };
}

/** List-price estimate for model_usage_events (Opus 5.5: $4 in / $20 out / $0.20 cache read / $5 cache write per MTok). */
export function estimateCostUsd(u: SessionUsage): number {
  return (u.inputTokens * 4 + u.outputTokens * 20 + u.cacheReadTokens * 0.2 + u.cacheWriteTokens * 5) / 1_000_000;
}
