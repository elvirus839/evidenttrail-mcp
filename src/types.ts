export enum ActionType {
  FileWrite = 1,
  FileRead = 2,
  FileDelete = 3,
  ToolInvocation = 4,
  ApiCall = 5,
  Decision = 6,
  SessionStart = 7,
  SessionEnd = 8,
  Custom = 99,
}

export interface AgentActionEntryRequest {
  actionType: ActionType;
  actionDetail: string;
  triggerDescription: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  occurredAt: string;
  sequenceNumber: number;
}

export interface IngestAgentSessionRequest {
  sessionId: string;
  agentName: string;
  agentVersion: string | null;
  modelId: string | null;
  branchName: string | null;
  previousChainHash: string | null;
  entries: AgentActionEntryRequest[];
}

export interface ClaudePostToolUsePayload {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string | { output?: string } | Record<string, unknown>;
  hook_event_name: string;
}

export interface Config {
  apiUrl: string;
  apiKey: string;
  repositoryId: string;
  agentName: string;
  agentVersion: string | null;
  modelId: string | null;
  port: number;
}
