/**
 * AgentVox WebSocket protocol types.
 * See AGENT_WEBSOCKET_PROTOCOL.md for the full specification.
 */

// Base message envelope
export type AgentVoxMessage = {
  id: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
};

// --- Auth ---

export type AuthPayload = {
  brainId?: string;
  agentAuthToken?: string;
  pairingCode?: string;
  name?: string;
  version?: string;
};

export type AuthSuccessPayload = {
  brainId: string;
  userId: string;
  agentAuthToken?: string;
};

// --- Ready ---

export type ReadyCapabilities = {
  tools: string[];
  maxMessageSize: number;
  streaming: boolean;
};

export type ReadyPayload = {
  version: string;
  apiVersion: string;
  capabilities: ReadyCapabilities;
  location: "external" | "eks";
};

// --- Message (user → agent) ---

export type InboundMessagePayload = {
  messageId: string;
  sessionId?: string;
  userId: string;
  message: string;
  metadata?: {
    inputMode?: "voice" | "text";
    timestamp?: string;
    [key: string]: unknown;
  };
  mediaAttachments?: Array<{
    data: string; // base64 encoded image data
    mimeType: string; // e.g. "image/jpeg"
    fileName?: string; // optional filename
  }>;
};

// --- Response (agent → user) ---

export type ResponsePayload = {
  messageId: string;
  sessionId?: string;
  response: {
    role: "assistant";
    content: string;
    metadata?: {
      model?: string;
      tokens?: number;
      [key: string]: unknown;
    };
  };
  appInstanceId?: string;
};

// --- Session context ---

export type ClientContext = {
  agentName?: string;
  timezone?: string;
  location?: {
    type: "city" | "precise";
    value: string;
    latitude?: number;
    longitude?: number;
  };
  device?: {
    name: string;
    model: string;
    osVersion: string;
  };
  inputMode?: "voice" | "text";
};

export type GetSessionContextPayload = {
  messageId: string;
  sessionId?: string;
  memoryQuery?: string;
  messageLimit?: number;
  clientContext?: ClientContext;
};

export type SessionContextTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type SessionContextPayload = {
  messageId: string;
  sessionId: string;
  systemPrompt: string;
  tools: SessionContextTool[];
  conversationHistory: Array<{ role: string; content: string | unknown[] }>;
  contextTokens?: number;
  compactionStatus?: {
    compactionCount?: number;
    oldestMessageAge?: number;
  };
  activeReminders?: unknown[];
};

// --- Message append ---

/**
 * Content block for structured message content (tool calls, multi-part, etc.).
 * Matches OpenAI/Anthropic content block format.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] };

export type MessageAppendPayload = {
  role: "user" | "assistant" | "system" | "tool";
  /** Plain text content (for simple messages). */
  content?: string;
  /** Structured content blocks (for tool calls, multi-part messages). */
  contentBlocks?: ContentBlock[];
  /** Tool call ID — required when role is "tool" (links result to the call). */
  toolCallId?: string;
  /** Tool name — optional metadata for tool results. */
  toolName?: string;
  /** Model that generated this message (for assistant messages from AgentVox's own model). */
  model?: string;
  /** Stop reason for assistant messages (default: "stop"). */
  stopReason?: string;
};

export type MessageAppendResponsePayload = {
  success: boolean;
  messageId?: string;
  contextTokens?: number;
  error?: string;
};

// --- Tool execute ---

export type ToolExecutePayload = {
  requestId: string;
  sessionId?: string;
  tool: string;
  parameters: Record<string, unknown>;
};

export type ToolResultPayload = {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
};

// --- Session updates (streaming) ---

export type SessionUpdatePayload = {
  sessionId: string;
  /** Agent run identifier — correlates all events from a single agent invocation. */
  runId?: string;
  /** Monotonic sequence number within the run for ordering. */
  seq?: number;
  update: {
    type:
      | "thinking"
      | "text_delta"
      | "text_chunk"
      | "tool_call"
      | "tool_result"
      | "lifecycle"
      | "transcript_updated"
      | "final";
    content: string;
    /** Role of the message author (user/assistant/system/tool). */
    role?: string;
    metadata?: {
      toolName?: string;
      toolCallId?: string;
      isComplete?: boolean;
      model?: string;
      tokens?: number;
      /** Lifecycle phase: start, end, error. */
      phase?: string;
      /** Channel/provider that originated the event (for cross-channel). */
      provider?: string;
      /** Error description when type is lifecycle/error. */
      error?: string;
      /** Event source hint (e.g. "cross_channel", "agent_event"). */
      source?: string;
      [key: string]: unknown;
    };
  };
};

// --- Session reset ---

export type ResetSessionPayload = {
  messageId: string;
  sessionId?: string;
  agentId?: string;
  appInstanceId?: string;
};

export type ResetSessionResponsePayload = {
  messageId: string;
  agentId?: string;
  success: boolean;
  /** The new sessionId after reset. */
  sessionId?: string;
  error?: string;
  appInstanceId?: string;
};

// --- Health ---

export type PongPayload = {
  uptime?: number;
};

export type StatusPayload = {
  uptime: number;
  memory?: { used: number; total: number };
  sessions?: number;
  busy?: boolean;
};

// --- Error ---

export type ErrorPayload = {
  code: string;
  message: string;
  originalMessageId?: string;
};

export type DisconnectPayload = {
  reason: string;
  message?: string;
};

// --- Host / Multi-agent ---

export type HostAgentInfo = {
  /** Host-local stable ID — the OpenClaw agent ID (e.g. 'main', 'loop'). */
  agentId: string;
  name: string;
  /** Agent emoji from IDENTITY.md (e.g. '🤖', '🎙️'). */
  emoji?: string;
  version?: string;
  status: "ready" | "busy" | "error";
};

export type AgentMapping = {
  /** Host-local agent ID (OpenClaw agent ID). */
  hostAgentId: string;
  /** Backend stable UUID for this agent. */
  agentId: string;
};

export type HostAuthSuccessPayload = {
  hostId: string;
  userId: string;
  /** Previously-registered agent mappings (hostAgentId ↔ backend agentId). */
  agentMappings: AgentMapping[];
};

export type AgentsUpdatePayload = {
  agents: HostAgentInfo[];
};

export type AgentsUpdateAckPayload = {
  agentMappings: AgentMapping[];
  /** Host-local IDs of agents that were removed (no longer reported). */
  removed: string[];
};

// --- Pairing (HTTP) ---

export type PairingInitRequest = {
  deviceName?: string;
  type?: "agent" | "host";
};

export type PairingInitResponse = {
  pairingId: string;
  pairingCode: string;
  pairingType?: "agent" | "host";
  expiresAt: string;
};

export type PairingStatusResponse = {
  status: "pending" | "confirmed" | "expired";
  // Agent pairing (legacy)
  brainId?: string;
  // Host pairing (new)
  hostId?: string;
  // Auth token (works for both agent and host)
  agentAuthToken?: string;
  secretsEncryptionKey?: string;
};

// Message type constants
export const MSG = {
  AUTH: "auth",
  AUTH_SUCCESS: "auth_success",
  READY: "ready",
  MESSAGE: "message",
  RESPONSE: "response",
  GET_SESSION_CONTEXT: "get_session_context",
  SESSION_CONTEXT: "session_context",
  MESSAGE_APPEND: "message.append",
  MESSAGE_APPEND_RESPONSE: "message.append_response",
  TOOL_EXECUTE: "tool_execute",
  TOOL_RESULT: "tool_result",
  SESSION_UPDATE: "session_update",
  RESET_SESSION: "reset_session",
  RESET_SESSION_RESPONSE: "reset_session_response",
  // Host messages
  AGENTS_UPDATE: "agents_update",
  AGENTS_UPDATE_ACK: "agents_update_ack",
  AGENT_STARTED: "agent_started",
  AGENT_STOPPED: "agent_stopped",
  // Canvas proxy + workspace
  CANVAS_PROXY_REQUEST: "canvas_proxy_request",
  CANVAS_PROXY_RESPONSE: "canvas_proxy_response",
  CANVAS_CONTROL: "canvas_control",
  CANVAS_CONTROL_RESPONSE: "canvas_control_response",
  CANVAS_EVENT: "canvas_event",
  WORKSPACE_REQUEST: "workspace_request",
  WORKSPACE_RESPONSE: "workspace_response",
  // Ping/pong/status
  PING: "ping",
  PONG: "pong",
  STATUS: "status",
  ERROR: "error",
  DISCONNECT: "disconnect",
} as const;
