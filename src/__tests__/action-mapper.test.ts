import { describe, it, expect } from 'vitest';
import { mapToolToActionType } from '../action-mapper.js';
import { ActionType } from '../types.js';

describe('mapToolToActionType', () => {
  it.each([
    ['Read', ActionType.FileRead],
    ['Glob', ActionType.FileRead],
    ['Write', ActionType.FileWrite],
    ['Edit', ActionType.FileWrite],
    ['Bash', ActionType.ToolInvocation],
    ['WebSearch', ActionType.ApiCall],
    ['WebFetch', ActionType.ApiCall],
    ['Agent', ActionType.ToolInvocation],
  ] as const)('maps %s → %s', (toolName, expected) => {
    expect(mapToolToActionType(toolName)).toBe(expected);
  });

  it('maps unknown tool names to Custom (99)', () => {
    expect(mapToolToActionType('SomeUnknownTool')).toBe(ActionType.Custom);
    expect(mapToolToActionType('')).toBe(ActionType.Custom);
    expect(mapToolToActionType('CreateMessage')).toBe(ActionType.Custom);
  });
});
