/**
 * Session bridge: reads/writes openclaw session transcripts for AgentVox.
 *
 * This is the core piece that connects AgentVox to openclaw's session system.
 * It uses SessionManager to maintain the parent-ID chain (critical for compaction).
 */

import fs from "node:fs";
import path from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import type { AgentVoxConfig } from "./config.js";

// Re-use the same session loading logic as the gateway
// These are imported from the core at runtime via jiti resolution.

type TranscriptMessage = {
  role: string;
  content: unknown;
  timestamp?: number;
  [key: string]: unknown;
};

export type SessionBridgeContext = {
  config: AgentVoxConfig;
};

/**
 * Resolve the session key for the target session.
 * Uses the configured sessionKey (default: "main") mapped to the agent's store key.
 * Pass agentIdOverride to target a specific agent (for multi-agent host mode).
 */
export function resolveTargetSessionKey(config: AgentVoxConfig, agentIdOverride?: string): string {
  const agentId = agentIdOverride || config.agentId || "main";
  const sessionKey = config.sessionKey || "main";
  return `agent:${agentId}:${sessionKey}`;
}

/**
 * Cache for sessionKey → sessionId lookups to minimize disk I/O.
 * Format: Map<sessionKey, { sessionId: string, lastRead: number }>
 */
const sessionIdCache = new Map<string, { sessionId: string; lastRead: number }>();
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Clear the session ID cache. Call after session reset so fresh IDs are resolved.
 */
export function clearSessionIdCache(): void {
  sessionIdCache.clear();
}

/**
 * Resolve sessionId (UUID) from sessionKey (e.g. "agent:agentvoxdev:main").
 * Uses cached value if fresh (<5s old), otherwise reads from session store.
 *
 * This is critical for streaming events which provide sessionKey (session NAME)
 * but need to publish to session:${agentId}:${sessionId} channels that iOS subscribes to.
 */
export function resolveSessionIdFromKey(sessionKey: string): string | null {
  // Check cache first
  const cached = sessionIdCache.get(sessionKey);
  if (cached && Date.now() - cached.lastRead < CACHE_TTL_MS) {
    return cached.sessionId;
  }

  try {
    // Parse sessionKey format: "agent:${agentId}:${sessionName}"
    const parts = sessionKey.split(":");
    if (parts.length < 3 || parts[0] !== "agent") {
      return null;
    }

    const agentId = parts[1];
    const openclawDir = path.join(process.env.HOME || "~", ".openclaw");
    const storePath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");

    if (!fs.existsSync(storePath)) {
      return null;
    }

    const storeData = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entry = storeData[sessionKey];

    if (!entry || !entry.sessionId) {
      return null;
    }

    // Cache the result
    sessionIdCache.set(sessionKey, { sessionId: entry.sessionId, lastRead: Date.now() });
    return entry.sessionId;
  } catch (err) {
    console.error(`[session-bridge] Error resolving sessionId from key ${sessionKey}:`, err);
    return null;
  }
}

/**
 * Find the transcript file path for a session.
 * Scans the sessions directory for matching JSONL files.
 */
function findTranscriptPath(sessionId: string, sessionsDir: string): string | null {
  const candidates = [
    path.join(sessionsDir, `${sessionId}.jsonl`),
    path.join(sessionsDir, sessionId, "session.jsonl"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Ensure a transcript file exists, creating it if needed.
 */
function ensureTranscriptFile(transcriptPath: string, sessionId: string): void {
  if (fs.existsSync(transcriptPath)) {
    return;
  }
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

/**
 * Read all messages from a transcript file.
 */
export function readTranscriptMessages(transcriptPath: string): TranscriptMessage[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }
  const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message && typeof parsed.message === "object") {
        messages.push(parsed.message as TranscriptMessage);
      }
    } catch {
      // skip bad lines
    }
  }
  return messages;
}

/**
 * Options for appending a message to the transcript.
 */
export type AppendToTranscriptParams = {
  transcriptPath: string;
  sessionId: string;
  role: string;
  /** Plain text content (for simple text messages). */
  content?: string;
  /** Structured content blocks (for tool calls, multi-part messages). */
  contentBlocks?: Array<Record<string, unknown>>;
  /** Tool call ID — required when role is "tool" (links result to the call). */
  toolCallId?: string;
  /** Tool name — optional metadata for tool results. */
  toolName?: string;
  /** Model name (for assistant messages). */
  model?: string;
  /** Stop reason (for assistant messages, default: "stop"). */
  stopReason?: string;
  createIfMissing?: boolean;
};

/**
 * Append a message to the transcript using SessionManager (preserves parentId chain).
 *
 * Supports all message types needed for V2V mode:
 *   - user: plain text transcription
 *   - assistant: text response, or structured with tool_use blocks
 *   - tool: tool result linked to a tool_call_id
 *   - system: context/instruction updates
 */
export function appendToTranscript(params: AppendToTranscriptParams): {
  ok: boolean;
  messageId?: string;
  error?: string;
} {
  const { transcriptPath, sessionId, role, createIfMissing } = params;

  if (!fs.existsSync(transcriptPath)) {
    if (!createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    ensureTranscriptFile(transcriptPath, sessionId);
  }

  const now = Date.now();

  // Resolve content: prefer structured contentBlocks, fall back to text wrapping
  let resolvedContent: unknown;
  if (params.contentBlocks && params.contentBlocks.length > 0) {
    resolvedContent = params.contentBlocks;
  } else if (typeof params.content === "string") {
    resolvedContent = [{ type: "text", text: params.content }];
  } else {
    resolvedContent = [{ type: "text", text: "" }];
  }

  // Build the message body compatible with SessionManager
  const messageBody: Record<string, unknown> = {
    role,
    content: resolvedContent,
    timestamp: now,
    provider: "agentvox",
  };

  // Assistant messages: add required fields for Pi/session compatibility
  if (role === "assistant") {
    messageBody.stopReason = params.stopReason ?? "stop";
    messageBody.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    messageBody.api = "openai-responses";
    messageBody.model = params.model ?? "agentvox-v2v";
  }

  // Tool results: link to the originating tool call
  if (role === "tool") {
    if (params.toolCallId) {
      messageBody.tool_call_id = params.toolCallId;
    }
    if (params.toolName) {
      messageBody.name = params.toolName;
    }
  }

  try {
    // Use SessionManager to maintain the parentId chain
    const sessionManager = SessionManager.open(transcriptPath);
    const messageId = sessionManager.appendMessage(
      messageBody as Parameters<SessionManager["appendMessage"]>[0],
    );
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve session info from the session store.
 * Returns the sessionId, transcript path, and full session entry for the configured session.
 * Pass agentIdOverride to target a specific agent (for multi-agent host mode).
 */
export function resolveSessionInfo(
  config: AgentVoxConfig,
  agentIdOverride?: string,
): {
  sessionKey: string;
  sessionId: string | null;
  transcriptPath: string | null;
  storePath: string | null;
  entry: Record<string, unknown> | null;
} {
  const sessionKey = resolveTargetSessionKey(config, agentIdOverride);
  const agentId = agentIdOverride || config.agentId || "main";

  try {
    // Directly read the sessions.json file (OpenClaw's session store)
    const openclawDir = path.join(process.env.HOME || "~", ".openclaw");
    const agentSessionsDir = path.join(openclawDir, "agents", agentId, "sessions");
    const storePath = path.join(agentSessionsDir, "sessions.json");

    console.log(
      `[session-bridge] resolveSessionInfo: sessionKey=${sessionKey}, agentId=${agentId}, storePath=${storePath}`,
    );

    if (!fs.existsSync(storePath)) {
      console.log(`[session-bridge] sessions.json not found at ${storePath}`);
      return { sessionKey, sessionId: null, transcriptPath: null, storePath, entry: null };
    }

    const storeData = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entry = storeData[sessionKey];

    if (!entry) {
      console.log(
        `[session-bridge] No entry found for sessionKey=${sessionKey}. Available keys:`,
        Object.keys(storeData).join(", "),
      );
      return { sessionKey, sessionId: null, transcriptPath: null, storePath, entry: null };
    }

    const sessionId = entry.sessionId ?? null;
    const transcriptPath = entry.sessionFile || null;

    console.log(
      `[session-bridge] Found session: sessionId=${sessionId}, transcriptPath=${transcriptPath}`,
    );

    return { sessionKey, sessionId, transcriptPath, storePath, entry };
  } catch (err) {
    console.log(`[session-bridge] Error resolving session:`, err);
    return { sessionKey, sessionId: null, transcriptPath: null, storePath: null, entry: null };
  }
}
