/**
 * P3394 secret redaction helpers.
 *
 * The bridge token is the single shared auth factor; it must never appear
 * verbatim in outbox snapshots, event logs, audit/trace or transcripts.
 * `redactP3394Secrets` is a belt-and-braces guard over the written blob.
 */
import { maskSensitiveShapes } from '../../util/log-sanitize';

/**
 * Blob-level guard for the local P3394 artifacts (event log, outbox snapshot).
 *
 * Composes the shared sensitive-shape masks — which already cover the bridge
 * token plus generic `Bearer` / `token=` / provider-token shapes — and
 * deliberately skips upload-path masking: these files are machine-local
 * diagnostics that are never uploaded, so absolute paths keep their value.
 */
export function redactP3394Secrets(text: string): string {
  return maskSensitiveShapes(String(text ?? ''));
}
