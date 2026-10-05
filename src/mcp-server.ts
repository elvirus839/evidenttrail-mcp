import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ActionType } from './types.js';
import type { Session } from './session.js';

const ACTION_TYPE_NAME_MAP: Record<string, ActionType> = {
  FileWrite: ActionType.FileWrite,
  FileRead: ActionType.FileRead,
  FileDelete: ActionType.FileDelete,
  ToolInvocation: ActionType.ToolInvocation,
  ApiCall: ActionType.ApiCall,
  Decision: ActionType.Decision,
  SessionStart: ActionType.SessionStart,
  SessionEnd: ActionType.SessionEnd,
  Custom: ActionType.Custom,
};

export function processLogAction(
  session: Session,
  raw: Record<string, unknown>,
): { isError?: boolean; content: Array<{ type: string; text: string }> } {
  const actionDetail = typeof raw['actionDetail'] === 'string' ? raw['actionDetail'] : null;
  if (!actionDetail) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'actionDetail is required and must be a non-empty string' }],
    };
  }

  const actionTypeName = typeof raw['actionType'] === 'string' ? raw['actionType'] : '';
  const actionType = ACTION_TYPE_NAME_MAP[actionTypeName] ?? ActionType.Custom;
  const inputSummary =
    typeof raw['inputSummary'] === 'string' ? raw['inputSummary'].slice(0, 500) : null;
  const outputSummary =
    typeof raw['outputSummary'] === 'string' ? raw['outputSummary'].slice(0, 500) : null;

  if (typeof raw['modelId'] === 'string' && raw['modelId'].length > 0) {
    session.setModelId(raw['modelId']);
  }

  session.addEntry(actionType, actionDetail, inputSummary, outputSummary);

  return { content: [{ type: 'text', text: 'Action logged' }] };
}

export async function startMcpServer(session: Session): Promise<{ close: () => Promise<void> }> {
  const server = new Server(
    { name: 'evidenttrail', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Capture the connecting agent's identity from the MCP initialize handshake.
  // getClientVersion() returns the clientInfo sent by the agent (name + version).
  // Falls back to EVIDENTTRAIL_AGENT_NAME / EVIDENTTRAIL_AGENT_VERSION env vars when absent.
  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    if (clientInfo) {
      session.setAgentIdentity(clientInfo.name, clientInfo.version);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'et_log_action',
        description:
          'Log an agent action as compliance evidence in EvidentTrail. ' +
          'Call this whenever you perform a significant action (file edit, API call, decision).',
        inputSchema: {
          type: 'object',
          properties: {
            actionType: {
              type: 'string',
              description:
                'ActionType name: FileWrite, FileRead, FileDelete, ToolInvocation, ApiCall, Decision, SessionStart, SessionEnd, Custom',
            },
            actionDetail: {
              type: 'string',
              description: 'Short human-readable description of the action (e.g. tool or file name)',
            },
            inputSummary: {
              type: 'string',
              description: 'Optional summary of inputs (max 500 chars)',
            },
            outputSummary: {
              type: 'string',
              description: 'Optional summary of outputs (max 500 chars)',
            },
            modelId: {
              type: 'string',
              description:
                'Optional model ID (e.g. claude-sonnet-4.6). Set on the first call; applies to all subsequent flushes in this session.',
            },
          },
          required: ['actionType', 'actionDetail'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'et_log_action') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    return processLogAction(
      session,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { close: () => server.close() };
}
