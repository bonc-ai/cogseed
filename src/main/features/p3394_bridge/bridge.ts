import type { P3394Envelope } from './envelope';
import { validateP3394Envelope } from './envelope';
import { P3394AuditJournal } from './audit-journal';
import { P3394IdempotencyStore } from './idempotency';
import { P3394PeerRegistry, type P3394PeerRecord } from './registry';
import { P3394ReplayProtector } from './replay-protection';

export interface P3394BridgeDeliveryReceipt {
  message_id: string;
  session_id: string;
  idempotency_key: string;
  sender_id: string;
  recipient_ids: string[];
  replay: boolean;
}

export type P3394BridgeSendResult = { ok: true; receipt: P3394BridgeDeliveryReceipt; envelope: P3394Envelope } | { ok: false; error: { reason: string; field: string; message: string } };

export interface P3394BridgeKernelDeps {
  registry?: P3394PeerRegistry;
  idempotency?: P3394IdempotencyStore<P3394BridgeDeliveryReceipt>;
  replay?: P3394ReplayProtector;
  audit?: P3394AuditJournal;
}

function validateRecipientAdmission(envelope: P3394Envelope, peer: P3394PeerRecord): { reason: string; field: string; message: string } | null {
  if (envelope.kind !== 'task' && envelope.kind !== 'message') return null;
  const nodeKind = peer.node_kind ?? 'agent';
  if (nodeKind === 'capability' || nodeKind === 'model_runtime') {
    return { reason: 'capability_not_authorized', field: 'recipients', message: 'Capability and model runtime nodes cannot receive autonomous task messages.' };
  }
  const profile = peer.manifest.capability_profile;
  if (!profile.capabilities.includes('handle_message')) {
    return { reason: 'capability_not_authorized', field: 'capability_profile.capabilities', message: 'Recipient does not authorize handle_message.' };
  }
  if (!profile.supported_performatives.includes(envelope.performative)) {
    return { reason: 'performative_not_authorized', field: 'capability_profile.supported_performatives', message: 'Recipient does not authorize this performative.' };
  }
  return null;
}

/**
 * 发送方准入（M-08/M-09 对称性）：capability / model_runtime 节点不是
 * 自主 Agent，不得发起 task/message 交换；node_kind 来自注册表的真实
 * 记录（hello 自报 + 本地配置），而非信封自述。
 */
function validateSenderAdmission(envelope: P3394Envelope, peer: P3394PeerRecord): { reason: string; field: string; message: string } | null {
  if (envelope.kind !== 'task' && envelope.kind !== 'message') return null;
  const nodeKind = peer.node_kind ?? 'agent';
  if (nodeKind === 'capability' || nodeKind === 'model_runtime') {
    return { reason: 'sender_not_authorized', field: 'sender', message: 'Capability and model runtime nodes cannot initiate autonomous task messages.' };
  }
  return null;
}

export class P3394BridgeKernel {
  readonly registry: P3394PeerRegistry;
  readonly idempotency: P3394IdempotencyStore<P3394BridgeDeliveryReceipt>;
  readonly replay: P3394ReplayProtector;
  readonly audit: P3394AuditJournal;

  constructor(deps: P3394BridgeKernelDeps = {}) {
    this.registry = deps.registry ?? new P3394PeerRegistry();
    this.idempotency = deps.idempotency ?? new P3394IdempotencyStore<P3394BridgeDeliveryReceipt>();
    this.replay = deps.replay ?? new P3394ReplayProtector();
    this.audit = deps.audit ?? new P3394AuditJournal();
  }

  send(envelopeInput: unknown, options: { epoch?: number } = {}): P3394BridgeSendResult {
    const validation = validateP3394Envelope(envelopeInput);
    if (validation.ok === false) {
      this.audit.append({ event: 'envelope.validate', actor_id: 'unknown', status: 'rejected', metadata: { reason: validation.error.reason } });
      return { ok: false, error: validation.error };
    }
    const envelope: P3394Envelope = validation.envelope;
    const sender = this.registry.resolve(envelope.sender.agent_id);
    if (sender.ok === false) {
      this.audit.append({ event: 'peer.resolve.sender', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: { ...sender.error } });
      return { ok: false, error: sender.error };
    }
    const senderAdmission = validateSenderAdmission(envelope, sender.value);
    if (senderAdmission) {
      this.audit.append({ event: 'sender.authorize', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: senderAdmission });
      return { ok: false, error: senderAdmission };
    }
    const recipientIds: string[] = [];
    for (let i = 0; i < envelope.recipients.length; i += 1) {
      const recipient = this.registry.resolve(envelope.recipients[i].agent_id);
      if (recipient.ok === false) {
        this.audit.append({ event: 'peer.resolve.recipient', actor_id: envelope.sender.agent_id, target_id: envelope.recipients[i].agent_id, status: 'rejected', metadata: { ...recipient.error } });
        return { ok: false, error: recipient.error };
      }
      const admission = validateRecipientAdmission(envelope, recipient.value);
      if (admission) {
        this.audit.append({ event: 'capability.authorize', actor_id: envelope.sender.agent_id, target_id: recipient.value.identity.agent_id, status: 'rejected', metadata: admission });
        return { ok: false, error: admission };
      }
      recipientIds.push(recipient.value.identity.agent_id);
    }
    if (options.epoch !== undefined) {
      const replay = this.replay.admit(envelope.sender.agent_id, options.epoch);
      if (replay.ok === false) {
        this.audit.append({ event: 'replay.reject', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: replay.error });
        return { ok: false, error: replay.error };
      }
    }
    const receipt: P3394BridgeDeliveryReceipt = {
      message_id: envelope.message_id,
      session_id: envelope.session_id,
      idempotency_key: envelope.idempotency_key,
      sender_id: envelope.sender.agent_id,
      recipient_ids: recipientIds,
      replay: false,
    };
    const idem = this.idempotency.record(envelope.sender.agent_id, envelope.idempotency_key, receipt);
    this.audit.append({ event: 'bridge.send', actor_id: envelope.sender.agent_id, status: idem.replay ? 'replayed' : 'accepted', metadata: { message_id: envelope.message_id } });
    return { ok: true, receipt: { ...idem.receipt.result, replay: idem.replay }, envelope };
  }
}
