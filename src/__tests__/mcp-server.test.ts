import { describe, it, expect, vi } from 'vitest';
import { processLogAction } from '../mcp-server.js';
import { ActionType } from '../types.js';
import type { Session } from '../session.js';

function makeSession(): Session {
  return {
    sessionId: 'test-session',
    addEntry: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    setModelId: vi.fn(),
  } as unknown as Session;
}

describe('processLogAction', () => {
  it('calls addEntry with correct args for a valid payload', () => {
    const session = makeSession();
    const result = processLogAction(session, {
      actionType: 'FileRead',
      actionDetail: 'Read file.ts',
      inputSummary: 'src/file.ts',
      outputSummary: 'file contents',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Action logged');
    expect(session.addEntry).toHaveBeenCalledWith(
      ActionType.FileRead,
      'Read file.ts',
      'src/file.ts',
      'file contents',
    );
  });

  it('returns isError when actionDetail is missing', () => {
    const session = makeSession();
    const result = processLogAction(session, { actionType: 'FileRead' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/actionDetail/);
    expect(session.addEntry).not.toHaveBeenCalled();
  });

  it('returns isError when actionDetail is not a string', () => {
    const session = makeSession();
    const result = processLogAction(session, { actionType: 'FileRead', actionDetail: 42 });

    expect(result.isError).toBe(true);
    expect(session.addEntry).not.toHaveBeenCalled();
  });

  it('returns isError when actionDetail is an empty string', () => {
    const session = makeSession();
    const result = processLogAction(session, { actionType: 'FileRead', actionDetail: '' });

    expect(result.isError).toBe(true);
    expect(session.addEntry).not.toHaveBeenCalled();
  });

  it('defaults actionType to Custom when the name is unrecognised', () => {
    const session = makeSession();
    processLogAction(session, { actionType: 'SomethingNew', actionDetail: 'detail' });

    expect(session.addEntry).toHaveBeenCalledWith(ActionType.Custom, 'detail', null, null);
  });

  it('defaults actionType to Custom when actionType is not a string', () => {
    const session = makeSession();
    processLogAction(session, { actionType: 99, actionDetail: 'detail' });

    expect(session.addEntry).toHaveBeenCalledWith(ActionType.Custom, 'detail', null, null);
  });

  it('treats non-string inputSummary as null', () => {
    const session = makeSession();
    processLogAction(session, {
      actionType: 'FileRead',
      actionDetail: 'detail',
      inputSummary: { nested: true },
    });

    const [, , inputSummary] = vi.mocked(session.addEntry).mock.calls[0];
    expect(inputSummary).toBeNull();
  });

  it('treats non-string outputSummary as null', () => {
    const session = makeSession();
    processLogAction(session, {
      actionType: 'FileRead',
      actionDetail: 'detail',
      outputSummary: 123,
    });

    const [, , , outputSummary] = vi.mocked(session.addEntry).mock.calls[0];
    expect(outputSummary).toBeNull();
  });

  it('truncates inputSummary and outputSummary to 500 chars', () => {
    const session = makeSession();
    const long = 'x'.repeat(600);
    processLogAction(session, {
      actionType: 'FileRead',
      actionDetail: 'detail',
      inputSummary: long,
      outputSummary: long,
    });

    const [, , inputSummary, outputSummary] = vi.mocked(session.addEntry).mock.calls[0];
    expect(inputSummary).toHaveLength(500);
    expect(outputSummary).toHaveLength(500);
  });

  it('passes null for optional fields when they are absent', () => {
    const session = makeSession();
    processLogAction(session, { actionType: 'Decision', actionDetail: 'Chose approach A' });

    expect(session.addEntry).toHaveBeenCalledWith(
      ActionType.Decision,
      'Chose approach A',
      null,
      null,
    );
  });

  it('calls setModelId when a non-empty modelId string is provided', () => {
    const session = makeSession();
    processLogAction(session, {
      actionType: 'Decision',
      actionDetail: 'detail',
      modelId: 'claude-sonnet-4.6',
    });

    expect(session.setModelId).toHaveBeenCalledWith('claude-sonnet-4.6');
  });

  it('does not call setModelId when modelId is absent', () => {
    const session = makeSession();
    processLogAction(session, { actionType: 'Decision', actionDetail: 'detail' });

    expect(session.setModelId).not.toHaveBeenCalled();
  });

  it('does not call setModelId when modelId is an empty string', () => {
    const session = makeSession();
    processLogAction(session, { actionType: 'Decision', actionDetail: 'detail', modelId: '' });

    expect(session.setModelId).not.toHaveBeenCalled();
  });
});
