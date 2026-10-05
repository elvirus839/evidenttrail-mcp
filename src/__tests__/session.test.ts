import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from '../session.js';
import { ActionType } from '../types.js';
import * as apiClient from '../api-client.js';

vi.mock('../api-client.js');

const mockConfig = {
  apiUrl: 'https://api.example.com',
  apiKey: 'et_live_test',
  repositoryId: 'test-repo-id',
  agentName: 'test-agent',
  agentVersion: null,
  modelId: null,
  port: 3100,
};

describe('Session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.postIngestSession).mockResolvedValue({ lastEntryHash: null });
  });

  it('generates a unique UUID sessionId on construction', () => {
    const s1 = new Session(mockConfig);
    const s2 = new Session(mockConfig);
    expect(s1.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('assigns monotonically increasing sequence numbers', async () => {
    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read');
    session.addEntry(ActionType.FileWrite, 'Write');
    session.addEntry(ActionType.ToolInvocation, 'Bash');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('auto-flushes when buffer reaches 20 entries', async () => {
    const session = new Session(mockConfig);

    for (let i = 0; i < 20; i++) {
      session.addEntry(ActionType.FileRead, `Read ${i}`);
    }

    // Allow the in-flight async flush to complete
    await vi.waitFor(() => {
      expect(apiClient.postIngestSession).toHaveBeenCalledOnce();
    });

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.entries).toHaveLength(20);
  });

  it('start() appends a SessionStart entry to the buffer without flushing', async () => {
    const session = new Session(mockConfig);
    await session.start();

    expect(apiClient.postIngestSession).not.toHaveBeenCalled();
  });

  it('end() after start() flushes the full session in a single ingest call', async () => {
    const session = new Session(mockConfig);
    await session.start();
    session.addEntry(ActionType.FileRead, 'Read');
    await session.end();

    expect(apiClient.postIngestSession).toHaveBeenCalledOnce();
    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.entries).toHaveLength(3); // SessionStart, FileRead, SessionEnd
    expect(payload.entries[0].actionType).toBe(ActionType.SessionStart);
    expect(payload.entries[0].actionDetail).toBe('Session started');
    expect(payload.entries[0].sequenceNumber).toBe(1);
    expect(payload.entries[0].triggerDescription).toBeNull();
    expect(payload.entries[2].actionType).toBe(ActionType.SessionEnd);
  });

  it('end() sends a SessionEnd entry and flushes', async () => {
    const session = new Session(mockConfig);
    await session.end();

    expect(apiClient.postIngestSession).toHaveBeenCalledOnce();
    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    const last = payload.entries[payload.entries.length - 1];
    expect(last.actionType).toBe(ActionType.SessionEnd);
    expect(last.actionDetail).toBe('Session ended');
  });

  it('flush() does nothing when buffer is empty', async () => {
    const session = new Session(mockConfig);
    await session.flush();
    expect(apiClient.postIngestSession).not.toHaveBeenCalled();
  });

  it('clears buffer after successful flush', async () => {
    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();
    await session.flush(); // second flush — buffer should be empty

    expect(apiClient.postIngestSession).toHaveBeenCalledOnce();
  });

  it('includes correct sessionId and agentName in flushed payload', async () => {
    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.sessionId).toBe(session.sessionId);
    expect(payload.agentName).toBe('test-agent');
    expect(payload.agentVersion).toBeNull();
    expect(payload.modelId).toBeNull();
  });

  it('retries once on network error then logs', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(apiClient.postIngestSession).mockRejectedValue(new Error('network error'));

    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read');

    const flushPromise = session.flush();
    // Advance past the 2-second retry delay
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(apiClient.postIngestSession).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[evidenttrail] Failed to flush session data:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it('restores entries to buffer when both retry attempts fail', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(apiClient.postIngestSession).mockRejectedValue(new Error('network error'));

    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'entry-1');

    const flushPromise = session.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    // Both attempts failed — buffer should be restored so a subsequent flush retries
    vi.mocked(apiClient.postIngestSession).mockResolvedValue({ lastEntryHash: null });
    await session.flush();

    expect(apiClient.postIngestSession).toHaveBeenCalledTimes(3);
    const lastPayload = vi.mocked(apiClient.postIngestSession).mock.calls[2][1];
    expect(lastPayload.entries).toHaveLength(1);
    expect(lastPayload.entries[0].actionDetail).toBe('entry-1');

    consoleSpy.mockRestore();
    vi.useRealTimers();
  });

  it('drops entries beyond 999 and logs a warning once', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = new Session(mockConfig);
    // Prevent threshold flushes so the buffer can grow to 999
    const flushSpy = vi.spyOn(session, 'flush').mockResolvedValue(undefined);

    for (let i = 0; i < 999; i++) {
      session.addEntry(ActionType.FileRead, `entry-${i}`);
    }

    // 999th entry is the last accepted
    expect(consoleSpy).not.toHaveBeenCalled();

    // 1000th and 1001st entries must be dropped, warning logged only once
    session.addEntry(ActionType.FileRead, 'should-be-dropped-1');
    session.addEntry(ActionType.FileRead, 'should-be-dropped-2');

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('buffer is full'));

    flushSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('accepts exactly 999 entries without warning', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = new Session(mockConfig);
    const flushSpy = vi.spyOn(session, 'flush').mockResolvedValue(undefined);

    for (let i = 0; i < 999; i++) {
      session.addEntry(ActionType.FileRead, `entry-${i}`);
    }

    expect(consoleSpy).not.toHaveBeenCalled();

    flushSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('always appends SessionEnd even when the buffer is full at 999 entries', async () => {
    const session = new Session(mockConfig);
    // Prevent threshold flushes so the buffer fills to 999 without being cleared
    const flushSpy = vi.spyOn(session, 'flush').mockResolvedValue(undefined);

    for (let i = 0; i < 999; i++) {
      session.addEntry(ActionType.FileRead, `entry-${i}`);
    }

    // Restore flush so session.end() actually sends the data
    flushSpy.mockRestore();

    // SessionEnd must bypass the cap so the session closes correctly
    await session.end();

    expect(apiClient.postIngestSession).toHaveBeenCalledOnce();
    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.entries).toHaveLength(1000);
    const last = payload.entries[999];
    expect(last.actionType).toBe(ActionType.SessionEnd);
    expect(last.actionDetail).toBe('Session ended');
  });

  it('updates lastFlushedHash after successful flush when response contains lastEntryHash', async () => {
    const hash = 'deadbeefcafe1234';
    vi.mocked(apiClient.postIngestSession).mockResolvedValue({ lastEntryHash: hash });

    const session = new Session(mockConfig);
    expect(session.lastFlushedHash).toBeNull();

    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    expect(session.lastFlushedHash).toBe(hash);
  });

  it('sends previousChainHash from lastFlushedHash on second flush', async () => {
    const firstHash = 'hash-from-first-batch';
    vi.mocked(apiClient.postIngestSession)
      .mockResolvedValueOnce({ lastEntryHash: firstHash })
      .mockResolvedValue({ lastEntryHash: 'hash-from-second-batch' });

    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read 1');
    await session.flush();

    session.addEntry(ActionType.FileRead, 'Read 2');
    await session.flush();

    const secondCallPayload = vi.mocked(apiClient.postIngestSession).mock.calls[1][1];
    expect(secondCallPayload.previousChainHash).toBe(firstHash);
  });

  it('uses config agentName/agentVersion before setAgentIdentity is called', async () => {
    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.agentName).toBe('test-agent');
    expect(payload.agentVersion).toBeNull();
  });

  it('uses detected identity after setAgentIdentity is called', async () => {
    const session = new Session(mockConfig);
    session.setAgentIdentity('claude', '3.5-sonnet');
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.agentName).toBe('claude');
    expect(payload.agentVersion).toBe('3.5-sonnet');
  });

  it('falls back to config identity when setAgentIdentity is called with null/undefined', async () => {
    const session = new Session(mockConfig);
    session.setAgentIdentity(null, undefined);
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.agentName).toBe('test-agent');
    expect(payload.agentVersion).toBeNull();
  });

  it('setModelId() overrides config modelId in subsequent flush payloads', async () => {
    const session = new Session(mockConfig);
    session.setModelId('claude-sonnet-4.6');
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.modelId).toBe('claude-sonnet-4.6');
  });

  it('setModelId(null) keeps modelId null', async () => {
    const session = new Session(mockConfig);
    session.setModelId(null);
    session.addEntry(ActionType.FileRead, 'Read');
    await session.flush();

    const payload = vi.mocked(apiClient.postIngestSession).mock.calls[0][1];
    expect(payload.modelId).toBeNull();
  });

  it('flushes on external session change and threads hash chain', async () => {
    const firstHash = 'hash-session-a';
    vi.mocked(apiClient.postIngestSession)
      .mockResolvedValueOnce({ lastEntryHash: firstHash })
      .mockResolvedValue({ lastEntryHash: 'hash-session-b' });

    const session = new Session(mockConfig);
    session.addEntry(ActionType.FileRead, 'entry in session A');

    await session.noteExternalSession('session-a');
    // First observation — no flush yet
    expect(apiClient.postIngestSession).not.toHaveBeenCalled();

    // Session ID changes — flush fires for the buffered session-A entry
    await session.noteExternalSession('session-b');
    expect(apiClient.postIngestSession).toHaveBeenCalledOnce();

    // Add a session-B entry and flush — should carry previousChainHash from session A
    session.addEntry(ActionType.FileWrite, 'entry in session B');
    await session.flush();

    const secondCallPayload = vi.mocked(apiClient.postIngestSession).mock.calls[1][1];
    expect(secondCallPayload.previousChainHash).toBe(firstHash);
  });
});
