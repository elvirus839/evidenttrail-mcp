import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ActionType } from './types.js';
import type { AgentActionEntryRequest, Config, IngestAgentSessionRequest } from './types.js';
import { postIngestSession } from './api-client.js';

// One entry is reserved for SessionEnd, keeping the total under the backend limit of 1000.
const MAX_BUFFER_ENTRIES = 999;
const FLUSH_THRESHOLD_ENTRIES = 20;

function getCurrentBranch(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
    // "HEAD" means detached HEAD state — not a named branch, treat as unknown.
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

export class Session {
  readonly sessionId: string;
  private sequenceCounter = 0;
  private buffer: AgentActionEntryRequest[] = [];
  private readonly config: Config;
  private readonly branchName: string | null;
  private bufferOverflowWarned = false;

  // Identity: set from MCP clientInfo after handshake, falls back to config
  private detectedAgentName: string | null = null;
  private detectedAgentVersion: string | null = null;
  private modelId: string | null;

  // Hash chain: carries the last contentHash across incremental flush batches.
  // The backend computes contentHash server-side; we obtain it via the ingest response.
  lastFlushedHash: string | null = null;

  // External Claude Code hook session tracking: flush when the hook session_id changes
  private lastExternalSessionId: string | null = null;

  // Prevent overlapping flushes
  private flushInFlight: Promise<void> | null = null;

  constructor(config: Config) {
    this.sessionId = uuidv4();
    this.config = config;
    this.branchName = getCurrentBranch();
    this.modelId = config.modelId;
  }

  /** Override agent identity from MCP clientInfo. Falls back to config when values are absent. */
  setAgentIdentity(agentName: string | null | undefined, agentVersion: string | null | undefined): void {
    this.detectedAgentName = agentName ?? null;
    this.detectedAgentVersion = agentVersion ?? null;
  }

  /** Set or update the model ID for subsequent flush payloads. */
  setModelId(modelId: string | null): void {
    this.modelId = modelId;
  }

  private get effectiveAgentName(): string {
    return this.detectedAgentName || this.config.agentName;
  }

  private get effectiveAgentVersion(): string | null {
    return this.detectedAgentVersion !== null
      ? this.detectedAgentVersion
      : this.config.agentVersion;
  }

  addEntry(
    actionType: ActionType,
    actionDetail: string,
    inputSummary: string | null = null,
    outputSummary: string | null = null,
  ): void {
    if (this.buffer.length >= MAX_BUFFER_ENTRIES && actionType !== ActionType.SessionEnd) {
      if (!this.bufferOverflowWarned) {
        this.bufferOverflowWarned = true;
        console.error(
          `[evidenttrail] Session buffer is full (${MAX_BUFFER_ENTRIES} entries). ` +
            'Further entries will be dropped. Consider using shorter sessions to stay within the backend ingestion limit.',
        );
      }
      return;
    }

    const entry: AgentActionEntryRequest = {
      actionType,
      actionDetail,
      triggerDescription: null,
      inputSummary,
      outputSummary,
      occurredAt: new Date().toISOString(),
      sequenceNumber: ++this.sequenceCounter,
    };
    this.buffer.push(entry);

    // Threshold flush: trigger when buffer hits 20 entries (fire-and-forget, non-blocking)
    if (this.buffer.length >= FLUSH_THRESHOLD_ENTRIES && actionType !== ActionType.SessionEnd) {
      void this.flush();
    }
  }

  /**
   * Called from the HTTP hook server to notify of a new external Claude Code session_id.
   * Flushes the current buffer whenever the session_id changes so each external session
   * is ingested as a coherent batch.
   */
  async noteExternalSession(externalSessionId: string | null): Promise<void> {
    if (
      externalSessionId &&
      this.lastExternalSessionId !== null &&
      this.lastExternalSessionId !== externalSessionId
    ) {
      await this.flush();
    }
    if (externalSessionId) {
      this.lastExternalSessionId = externalSessionId;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Serialize flushes: wait for any in-flight flush to complete before starting a new one
    if (this.flushInFlight) {
      await this.flushInFlight;
      // After the previous flush, buffer may be empty (or have been restored on failure)
      if (this.buffer.length === 0) return;
    }

    this.flushInFlight = this._doFlush();
    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  private async _doFlush(): Promise<void> {
    const entries = [...this.buffer];
    this.buffer = [];

    const payload: IngestAgentSessionRequest = {
      sessionId: this.sessionId,
      agentName: this.effectiveAgentName,
      agentVersion: this.effectiveAgentVersion,
      modelId: this.modelId,
      branchName: this.branchName,
      previousChainHash: this.lastFlushedHash,
      entries,
    };

    try {
      const result = await postIngestSession(this.config, payload);
      if (result?.lastEntryHash) {
        this.lastFlushedHash = result.lastEntryHash;
      }
    } catch {
      // Retry once after 2 seconds — non-fatal, agent must not block on logging failures
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      try {
        const result = await postIngestSession(this.config, payload);
        if (result?.lastEntryHash) {
          this.lastFlushedHash = result.lastEntryHash;
        }
      } catch (err) {
        console.error('[evidenttrail] Failed to flush session data:', err);
        // Restore entries to buffer so they can be retried on the next flush
        this.buffer = [...entries, ...this.buffer];
      }
    }
  }

  async start(): Promise<void> {
    // Buffer only — do not flush here. Deferring to end() or threshold keeps entries
    // in coherent batches so the backend computes correctly linked hash chains.
    this.addEntry(ActionType.SessionStart, 'Session started');
  }

  async end(): Promise<void> {
    this.addEntry(ActionType.SessionEnd, 'Session ended');
    await this.flush();
  }
}
