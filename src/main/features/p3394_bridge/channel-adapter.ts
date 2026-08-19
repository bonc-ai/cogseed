/**
 * P3394 Channel Adapter contract (SDK design §5.2/§5.3, guide §13).
 *
 * A channel adapter moves UMF frames between nodes and declares exactly
 * which semantics it preserves. The kernel negotiates a common profile or
 * fails explicitly — it never silently discards semantics.
 */

import type { P3394Envelope } from './envelope';

export interface P3394ChannelDeliveryReceipt { channel_id: string; message_id: string; accepted: boolean }
export interface P3394ChannelListenerResult { ok: boolean; error?: { message: string } }
export type P3394ChannelListener = (envelope: P3394Envelope) => P3394ChannelListenerResult | void;

/** Adapter descriptor (SDK design §5.3): what this adapter IS and which
 *  semantics it preserves. Every installable adapter declares one. */
export interface P3394ChannelDescriptor {
  /** Reverse-DNS adapter id, e.g. org.p3394.channel.native_https. */
  id: string;
  adapter_version: string;
  /** URI schemes this adapter handles, e.g. p3394+https / p3394+ipc. */
  schemes: string[];
  roles: Array<'listener' | 'dialer'>;
  bindings: string[];
  capabilities: {
    streaming: 'none' | 'bidirectional';
    durable_tasks: boolean;
    cancellation: boolean;
    artifacts: 'none' | 'inline' | 'referenced';
    multi_party_sessions: boolean;
    identity_proofs: string[];
  };
  entrypoint: string;
}

export interface P3394ChannelHealth {
  ok: boolean;
  scheme: string;
  listener_active?: boolean;
  dialer_connected?: boolean;
  detail?: string;
}

export interface P3394ChannelAdapter {
  descriptor: P3394ChannelDescriptor;
  listen(): Promise<void>;
  dial(peerId: string): Promise<void>;
  send(envelope: P3394Envelope): Promise<P3394ChannelDeliveryReceipt>;
  /** Negotiated capability view for a remote endpoint (SDK §5.2). */
  capabilities?(endpoint?: string): Promise<P3394ChannelDescriptor['capabilities']>;
  /** Liveness of this adapter (SDK §5.2 health). */
  health?(): Promise<P3394ChannelHealth>;
  subscribe(listener: P3394ChannelListener): () => void;
  close(): Promise<void>;
}

/** Declares required semantics and refuses startup when the selected
 *  adapter cannot carry them (SDK §5.4: 'the bridge refuses startup when
 *  a required capability is absent'). Returns the missing list. */
export function missingP3394ChannelCapabilities(
  adapter: P3394ChannelDescriptor,
  required: Partial<P3394ChannelDescriptor['capabilities']>,
): string[] {
  const missing: string[] = [];
  const caps = adapter.capabilities;
  if (required.streaming === 'bidirectional' && caps.streaming !== 'bidirectional') missing.push('streaming:bidirectional');
  if (required.durable_tasks === true && !caps.durable_tasks) missing.push('durable_tasks');
  if (required.cancellation === true && !caps.cancellation) missing.push('cancellation');
  if (required.artifacts === 'inline' && caps.artifacts === 'none') missing.push('artifacts:inline');
  if (required.artifacts === 'referenced' && caps.artifacts === 'none') missing.push('artifacts:referenced');
  if (required.multi_party_sessions === true && !caps.multi_party_sessions) missing.push('multi_party_sessions');
  for (const proof of required.identity_proofs ?? []) {
    if (!caps.identity_proofs.includes(proof)) missing.push('identity_proof:' + proof);
  }
  return missing;
}

/**
 * Channel adapter registry: resolves one conformant adapter per URI
 * scheme. Two packages claiming the same scheme is a startup error
 * (SDK §5.4: 'if two packages claim the same scheme, configuration must
 * choose one explicitly').
 */
export class P3394ChannelRegistry {
  private readonly byScheme = new Map<string, P3394ChannelAdapter>();
  private readonly adapters = new Map<string, P3394ChannelAdapter>();

  register(adapter: P3394ChannelAdapter): { ok: true } | { ok: false; error: { reason: string; message: string } } {
    if (this.adapters.has(adapter.descriptor.id)) {
      return { ok: false, error: { reason: 'adapter_already_registered', message: 'Adapter ' + adapter.descriptor.id + ' is already registered.' } };
    }
    for (const scheme of adapter.descriptor.schemes) {
      const existing = this.byScheme.get(scheme);
      if (existing) {
        return { ok: false, error: { reason: 'scheme_conflict', message: 'Scheme ' + scheme + ' is already claimed by ' + existing.descriptor.id + '; configuration must choose one adapter explicitly.' } };
      }
    }
    this.adapters.set(adapter.descriptor.id, adapter);
    for (const scheme of adapter.descriptor.schemes) this.byScheme.set(scheme, adapter);
    return { ok: true };
  }

  /** Resolves an adapter by URI scheme (never by import order). */
  resolveByScheme(scheme: string): P3394ChannelAdapter | null {
    return this.byScheme.get(scheme) ?? null;
  }

  list(): P3394ChannelAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Descriptor factory for the built-in channels. */
export function buildP3394ChannelDescriptor(
  input: Omit<P3394ChannelDescriptor, 'adapter_version' | 'entrypoint'> & Partial<Pick<P3394ChannelDescriptor, 'adapter_version' | 'entrypoint'>>,
): P3394ChannelDescriptor {
  return {
    adapter_version: '1.0.0',
    entrypoint: 'cogseed:channel:' + input.id,
    ...input,
  };
}
