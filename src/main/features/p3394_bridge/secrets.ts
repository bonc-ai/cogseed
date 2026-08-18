/**
 * P3394 secret redaction helpers.
 *
 * The bridge token is the single shared auth factor; it must never appear
 * verbatim in outbox snapshots, event logs, audit/trace or transcripts.
 * `redactP3394Secrets` is a belt-and-braces regex over the written blob.
 */

/** Bridge token shape: `p3394-<slug>-<slug>` (generated in app-wiring). */
const BRIDGE_TOKEN_PATTERN = /p3394-[A-Za-z0-9]{8,}-[A-Za-z0-9]{8,}/g;

/** Replace bridge-token-shaped substrings anywhere (blob-level fallback). */
export function redactP3394Secrets(text: string): string {
  return String(text ?? '').replace(BRIDGE_TOKEN_PATTERN, '[REDACTED]');
}
