/** A correction workflow cannot write deliverables or finish on prose alone.
 * The formal Agent workflow opts in by referencing the correction contract;
 * no product Agent id or installed builtin path is a runtime dependency.
 * Every source needs matching scan/apply evidence within this invocation.
 * Tools may recover from wrong arguments, but draft/empty/failed correction
 * never authorizes minutes, shell writes, delegation or successful completion. */
import { createHash } from 'node:crypto';
import type { RuntimeKernelRequest } from './types';
import type { RuntimeToolResult } from './tools/file-tools';

const READ_TOOLS = new Set([
  'stat_file', 'read_file', 'search_files', 'grep_files', 'list_connector_tools',
  'search_mate_kb', 'read_mate_kb', 'ontology_graph_read', 'office_read',
  'transcript_glossary_list', 'transcript_glossary_upsert',
]);

export function createTranscriptGate(request: RuntimeKernelRequest) {
  let required = request.context.some((item) => item.type === 'text'
    && item.label === 'Formal Agent execution context'
    && /\btranscript_glossary_apply\b/.test(item.content));
  const scanned = new Set<string>();
  const outstanding = new Set<string>();
  let applied = false;
  const closed = () => required && (!applied || outstanding.size > 0);
  // A successful scan is the Agent's current source. Earlier sources it
  // scanned or tried to apply but never applied were abandoned (a retyped
  // copy, another docId); keeping them open would refuse every later write.
  const supersede = (source: string) => { outstanding.clear(); outstanding.add(source); };
  // A file source is identified by the path the Agent passes (the host reads
  // it, so its hash is unknown here); a text source by docId + content hash.
  const filePath = (input: Record<string, unknown>) => typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined;
  const key = (input: Record<string, unknown>) => filePath(input) ? JSON.stringify(['path', filePath(input)]) : JSON.stringify([
    typeof input.docId === 'string' ? input.docId.trim() : input.docId,
    typeof input.text === 'string' ? createHash('sha256').update(input.text.trim()).digest('hex') : null,
  ]);
  const matches = (input: Record<string, unknown>, evidence: NonNullable<RuntimeToolResult['correction']>) => filePath(input)
    ? evidence.source === filePath(input)
    : key(input) === JSON.stringify([evidence.docId, evidence.sourceHash]);

  return {
    closed,
    // Evidence comes only from the host-owned native session, never user prose.
    restore(name: string, input: Record<string, unknown>, result: RuntimeToolResult): void {
      const evidence = result.correction;
      if (result.isError || !evidence || !matches(input, evidence)) return;
      if (name === 'transcript_glossary_scan' && ['scanned', 'needs_confirmation'].includes(evidence.state)) {
        required = true; scanned.add(key(input)); supersede(key(input));
      }
      if (name === 'transcript_glossary_apply' && evidence.state === 'applied') {
        required = true; scanned.add(key(input)); outstanding.delete(key(input)); applied = true;
      }
    },
    before(name: string, input: Record<string, unknown>): RuntimeToolResult | undefined {
      if (name === 'transcript_glossary_scan' || name === 'transcript_glossary_apply') {
        required = true;
        outstanding.add(key(input));
        if (name === 'transcript_glossary_scan') scanned.delete(key(input));
        if (name === 'transcript_glossary_apply' && !scanned.has(key(input))) {
          // Reject before the host consumes a one-shot confirmation token.
          // A resumed Worker must establish its own matching scan evidence.
          return { content: '[E_TRANSCRIPT_SCAN_REQUIRED] Scan this exact text and docId first, then apply. Any submitted confirmation remains available in the host.', isError: true };
        }
        return;
      }
      if (!closed() || READ_TOOLS.has(name)) return;
      // Allow connector reads needed to obtain the source, never create/send.
      if (name === 'call_connector_tool' && typeof input.tool_name === 'string'
        && /^(get_|list_|search_)/.test(input.tool_name)) return;
      return {
        content: '[E_TRANSCRIPT_CORRECTION_REQUIRED] Complete transcript_glossary_scan and transcript_glossary_apply first. Only reading and correction are allowed until then. Do not write minutes or a placeholder corrected transcript. Pass the transcript file path to both; apply saves the raw (rawOutputPath) and corrected (outputPath) transcripts itself.',
        isError: true,
      };
    },
    after(name: string, input: Record<string, unknown>, result: RuntimeToolResult): void {
      if (name !== 'transcript_glossary_scan' && name !== 'transcript_glossary_apply') return;
      const source = key(input);
      const evidence = result.correction;
      if (result.isError || !evidence || !matches(input, evidence)) return;
      if (name === 'transcript_glossary_scan' && ['scanned', 'needs_confirmation'].includes(evidence.state)) supersede(source);
      if (name === 'transcript_glossary_scan' && evidence.state === 'scanned') scanned.add(source);
      if (name === 'transcript_glossary_apply' && evidence.state === 'applied' && scanned.has(source)) {
        outstanding.delete(source);
        applied = true;
      }
    },
  };
}
