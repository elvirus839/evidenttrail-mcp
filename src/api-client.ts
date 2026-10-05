import type { Config, IngestAgentSessionRequest } from './types.js';

const INGEST_TIMEOUT_MS = 10_000;

export interface IngestSessionResult {
  lastEntryHash: string | null;
}

export async function postIngestSession(
  config: Config,
  payload: IngestAgentSessionRequest,
): Promise<IngestSessionResult> {
  const url = new URL('/api/agent-action-logs/ingest', config.apiUrl);
  url.searchParams.set('repositoryId', config.repositoryId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EvidentTrail-Key': config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ingest failed: ${response.status} ${response.statusText}`);
    }

    try {
      const body = await response.json() as { lastEntryHash?: string | null };
      return { lastEntryHash: body?.lastEntryHash ?? null };
    } catch {
      // Non-JSON or empty body — hash chaining will restart from null on the next batch
      return { lastEntryHash: null };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
