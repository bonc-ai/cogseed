/**
 * P3394 Reduced Profiles and Mapping Reports (guide §12, SDK design §13).
 *
 * When a P3394 node addresses something that is NOT a full P3394 peer
 * (an A2A agent, an MCP server, an OpenAI-compatible model API, or a
 * proprietary endpoint), the adapter must DECLARE what the binding
 * preserves, synthesizes and drops — never silently degrade semantics.
 * A mapping that drops a required UMF field fails negotiation.
 */

export type P3394ReducedTarget = 'p3394-native' | 'a2a' | 'mcp' | 'openai-model' | 'proprietary';

export type P3394FieldDisposition = 'preserved' | 'synthesized' | 'dropped';

export interface P3394FieldMapping {
  field: string;
  disposition: P3394FieldDisposition;
  /** Target-protocol field or behaviour carrying the UMF semantic. */
  target?: string;
  note?: string;
}

export interface P3394MappingReport {
  source: 'p3394-umf/1.0';
  target: P3394ReducedTarget;
  /** Session semantics the binding can honour (guide §12 table). */
  session_semantics: 'full' | 'binding-mapped' | 'restricted' | 'local-bridge';
  fields: P3394FieldMapping[];
}

/** UMF fields a binding must preserve to remain a valid P3394 channel. */
export const P3394_REQUIRED_UMF_FIELDS = [
  'message_id',
  'session_id',
  'sender.agent_id',
  'recipients',
  'payload.parts',
] as const;

/** Maps one UMF field for the given target with per-binding rules. */
function mapFor(target: P3394ReducedTarget, field: string): P3394FieldMapping {
  switch (target) {
    case 'p3394-native':
      return { field, disposition: 'preserved' };
    case 'a2a':
      if (field === 'session_id') return { field, disposition: 'synthesized', target: 'contextId', note: 'mapped to A2A contextId' };
      if (field === 'task_id') return { field, disposition: 'preserved', target: 'taskId' };
      if (field === 'kind') return { field, disposition: 'dropped', note: 'A2A has no UMF kind; message/task mapping decides' };
      if (field === 'performative') return { field, disposition: 'dropped', note: 'A2A roles decide requester/responder' };
      if (field === 'payload.parts') return { field, disposition: 'synthesized', target: 'message.parts' };
      if (field === 'extensions') return { field, disposition: 'synthesized', target: 'message.metadata', note: 'namespaced keys only' };
      return { field, disposition: 'preserved' };
    case 'mcp':
      if (field === 'session_id') return { field, disposition: 'synthesized', target: 'local session binding', note: 'MCP has no agent session; the bridge keeps the P3394 session' };
      if (field === 'task_id') return { field, disposition: 'synthesized', target: 'tool call id' };
      if (field === 'kind') return { field, disposition: 'dropped', note: 'tool calls carry no UMF kind' };
      if (field === 'performative') return { field, disposition: 'dropped', note: 'tool calls are always requests' };
      if (field === 'payload.parts') return { field, disposition: 'synthesized', target: 'tool arguments/content' };
      if (field === 'recipients') return { field, disposition: 'synthesized', target: 'recorded by the local bridge', note: 'capability node addressing is 1:1; the bridge records recipients' };
      return { field, disposition: 'preserved' };
    case 'openai-model':
      if (field === 'session_id') return { field, disposition: 'synthesized', target: 'bridge-held session', note: 'the model has no session; the local bridge keeps it' };
      if (field === 'task_id') return { field, disposition: 'synthesized', target: 'request id (local)' };
      if (field === 'kind') return { field, disposition: 'dropped' };
      if (field === 'performative') return { field, disposition: 'dropped', note: 'a model call is always a request' };
      if (field === 'sender.agent_id') return { field, disposition: 'synthesized', target: 'caller id recorded by the local bridge' };
      if (field === 'recipients') return { field, disposition: 'synthesized', target: 'recorded by the local bridge', note: 'model endpoints have no agent addressing; the bridge records recipients' };
      if (field === 'payload.parts') return { field, disposition: 'synthesized', target: 'messages[]' };
      return { field, disposition: 'preserved' };
    case 'proprietary':
      return { field, disposition: 'synthesized', target: 'adapter-defined', note: 'proprietary bindings must declare their own report' };
    default:
      return { field, disposition: 'dropped' };
  }
}

const UMF_FIELDS = [
  'spec_version',
  'message_id',
  'session_id',
  'task_id',
  'kind',
  'performative',
  'role',
  'sender.agent_id',
  'sender.alias',
  'sender.channel_instance_id',
  'sender.delegation',
  'recipients',
  'payload.parts',
  'payload.metadata',
  'reply_to',
  'traceparent',
  'extensions',
  'idempotency_key',
] as const;

export function buildP3394MappingReport(target: P3394ReducedTarget): P3394MappingReport {
  const sessionSemantics =
    target === 'p3394-native' ? 'full' :
    target === 'a2a' ? 'binding-mapped' :
    target === 'mcp' ? 'restricted' :
    'local-bridge';
  return {
    source: 'p3394-umf/1.0',
    target,
    session_semantics: sessionSemantics,
    fields: UMF_FIELDS.map((field) => mapFor(target, field)),
  };
}

/** Validates a report: required UMF fields must not be dropped (SDK §13:
 *  a channel fails negotiation when a required semantic cannot be
 *  represented safely). Synthesized is acceptable for required fields. */
export function validateP3394MappingReport(
  report: P3394MappingReport,
): { ok: true; report: P3394MappingReport } | { ok: false; error: { reason: string; field: string; message: string } } {
  if (!report || report.source !== 'p3394-umf/1.0' || typeof report.target !== 'string') {
    return { ok: false, error: { reason: 'invalid_mapping_report', field: 'report', message: 'Mapping report must declare source and target.' } };
  }
  const byField = new Map(report.fields.map((mapping) => [mapping.field, mapping]));
  for (const field of P3394_REQUIRED_UMF_FIELDS) {
    const mapping = byField.get(field);
    if (!mapping || mapping.disposition === 'dropped') {
      return { ok: false, error: { reason: 'required_field_dropped', field, message: 'Required UMF field ' + field + ' cannot be dropped; negotiation fails.' } };
    }
  }
  return { ok: true, report };
}
