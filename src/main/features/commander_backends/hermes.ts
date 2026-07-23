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
  return (fenced ? fenced[1] : trimmed).trim();
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
