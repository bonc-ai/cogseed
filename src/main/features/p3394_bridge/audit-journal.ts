import { createLogger } from '../../logger';
import { appendJsonlAtomic } from '../../storage';

export interface P3394AuditRecord { event: string; actor_id: string; target_id?: string; status: 'accepted' | 'rejected' | 'replayed' | 'failed'; metadata?: Record<string, unknown>; at: string }

const log = createLogger('p3394-bridge:audit-journal');

const SECRET_KEYS = /secret|token|password|credential|api[_-]?key|authorization/i;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v);
    return out;
  }
  return value;
}

export interface P3394AuditJournalOptions {
  /** Optional append-only JSONL persistence target (e.g. Agent Home audit dir). */
  filePath?: string;
}

export class P3394AuditJournal {
  private records: P3394AuditRecord[] = [];
  private readonly filePath: string | null;

  constructor(options: P3394AuditJournalOptions = {}) {
    this.filePath = options.filePath ?? null;
  }

  append(input: Omit<P3394AuditRecord, 'at'> & { at?: string }): P3394AuditRecord {
    const record: P3394AuditRecord = { ...input, ...(input.metadata ? { metadata: redact(input.metadata) as Record<string, unknown> } : {}), at: input.at ?? new Date().toISOString() };
    this.records.push(record);
    if (this.filePath) {
      void appendJsonlAtomic(this.filePath, record).catch((error) => {
        log.warn('P3394 audit journal append failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return record;
  }

  list(): P3394AuditRecord[] { return this.records.map((r) => ({ ...r, metadata: r.metadata ? { ...r.metadata } : undefined })); }
}
