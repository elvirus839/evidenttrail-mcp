#!/usr/bin/env node
import crypto from 'node:crypto';
import { Session } from './session.js';
import { createHttpServer } from './http-server.js';
import { startMcpServer } from './mcp-server.js';
import type { Config } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[evidenttrail] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

function parsePort(raw: string | undefined): number {
  const port = parseInt(raw ?? '3100', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(
      `[evidenttrail] EVIDENTTRAIL_PORT must be a number between 1 and 65535 (got: ${raw ?? 'undefined'})`,
    );
    process.exit(1);
  }
  return port;
}

const config: Config = {
  apiUrl: requireEnv('EVIDENTTRAIL_API_URL'),
  apiKey: requireEnv('EVIDENTTRAIL_API_KEY'),
  repositoryId: requireEnv('EVIDENTTRAIL_REPOSITORY_ID'),
  agentName: process.env['EVIDENTTRAIL_AGENT_NAME'] ?? 'claude-code',
  agentVersion: process.env['EVIDENTTRAIL_AGENT_VERSION'] ?? null,
  modelId: process.env['EVIDENTTRAIL_MODEL_ID'] ?? null,
  port: parsePort(process.env['EVIDENTTRAIL_PORT']),
};

async function main(): Promise<void> {
  const session = new Session(config);

  // Buffer SessionStart with an accurate timestamp; ingest is deferred to threshold/interval/shutdown.
  await session.start();

  // Periodic flush every 60 seconds so evidence reaches the API during long sessions
  const flushInterval = setInterval(() => void session.flush(), 60_000);
  // Prevent the interval from keeping the process alive if everything else is done
  flushInterval.unref?.();

  // HTTP server for Claude Code PostToolUse hooks
  // Defaults to 127.0.0.1; override with EVIDENTTRAIL_HOST (non-localhost exposes /hook)
  const host = process.env['EVIDENTTRAIL_HOST'] ?? '127.0.0.1';
  // Use a pre-seeded token (e.g. from a parent process) or generate a fresh one.
  // The token is printed to stderr so the orchestrating process can capture it for
  // programmatic /shutdown calls. It is a process-local IPC secret, not a user credential.
  const shutdownToken =
    process.env['EVIDENTTRAIL_SHUTDOWN_TOKEN'] ?? crypto.randomBytes(32).toString('hex');
  console.error(`[evidenttrail] Shutdown token: ${shutdownToken}`);
  const { app, drain } = createHttpServer(session, () => void shutdown(), shutdownToken);
  const httpServer = app.listen(config.port, host, () => {
    httpServerStarted = true;
    console.error(`[evidenttrail] HTTP hook server listening on ${host}:${config.port}`);
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[evidenttrail] Port ${config.port} already in use — HTTP hook server disabled. ` +
          'PostToolUse hooks will not fire; MCP stdio tools remain available.',
      );
    } else {
      console.error('[evidenttrail] HTTP server error:', err);
      process.exit(1);
    }
  });

  // MCP stdio server for Copilot / Cursor / Windsurf — keep a handle for clean shutdown
  let mcpHandle: { close: () => Promise<void> } | null = null;
  try {
    mcpHandle = await startMcpServer(session);
  } catch (err: unknown) {
    console.error('[evidenttrail] MCP server error:', err);
  }

  let shuttingDown = false;
  let httpServerStarted = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error('[evidenttrail] Shutting down...');

    clearInterval(flushInterval);

    // Close the HTTP server first so no new /hook requests can start, then drain
    // any in-flight processHook tasks. Close the MCP server next to prevent late
    // tool-call entries, then record SessionEnd and flush the full session.
    if (httpServerStarted) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await drain();
    }
    if (mcpHandle) {
      await mcpHandle.close().catch((err: unknown) => {
        console.error('[evidenttrail] MCP server close error:', err);
      });
    }
    await session.end();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[evidenttrail] Fatal error:', err);
  process.exit(1);
});
