# AgentVox Plugin for OpenClaw

Allows an OpenClaw instance to act as a third-party [AgentVox](https://agentvox.bot) agent, so users can talk to their OpenClaw instance via the AgentVox iOS app.

## Modes

### Agent Mode

AgentVox sends user messages to OpenClaw, which runs its full agent pipeline and returns the response. This is like chatting via Telegram or the web UI — OpenClaw's LLM generates the reply.

### Voice-to-Voice (V2V) Mode

AgentVox runs its own voice model. It reads session context from OpenClaw (`get_session_context`), appends messages of all roles directly to the transcript (`message.append`), and executes tools via OpenClaw (`tool_execute`). OpenClaw acts as the context store and tool executor.

## Features

### Cross-Channel Message Forwarding

Messages sent via Telegram, webchat, or other channels appear in the AgentVox iOS app conversation in real-time. When a message is written to the OpenClaw session transcript, the extension:

1. Detects the update via `onSessionTranscriptUpdate` event
2. Reads the last line from the transcript file
3. Parses the message structure: `{ type: "message", message: { role, content } }`
4. Sends a `session_update` event with `type: "transcript_updated"` to the backend
5. Backend routes the event to all subscribed apps via Redis pub/sub

This provides seamless multi-channel access to the same conversation from both the iOS app and other platforms.

## Setup

### 1. Enable the plugin

Add to your `openclaw.json5`:

```json5
{
  plugins: {
    agentvox: {
      enabled: true,
      // Optional overrides:
      // sessionKey: "main",
      // agentId: "main",
      // deviceName: "OpenClaw",
    },
  },
}
```

### 2. Pair with AgentVox app

```bash
openclaw agentvox pair
```

This displays a QR code and pairing code. Open the AgentVox iOS app → Agents → "+" → "Pair Device" → scan QR or enter code manually.

Credentials are saved to `~/.openclaw/credentials/agentvox.json`.

### 3. Start the gateway

The AgentVox service starts automatically with the gateway and maintains a persistent WebSocket connection to the AgentVox hub.

## CLI Commands

```bash
openclaw agentvox pair      # Pair with AgentVox app
openclaw agentvox status    # Show connection status
openclaw agentvox unpair    # Remove credentials and disconnect
```

## Gateway Methods

| Method            | Description                         |
| ----------------- | ----------------------------------- |
| `agentvox.status` | Connection status, brain ID, config |
| `agentvox.unpair` | Remove credentials, disconnect      |

## Configuration

| Key          | Default                           | Description                |
| ------------ | --------------------------------- | -------------------------- |
| `enabled`    | `true`                            | Enable/disable the plugin  |
| `hubUrl`     | `wss://api.agentvox.bot/ws/brain` | AgentVox hub WebSocket URL |
| `sessionKey` | `main`                            | OpenClaw session to bridge |
| `agentId`    | `main`                            | OpenClaw agent ID          |
| `deviceName` | `OpenClaw`                        | Name shown in AgentVox app |

## Protocol

See [AGENT_WEBSOCKET_PROTOCOL.md](../../AGENT_WEBSOCKET_PROTOCOL.md) for the full AgentVox WebSocket protocol specification.
