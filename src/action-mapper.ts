import { ActionType } from './types.js';

const TOOL_ACTION_MAP: Record<string, ActionType> = {
  Read: ActionType.FileRead,
  Glob: ActionType.FileRead,
  Write: ActionType.FileWrite,
  Edit: ActionType.FileWrite,
  Bash: ActionType.ToolInvocation,
  WebSearch: ActionType.ApiCall,
  WebFetch: ActionType.ApiCall,
  Agent: ActionType.ToolInvocation,
};

export function mapToolToActionType(toolName: string): ActionType {
  return TOOL_ACTION_MAP[toolName] ?? ActionType.Custom;
}
