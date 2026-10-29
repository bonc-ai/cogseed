/** Model-facing query failures. Recovery guidance never grants read or write authority. */
import { OntologyError, validateOntologyId } from '../../features/cognition/ontology/model';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';

const log = createLogger('cognition-query');
const failureBoundary = ' A failed query does not establish absence. Do not use create_cognition to bypass this failure.';

/** Preserve the existing omitted/empty module selector; never resolve names as IDs. */
export function queryModuleId(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  try { return validateOntologyId(value); }
  catch {
    throw new OntologyError('invalid_input', 'moduleId must be a formal ontology ID returned by cognition_ontology_query, not a display name.');
  }
}

function recoveryHint(code: string): string {
  switch (code) {
    case 'invalid_input':
      return 'Correct the reported arguments before retrying. For a module name, call cognition_ontology_query with query set to that name, then use the returned module ID; do not guess an ID.';
    case 'invalid_time':
      return 'Correct the date argument using a real calendar date in YYYY-MM-DD format before retrying.';
    case 'baseline_changed':
    case 'inventory_snapshot_changed':
    case 'invalid_cursor':
      return 'Restart the original authorized read without a stale cursor or expectedRevision. Use the newly returned revision and cursors; do not mix snapshots or guess a revision.';
    case 'not_authorized':
    case 'inventory_intent_required':
      return 'Do not repeat the denied read unchanged or broaden its scope. Stay within the current task permissions; management reads require the user to explicitly name the target, and inventory requires an explicit full-inventory instruction.';
    case 'not_found':
      return 'Recheck the exact target ID or name within the authorized scope. This does not prove that the entire library lacks the content.';
    case 'source_unavailable':
    case 'store_corrupt':
      return 'Stop operations that depend on the unreadable content. Report the source or storage problem and resume only after it is resolved; unrelated authorized work can continue.';
    default:
      return 'Stop operations that depend on this result and report the query failure. Check the local diagnostic log before retrying; do not repeat the same call blindly.';
  }
}

export function cognitionQueryFailure(
  tool: 'cognition_ontology_query' | 'transcript_corrections_query', error: unknown, userId: string,
): { content: string; isError: true } {
  const domainError = error instanceof OntologyError;
  const code = domainError ? error.code : 'query_failed';
  const reason = domainError ? error.message : 'The query failed; no reliable result was returned.';
  if (!domainError) {
    const diagnostic = logErrorRef(error);
    log.warn('query failed', { tool, userId: maskId(userId), error: { ...diagnostic,
      message: sanitizeLogTextForUpload(String(diagnostic.message || '')) } });
  }
  return { content: JSON.stringify({ status: 'blocked', code, reason, recoveryHint: recoveryHint(code) + failureBoundary,
    ...(tool === 'transcript_corrections_query' ? { error: reason } : {}) }), isError: true };
}
