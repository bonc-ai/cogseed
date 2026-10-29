import { createHash } from 'node:crypto';

/** Pure orchestration: caller owns model dispatch, prompt loading and persistence.
 * Coverage proves that every source slice was submitted and validated, not that
 * the model understood it. Literal evidence validation cannot prove semantics. */
export interface CaptureContextMessage { id: string; role: string; text: string; ts?: string; discovery?: boolean; observations?: readonly unknown[] }
export interface CaptureContextEvidence { messageId: string; quote: string; role: string; start: number; end: number }
export interface CaptureContextTopic {
  title: string;
  content: string;
  conditions: string[];
  unresolved: string[];
  attribution: 'user_requirement' | 'assistant_proposal' | 'source_observation' | 'mixed';
  evidence: CaptureContextEvidence[];
}
export interface CaptureContextCheckpoint {
  version: 1;
  sourceDigest: string;
  maxInputChars: number;
  chunks: Array<{ id: string; coveredIds: string[]; topics: CaptureContextTopic[] }>;
  merges?: Array<{ id: string; inputIds: string[]; coveredIds: string[]; topics: CaptureContextTopic[]; topicInputIds: string[][] }>;
}
export interface CaptureContextSummary {
  sourceDigest: string;
  topics: CaptureContextTopic[];
  completedAt: string;
  coverage: { messageCount: number; sourceChars: number; segmentCount: number; processedSegmentIds: string[]; maxInputChars: number };
}

/** Contiguous summary passages may jointly cover a value quote. Never join
 * across a gap, a different message, or an assistant-authored passage. */
export function summaryCoversUserQuote(summary: CaptureContextSummary, messageId: string, quote: string): boolean {
  const passages = summary.topics.flatMap(topic => topic.evidence)
    .filter(ref => ref.messageId === messageId && ref.role === 'user')
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let combined = '', start = -1, end = -1;
  for (const ref of passages) {
    if (start < 0 || ref.start > end) { combined = ref.quote; start = ref.start; end = ref.end; }
    else if (ref.end > end) { combined += ref.quote.slice(end - ref.start); end = ref.end; }
    if (combined.includes(quote)) return true;
  }
  return false;
}
export interface CaptureContextSummaryOptions {
  run: (inputJson: string) => Promise<string>;
  shouldContinue?: () => Promise<boolean>;
  checkpoint?: CaptureContextCheckpoint;
  onCheckpoint?: (checkpoint: CaptureContextCheckpoint) => Promise<void> | void;
  maxInputChars?: number;
}
export class CaptureContextInterruptedError extends Error {
  constructor(public readonly checkpoint: CaptureContextCheckpoint) {
    super('capture context summary interrupted');
    this.name = 'CaptureContextInterruptedError';
  }
}
type Segment = { id: string; messageId: string; role: string; discovery: boolean; start: number; end: number; text: string; ts?: string; observations?: readonly unknown[] };
type Node = { id: string; topics: CaptureContextTopic[] };
const MAX_OUTPUT_CHARS = 16_000;
function fail(reason: string): never { throw new Error(`invalid capture context summary: ${reason}`); }
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail('object shape');
  return value as Record<string, any>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('text size or shape');
  return value as string;
}
function strings(value: unknown, max = 16): string[] {
  if (!Array.isArray(value) || value.length > max) fail('list shape');
  return value.map(item => string(item, 2_000));
}
function sameIds(value: unknown, expected: string[]): string[] {
  const ids = strings(value, Math.max(expected.length, 1));
  if (ids.length !== expected.length || new Set(ids).size !== ids.length
    || ids.some(id => !expected.includes(id))) fail('incomplete coverage');
  return ids;
}
function parseTopics(value: unknown, messages: readonly CaptureContextMessage[], segments?: Segment[], allowed?: CaptureContextEvidence[], inputTopicIds?: string[]): CaptureContextTopic[] {
  if (!Array.isArray(value) || value.length > 64) fail('topics shape');
  if (segments?.some(segment => segment.text.trim()) && !value.length) fail('nonempty source requires a topic');
  const mapped: string[] = [];
  const topics = value.map(item => {
    const topic = object(item, ['id', 'title', 'content', 'conditions', 'unresolved', 'attribution', 'evidence', ...(inputTopicIds ? ['inputIds'] : [])]);
    // Some providers add a local topic annotation despite the closed output contract.
    // It carries no identity/reference authority and is dropped, never stored or used for coverage.
    if (topic.id !== undefined && (typeof topic.id !== 'string' || !topic.id.trim() || topic.id.length > 200)) fail('invalid topic annotation');
    if (inputTopicIds) {
      const ids = strings(topic.inputIds, inputTopicIds.length);
      if (!ids.length || ids.some(id => !inputTopicIds.includes(id))) fail('unknown input topic');
      mapped.push(...ids);
    }
    if (!['user_requirement', 'assistant_proposal', 'source_observation', 'mixed'].includes(topic.attribution)) fail('attribution');
    if (!Array.isArray(topic.evidence) || !topic.evidence.length || topic.evidence.length > 32) fail('evidence shape');
    const evidence: CaptureContextEvidence[] = topic.evidence.map((item: unknown) => {
      const entry = object(item, ['messageId', 'quote', 'role', 'start', 'end']);
      const message = messages.find(message => message.id === entry.messageId);
      const quote = string(entry.quote, 1_000);
      if (!message) fail('unknown message');
      let start: number;
      if (segments) {
        const segment = segments.find(segment => segment.messageId === message.id && segment.text.includes(quote)
          && (entry.start === undefined || (Number.isInteger(entry.start) && entry.start >= segment.start
            && entry.start + quote.length <= segment.end && message.text.slice(entry.start, entry.start + quote.length) === quote)));
        if (!segment) fail('quote outside submitted source');
        start = entry.start ?? segment.start + segment.text.indexOf(quote);
      } else {
        const original = allowed?.find(evidence => evidence.messageId === message.id && evidence.quote === quote
          && (entry.start === undefined || evidence.start === entry.start));
        if (!original) fail('quote outside input evidence');
        start = original.start;
      }
      if (message.text.slice(start, start + quote.length) !== quote) fail('fabricated quote');
      if (entry.role !== undefined && entry.role !== message.role) fail('fabricated role');
      if (entry.start !== undefined && entry.start !== start) fail('fabricated offset');
      if (entry.end !== undefined && entry.end !== start + quote.length) fail('fabricated offset');
      return { messageId: message.id, quote, role: message.role, start, end: start + quote.length };
    });
    if (topic.attribution === 'user_requirement' && !evidence.some(item => item.role === 'user')) fail('user attribution lacks user evidence');
    if (topic.attribution === 'assistant_proposal' && !evidence.some(item => item.role === 'assistant')) fail('assistant attribution lacks assistant evidence');
    return { title: string(topic.title, 200), content: string(topic.content, 4_000), conditions: strings(topic.conditions),
      unresolved: strings(topic.unresolved), attribution: topic.attribution, evidence } as CaptureContextTopic;
  });
  if (inputTopicIds && inputTopicIds.some(id => !mapped.includes(id))) fail('dropped input topic');
  return topics;
}
function parse(raw: string): Record<string, any> {
  if (typeof raw !== 'string' || raw.length > MAX_OUTPUT_CHARS) fail('output too large');
  return object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), ['coveredIds', 'topics']);
}
const snapshot = (checkpoint: CaptureContextCheckpoint): CaptureContextCheckpoint => JSON.parse(JSON.stringify(checkpoint));

/** Hashes exact message text and ordered provenance; does not normalize text. */
export function captureContextSourceDigest(messages: readonly CaptureContextMessage[]): string {
  const seen = new Set<string>();
  for (const message of messages) {
    string(message.id, 200); string(message.role, 100);
    if (typeof message.text !== 'string' || (message.discovery !== undefined && typeof message.discovery !== 'boolean') || seen.has(message.id)) fail('messages');
    seen.add(message.id);
  }
  return createHash('sha256').update(JSON.stringify(messages.map(({ id, role, text, discovery, observations }) => ({ id, role, text, discovery: !!discovery, ...(observations?.length ? { observations } : {}) })))).digest('hex');
}

function sourceSegments(messages: readonly CaptureContextMessage[], maxInputChars: number): Segment[] {
  if (!Number.isInteger(maxInputChars) || maxInputChars < 2_000 || maxInputChars > 100_000) fail('input limit');
  // JSON escaping can expand each source code unit sixfold. This conservative
  // bound leaves envelope space and never trims or normalizes the source.
  const sliceSize = Math.floor((maxInputChars - 1_000) / 8);
  const segments: Segment[] = [];
  messages.forEach((message, index) => {
    for (let start = 0; start < message.text.length || start === 0; start += sliceSize) {
      let end = Math.min(start + sliceSize, message.text.length);
      // Preserve UTF-16 coordinates, while avoiding broken astral characters.
      if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1])) end--;
      segments.push({ id: `m${index}:${start}`, messageId: message.id, role: message.role, discovery: !!message.discovery,
        start, end, text: message.text.slice(start, end), ...(message.ts ? { ts: message.ts } : {}), ...(start === 0 && message.observations?.length ? { observations: message.observations } : {}) });
      if (end < start + sliceSize) start = end - sliceSize;
      if (!message.text.length) break;
    }
  });
  return segments;
}

/** Revalidates persisted output without model calls. Checks structural coverage
 * and literal evidence only; it cannot establish correctness of summary meaning. */
export function validateCaptureContextSummary(summary: unknown, messages: readonly CaptureContextMessage[]): CaptureContextSummary {
  const result = object(summary, ['sourceDigest', 'topics', 'completedAt', 'coverage']);
  const sourceDigest = captureContextSourceDigest(messages);
  if (result.sourceDigest !== sourceDigest) fail('stored source digest mismatch');
  if (typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))
    || new Date(result.completedAt).toISOString() !== result.completedAt) fail('completion timestamp');
  const coverage = object(result.coverage, ['messageCount', 'sourceChars', 'segmentCount', 'processedSegmentIds', 'maxInputChars']);
  const segments = sourceSegments(messages, coverage.maxInputChars);
  const sourceChars = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (coverage.messageCount !== messages.length || coverage.sourceChars !== sourceChars || coverage.segmentCount !== segments.length) fail('stored source coverage');
  sameIds(coverage.processedSegmentIds, segments.map(segment => segment.id));
  // All stored coordinates must independently resolve against the original JS
  // string, before they can be reused as allowed merge evidence.
  if (!Array.isArray(result.topics) || result.topics.length > 64) fail('topics shape');
  const evidence: CaptureContextEvidence[] = [];
  for (const topic of result.topics) {
    if (!topic || !Array.isArray(topic.evidence) || topic.evidence.length > 32) fail('evidence shape');
    for (const item of topic.evidence) {
      const entry = object(item, ['messageId', 'quote', 'role', 'start', 'end']);
      const message = messages.find(message => message.id === entry.messageId);
      const quote = string(entry.quote, 1_000);
      if (!message || entry.role !== message.role || !Number.isInteger(entry.start) || !Number.isInteger(entry.end)
        || entry.start < 0 || entry.end !== entry.start + quote.length || entry.end > message.text.length
        || message.text.slice(entry.start, entry.end) !== quote) fail('stored literal evidence');
      evidence.push({ messageId: message.id, role: message.role, quote, start: entry.start, end: entry.end });
    }
  }
  if (segments.some(segment => segment.text.trim()) && !result.topics.length) fail('nonempty source requires a topic');
  const topics = parseTopics(result.topics, messages, undefined, evidence);
  return { sourceDigest, completedAt: result.completedAt, topics, coverage: { messageCount: messages.length, sourceChars,
    segmentCount: segments.length, processedSegmentIds: [...coverage.processedSegmentIds], maxInputChars: coverage.maxInputChars } };
}

export async function summarizeCaptureContext(messages: readonly CaptureContextMessage[], options: CaptureContextSummaryOptions): Promise<CaptureContextSummary> {
  const maxInputChars = options.maxInputChars ?? 24_000;
  if (!Number.isInteger(maxInputChars) || maxInputChars < 2_000 || maxInputChars > 100_000) fail('input limit');
  const sourceDigest = captureContextSourceDigest(messages);
  const segments = sourceSegments(messages, maxInputChars);
  const outputBudgetChars = Math.min(MAX_OUTPUT_CHARS, Math.floor(maxInputChars * 0.4) - 100);
  const chunkEnvelope = (segments: Segment[]) => ({ stage: 'chunk', outputBudgetChars, segments });
  const mergeEnvelope = (inputs: Node[]) => ({ stage: 'merge', outputBudgetChars, inputs: inputs.map(node => ({ id: node.id,
    topics: node.topics.map((topic, i) => ({ id: `${node.id}:t${i}`, ...topic })) })) });
  const chunks: Segment[][] = [];
  for (const segment of segments) {
    const current = chunks.at(-1);
    if (current && JSON.stringify(chunkEnvelope([...current, segment])).length <= maxInputChars) current.push(segment);
    else {
      if (JSON.stringify(chunkEnvelope([segment])).length > maxInputChars) fail('source envelope too large');
      chunks.push([segment]);
    }
  }
  const checkpoint: CaptureContextCheckpoint = { version: 1, sourceDigest, maxInputChars, chunks: [], merges: [] };
  if (options.checkpoint) {
    const resumed = options.checkpoint;
    if (resumed.version !== 1 || resumed.sourceDigest !== sourceDigest || resumed.maxInputChars !== maxInputChars || !Array.isArray(resumed.chunks) || resumed.chunks.length > chunks.length) fail('checkpoint mismatch');
    resumed.chunks.forEach((chunk, index) => {
      if (chunk.id !== `c${index}`) fail('checkpoint order');
      const coveredIds = sameIds(chunk.coveredIds, chunks[index].map(segment => segment.id));
      const topics = parseTopics(chunk.topics, messages, chunks[index]);
      if (JSON.stringify({ id: 'budget', topics }).length > outputBudgetChars) fail('checkpoint summary exceeds budget');
      checkpoint.chunks.push({ id: chunk.id, coveredIds, topics });
    });
  }
  // Validate the stored merge DAG in topological order before reusing any node.
  const cached = new Map<string, NonNullable<CaptureContextCheckpoint['merges']>[number]>();
  const known = new Map<string, Node>(checkpoint.chunks.map(node => [node.id, node]));
  if (options.checkpoint?.merges !== undefined && !Array.isArray(options.checkpoint.merges)) fail('checkpoint merges');
  for (const merge of options.checkpoint?.merges ?? []) {
    if (!merge || typeof merge.id !== 'string' || known.has(merge.id) || !Array.isArray(merge.inputIds)
      || merge.inputIds.length < 2 || new Set(merge.inputIds).size !== merge.inputIds.length) fail('checkpoint merge DAG');
    const inputs = merge.inputIds.map(id => known.get(id) ?? fail('checkpoint missing merge input'));
    if (inputs.some(node => !node)) fail('checkpoint missing merge input');
    sameIds(merge.coveredIds, merge.inputIds);
    if (!Array.isArray(merge.topicInputIds) || merge.topicInputIds.length !== merge.topics?.length) fail('checkpoint topic mapping');
    const inputTopicIds = inputs.flatMap(node => node.topics.map((_, i) => `${node.id}:t${i}`));
    const topics = parseTopics(merge.topics.map((topic, i) => ({ ...topic, inputIds: merge.topicInputIds[i] })), messages,
      undefined, inputs.flatMap(node => node.topics.flatMap(topic => topic.evidence)), inputTopicIds);
    if (JSON.stringify({ id: 'budget', topics }).length > outputBudgetChars) fail('checkpoint merge exceeds budget');
    const validated = { id: merge.id, inputIds: [...merge.inputIds], coveredIds: [...merge.coveredIds], topics,
      topicInputIds: merge.topicInputIds.map(ids => [...ids]) };
    const key = JSON.stringify(merge.inputIds);
    if (cached.has(key)) fail('duplicate checkpoint merge');
    cached.set(key, validated); known.set(merge.id, validated); checkpoint.merges!.push(validated);
  }
  const continueOrThrow = async () => {
    if (options.shouldContinue && !await options.shouldContinue()) throw new CaptureContextInterruptedError(snapshot(checkpoint));
  };
  const inputTopicIds = (inputs: Node[]) => inputs.flatMap(node => node.topics.map((_, i) => `${node.id}:t${i}`));
  // A response may fit the runner's output limit while being too large to pair
  // with another node. Compress at most twice; never truncate source or evidence.
  const fit = async (topics: CaptureContextTopic[], mappings?: string[][]) => {
    let current = topics;
    let currentMappings = mappings;
    for (let attempt = 0; JSON.stringify({ id: 'budget', topics: current }).length > outputBudgetChars; attempt++) {
      if (attempt >= 2) fail('summary compression budget exhausted');
      await continueOrThrow();
      const node = { id: `compress${attempt}`, topics: current };
      const input = JSON.stringify({ ...mergeEnvelope([node]), compression: true });
      if (input.length > maxInputChars) fail('compression input too large');
      const result = parse(await options.run(input));
      sameIds(result.coveredIds, [node.id]);
      const compressed = parseTopics(result.topics, messages, undefined, current.flatMap(topic => topic.evidence), inputTopicIds([node]));
      const preserved = compressed.flatMap(topic => topic.evidence);
      if (current.flatMap(topic => topic.evidence).some(entry => !preserved.some(item =>
        item.messageId === entry.messageId && item.quote === entry.quote && item.start === entry.start && item.end === entry.end))) fail('compression dropped evidence');
      if (currentMappings) {
        const previousMappings = currentMappings;
        currentMappings = result.topics.map((topic: any) => [...new Set(topic.inputIds.flatMap((id: string) =>
          previousMappings[Number(id.slice(id.lastIndexOf(':t') + 2))]))]) as string[][];
      }
      current = compressed;
    }
    return { topics: current, mappings: currentMappings };
  };
  for (let index = checkpoint.chunks.length; index < chunks.length; index++) {
    await continueOrThrow();
    const result = parse(await options.run(JSON.stringify(chunkEnvelope(chunks[index]))));
    const coveredIds = sameIds(result.coveredIds, chunks[index].map(segment => segment.id));
    const fitted = await fit(parseTopics(result.topics, messages, chunks[index]));
    checkpoint.chunks.push({ id: `c${index}`, coveredIds, topics: fitted.topics });
    await options.onCheckpoint?.(snapshot(checkpoint));
  }
  let nodes: Node[] = checkpoint.chunks.map(({ id, topics }) => ({ id, topics }));
  let level = 0;
  const usedCached = new Set<string>();
  while (nodes.length > 1) {
    const next: Node[] = [];
    for (let index = 0; index < nodes.length;) {
      const group: Node[] = [nodes[index++]];
      while (index < nodes.length && JSON.stringify(mergeEnvelope([...group, nodes[index]])).length <= maxInputChars) group.push(nodes[index++]);
      if (group.length === 1) {
        if (index < nodes.length || next.length === nodes.length - 1) fail('merge cannot fit two summaries');
        next.push(group[0]); continue;
      }
      const key = JSON.stringify(group.map(node => node.id));
      const reused = cached.get(key);
      if (reused) { usedCached.add(key); next.push(reused); continue; }
      await continueOrThrow();
      const result = parse(await options.run(JSON.stringify(mergeEnvelope(group))));
      sameIds(result.coveredIds, group.map(node => node.id));
      const topics = parseTopics(result.topics, messages, undefined, group.flatMap(node => node.topics.flatMap(topic => topic.evidence)), inputTopicIds(group));
      const fitted = await fit(topics, result.topics.map((topic: any) => topic.inputIds));
      const merged = { id: `l${level}:n${next.length}`, inputIds: group.map(node => node.id), coveredIds: group.map(node => node.id),
        topics: fitted.topics, topicInputIds: fitted.mappings! };
      if (known.has(merged.id)) fail('checkpoint merge plan mismatch');
      known.set(merged.id, merged); checkpoint.merges!.push(merged);
      next.push(merged);
      await options.onCheckpoint?.(snapshot(checkpoint));
    }
    nodes = next; level++;
  }
  if (usedCached.size !== cached.size) fail('unused checkpoint merge');
  await continueOrThrow();
  return { sourceDigest, topics: nodes[0]?.topics ?? [], completedAt: new Date().toISOString(),
    coverage: { messageCount: messages.length, sourceChars: messages.reduce((sum, message) => sum + message.text.length, 0),
      segmentCount: segments.length, processedSegmentIds: checkpoint.chunks.flatMap(chunk => chunk.coveredIds), maxInputChars } };
}
