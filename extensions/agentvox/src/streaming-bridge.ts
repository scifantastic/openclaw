/**
 * Streaming bridge: subscribes to openclaw's real-time event systems
 * and forwards events to the AgentVox WebSocket as SESSION_UPDATE messages.
 *
 * Two modes:
 *   1. Event hooks (requires PR #16044): onAgentEvent + onSessionTranscriptUpdate
 *      - Real-time text deltas, tool events, lifecycle from agent event bus
 *      - Cross-channel transcript updates via event subscription
 *
 *   2. File watcher fallback: fs.watch on transcript JSONL files
 *      - Detects new messages appended to transcript files
 *      - Works with stock OpenClaw (no PR needed)
 *      - No streaming granularity (only completed messages)
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentVoxConfig } from "./config.js";
import { MSG } from "./protocol.js";
import { resolveSessionInfo, resolveSessionIdFromKey } from "./session-bridge.js";
import { stripInboundMetadata, stripSystemLines } from "./strip-inbound-meta.js";
import { buildMessage, type AgentVoxWsClient } from "./ws-client.js";

export type StreamingBridgeLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Message included in enriched transcript update events (when available). */
type TranscriptMessage = {
  role: string;
  content: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  [key: string]: unknown;
};

/** Subset of PluginRuntime.events used by the streaming bridge (may be unavailable). */
export type StreamingBridgeEvents = {
  onAgentEvent?: (listener: (evt: AgentEventPayload) => void) => () => void;
  onSessionTranscriptUpdate?: (
    listener: (update: { sessionFile: string; message?: TranscriptMessage }) => void,
  ) => () => void;
};

export type StreamingBridgeOptions = {
  config: AgentVoxConfig;
  client: AgentVoxWsClient;
  logger: StreamingBridgeLogger;
  /** Event subscriptions from api.runtime.events (may be partial or empty). */
  events?: StreamingBridgeEvents;
};

/** Shape of an agent event from openclaw's internal event bus. */
type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

/** Extract plain text from message content (string or content blocks array). */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c?.type === "text" && typeof c?.text === "string")
      .map((c) => c.text as string);
    return texts.join("\n");
  }
  return "";
}

/** Minimum interval between text_delta sends to avoid flooding the WebSocket. */
const DELTA_THROTTLE_MS = 100;

export type StreamingBridge = {
  start: () => void;
  stop: () => void;
};

export function createStreamingBridge(opts: StreamingBridgeOptions): StreamingBridge {
  const { config, client, logger, events } = opts;
  let unsubAgentEvent: (() => void) | null = null;
  let unsubTranscript: (() => void) | null = null;
  let lastDeltaSentAt = 0;

  // Track the last throttled text delta per run so we can flush it on lifecycle:end.
  const pendingDeltas = new Map<string, AgentEventPayload>();

  // Track active agent runs so we can suppress redundant transcript messages
  // during a run (those messages are already being streamed via text_delta).
  const activeRuns = new Set<string>();

  // Resolve the session info once at start
  const sessionInfo = resolveSessionInfo(config);
  const sessionId = sessionInfo.sessionId ?? "main";

  // --- File watcher state ---
  // Map of watched file path → { watcher, offset }
  const fileWatchers = new Map<
    string,
    { watcher: fs.FSWatcher; offset: number; debounceTimer?: ReturnType<typeof setTimeout> }
  >();
  // Watcher on the agents directory for new session files
  let agentsDirWatcher: fs.FSWatcher | null = null;

  // Track which mode we're using
  let usingEventHooks = false;

  // --- Transcript file offset tracking (shared by both modes) ---
  // Map of file path → byte offset for incremental reads
  const transcriptOffsets = new Map<string, number>();

  /** Initialize offset for a transcript file (skip existing content). */
  function initOffset(filePath: string): number {
    try {
      const stat = fs.statSync(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /** Read new messages from a transcript file since last offset. */
  function readNewMessages(
    filePath: string,
  ): Array<{ role: string; content: unknown; transcriptId?: string; [key: string]: unknown }> {
    let offset = transcriptOffsets.get(filePath) ?? 0;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= offset) {
        if (stat.size < offset) {
          // File was truncated/compacted
          transcriptOffsets.set(filePath, stat.size);
        }
        return [];
      }

      const fd = fs.openSync(filePath, "r");
      const newBytes = stat.size - offset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, newBytes, offset);
      fs.closeSync(fd);
      transcriptOffsets.set(filePath, stat.size);

      const lines = buf.toString("utf-8").split(/\r?\n/);
      const messages: Array<{
        role: string;
        content: unknown;
        transcriptId?: string;
        [key: string]: unknown;
      }> = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "message" && parsed?.message?.role) {
            messages.push({ ...parsed.message, transcriptId: parsed.id });
          }
        } catch {
          // skip bad lines
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  // --- Session update sender (shared) ---

  function sendSessionUpdate(update: {
    type: string;
    content: string;
    runId?: string;
    seq?: number;
    role?: string;
    metadata?: Record<string, unknown>;
    sessionKey?: string;
  }) {
    if (!client.isConnected()) return;

    let agentId = config.agentId || "main";
    let resolvedSessionId = sessionId;

    if (update.sessionKey) {
      const parts = update.sessionKey.split(":");
      if (parts.length >= 3 && parts[0] === "agent") {
        agentId = parts[1];
        const resolved = resolveSessionIdFromKey(update.sessionKey);
        if (resolved) {
          resolvedSessionId = resolved;
        } else {
          const extracted = parts[2];
          if (extracted && extracted.length > 10 && extracted.includes("-")) {
            resolvedSessionId = extracted;
          }
        }
      }
    }

    client.send(
      buildMessage(MSG.SESSION_UPDATE, {
        agentId,
        sessionId: resolvedSessionId,
        runId: update.runId,
        seq: update.seq,
        update: {
          type: update.type,
          content: update.content,
          role: update.role,
          metadata: update.metadata,
        },
      }),
    );
  }

  // --- Forward transcript message (shared by both modes) ---

  function forwardTranscriptMessage(
    msg: { role: string; content: unknown; transcriptId?: string; [key: string]: unknown },
    sessionKey: string,
  ) {
    let textContent = extractTextContent(msg.content);
    if (!textContent.trim()) return;

    // Strip OpenClaw-injected metadata blocks from user messages before
    // forwarding to the iOS app — they're AI-facing only.
    let systemEvents: string[] | undefined;
    if (msg.role === "user") {
      textContent = stripInboundMetadata(textContent);
      if (!textContent.trim()) return;
      // Extract System: lines (node events, model switches, etc.) and pass
      // them as a separate attribute so clients can display them distinctly.
      const stripped = stripSystemLines(textContent);
      textContent = stripped.content;
      if (stripped.systemEvents.length > 0) {
        systemEvents = stripped.systemEvents;
      }
      if (!textContent.trim()) return;
    }

    const contentBlocks = Array.isArray(msg.content) ? msg.content : undefined;
    const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : undefined;
    const thinking = typeof msg.thinking === "string" ? msg.thinking : undefined;
    const model = typeof msg.model === "string" ? msg.model : undefined;
    const usage = msg.usage && typeof msg.usage === "object" ? msg.usage : undefined;
    const transcriptId = typeof msg.transcriptId === "string" ? msg.transcriptId : undefined;

    logger.info(
      `[agentvox] sending transcript_updated: role=${msg.role}, sessionKey=${sessionKey}, transcriptId=${transcriptId}, content=${textContent.substring(0, 50)}...`,
    );
    sendSessionUpdate({
      type: "transcript_updated",
      content: textContent,
      role: msg.role,
      sessionKey,
      metadata: {
        source: "cross_channel",
        provider: typeof msg.provider === "string" ? msg.provider : undefined,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
        transcriptId,
        contentBlocks,
        toolCalls,
        thinking,
        model,
        usage,
        systemEvents,
      },
    });
  }

  // =========================================================================
  // Mode 1: Event hooks (onAgentEvent + onSessionTranscriptUpdate)
  // =========================================================================

  function handleAgentEvent(evt: AgentEventPayload) {
    if (!evt.sessionKey || !evt.sessionKey.startsWith("agent:")) return;

    logger.info(
      `[agentvox] agent event: stream=${evt.stream}, runId=${evt.runId}, dataKeys=${Object.keys(evt.data || {}).join(",")}`,
    );

    // Assistant text deltas
    if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
      const now = Date.now();
      if (now - lastDeltaSentAt < DELTA_THROTTLE_MS) {
        pendingDeltas.set(evt.runId, evt);
        return;
      }
      lastDeltaSentAt = now;
      pendingDeltas.delete(evt.runId);
      const mediaUrls = Array.isArray(evt.data.mediaUrls) ? evt.data.mediaUrls : undefined;
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : undefined;
      sendSessionUpdate({
        type: "text_delta",
        content: evt.data.text,
        runId: evt.runId,
        seq: evt.seq,
        role: "assistant",
        sessionKey: evt.sessionKey,
        metadata: { source: "agent_event", mediaUrls, delta },
      });
      return;
    }

    // Tool events
    if (evt.stream === "tool") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
      const toolName =
        typeof evt.data?.name === "string"
          ? evt.data.name
          : typeof evt.data?.toolName === "string"
            ? evt.data.toolName
            : undefined;
      const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : undefined;
      const meta = typeof evt.data?.meta === "string" ? evt.data.meta : undefined;
      const isError = evt.data?.isError === true;
      const args = evt.data?.args;
      const result = evt.data?.result;

      let content = toolName || "tool";
      if (meta) {
        content = `${toolName}: ${meta}`;
      } else if (phase === "start" && args && typeof args === "object") {
        const argsObj = args as Record<string, unknown>;
        const argPath = argsObj.path || argsObj.file_path || argsObj.filePath;
        const query = argsObj.query;
        const command = argsObj.command;
        if (argPath && typeof argPath === "string") content = `${toolName}: ${argPath}`;
        else if (query && typeof query === "string")
          content = `${toolName}: ${query.substring(0, 50)}`;
        else if (command && typeof command === "string")
          content = `${toolName}: ${command.substring(0, 50)}`;
      }

      sendSessionUpdate({
        type: phase === "result" ? "tool_result" : "tool_call",
        content,
        runId: evt.runId,
        seq: evt.seq,
        sessionKey: evt.sessionKey,
        metadata: {
          toolName,
          toolCallId,
          phase,
          meta,
          isError,
          args: phase === "start" ? args : undefined,
          result: phase === "result" ? result : undefined,
          source: "agent_event",
        },
      });
      return;
    }

    // Thinking events
    if (evt.stream === "thinking") {
      const text = typeof evt.data?.text === "string" ? evt.data.text : "";
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      sendSessionUpdate({
        type: "thinking",
        content: text,
        runId: evt.runId,
        seq: evt.seq,
        role: "assistant",
        sessionKey: evt.sessionKey,
        metadata: { delta, source: "agent_event" },
      });
      return;
    }

    // Lifecycle events
    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;

      if (phase === "start") {
        activeRuns.add(evt.runId);
      } else if (phase === "end" || phase === "error") {
        const pending = pendingDeltas.get(evt.runId);
        if (pending && typeof pending.data?.text === "string") {
          const mediaUrls = Array.isArray(pending.data.mediaUrls)
            ? pending.data.mediaUrls
            : undefined;
          const delta = typeof pending.data?.delta === "string" ? pending.data.delta : undefined;
          sendSessionUpdate({
            type: "text_delta",
            content: pending.data.text,
            runId: pending.runId,
            seq: pending.seq,
            role: "assistant",
            sessionKey: pending.sessionKey,
            metadata: { source: "agent_event", mediaUrls, delta },
          });
        }
        pendingDeltas.delete(evt.runId);
        activeRuns.delete(evt.runId);
      }

      sendSessionUpdate({
        type: "lifecycle",
        content: phase ?? "",
        runId: evt.runId,
        seq: evt.seq,
        sessionKey: evt.sessionKey,
        metadata: {
          phase,
          error: evt.data?.error ? String(evt.data.error) : undefined,
          source: "agent_event",
        },
      });
    }
  }

  /** Initialize transcript offsets for all known session files so the first
   *  onSessionTranscriptUpdate event only picks up NEW messages. */
  function initTranscriptOffsets() {
    const openclawDir = path.join(process.env.HOME || "~", ".openclaw");
    const agentsDir = path.join(openclawDir, "agents");
    if (!fs.existsSync(agentsDir)) return;

    try {
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const sessionsDir = path.join(agentsDir, agent.name, "sessions");
        if (!fs.existsSync(sessionsDir)) continue;
        try {
          const files = fs.readdirSync(sessionsDir);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(sessionsDir, file);
            const offset = initOffset(filePath);
            transcriptOffsets.set(filePath, offset);
          }
        } catch {
          // skip unreadable dirs
        }
      }
    } catch {
      // agents dir not scannable — offsets will be initialized on first event
    }
    logger.info(
      `[agentvox] Initialized transcript offsets for ${transcriptOffsets.size} session file(s)`,
    );
  }

  function startEventHooks() {
    // Initialize transcript file offsets BEFORE subscribing to events.
    // This ensures the first event only picks up messages written AFTER
    // the bridge starts, not the entire history.
    initTranscriptOffsets();

    // Subscribe to agent events
    if (events?.onAgentEvent) {
      try {
        unsubAgentEvent = events.onAgentEvent(handleAgentEvent);
        logger.info(`[agentvox] Streaming bridge: subscribed to agent events (event hooks)`);
      } catch (err) {
        logger.warn(`[agentvox] Streaming bridge: failed to subscribe to agent events: ${err}`);
      }
    }

    // Subscribe to transcript updates.
    // Uses offset-based reading (like the file watcher mode) to reliably
    // pick up ALL new messages since the last read. The previous approach
    // of reading the last line of the file was racy — by the time we read,
    // the agent may have written additional lines, causing user messages
    // to be skipped.
    if (events?.onSessionTranscriptUpdate) {
      try {
        unsubTranscript = events.onSessionTranscriptUpdate(
          (update: { sessionFile: string; message?: TranscriptMessage }) => {
            if (!update.sessionFile || !update.sessionFile.includes("/.openclaw/agents/")) return;

            const agentIdMatch = update.sessionFile.match(/\.openclaw\/agents\/([^/]+)\//);
            const agentId = agentIdMatch?.[1] || config.agentId || "main";
            const sessionIdMatch = update.sessionFile.match(/\/([^/]+)\.jsonl$/);
            const extractedSessionId = sessionIdMatch?.[1] || "main";
            const sessionKey = `agent:${agentId}:${extractedSessionId}`;

            // If this is a file we haven't seen before (new session created
            // after bridge start), initialize offset to 0 so we read from
            // the beginning (new files start empty, so this is correct).
            if (!transcriptOffsets.has(update.sessionFile)) {
              transcriptOffsets.set(update.sessionFile, 0);
            }

            // Read all new messages since last offset — no race condition.
            const newMessages = readNewMessages(update.sessionFile);
            for (const msg of newMessages) {
              forwardTranscriptMessage(msg, sessionKey);
            }
          },
        );
        logger.info("[agentvox] Streaming bridge: subscribed to transcript updates (event hooks)");
      } catch (err) {
        logger.warn(
          `[agentvox] Streaming bridge: failed to subscribe to transcript updates: ${err}`,
        );
      }
    }
  }

  // =========================================================================
  // Mode 2: File watcher fallback
  // =========================================================================

  /** Watch a single transcript JSONL file for new messages. */
  function watchTranscriptFile(filePath: string, agentId: string) {
    if (fileWatchers.has(filePath)) return;

    // Initialize offset to current file size (skip existing content)
    const offset = initOffset(filePath);
    transcriptOffsets.set(filePath, offset);

    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType !== "change") return;

        // Debounce: multiple rapid writes should coalesce
        const entry = fileWatchers.get(filePath);
        if (entry?.debounceTimer) clearTimeout(entry.debounceTimer);
        if (entry) {
          entry.debounceTimer = setTimeout(() => {
            const messages = readNewMessages(filePath);
            if (messages.length === 0) return;

            const sessionIdMatch = filePath.match(/\/([^/]+)\.jsonl$/);
            const fileSessionId = sessionIdMatch?.[1] || "main";
            const sessionKey = `agent:${agentId}:${fileSessionId}`;

            logger.info(
              `[agentvox] file watcher: ${messages.length} new message(s) in ${path.basename(filePath)}`,
            );

            for (const msg of messages) {
              forwardTranscriptMessage(msg, sessionKey);
            }
          }, 50); // 50ms debounce
        }
      });

      fileWatchers.set(filePath, { watcher, offset });
      logger.info(`[agentvox] file watcher: watching ${filePath}`);
    } catch (err) {
      logger.warn(`[agentvox] file watcher: failed to watch ${filePath}: ${err}`);
    }
  }

  /** Scan for and watch all active transcript files for all agents. */
  function scanAndWatchTranscripts() {
    const openclawDir = path.join(process.env.HOME || "~", ".openclaw");
    const agentsDir = path.join(openclawDir, "agents");

    if (!fs.existsSync(agentsDir)) {
      logger.info(`[agentvox] file watcher: agents dir not found, will retry on creation`);
      return;
    }

    try {
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const sessionsDir = path.join(agentsDir, agent.name, "sessions");
        if (!fs.existsSync(sessionsDir)) continue;

        // Read sessions.json to find active session files
        const storeFile = path.join(sessionsDir, "sessions.json");
        if (fs.existsSync(storeFile)) {
          try {
            const store = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
            for (const entry of Object.values(store) as Array<Record<string, unknown>>) {
              const sessionFile = entry.sessionFile;
              if (typeof sessionFile === "string" && fs.existsSync(sessionFile)) {
                watchTranscriptFile(sessionFile, agent.name);
              }
            }
          } catch {
            // skip bad store files
          }
        }

        // Also watch any .jsonl files directly (catches files not in sessions.json)
        try {
          const files = fs.readdirSync(sessionsDir);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(sessionsDir, file);
            watchTranscriptFile(filePath, agent.name);
          }
        } catch {
          // skip unreadable dirs
        }
      }
    } catch (err) {
      logger.warn(`[agentvox] file watcher: error scanning agents: ${err}`);
    }
  }

  /** Periodically rescan for new session files (new sessions, new agents). */
  let rescanInterval: ReturnType<typeof setInterval> | null = null;
  const RESCAN_INTERVAL_MS = 10_000; // 10 seconds

  function startFileWatcher() {
    logger.info(
      "[agentvox] Streaming bridge: using file watcher fallback (event hooks not available)",
    );

    // Initial scan
    scanAndWatchTranscripts();

    // Periodic rescan for new files
    rescanInterval = setInterval(scanAndWatchTranscripts, RESCAN_INTERVAL_MS);
  }

  function stopFileWatcher() {
    if (rescanInterval) {
      clearInterval(rescanInterval);
      rescanInterval = null;
    }
    if (agentsDirWatcher) {
      agentsDirWatcher.close();
      agentsDirWatcher = null;
    }
    for (const [filePath, entry] of fileWatchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.watcher.close();
    }
    fileWatchers.clear();
    transcriptOffsets.clear();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  function start() {
    const hasAgentEvents = typeof events?.onAgentEvent === "function";
    const hasTranscriptEvents = typeof events?.onSessionTranscriptUpdate === "function";

    if (hasAgentEvents || hasTranscriptEvents) {
      usingEventHooks = true;
      logger.info(
        `[agentvox] Streaming bridge: event hooks detected (agentEvents=${hasAgentEvents}, transcriptEvents=${hasTranscriptEvents})`,
      );
      startEventHooks();
    } else {
      usingEventHooks = false;
      startFileWatcher();
    }
  }

  function stop() {
    if (usingEventHooks) {
      if (unsubAgentEvent) {
        unsubAgentEvent();
        unsubAgentEvent = null;
      }
      if (unsubTranscript) {
        unsubTranscript();
        unsubTranscript = null;
      }
    } else {
      stopFileWatcher();
    }
    logger.info("[agentvox] Streaming bridge: stopped");
  }

  return { start, stop };
}
