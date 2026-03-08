/**
 * AgentVox message handlers.
 *
 * Routes incoming protocol messages to the appropriate session bridge operations:
 *   - message → run openclaw agent pipeline, return response
 *   - get_session_context → read transcript + config, return context
 *   - message.append → append directly to transcript (no agent run)
 *   - tool_execute → execute tool from openclaw's registry
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { AgentVoxConfig } from "./config.js";
import type {
  AgentVoxMessage,
  ClientContext,
  GetSessionContextPayload,
  InboundMessagePayload,
  MessageAppendPayload,
  ResetSessionPayload,
  ToolExecutePayload,
} from "./protocol.js";
import { MSG } from "./protocol.js";
import {
  appendToTranscript,
  clearSessionIdCache,
  readTranscriptMessages,
  resolveSessionInfo,
  resolveTargetSessionKey,
} from "./session-bridge.js";
import { stripInboundMetadata, stripSystemLines } from "./strip-inbound-meta.js";
import { buildMessage, type AgentVoxWsClient } from "./ws-client.js";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type HandlerContext = {
  config: AgentVoxConfig;
  client: AgentVoxWsClient;
  logger: Logger;
  runtime: PluginRuntime;
  /** Collect tool names from the plugin's tool registry. */
  getToolNames: () => string[];
};

// ---------------------------------------------------------------------------
// Client context → USER.md
// ---------------------------------------------------------------------------

/**
 * Tracks the last-seen client context so we can detect field-level changes
 * between successive `get_session_context` requests and only rewrite USER.md
 * when something actually changed.
 */
let lastClientContext: ClientContext | null = null;

/** Managed-section markers inside USER.md. */
const CTX_START = "<!-- agentvox:client-context:start -->";
const CTX_END = "<!-- agentvox:client-context:end -->";

/**
 * Resolve the agent workspace directory (mirrors core `resolveAgentWorkspaceDir`
 * for the common case without pulling in all of core).
 */
function resolveWorkspaceDir(config: AgentVoxConfig): string {
  const home = process.env.OPENCLAW_HOME?.trim() || process.env.HOME || "~";
  const openclawDir = path.join(home, ".openclaw");

  // If a non-default agent has a custom workspace configured we'd need to read
  // config.json – but for the typical case the default workspace is fine.
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(openclawDir, `workspace-${profile}`);
  }
  return path.join(openclawDir, "workspace");
}

/**
 * Build the markdown content for the managed client-context section.
 */
function buildClientContextSection(ctx: ClientContext): string {
  const lines: string[] = [
    CTX_START,
    "## Client Device Context",
    "",
    "_Auto-updated by AgentVox when the user's device context changes._",
    "",
  ];

  if (ctx.location) {
    lines.push(`- **Location:** ${ctx.location.value}`);
  }
  if (ctx.device) {
    lines.push(`- **Device:** ${ctx.device.name} (${ctx.device.osVersion})`);
  }
  if (ctx.inputMode) {
    const mode = ctx.inputMode === "voice" ? "voice input" : "text input";
    lines.push(`- **Input mode:** ${mode}`);
  }
  if (ctx.timezone) {
    lines.push(`- **Timezone:** ${ctx.timezone}`);
  }

  lines.push(CTX_END);
  return lines.join("\n");
}

/**
 * Compare current client context with the previous one and return whether
 * anything relevant changed.
 */
function hasContextChanged(prev: ClientContext | null, curr: ClientContext): boolean {
  if (!prev) return true;
  return (
    JSON.stringify(prev.location) !== JSON.stringify(curr.location) ||
    JSON.stringify(prev.device) !== JSON.stringify(curr.device) ||
    prev.inputMode !== curr.inputMode ||
    prev.timezone !== curr.timezone
  );
}

/**
 * Write (or update) the managed client-context section in USER.md.
 *
 * If USER.md already contains the managed markers we replace only that region;
 * otherwise we append the section at the end of the file.
 */
function writeClientContextToUserMd(
  workspaceDir: string,
  clientContext: ClientContext,
  logger: Logger,
): void {
  const userMdPath = path.join(workspaceDir, "USER.md");
  const section = buildClientContextSection(clientContext);

  let existing = "";
  try {
    existing = fs.readFileSync(userMdPath, "utf-8");
  } catch {
    // File doesn't exist yet – we'll create it
  }

  const startIdx = existing.indexOf(CTX_START);
  const endIdx = existing.indexOf(CTX_END);

  let updated: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing managed section
    updated = existing.slice(0, startIdx) + section + existing.slice(endIdx + CTX_END.length);
  } else {
    // Append (with a blank line separator if the file has content)
    const sep = existing.trim() ? "\n\n" : "";
    updated = existing + sep + section + "\n";
  }

  fs.mkdirSync(path.dirname(userMdPath), { recursive: true });
  fs.writeFileSync(userMdPath, updated, "utf-8");
  logger.info(`[agentvox] Updated USER.md client context at ${userMdPath}`);
}

/**
 * Create the main message handler that routes all incoming AgentVox messages.
 */
export function createMessageHandler(ctx: HandlerContext) {
  return async (msg: AgentVoxMessage) => {
    switch (msg.type) {
      case MSG.MESSAGE:
        await handleMessage(ctx, msg);
        break;
      case MSG.GET_SESSION_CONTEXT:
        handleGetSessionContext(ctx, msg);
        break;
      case MSG.MESSAGE_APPEND:
        handleMessageAppend(ctx, msg);
        break;
      case MSG.TOOL_EXECUTE:
        await handleToolExecute(ctx, msg);
        break;
      case MSG.RESET_SESSION:
        await handleResetSession(ctx, msg);
        break;
      case MSG.CANVAS_PROXY_REQUEST:
        await handleCanvasProxyRequest(ctx, msg);
        break;
      case MSG.CANVAS_CONTROL:
        handleCanvasControl(ctx, msg);
        break;
      case MSG.WORKSPACE_REQUEST:
        await handleWorkspaceRequest(ctx, msg);
        break;
      default:
        ctx.logger.warn(
          `[agentvox] Unhandled message type: ${msg.type}, full message:`,
          JSON.stringify(msg, null, 2),
        );
    }
  };
}

/**
 * Handle `message` — user sent a message via AgentVox.
 * Routes through openclaw's agent pipeline (same as chat.send).
 * In host mode, payload.agentId is the host-local agent ID to route to.
 */
async function handleMessage(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as unknown as InboundMessagePayload & { agentId?: string };
  if (!payload?.message || !payload?.messageId) {
    ctx.logger.warn("[agentvox] Invalid message payload");
    return;
  }

  // In host mode, use the agentId from the payload to route to the right session
  const targetAgentId = payload.agentId || ctx.config.agentId || "main";
  const sessionKey = resolveTargetSessionKey(ctx.config, targetAgentId);
  ctx.logger.info(
    `[agentvox] Received message: "${payload.message.slice(0, 80)}..." → session ${sessionKey}`,
  );
  // Log payload summary (omit large base64 data from media attachments)
  const payloadSummary = { ...payload };
  if (payloadSummary.mediaAttachments) {
    payloadSummary.mediaAttachments = (payloadSummary.mediaAttachments as any[]).map((a: any) => ({
      ...a,
      data: `[${a.data?.length ?? 0} chars base64]`,
    }));
  }
  ctx.logger.info(`[agentvox] Full payload: ${JSON.stringify(payloadSummary)}`);

  // Send an error event when the handler fails before the streaming bridge starts.
  // Uses session_update lifecycle:error so the iOS app shows it inline.
  const sendErrorEvent = (errorMsg: string) => {
    ctx.client.send(
      buildMessage(MSG.SESSION_UPDATE, {
        sessionId: payload.sessionId ?? "main",
        runId: randomUUID(),
        seq: 1,
        update: {
          type: "lifecycle",
          content: "error",
          metadata: {
            phase: "error",
            error: errorMsg,
            source: "agent_event",
          },
        },
      }),
    );
  };

  // Track saved media files for cleanup in finally block
  const mediaPaths: string[] = [];

  try {
    const cfg = ctx.runtime.config.loadConfig();

    // Save media attachments to temp files so OpenClaw's native image pipeline can pick them up.
    // OpenClaw expects MediaPaths/MediaTypes on the context (like Telegram/Discord),
    // NOT structured content blocks in BodyForAgent (which must be a string).
    const mediaTypes: string[] = [];

    if (payload.mediaAttachments && payload.mediaAttachments.length > 0) {
      ctx.logger.info(
        `[agentvox] Processing ${payload.mediaAttachments.length} media attachment(s)`,
      );

      // Create a temp directory for media files
      const mediaDir = path.join(process.env.HOME || "/tmp", ".openclaw", "media", "agentvox");
      fs.mkdirSync(mediaDir, { recursive: true });

      for (const attachment of payload.mediaAttachments) {
        // Determine file extension from mime type
        const extMap: Record<string, string> = {
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "image/heic": ".heic",
          "image/heif": ".heif",
        };
        const ext = extMap[attachment.mimeType] || ".jpg";
        const fileName = `agentvox-${randomUUID()}${ext}`;
        const filePath = path.join(mediaDir, fileName);

        // Write base64 data to file
        fs.writeFileSync(filePath, Buffer.from(attachment.data, "base64"));
        mediaPaths.push(filePath);
        mediaTypes.push(attachment.mimeType);

        ctx.logger.info(
          `[agentvox] Saved image: ${attachment.mimeType}, ${attachment.data.length} base64 chars → ${filePath}`,
        );
      }
    }

    const messageText = payload.message;

    // Build inbound message context (like Telegram does)
    const inboundCtx: Record<string, unknown> = {
      Body: messageText,
      BodyForAgent: messageText,
      BodyForCommands: messageText,
      RawBody: messageText,
      CommandBody: messageText,
      SessionKey: sessionKey,
      Provider: "agentvox",
      Surface: "agentvox",
      OriginatingChannel: "agentvox",
      ChatType: "direct" as const,
      CommandAuthorized: true,
      MessageSid: payload.messageId,
    };

    // Set media fields so OpenClaw's native image pipeline processes them
    if (mediaPaths.length > 0) {
      inboundCtx.MediaPath = mediaPaths[0];
      inboundCtx.MediaType = mediaTypes[0];
      inboundCtx.MediaUrl = mediaPaths[0];
      inboundCtx.MediaPaths = mediaPaths;
      inboundCtx.MediaUrls = mediaPaths;
      inboundCtx.MediaTypes = mediaTypes;
    }

    ctx.logger.info(
      `[agentvox] Built context with Body="${messageText.slice(0, 80)}"${mediaPaths.length > 0 ? `, ${mediaPaths.length} media file(s)` : ""}`,
    );

    // Record inbound session (creates/updates session metadata)
    const storePath = ctx.runtime.channel.session.resolveStorePath(undefined, {
      agentId: targetAgentId,
    });
    try {
      await ctx.runtime.channel.session.recordInboundSession({
        storePath,
        sessionKey,
        ctx: inboundCtx,
        createIfMissing: true,
        onRecordError: (err: unknown) => {
          ctx.logger.warn(`[agentvox] recordInboundSession error: ${err}`);
        },
      });
      ctx.logger.info(`[agentvox] Session recorded`);
    } catch (err) {
      ctx.logger.warn(`[agentvox] recordInboundSession error: ${err}`);
    }

    // Finalize the context
    let finalizedCtx;
    try {
      finalizedCtx = ctx.runtime.channel.reply.finalizeInboundContext(inboundCtx);
      ctx.logger.info(`[agentvox] Context finalized`);
    } catch (err) {
      ctx.logger.error(`[agentvox] finalizeInboundContext error: ${err}`);
      throw err;
    }

    // Create a reply dispatcher with streaming support.
    // Block and tool replies are sent as SESSION_UPDATE events in real time;
    // the final reply is collected and sent as a RESPONSE message.
    const sessionId = payload.sessionId ?? "main";
    const appInstanceId = (payload as any).appInstanceId;
    let dispatcher, replyOptions, markDispatchIdle;
    try {
      const result = ctx.runtime.channel.reply.createReplyDispatcherWithTyping({
        onTyping: async () => {
          // No typing indicator for AgentVox (voice interface)
        },
        onError: (err: unknown) => {
          ctx.logger.warn(`[agentvox] Dispatch error: ${err}`);
        },
        deliver: async (_deliveryPayload: { text?: string }, _info: { kind: string }) => {
          // No-op: the streaming bridge sends real-time session_update events
          // (text_delta, tool_call, lifecycle) via the agent event bus.
          // We don't need to collect text here — the streaming events are the
          // authoritative record of the agent's output.
        },
      });
      dispatcher = result.dispatcher;
      replyOptions = result.replyOptions;
      markDispatchIdle = result.markDispatchIdle;
      ctx.logger.info(`[agentvox] Dispatcher created`);
    } catch (err) {
      ctx.logger.error(`[agentvox] createReplyDispatcherWithTyping error: ${err}`);
      throw err;
    }

    // Dispatch through the full reply pipeline.
    // The streaming bridge sends real-time session_update events (text_delta,
    // tool_call, lifecycle) via the agent event bus. There is no separate
    // "brain_response" — the streaming events ARE the authoritative record
    // of the agent's output. The iOS app builds the conversation from these
    // events, and lifecycle:end signals completion.
    try {
      ctx.logger.info(`[agentvox] Starting dispatch...`);
      await ctx.runtime.channel.reply.dispatchReplyFromConfig({
        ctx: finalizedCtx,
        cfg,
        dispatcher,
        replyOptions,
      });
      ctx.logger.info(`[agentvox] Dispatch complete`);
    } catch (err) {
      ctx.logger.error(`[agentvox] dispatchReplyFromConfig error: ${err}`);
      throw err;
    }

    markDispatchIdle();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[agentvox] Failed to process message: ${errorMsg}`);
    ctx.logger.error(`[agentvox] Stack: ${err instanceof Error ? err.stack : "n/a"}`);
    sendErrorEvent("Sorry, I encountered an error processing your message.");
  } finally {
    // Clean up temp media files (best-effort, don't block on errors)
    for (const mediaPath of mediaPaths) {
      try {
        fs.unlinkSync(mediaPath);
      } catch {
        // ignore — file may have already been moved/deleted
      }
    }
  }
}

/**
 * Handle `get_session_context` — return system prompt, tools, conversation history.
 * In host mode, payload.agentId is the host-local agent ID to read context from.
 */
function handleGetSessionContext(ctx: HandlerContext, msg: AgentVoxMessage) {
  ctx.logger.info(`[agentvox] Handling get_session_context request`);
  const payload = msg.payload as unknown as GetSessionContextPayload & { agentId?: string };
  if (!payload?.messageId) {
    ctx.logger.warn("[agentvox] Invalid get_session_context payload");
    return;
  }

  // In host mode, use agentId from payload to target the right agent
  const targetAgentId = (payload as any).agentId || ctx.config.agentId || "main";
  ctx.logger.info(
    `[agentvox] get_session_context messageId: ${payload.messageId}, sessionId: ${payload.sessionId}, targetAgent: ${targetAgentId}`,
  );

  // --- Client context → USER.md ---
  const clientContext = payload.clientContext as ClientContext | undefined;
  if (clientContext && hasContextChanged(lastClientContext, clientContext)) {
    try {
      const workspaceDir = resolveWorkspaceDir(ctx.config);
      writeClientContextToUserMd(workspaceDir, clientContext, ctx.logger);
    } catch (err) {
      ctx.logger.warn(`[agentvox] Failed to update USER.md: ${err}`);
    }
    lastClientContext = { ...clientContext };
  }

  const sessionInfo = resolveSessionInfo(ctx.config, targetAgentId);
  let conversationHistory: Array<{ role: string; content: string | unknown[] }> = [];
  let systemPrompt = "You are a helpful assistant.";

  if (sessionInfo.transcriptPath) {
    const messages = readTranscriptMessages(sessionInfo.transcriptPath);

    // Convert transcript messages to the AgentVox format
    conversationHistory = messages.map((m) => {
      let content: string | unknown[];
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        // Extract text from content array
        const texts = (m.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c?.type === "text" && typeof c?.text === "string")
          .map((c) => c.text as string);
        content = texts.join("\n") || "";
      } else {
        content = "";
      }
      // Strip OpenClaw-injected metadata blocks from user messages —
      // they're AI-facing only and shouldn't appear in the iOS app.
      let systemEvents: string[] | undefined;
      if (m.role === "user" && typeof content === "string") {
        content = stripInboundMetadata(content);
        // Extract System: lines and pass them as a separate attribute
        const stripped = stripSystemLines(content);
        content = stripped.content;
        if (stripped.systemEvents.length > 0) {
          systemEvents = stripped.systemEvents;
        }
      }
      // Pass timestamp (ms epoch) so clients can display correct message times
      const timestamp = typeof m.timestamp === "number" ? m.timestamp : undefined;
      return {
        role: m.role,
        content,
        ...(timestamp ? { timestamp } : {}),
        ...(systemEvents ? { systemEvents } : {}),
      };
    });

    // Build system prompt from workspace files in the session's systemPromptReport
    if (sessionInfo.entry?.systemPromptReport?.injectedWorkspaceFiles) {
      const fsSync = require("fs");
      const workspaceFiles = sessionInfo.entry.systemPromptReport.injectedWorkspaceFiles as Array<{
        name: string;
        path: string;
        missing: boolean;
      }>;

      const fileContents = workspaceFiles
        .filter((f) => !f.missing && fsSync.existsSync(f.path))
        .map((f) => {
          try {
            const content = fsSync.readFileSync(f.path, "utf-8");
            return `## ${f.name}\n${content}`;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (fileContents.length > 0) {
        systemPrompt = fileContents.join("\n\n");
      } else {
        systemPrompt = "You are a helpful AI assistant powered by OpenClaw.";
      }
    } else {
      systemPrompt = "You are a helpful AI assistant powered by OpenClaw.";
    }
  }

  // Build tool list from openclaw's registry
  const toolNames = ctx.getToolNames();
  const tools = toolNames.map((name) => ({
    name,
    description: `Tool: ${name}`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  }));

  ctx.logger.info(
    `[agentvox] Sending session_context response: sessionId=${sessionInfo.sessionId}, messages=${conversationHistory.length}, tools=${tools.length}`,
  );

  ctx.client.send(
    buildMessage(MSG.SESSION_CONTEXT, {
      // agentId must be the host-local agent ID so the backend can route this response
      agentId: targetAgentId,
      messageId: payload.messageId,
      sessionId: sessionInfo.sessionId ?? "main",
      systemPrompt,
      tools,
      conversationHistory,
      contextTokens: 0, // TODO: implement proper token counting
      activeReminders: [],
      appInstanceId: (payload as any).appInstanceId, // Echo back for routing
    }),
  );

  ctx.logger.info(`[agentvox] session_context response sent successfully`);
}

/**
 * Handle `message.append` — append a message directly to the transcript.
 * Used by AgentVox V2V mode to write user/assistant/system/tool messages.
 *
 * Supports:
 *   - Plain text: `{ role: "user", content: "Hello" }`
 *   - Structured content: `{ role: "assistant", contentBlocks: [{ type: "text", text: "..." }] }`
 *   - Tool calls: `{ role: "assistant", contentBlocks: [{ type: "tool_use", id: "...", name: "exec", input: {...} }] }`
 *   - Tool results: `{ role: "tool", toolCallId: "...", content: "result text" }`
 */
function handleMessageAppend(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as unknown as MessageAppendPayload & { agentId?: string };

  // Validate: need role + at least some content
  if (!payload?.role) {
    ctx.client.send(
      buildMessage(MSG.MESSAGE_APPEND_RESPONSE, {
        success: false,
        error: "role is required",
      }),
    );
    return;
  }

  const hasContent = payload.content || (payload.contentBlocks && payload.contentBlocks.length > 0);
  if (!hasContent) {
    ctx.client.send(
      buildMessage(MSG.MESSAGE_APPEND_RESPONSE, {
        success: false,
        error: "content or contentBlocks is required",
      }),
    );
    return;
  }

  // Tool results must include toolCallId to link to the originating call
  if (payload.role === "tool" && !payload.toolCallId) {
    ctx.logger.warn(
      "[agentvox] message.append: tool result without toolCallId — will append but compaction may not link correctly",
    );
  }

  const appendTargetAgentId = (payload as any).agentId || ctx.config.agentId || "main";
  const sessionInfo = resolveSessionInfo(ctx.config, appendTargetAgentId);
  if (!sessionInfo.transcriptPath || !sessionInfo.sessionId) {
    ctx.client.send(
      buildMessage(MSG.MESSAGE_APPEND_RESPONSE, {
        agentId: appendTargetAgentId,
        success: false,
        error: "Session not found or transcript path not resolved",
      }),
    );
    return;
  }

  const result = appendToTranscript({
    transcriptPath: sessionInfo.transcriptPath,
    sessionId: sessionInfo.sessionId,
    role: payload.role,
    content: payload.content,
    contentBlocks: payload.contentBlocks as Array<Record<string, unknown>> | undefined,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    model: payload.model,
    stopReason: payload.stopReason,
    createIfMissing: true,
  });

  ctx.client.send(
    buildMessage(MSG.MESSAGE_APPEND_RESPONSE, {
      agentId: appendTargetAgentId,
      success: result.ok,
      messageId: result.messageId,
      contextTokens: 0, // TODO: implement proper token counting
      ...(result.error ? { error: result.error } : {}),
    }),
  );
}

/**
 * Handle `reset_session` — reset the agent session (like /new or /reset).
 * Archives old transcript, creates new sessionId, clears conversation.
 */
async function handleResetSession(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as unknown as ResetSessionPayload;
  if (!payload?.messageId) {
    ctx.logger.warn("[agentvox] Invalid reset_session payload");
    return;
  }

  const targetAgentId = (payload as any).agentId || ctx.config.agentId || "main";
  const sessionKey = resolveTargetSessionKey(ctx.config, targetAgentId);
  ctx.logger.info(`[agentvox] Resetting session: ${sessionKey} (agent: ${targetAgentId})`);

  try {
    // Call the gateway's sessions.reset method
    const { callGatewayCli } = require("../../../src/gateway/call.js") as {
      callGatewayCli: <T>(opts: {
        method: string;
        params?: Record<string, unknown>;
        timeoutMs?: number;
      }) => Promise<T>;
    };

    const result = await callGatewayCli<{ ok: boolean; key: string }>({
      method: "sessions.reset",
      params: { key: sessionKey, reason: "new" },
      timeoutMs: 10_000,
    });

    ctx.logger.info(`[agentvox] Session reset result: ${JSON.stringify(result)}`);

    // Invalidate the session ID cache so next resolveSessionInfo gets the new ID
    clearSessionIdCache();

    // Resolve the new session info
    const newSessionInfo = resolveSessionInfo(ctx.config, targetAgentId);

    ctx.client.send(
      buildMessage(MSG.RESET_SESSION_RESPONSE, {
        messageId: payload.messageId,
        agentId: targetAgentId,
        success: true,
        sessionId: newSessionInfo.sessionId ?? "main",
        appInstanceId: payload.appInstanceId,
      }),
    );

    ctx.logger.info(
      `[agentvox] Session reset complete, new sessionId: ${newSessionInfo.sessionId}`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[agentvox] Failed to reset session: ${errorMsg}`);

    ctx.client.send(
      buildMessage(MSG.RESET_SESSION_RESPONSE, {
        messageId: payload.messageId,
        agentId: targetAgentId,
        success: false,
        error: errorMsg,
        appInstanceId: payload.appInstanceId,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Canvas Proxy
// ---------------------------------------------------------------------------

/**
 * The currently active canvas proxy port. Set to 0 (inactive) by default.
 * Updated when an agent sends a canvas_event with a port, or via env override.
 */
export let activeCanvasPort: number = 0;

/** Set the active canvas proxy port (called from the canvas hook in index.ts). */
export function setActiveCanvasPort(port: number): void {
  activeCanvasPort = port;
}

/**
 * Resolve the canvas host port. Only returns a real port if explicitly
 * configured via env var or set at runtime by a canvas_event.
 * Does NOT default to the gateway port to avoid accidentally proxying
 * the OpenClaw dashboard.
 */
function resolveCanvasPort(): number {
  if (activeCanvasPort > 0) return activeCanvasPort;

  const envPort = process.env.OPENCLAW_CANVAS_PORT;
  if (envPort) return parseInt(envPort, 10);

  return 0; // No canvas target — will return 503
}

/**
 * Handle `canvas_proxy_request` — proxy HTTP request to the local canvas host.
 */
async function handleCanvasProxyRequest(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as {
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    appInstanceId: string;
    agentId?: string;
  };

  if (!payload?.requestId) {
    ctx.logger.warn("[agentvox] Invalid canvas_proxy_request payload");
    return;
  }

  const targetAgentId = payload.agentId || ctx.config.agentId || "main";
  const canvasPort = resolveCanvasPort();
  const requestPath = payload.path || "/";

  ctx.logger.info(
    `[agentvox] Canvas proxy: ${payload.method} ${requestPath} → localhost:${canvasPort}`,
  );

  try {
    const response = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: canvasPort,
          path: requestPath,
          method: payload.method || "GET",
          headers: {
            ...payload.headers,
            host: `127.0.0.1:${canvasPort}`,
          },
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") headers[key] = value;
              else if (Array.isArray(value)) headers[key] = value.join(", ");
            }
            resolve({ status: res.statusCode || 500, headers, body });
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Canvas proxy timeout"));
      });
      req.end();
    });

    ctx.client.send(
      buildMessage(MSG.CANVAS_PROXY_RESPONSE, {
        agentId: targetAgentId,
        requestId: payload.requestId,
        appInstanceId: payload.appInstanceId,
        status: response.status,
        headers: response.headers,
        body: response.body.toString("base64"),
        bodyLength: response.body.length,
      }),
    );

    ctx.logger.info(
      `[agentvox] Canvas proxy response: ${response.status} (${response.body.length} bytes)`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[agentvox] Canvas proxy error: ${errorMsg}`);

    ctx.client.send(
      buildMessage(MSG.CANVAS_PROXY_RESPONSE, {
        agentId: targetAgentId,
        requestId: payload.requestId,
        appInstanceId: payload.appInstanceId,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(`Canvas proxy error: ${errorMsg}`).toString("base64"),
        bodyLength: 0,
      }),
    );
  }
}

/**
 * Handle `canvas_control` — acknowledge control commands.
 */
function handleCanvasControl(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as {
    action: string;
    url?: string;
    javaScript?: string;
    appInstanceId?: string;
    agentId?: string;
  };

  const targetAgentId = payload?.agentId || ctx.config.agentId || "main";
  ctx.logger.info(`[agentvox] Canvas control: ${payload?.action}`);

  ctx.client.send(
    buildMessage(MSG.CANVAS_CONTROL_RESPONSE, {
      agentId: targetAgentId,
      action: payload?.action,
      success: true,
      ...(payload?.appInstanceId && { appInstanceId: payload.appInstanceId }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Workspace File Explorer
// ---------------------------------------------------------------------------

/**
 * Handle `workspace_request` — file system operations scoped to agent workspace.
 */
async function handleWorkspaceRequest(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as {
    requestId: string;
    action: "list" | "read" | "write" | "mkdir";
    path: string;
    content?: string;
    encoding?: string;
    appInstanceId: string;
    agentId?: string;
  };

  if (!payload?.requestId || !payload?.action) {
    ctx.logger.warn("[agentvox] Invalid workspace_request payload");
    return;
  }

  const targetAgentId = payload.agentId || ctx.config.agentId || "main";
  const workspaceDir = resolveWorkspaceDir(ctx.config);

  ctx.logger.info(
    `[agentvox] Workspace: ${payload.action} ${payload.path} (root: ${workspaceDir})`,
  );

  // Resolve and validate path is within workspace
  const requestPath = payload.path.replace(/^\/+/, "");
  const resolved = path.resolve(workspaceDir, requestPath);
  if (!resolved.startsWith(workspaceDir)) {
    ctx.client.send(
      buildMessage(MSG.WORKSPACE_RESPONSE, {
        agentId: targetAgentId,
        requestId: payload.requestId,
        appInstanceId: payload.appInstanceId,
        success: false,
        error: "Path is outside workspace",
      }),
    );
    return;
  }

  try {
    switch (payload.action) {
      case "list": {
        const entries = await listWorkspaceDirectory(resolved, workspaceDir);
        ctx.client.send(
          buildMessage(MSG.WORKSPACE_RESPONSE, {
            agentId: targetAgentId,
            requestId: payload.requestId,
            appInstanceId: payload.appInstanceId,
            success: true,
            data: { entries, root: path.relative(workspaceDir, resolved) || "/" },
          }),
        );
        break;
      }

      case "read": {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          throw new Error("Cannot read a directory");
        }
        if (stat.size > 1024 * 1024) {
          throw new Error(`File too large (${stat.size} bytes, max 1MB)`);
        }
        const encoding = payload.encoding === "base64" ? ("base64" as const) : ("utf8" as const);
        const content = fs.readFileSync(resolved, { encoding });
        ctx.client.send(
          buildMessage(MSG.WORKSPACE_RESPONSE, {
            agentId: targetAgentId,
            requestId: payload.requestId,
            appInstanceId: payload.appInstanceId,
            success: true,
            data: {
              content,
              encoding,
              path: path.relative(workspaceDir, resolved),
              size: stat.size,
              modified: stat.mtime.toISOString(),
            },
          }),
        );
        break;
      }

      case "write": {
        if (payload.content === undefined) {
          throw new Error("No content provided");
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        if (payload.encoding === "base64") {
          fs.writeFileSync(resolved, Buffer.from(payload.content, "base64"));
        } else {
          fs.writeFileSync(resolved, payload.content, "utf8");
        }
        ctx.client.send(
          buildMessage(MSG.WORKSPACE_RESPONSE, {
            agentId: targetAgentId,
            requestId: payload.requestId,
            appInstanceId: payload.appInstanceId,
            success: true,
            data: { path: path.relative(workspaceDir, resolved) },
          }),
        );
        break;
      }

      case "mkdir": {
        fs.mkdirSync(resolved, { recursive: true });
        ctx.client.send(
          buildMessage(MSG.WORKSPACE_RESPONSE, {
            agentId: targetAgentId,
            requestId: payload.requestId,
            appInstanceId: payload.appInstanceId,
            success: true,
            data: { path: path.relative(workspaceDir, resolved) },
          }),
        );
        break;
      }

      default:
        throw new Error(`Unknown workspace action: ${payload.action}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[agentvox] Workspace error: ${errorMsg}`);
    ctx.client.send(
      buildMessage(MSG.WORKSPACE_RESPONSE, {
        agentId: targetAgentId,
        requestId: payload.requestId,
        appInstanceId: payload.appInstanceId,
        success: false,
        error: errorMsg,
      }),
    );
  }
}

type WorkspaceEntryInfo = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
};

async function listWorkspaceDirectory(
  dirPath: string,
  workspaceDir: string,
): Promise<WorkspaceEntryInfo[]> {
  const entries: WorkspaceEntryInfo[] = [];

  try {
    const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      let size: number | undefined;
      let modified: string | undefined;

      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        modified = stat.mtime.toISOString();
      } catch {
        // Skip entries we can't stat
      }

      entries.push({
        name: entry.name,
        path: path.relative(workspaceDir, fullPath),
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? undefined : size,
        modified,
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  return entries;
}

/**
 * Handle `tool_execute` — execute a tool from openclaw's registry.
 */
async function handleToolExecute(ctx: HandlerContext, msg: AgentVoxMessage) {
  const payload = msg.payload as unknown as ToolExecutePayload & { agentId?: string };
  if (!payload?.requestId || !payload?.tool) {
    ctx.logger.warn("[agentvox] Invalid tool_execute payload");
    return;
  }

  const toolTargetAgentId = payload.agentId || ctx.config.agentId || "main";
  ctx.logger.info(`[agentvox] Tool execute: ${payload.tool} (agent: ${toolTargetAgentId})`);

  // Tool execution is not yet implemented for the OpenClaw extension
  ctx.client.send(
    buildMessage(MSG.TOOL_RESULT, {
      agentId: toolTargetAgentId,
      requestId: payload.requestId,
      success: false,
      error: "Tool execution not yet implemented in OpenClaw extension",
    }),
  );
}
