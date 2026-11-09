/**
 * Local prefix diagnostics for the final pi-ai onPayload value, never PiContext.
 * Logical order: one system envelope, one ordered tool-list envelope, then each
 * wire history item. Leading system/developer messages join the system envelope;
 * later instructions stay in history so their position is never normalized away.
 * This is neither a tokenizer nor evidence of a server cache hit or HTTP success.
 *
 * Only keyed digests, byte lengths, counts and fixed enums escape. The random key
 * lives in this audit instance; raw payloads/identities and keys are never retained
 * in baselines or reports. Serialization is incremental, bounded and order-sensitive.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const REQUEST_PREFIX_AUDIT_LIMITS = Object.freeze({
  sessions: 32,
  blocks: 512,
  bytes: 1024 * 1024,
  nodes: 32_768,
  depth: 32,
});

export interface PrefixAuditIdentity {
  api: string;
  provider: string;
  model: string;
  baseUrl?: string;
  sessionId?: string;
}

type Kind = 'system' | 'tool' | 'history';
type Digest = { hash: string; bytes: number };
type Summary = Digest & { blocks: number; system: number; tools: number; history: number };
type Snapshot = { summary: Summary; blocks: Digest[] };
type SkipReason = 'missing_session' | 'unsupported_payload' | 'limit';

export interface PrefixAuditReport {
  version: 1;
  status: 'initial' | 'equal' | 'append_only' | 'rewrite' | 'skipped';
  reason?: SkipReason;
  scopeHash?: string;
  previous?: Summary;
  current?: Summary;
  commonBlocks?: number;
  /** Whole matching logical blocks, not provider token counts or HTTP bytes. */
  commonPrefixBytes?: number;
  currentSuffixBytes?: number;
  previousSuffixBytes?: number;
  firstChanged?: {
    index: number;
    kind: Kind;
    sectionIndex: number;
    before: Digest | null;
    after: Digest | null;
  };
}

class AuditSkip {
  constructor(readonly reason: SkipReason) {}
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditSkip('unsupported_payload');
  return value as Record<string, unknown>;
}

/** JSON-equivalent scalars/containers, including object insertion order. Does not
 * invoke toJSON, build a full serialized request, or retain a raw string. */
function digest(key: Buffer, value: unknown, budget: { bytes: number; nodes: number }): Digest {
  const hash = createHmac('sha256', key);
  const ancestors = new Set<object>();
  let bytes = 0;
  const write = (text: string) => {
    const length = Buffer.byteLength(text, 'utf8');
    if (budget.bytes + length > REQUEST_PREFIX_AUDIT_LIMITS.bytes) throw new AuditSkip('limit');
    budget.bytes += length;
    bytes += length;
    hash.update(text);
  };
  const scalar = (value: string | number | boolean | null) => {
    // Bound the temporary escaped string too (at most 6x the remaining budget).
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > REQUEST_PREFIX_AUDIT_LIMITS.bytes - budget.bytes) {
      throw new AuditSkip('limit');
    }
    write(JSON.stringify(value));
  };
  const visit = (item: unknown, depth: number) => {
    if (++budget.nodes > REQUEST_PREFIX_AUDIT_LIMITS.nodes || depth > REQUEST_PREFIX_AUDIT_LIMITS.depth) throw new AuditSkip('limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      scalar(item as string | number | boolean | null);
      return;
    }
    if (typeof item !== 'object' || !item) throw new AuditSkip('unsupported_payload');
    if (ancestors.has(item)) throw new AuditSkip('unsupported_payload');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > REQUEST_PREFIX_AUDIT_LIMITS.nodes - budget.nodes) throw new AuditSkip('limit');
      write('[');
      for (let i = 0; i < item.length; i++) {
        if (i) write(',');
        visit(item[i] === undefined ? null : item[i], depth + 1);
      }
      write(']');
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) throw new AuditSkip('unsupported_payload');
      write('{');
      let first = true;
      for (const name in item) {
        if (!Object.hasOwn(item, name)) continue;
        if (++budget.nodes > REQUEST_PREFIX_AUDIT_LIMITS.nodes) throw new AuditSkip('limit');
        const child = (item as Record<string, unknown>)[name];
        if (child === undefined) continue;
        if (!first) write(',');
        first = false;
        scalar(name);
        write(':');
        visit(child, depth + 1);
      }
      write('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return { hash: hash.digest('hex'), bytes };
}

function snapshot(key: Buffer, api: string, payload: unknown): Snapshot {
  const body = record(payload);
  let history: unknown[];
  let source: string;
  let system: unknown;
  let tools: unknown;
  let systemCount = 0;
  let leading = 0;
  let stringInput = false;
  switch (api) {
    case 'openai-completions':
    case 'anthropic-messages':
      source = 'messages';
      history = body.messages as unknown[];
      system = { system: body.system };
      systemCount = body.system === undefined ? 0 : Array.isArray(body.system) ? body.system.length : 1;
      tools = body.tools;
      break;
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
      source = 'input';
      stringInput = typeof body.input === 'string';
      history = stringInput ? [body.input] : body.input as unknown[];
      system = { instructions: body.instructions };
      systemCount = body.instructions === undefined ? 0 : 1;
      tools = body.tools;
      break;
    case 'google-generative-ai':
    case 'google-vertex': {
      source = 'contents';
      history = body.contents as unknown[];
      const config = record(body.config);
      system = { systemInstruction: config.systemInstruction };
      systemCount = config.systemInstruction === undefined ? 0 : 1;
      tools = config.tools;
      break;
    }
    default:
      throw new AuditSkip('unsupported_payload');
  }
  if (!Array.isArray(history) || (tools !== undefined && !Array.isArray(tools))) throw new AuditSkip('unsupported_payload');
  // Includes both section envelopes; no truncated snapshot can claim equality.
  if (history.length + 2 > REQUEST_PREFIX_AUDIT_LIMITS.blocks) throw new AuditSkip('limit');
  if (source !== 'contents' && !stringInput) {
    while (leading < history.length) {
      const item = history[leading] as Record<string, unknown> | null;
      if (!item || (item.role !== 'system' && item.role !== 'developer')) break;
      leading++;
    }
  }
  const budget = { bytes: 0, nodes: 0 };
  const blocks: Digest[] = [
    digest(key, { source, stringInput, root: system, leading: history.slice(0, leading) }, budget),
    digest(key, { tools }, budget),
  ];
  for (let i = leading; i < history.length; i++) blocks.push(digest(key, history[i], budget));
  // Fixed-size block digests form an unambiguous ordered aggregate.
  const aggregate = createHmac('sha256', key);
  for (const block of blocks) aggregate.update(block.hash);
  return {
    blocks,
    summary: {
      hash: aggregate.digest('hex'), bytes: budget.bytes, blocks: blocks.length,
      system: systemCount + leading, tools: (tools as unknown[] | undefined)?.length ?? 0,
      history: history.length - leading,
    },
  };
}

/** One instance per process in pi-provider; LRU persists across provider factories.
 * Baselines retain at most sessions × blocks digest/length pairs, never payloads. */
export function createRequestPrefixAudit(): { observe(identity: PrefixAuditIdentity, payload: unknown): PrefixAuditReport } {
  const key = randomBytes(32);
  const baselines = new Map<string, Snapshot>();
  return {
    observe(identity, payload) {
      let scopeHash: string | undefined;
      try {
        if (!identity.sessionId) return { version: 1, status: 'skipped', reason: 'missing_session' };
        scopeHash = digest(key, {
          api: identity.api, provider: identity.provider, model: identity.model,
          baseUrl: identity.baseUrl, sessionId: identity.sessionId,
        }, { bytes: 0, nodes: 0 }).hash;
        const current = snapshot(key, identity.api, payload);
        const previous = baselines.get(scopeHash);
        baselines.delete(scopeHash);
        baselines.set(scopeHash, current);
        if (baselines.size > REQUEST_PREFIX_AUDIT_LIMITS.sessions) baselines.delete(baselines.keys().next().value!);
        // Return fresh summaries and block descriptors so callers cannot mutate
        // retained baselines through a logger or diagnostic consumer.
        const report: PrefixAuditReport = { version: 1, scopeHash, status: 'initial', current: { ...current.summary } };
        if (!previous) return report;
        report.previous = { ...previous.summary };
        let common = 0;
        while (common < previous.blocks.length && common < current.blocks.length && previous.blocks[common].hash === current.blocks[common].hash) common++;
        report.commonBlocks = common;
        report.commonPrefixBytes = current.blocks.slice(0, common).reduce((sum, block) => sum + block.bytes, 0);
        report.currentSuffixBytes = current.summary.bytes - report.commonPrefixBytes;
        report.previousSuffixBytes = previous.summary.bytes - report.commonPrefixBytes;
        report.status = common === previous.blocks.length
          ? common === current.blocks.length ? 'equal' : 'append_only'
          : 'rewrite';
        if (report.status !== 'equal') {
          report.firstChanged = {
            index: common,
            kind: common === 0 ? 'system' : common === 1 ? 'tool' : 'history',
            sectionIndex: Math.max(0, common - 2),
            before: previous.blocks[common] ? { ...previous.blocks[common] } : null,
            after: current.blocks[common] ? { ...current.blocks[common] } : null,
          };
        }
        return report;
      } catch (error) {
        // Never stringify exceptions: getters/serialization errors may contain
        // user content. A skipped observation breaks continuity for this scope.
        if (scopeHash) baselines.delete(scopeHash);
        return { version: 1, status: 'skipped', reason: error instanceof AuditSkip ? error.reason : 'unsupported_payload', ...(scopeHash ? { scopeHash } : {}) };
      }
    },
  };
}
