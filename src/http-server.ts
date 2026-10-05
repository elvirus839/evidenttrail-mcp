import express, { type Request, type Response, type NextFunction } from 'express';
import { mapToolToActionType } from './action-mapper.js';
import type { ClaudePostToolUsePayload } from './types.js';
import type { Session } from './session.js';

export interface HttpServerHandle {
  app: express.Express;
  drain: () => Promise<void>;
}

export function createHttpServer(
  session: Session,
  onShutdown?: () => void,
  shutdownToken?: string,
): HttpServerHandle {
  const app = express();
  app.use(express.json());

  let pending = 0;
  const drainCallbacks: Array<() => void> = [];

  function trackHook(task: Promise<void>): void {
    pending++;
    task.finally(() => {
      pending--;
      if (pending === 0) {
        for (const cb of drainCallbacks.splice(0)) cb();
      }
    });
  }

  function drain(): Promise<void> {
    if (pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => drainCallbacks.push(resolve));
  }

  app.post('/hook', (req: Request, res: Response) => {
    // Respond 200 immediately — Claude Code must never block waiting for this
    res.status(200).end();
    const task = processHook(session, req.body).catch((error: unknown) => {
      console.error('[evidenttrail] Failed to process hook payload:', error);
    });
    trackHook(task);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', sessionId: session.sessionId });
  });

  app.post('/shutdown', (req: Request, res: Response) => {
    if (shutdownToken) {
      const authHeader = req.headers['authorization'] ?? '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (provided !== shutdownToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    if (!onShutdown) {
      res.status(503).json({ error: 'Shutdown handler not configured' });
      return;
    }
    // Respond before shutting down so the caller receives the 202
    res.status(202).end();
    setImmediate(onShutdown);
  });

  // If express.json() rejects the body (malformed JSON, oversized), still respond 200
  // to /hook so Claude Code is never blocked. Log the error so operators can detect
  // malformed/oversized payloads that caused evidence to be discarded.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/hook') {
      console.error('[evidenttrail] Discarding malformed /hook payload:', err);
      res.status(200).end();
    } else {
      next(err);
    }
  });

  return { app, drain };
}

async function processHook(session: Session, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') {
    // Non-object body (null, number, string, etc.) — skip silently
    return;
  }

  const { session_id, tool_name, tool_input, tool_response } = payload as ClaudePostToolUsePayload;

  if (typeof tool_name !== 'string' || tool_name.length === 0) {
    // Malformed or empty payload — skip silently; 200 was already sent to the hook caller
    return;
  }

  // Flush when the external Claude Code session_id changes (new conversation started)
  const externalSessionId = typeof session_id === 'string' && session_id.length > 0 ? session_id : null;
  await session.noteExternalSession(externalSessionId);

  const actionType = mapToolToActionType(tool_name);

  const inputSummary =
    tool_input && Object.keys(tool_input).length > 0
      ? JSON.stringify(tool_input).slice(0, 500)
      : null;

  let outputSummary: string | null = null;
  if (tool_response) {
    const raw =
      typeof tool_response === 'string'
        ? tool_response
        : typeof (tool_response as { output?: string }).output === 'string'
          ? (tool_response as { output: string }).output
          : JSON.stringify(tool_response);
    outputSummary = raw.slice(0, 500) || null;
  }

  session.addEntry(actionType, tool_name, inputSummary, outputSummary);
}
