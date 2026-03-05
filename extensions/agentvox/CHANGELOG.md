# @openclaw/plugin-agentvox

## 0.0.2 (2026-02-22)

### Added

- **Cross-channel message forwarding**: Messages from Telegram, webchat, and other channels now appear in the AgentVox iOS app in real-time
- Streaming bridge subscribes to `onSessionTranscriptUpdate` events
- Automatic detection of session UUID from transcript filename
- Intelligent sessionId extraction: distinguishes session names ("main") from UUIDs
- Support for multi-agent message forwarding (all agents monitored, not just configured agent)
- `transcript_updated` SESSION_UPDATE events for cross-channel messages

### Changed

- Updated to use OpenClaw's event APIs (`onAgentEvent`, `onSessionTranscriptUpdate`)
- Merged 2,288 commits from upstream `openclaw/openclaw:main`
- Improved transcript message parsing to handle `{ type: "message", message: {...} }` structure

### Fixed

- SessionId extraction regression that broke streaming responses
- Transcript message parsing (extract inner `message` object)
- Hardcoded sessionId "main" replaced with UUID extraction

## 0.0.1

- Initial implementation of AgentVox integration plugin
- WebSocket client with auth, reconnect, ping/pong keepalive
- Pairing flow via HTTP + QR code + terminal display
- Dual-mode operation:
  - **Agent mode**: `message` → openclaw agent pipeline → `response`
  - **V2V mode**: `message.append` direct transcript writes, `get_session_context` reads
- Tool execution via `tool_execute` using openclaw's tool registry
- CLI commands: `openclaw agentvox pair|status|unpair`
- Gateway methods: `agentvox.status`, `agentvox.unpair`
- Credential storage in `~/.openclaw/credentials/agentvox.json`
