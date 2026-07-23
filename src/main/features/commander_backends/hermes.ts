export interface CommanderDecision {
  kind: 'reply' | 'dispatch_to' | 'hand_off_to' | 'run_worker' | 'ask_user';
  targetAgentId?: string;
  task?: string;
  message?: string;
  reason?: string;
}

const ALLOWED_KEYS = new Set(['kind', 'targetAgentId', 'task', 'message', 'reason']);
const ALLOWED_KINDS = new Set(['reply', 'dispatch_to', 'hand_off_to', 'run_worker', 'ask_user']);

function extractJsonCandidate(text: string): string {
  const trimmed = String(text || '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1].trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  // Hermes often narrates first and then emits the strict orchestration JSON
  // as the final block. Accept only a balanced JSON object that reaches the
  // end of the output, so examples or prose in the middle are not executed.
  let depth = 0;
  let start = -1;
  let lastCompleteStart = -1;
  let lastCompleteEnd = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) return trimmed;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        lastCompleteStart = start;
        lastCompleteEnd = i;
      }
    }
  }
  if (lastCompleteStart >= 0 && lastCompleteEnd === trimmed.length - 1) {
    return trimmed.slice(lastCompleteStart, lastCompleteEnd + 1).trim();
  }
  return trimmed;
}

export function parseHermesCommanderDecision(text: string): CommanderDecision | null {
  const raw = extractJsonCandidate(text);
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }
  if (typeof obj.kind !== 'string' || !ALLOWED_KINDS.has(obj.kind)) return null;
  const out: CommanderDecision = { kind: obj.kind as CommanderDecision['kind'] };
  for (const key of ['targetAgentId', 'task', 'message', 'reason'] as const) {
    if (obj[key] == null) continue;
    if (typeof obj[key] !== 'string') return null;
    const value = obj[key].trim();
    if (value) out[key] = value;
  }
  if ((out.kind === 'dispatch_to' || out.kind === 'hand_off_to') && (!out.targetAgentId || !out.task)) return null;
  if (out.kind === 'run_worker' && !out.task) return null;
  if ((out.kind === 'reply' || out.kind === 'ask_user') && !out.message) return null;
  return out;
}

export function buildHermesCommanderRepairMessage(originalMessage: string, previousOutput: string): string {
  return [
    'Your previous answer was rejected because it claimed an Agent dispatch had started, but it did not call a platform orchestration tool and did not return executable JSON.',
    'You must now output EXACTLY ONE strict JSON object and nothing else: no markdown, no explanation, no "started/running" prose.',
    'If you intended to run a worker or named Agent, use one of:',
    '{"kind":"run_worker","targetAgentId":"Agent name or id","task":"task text","reason":"short reason"}',
    '{"kind":"dispatch_to","targetAgentId":"Agent name or id","task":"task text","reason":"short reason"}',
    '{"kind":"hand_off_to","targetAgentId":"Agent name or id","task":"task text","reason":"short reason"}',
    'If no Agent should run, use {"kind":"reply","message":"..."}.',
    '',
    '<original-user-message>',
    originalMessage,
    '</original-user-message>',
    '',
    '<rejected-previous-output>',
    previousOutput,
    '</rejected-previous-output>',
  ].join('\n');
}

const DISPATCH_CLAIM_PATTERNS = [
  /delegation_id\s*[:：]\s*deleg_[A-Za-z0-9_-]+/i,
  /(?:已|真正|已经)\s*(?:启动|派发|调度|dispatch)/i,
  /(?:后台|并行).*?(?:运行中|执行中|跑)/i,
  /(?:运行中|执行中).*?(?:@|agent|Agent|智能体)/i,
];

const NON_EXECUTION_HINTS = [
  /还没有执行/,
  /未执行/,
  /没有(?:真正)?(?:启动|调度|dispatch)/i,
  /建议.*(?:dispatch_to|调度|派发)/i,
];

export function hasHermesCommanderDispatchClaim(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (NON_EXECUTION_HINTS.some((pattern) => pattern.test(value))) return false;
  return DISPATCH_CLAIM_PATTERNS.some((pattern) => pattern.test(value));
}
