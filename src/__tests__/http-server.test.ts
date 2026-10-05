import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../http-server.js';
import type { Session } from '../session.js';
import { ActionType } from '../types.js';

function makeSession(overrides?: Partial<Session>): Session {
  return {
    sessionId: 'test-session-uuid',
    addEntry: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    noteExternalSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Session;
}

const validHookPayload = {
  session_id: 'claude-session-1',
  tool_name: 'Read',
  tool_input: { file_path: '/src/foo.ts' },
  tool_response: { output: 'file contents here' },
  hook_event_name: 'PostToolUse',
};

describe('HTTP server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /hook', () => {
    it('responds 200 immediately for a well-formed payload', async () => {
      const { app } = createHttpServer(makeSession());
      await request(app).post('/hook').send(validHookPayload).expect(200);
    });

    it('responds 200 even when the request body is malformed JSON', async () => {
      // Regression: express.json() would normally return 400; the error handler
      // must intercept and still respond 200 so Claude Code is never blocked.
      // The error must also be logged so operators can detect discarded payloads.
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { app } = createHttpServer(makeSession());

      await request(app)
        .post('/hook')
        .set('Content-Type', 'application/json')
        .send('{ not valid json }')
        .expect(200);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[evidenttrail] Discarding malformed /hook payload:',
        expect.anything(),
      );

      consoleSpy.mockRestore();
    });

    it('calls addEntry with the correct ActionType and truncated summaries', async () => {
      const session = makeSession();
      const { app } = createHttpServer(session);

      await request(app)
        .post('/hook')
        .send({
          session_id: 's',
          tool_name: 'Write',
          tool_input: { file_path: '/bar.ts', content: 'hello' },
          tool_response: { output: 'written' },
          hook_event_name: 'PostToolUse',
        })
        .expect(200);

      await vi.waitFor(() => {
        expect(session.addEntry).toHaveBeenCalledOnce();
      });

      expect(session.addEntry).toHaveBeenCalledWith(
        ActionType.FileWrite,
        'Write',
        expect.stringContaining('bar.ts'),
        expect.stringContaining('written'),
      );
    });

    it('handles a string tool_response', async () => {
      const session = makeSession();
      const { app } = createHttpServer(session);

      await request(app)
        .post('/hook')
        .send({
          session_id: 's',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: 'stdout output here',
          hook_event_name: 'PostToolUse',
        })
        .expect(200);

      await vi.waitFor(() => {
        expect(session.addEntry).toHaveBeenCalledOnce();
      });

      const [, , , outputSummary] = (session.addEntry as ReturnType<typeof vi.fn>).mock.calls[0] as [
        ActionType,
        string,
        string | null,
        string | null,
      ];
      expect(outputSummary).toContain('stdout output here');
    });

    it('responds 200 and logs the error when processHook rejects', async () => {
      // Regression: fire-and-forget .catch() must swallow the rejection so the
      // server never crashes and the 200 is still delivered.
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const session = makeSession({
        addEntry: vi.fn().mockImplementation(() => {
          throw new Error('unexpected failure');
        }),
      });
      const { app } = createHttpServer(session);

      await request(app).post('/hook').send(validHookPayload).expect(200);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          '[evidenttrail] Failed to process hook payload:',
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });

    it('does not call addEntry when the body has no tool_name', async () => {
      const session = makeSession();
      const { app } = createHttpServer(session);

      await request(app).post('/hook').send({}).expect(200);

      // Allow processHook microtask to settle
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(session.addEntry).not.toHaveBeenCalled();
    });

    it('does not call addEntry when tool_name is an empty string', async () => {
      const session = makeSession();
      const { app } = createHttpServer(session);

      await request(app)
        .post('/hook')
        .send({ tool_name: '', tool_input: {}, tool_response: {}, hook_event_name: 'PostToolUse' })
        .expect(200);

      await new Promise<void>((r) => setTimeout(r, 0));

      expect(session.addEntry).not.toHaveBeenCalled();
    });

    it('does not call addEntry when the body is a non-object (e.g. a JSON number)', async () => {
      // Regression: processHook must guard against non-object payloads
      // (express.json() can produce null, number, string, etc. for valid-but-non-object JSON).
      const session = makeSession();
      const { app } = createHttpServer(session);

      await request(app)
        .post('/hook')
        .set('Content-Type', 'application/json')
        .send('42')
        .expect(200);

      await new Promise<void>((r) => setTimeout(r, 0));

      expect(session.addEntry).not.toHaveBeenCalled();
    });
  });

  describe('drain()', () => {
    it('resolves immediately when no hooks are pending', async () => {
      const { drain } = createHttpServer(makeSession());
      await expect(drain()).resolves.toBeUndefined();
    });

    it('resolves after all in-flight hook tasks have settled', async () => {
      const session = makeSession();
      const { app, drain } = createHttpServer(session);

      await request(app).post('/hook').send(validHookPayload).expect(200);

      // drain() must settle (i.e., not hang) once processHook completes
      await drain();

      expect(session.addEntry).toHaveBeenCalled();
    });
  });

  describe('GET /health', () => {
    it('responds 200 with status ok and the sessionId', async () => {
      const { app } = createHttpServer(makeSession());
      const res = await request(app).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', sessionId: 'test-session-uuid' });
    });
  });

  describe('POST /shutdown', () => {
    it('responds 202 and calls the onShutdown callback', async () => {
      const onShutdown = vi.fn();
      const { app } = createHttpServer(makeSession(), onShutdown);

      await request(app).post('/shutdown').expect(202);

      await vi.waitFor(() => {
        expect(onShutdown).toHaveBeenCalledOnce();
      });
    });

    it('responds 503 when no onShutdown callback is provided', async () => {
      const { app } = createHttpServer(makeSession());
      await request(app).post('/shutdown').expect(503);
    });

    it('responds 401 when no Authorization header is provided and a token is configured', async () => {
      const { app } = createHttpServer(makeSession(), vi.fn(), 'secret-token');
      await request(app).post('/shutdown').expect(401);
    });

    it('responds 401 when the Authorization header has the wrong token', async () => {
      const { app } = createHttpServer(makeSession(), vi.fn(), 'secret-token');
      await request(app)
        .post('/shutdown')
        .set('Authorization', 'Bearer wrong-token')
        .expect(401);
    });

    it('responds 202 when the correct Bearer token is provided', async () => {
      const onShutdown = vi.fn();
      const { app } = createHttpServer(makeSession(), onShutdown, 'secret-token');
      await request(app)
        .post('/shutdown')
        .set('Authorization', 'Bearer secret-token')
        .expect(202);

      await vi.waitFor(() => {
        expect(onShutdown).toHaveBeenCalledOnce();
      });
    });

    it('responds 503 when the correct token is provided but no onShutdown callback', async () => {
      const { app } = createHttpServer(makeSession(), undefined, 'secret-token');
      await request(app)
        .post('/shutdown')
        .set('Authorization', 'Bearer secret-token')
        .expect(503);
    });
  });
});
