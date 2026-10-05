# EvidentTrail MCP

EvidentTrail compliance evidence collector for AI coding agents (Claude Code, GitHub Copilot, Cursor, Windsurf).

Runs two servers simultaneously:

- **HTTP server** (default port 3100) — receives [Claude Code PostToolUse hook](https://docs.anthropic.com/en/docs/claude-code/hooks) events
- **MCP stdio server** — exposes an `et_log_action` tool that Copilot, Cursor, and Windsurf can call directly

Both servers feed into a shared session buffer that flushes to the EvidentTrail ingestion API, where the entries become a tamper-evident (SHA-256 hash-chained) audit trail linked to your pull requests.

## Before you start

You need:

1. **Node.js 20 or newer** and git
2. An **EvidentTrail account** with the GitHub App installed on the repository you want to govern
3. An **API key** (`et_live_...`) — create one in the EvidentTrail app under *Settings → API Keys*
4. The **repository ID** (UUID) of that repository in EvidentTrail

## Installation

The server is installed from source. There is no npm package yet.

```bash
git clone https://github.com/elvirus839/evidenttrail-mcp.git
cd evidenttrail-mcp
npm ci
npm run build
```

This produces `dist/index.js`. Note the absolute path to it — the configuration below refers to it as `<path-to>/evidenttrail-mcp/dist/index.js`.

To update later:

```bash
git pull
npm ci
npm run build
```

Dependency install scripts are disabled by the bundled `.npmrc` (`ignore-scripts=true`), so `npm run build` must be run explicitly.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVIDENTTRAIL_API_URL` | ✅ | — | Base URL of the EvidentTrail API, e.g. `https://evidenttrail-api.fly.dev` |
| `EVIDENTTRAIL_API_KEY` | ✅ | — | Long-lived API key (`et_live_...`) |
| `EVIDENTTRAIL_REPOSITORY_ID` | ✅ | — | UUID of the repository being worked on |
| `EVIDENTTRAIL_AGENT_NAME` | | `claude-code` | Display name for the agent |
| `EVIDENTTRAIL_AGENT_VERSION` | | — | Optional version string |
| `EVIDENTTRAIL_MODEL_ID` | | — | Optional model ID, e.g. `claude-sonnet-4-6` |
| `EVIDENTTRAIL_HOST` | | `127.0.0.1` | HTTP hook server bind address. **Warning:** non-localhost values expose an unauthenticated `/hook` endpoint. |
| `EVIDENTTRAIL_PORT` | | `3100` | HTTP hook server port |

Keep the API key out of version control. If you commit an MCP config file to a shared repository, reference the key from your shell environment rather than pasting it in.

## Usage as an MCP server (Claude Code, Copilot CLI, Cursor, Windsurf)

Add this block to your agent's MCP configuration file:

```json
{
  "mcpServers": {
    "evidenttrail": {
      "command": "node",
      "args": ["<path-to>/evidenttrail-mcp/dist/index.js"],
      "env": {
        "EVIDENTTRAIL_API_URL": "https://evidenttrail-api.fly.dev",
        "EVIDENTTRAIL_API_KEY": "et_live_...",
        "EVIDENTTRAIL_REPOSITORY_ID": "your-repo-uuid",
        "EVIDENTTRAIL_AGENT_NAME": "claude-code"
      }
    }
  }
}
```

| Agent | Config file | Suggested `EVIDENTTRAIL_AGENT_NAME` |
|---|---|---|
| Claude Code | `.mcp.json` in the project root | `claude-code` |
| GitHub Copilot CLI | `.mcp.json` in the project root | `copilot-cli` |
| Cursor | `.cursor/mcp.json` | `cursor` |
| Windsurf | `.windsurf/mcp.json` | `windsurf` |

The agent starts and stops the server itself. Agents then call the `et_log_action` tool to record what they do:

```typescript
await agent.callTool('et_log_action', {
  actionType: 'FileWrite',
  actionDetail: 'Updated src/config.ts',
  outputSummary: 'Configuration file updated successfully'
});
```

To make logging consistent, tell the agent to do it in its instruction file (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, …), for example: *"Call `et_log_action` after every file write, command execution, and external API call."*

## Usage with Claude Code hooks (automatic capture)

With the PostToolUse hook, every Claude Code tool call is captured automatically — the agent does not have to remember to log.

1. Start the server in a terminal and leave it running:

   ```bash
   EVIDENTTRAIL_API_URL=https://evidenttrail-api.fly.dev \
   EVIDENTTRAIL_API_KEY=et_live_... \
   EVIDENTTRAIL_REPOSITORY_ID=your-repo-uuid \
   node <path-to>/evidenttrail-mcp/dist/index.js
   ```

   PowerShell:

   ```powershell
   $env:EVIDENTTRAIL_API_URL = "https://evidenttrail-api.fly.dev"
   $env:EVIDENTTRAIL_API_KEY = "et_live_..."
   $env:EVIDENTTRAIL_REPOSITORY_ID = "your-repo-uuid"
   node <path-to>\evidenttrail-mcp\dist\index.js
   ```

2. Add the hook to `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PostToolUse": [{
         "matcher": ".*",
         "hooks": [{ "type": "http", "url": "http://localhost:3100/hook" }]
       }]
     }
   }
   ```

3. Stop the server with `Ctrl+C` when the session is done so the final entries are sent.

## Check that it works

```bash
curl http://localhost:3100/health
```

```json
{ "status": "ok", "sessionId": "..." }
```

Within about a minute of the first tool call, the session appears under *Agent Sessions* in the EvidentTrail app.

## Session lifecycle

1. On startup a UUID `sessionId` is generated for the process lifetime and a `SessionStart` entry is buffered
2. Each tool call increments a sequence counter and appends to the buffer
3. The buffer is flushed to the API when it reaches 20 entries, every 60 seconds, and when the Claude Code session ID changes. Each batch carries the hash of the previous one, so the backend keeps a single hash chain per session
4. A failed flush is retried once, then the entries are kept and retried on the next flush — logging never blocks the agent
5. On `SIGTERM` / `SIGINT` a `SessionEnd` entry is appended, the remaining buffer is flushed, and the process exits

If the process is killed without a signal (crash, `kill -9`), entries buffered since the last flush are lost and the session has no `SessionEnd` entry. If the API is unreachable for long enough that 999 entries accumulate, further entries are dropped.

## ActionType mapping (HTTP hook)

| Tool name | ActionType |
|---|---|
| `Read`, `Glob` | `FileRead` (2) |
| `Write`, `Edit` | `FileWrite` (1) |
| `Bash`, `Agent` | `ToolInvocation` (4) |
| `WebSearch`, `WebFetch` | `ApiCall` (5) |
| anything else | `Custom` (99) |

## Privacy

`triggerDescription` is always `null` — conversation transcript content is never sent to the API.

Input and output summaries are truncated to 500 characters.

## Development

```bash
npm ci
npm test
npm run dev
```

## License

[MIT](LICENSE)
