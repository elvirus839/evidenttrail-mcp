import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postIngestSession } from '../api-client.js';
import { ActionType } from '../types.js';
import type { Config, IngestAgentSessionRequest } from '../types.js';

const mockConfig: Config = {
  apiUrl: 'https://api.example.com',
  apiKey: 'et_live_testkey123',
  repositoryId: 'repo-uuid-1234',
  agentName: 'test-agent',
  agentVersion: null,
  modelId: null,
  port: 3100,
};

const mockPayload: IngestAgentSessionRequest = {
  sessionId: 'session-uuid-abcd',
  agentName: 'test-agent',
  agentVersion: null,
  modelId: null,
  branchName: null,
  previousChainHash: null,
  entries: [
    {
      actionType: ActionType.SessionStart,
      actionDetail: 'Session started',
      triggerDescription: null,
      inputSummary: null,
      outputSummary: null,
      occurredAt: '2026-05-03T21:00:00.000Z',
      sequenceNumber: 1,
    },
  ],
};

describe('postIngestSession', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the correct URL including repositoryId query param', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/api/agent-action-logs/ingest?repositoryId=repo-uuid-1234',
    );
  });

  it('uses POST method', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe('POST');
  });

  it('sends X-EvidentTrail-Key header with API key', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['X-EvidentTrail-Key']).toBe('et_live_testkey123');
  });

  it('sends Content-Type: application/json header', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('serialises the payload as JSON in the request body', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as IngestAgentSessionRequest;

    expect(body.sessionId).toBe('session-uuid-abcd');
    expect(body.agentName).toBe('test-agent');
    expect(body.agentVersion).toBeNull();
    expect(body.modelId).toBeNull();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].actionType).toBe(ActionType.SessionStart);
    expect(body.entries[0].sequenceNumber).toBe(1);
    expect(body.entries[0].triggerDescription).toBeNull();
  });

  it('resolves with { lastEntryHash: null } when response body has no lastEntryHash', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({}) });
    await expect(postIngestSession(mockConfig, mockPayload)).resolves.toEqual({ lastEntryHash: null });
  });

  it('resolves with lastEntryHash from response body', async () => {
    const hash = 'abc123def456';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ lastEntryHash: hash }),
    });
    await expect(postIngestSession(mockConfig, mockPayload)).resolves.toEqual({ lastEntryHash: hash });
  });

  it('throws an error on non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });

    await expect(postIngestSession(mockConfig, mockPayload)).rejects.toThrow(
      'Ingest failed: 401 Unauthorized',
    );
  });

  it('throws an error on 500 Internal Server Error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    await expect(postIngestSession(mockConfig, mockPayload)).rejects.toThrow(
      'Ingest failed: 500 Internal Server Error',
    );
  });

  it('passes an AbortSignal to fetch', async () => {
    await postIngestSession(mockConfig, mockPayload);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when the request exceeds the 10-second timeout', async () => {
    vi.useFakeTimers();

    fetchMock.mockImplementation((_url: string, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (options.signal as AbortSignal).addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const promise = postIngestSession(mockConfig, mockPayload);
    // Attach the rejection handler BEFORE advancing the timer so the promise is
    // never in an "unhandled" state when the abort fires synchronously.
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;

    vi.useRealTimers();
  });
});
