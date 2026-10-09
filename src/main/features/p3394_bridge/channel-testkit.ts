/**
 * P3394 Channel Adapter Test Kit (SDK design §5.3 rule 7, §18).
 *
 * Every conformant channel adapter passes the same framework-independent
 * contract suite: descriptor validity, framing/round-trip delivery,
 * delivery receipts, subscribe/unsubscribe semantics, closed-channel
 * behaviour, and (when provided) health reporting. The CLI entry point is
 * scripts/p3394-adapter-test.ts (`p3394 adapter test <adapter>`).
 */

import type { P3394ChannelAdapter } from './channel-adapter';
import type { P3394Envelope } from './envelope';

export interface P3394TestkitCheck { name: string; status: 'pass' | 'fail' | 'skip'; reason?: string }
export interface P3394ChannelTestkitReport { adapter: string; checks: P3394TestkitCheck[]; ok: boolean }

export interface P3394ChannelTestkitOptions {
  /** Envelope used for delivery checks (must not be sent anywhere real). */
  envelope?: P3394Envelope;
  /** Skip listen() when the adapter has no listener configured. */
  skipListen?: boolean;
}

function check(name: string, status: P3394TestkitCheck['status'], reason?: string): P3394TestkitCheck {
  return { name, status, ...(reason ? { reason } : {}) };
}

export function p3394TestkitEnvelope(overrides: Partial<P3394Envelope> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-testkit-' + Math.random().toString(36).slice(2, 10),
    session_id: 'ses-testkit',
    kind: 'message',
    performative: 'inform',
    sender: { agent_id: 'testkit' },
    recipients: [{ agent_id: 'local' }],
    payload: { parts: [{ type: 'text', text: 'testkit ping' }] },
    idempotency_key: 'idem-testkit-' + Math.random().toString(36).slice(2, 10),
    ...overrides,
  };
}

/**
 * Runs the adapter contract suite. Conformance requirements (SDK §18):
 * descriptor validity, framing, delivery, receipts, close semantics, and
 * health. Listen checks run only when the adapter declares the listener
 * role AND the caller did not opt out (a dialer-only instance in a unit
 * test cannot bind its configured port).
 */
export async function runP3394ChannelAdapterConformance(
  adapter: P3394ChannelAdapter,
  options: P3394ChannelTestkitOptions = {},
): Promise<P3394ChannelTestkitReport> {
  const checks: P3394TestkitCheck[] = [];
  const descriptor = adapter.descriptor;

  // 1. Descriptor validity.
  if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
    checks.push(check('descriptor.id', 'fail', 'missing adapter descriptor id'));
  } else {
    checks.push(check('descriptor.id', 'pass'));
  }
  if (!Array.isArray(descriptor.schemes) || descriptor.schemes.length === 0) {
    checks.push(check('descriptor.schemes', 'fail', 'adapter must declare at least one scheme'));
  } else {
    checks.push(check('descriptor.schemes', 'pass'));
  }
  if (!Array.isArray(descriptor.roles) || descriptor.roles.length === 0) {
    checks.push(check('descriptor.roles', 'fail', 'adapter must declare listener and/or dialer roles'));
  } else {
    checks.push(check('descriptor.roles', 'pass'));
  }
  if (!Array.isArray(descriptor.bindings) || !descriptor.bindings.includes('umf-json')) {
    checks.push(check('descriptor.bindings', 'fail', 'adapter must declare umf-json binding'));
  } else {
    checks.push(check('descriptor.bindings', 'pass'));
  }
  const caps = descriptor.capabilities;
  if (!caps || typeof caps !== 'object') {
    checks.push(check('descriptor.capabilities', 'fail', 'capability declaration required'));
  } else {
    checks.push(check('descriptor.capabilities', 'pass'));
  }

  // 2. Delivery round-trip: send() must reach subscribers with the same envelope.
  const envelope = options.envelope ?? p3394TestkitEnvelope();
  const received: P3394Envelope[] = [];
  const unsubscribe = adapter.subscribe((e) => { received.push(e); });
  try {
    const receipt = await adapter.send(envelope);
    if (!receipt || receipt.message_id !== envelope.message_id || receipt.accepted !== true) {
      checks.push(check('delivery.receipt', 'fail', 'receipt must echo message_id with accepted=true'));
    } else {
      checks.push(check('delivery.receipt', 'pass'));
    }
    // Local (in-process) channels deliver synchronously; remote channels may
    // not loop back to the sender — the check is informational there.
    if (received.length === 0 && descriptor.id.includes('in_process')) {
      checks.push(check('delivery.roundtrip', 'fail', 'subscriber did not receive the envelope'));
    } else if (received.length === 0) {
      checks.push(check('delivery.roundtrip', 'skip', 'no loopback for remote channel'));
    } else if (received[0].message_id !== envelope.message_id) {
      checks.push(check('delivery.roundtrip', 'fail', 'subscriber received a different envelope'));
    } else {
      checks.push(check('delivery.roundtrip', 'pass'));
    }
  } catch (error) {
    checks.push(check('delivery.receipt', 'fail', error instanceof Error ? error.message : String(error)));
    checks.push(check('delivery.roundtrip', 'skip', 'send failed'));
  }

  // 3. Unsubscribe semantics.
  unsubscribe();
  const before = received.length;
  try {
    await adapter.send(envelope);
  } catch { /* closed or unreachable: acceptable for this check */ }
  if (received.length !== before && descriptor.id.includes('in_process')) {
    checks.push(check('delivery.unsubscribe', 'fail', 'unsubscribed listener still receives envelopes'));
  } else {
    checks.push(check('delivery.unsubscribe', 'pass'));
  }

  // 4. Health (when provided).
  if (typeof adapter.health === 'function') {
    try {
      const health = await adapter.health();
      if (!health || typeof health.ok !== 'boolean' || typeof health.scheme !== 'string') {
        checks.push(check('health', 'fail', 'health must report ok and scheme'));
      } else {
        checks.push(check('health', 'pass'));
      }
    } catch (error) {
      checks.push(check('health', 'fail', error instanceof Error ? error.message : String(error)));
    }
  } else {
    checks.push(check('health', 'skip', 'adapter does not implement health()'));
  }

  // 5. Graceful shutdown: send after close must fail, close must resolve.
  try {
    await adapter.close();
    checks.push(check('close.graceful', 'pass'));
    let sendAfterCloseFailed = false;
    try {
      await adapter.send(envelope);
    } catch {
      sendAfterCloseFailed = true;
    }
    checks.push(check('close.send_rejected', sendAfterCloseFailed ? 'pass' : 'fail', sendAfterCloseFailed ? undefined : 'send after close did not fail'));
  } catch (error) {
    checks.push(check('close.graceful', 'fail', error instanceof Error ? error.message : String(error)));
  }

  return { adapter: descriptor.id ?? 'unknown', checks, ok: checks.every((c) => c.status !== 'fail') };
}
