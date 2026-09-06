import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalP3394SigningPayload,
  generateP3394SigningKeyPair,
  p3394EnvelopeSignature,
  P3394MessageSigner,
  signP3394Envelope,
  verifyP3394Envelope,
} from '../../../../src/main/features/p3394_bridge/message-signing';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

// 密钥落 p3394StateFile：一次性 variant 隔离，避免污染真实节点密钥。
let previousVariant: string | undefined;
let variantName: string;
beforeEach(() => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  variantName = 'p3394-sign-' + Math.random().toString(36).slice(2, 8);
  process.env.COGSEED_RUNTIME_VARIANT = variantName;
});
afterEach(() => {
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName), { recursive: true, force: true }); } catch { /* best effort */ }
});

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-sign-1',
    session_id: 'ses-sign-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'alice' },
    recipients: [{ agent_id: 'bob' }],
    payload: { parts: [{ type: 'text', text: 'sign me' }] },
    idempotency_key: 'idem-sign-1',
    ...overrides,
  } as never;
}

describe('P3394 message signing (ed25519)', () => {
  it('generates a usable ed25519 key pair', () => {
    const key = generateP3394SigningKeyPair();
    expect(key.keyid).toMatch(/^k-[0-9a-f]+$/);
    expect(key.private_key).toContain('PRIVATE KEY');
    expect(key.public_key).toContain('PUBLIC KEY');
  });

  it('canonical payload is explicit-field-list based (stable, key-order independent)', () => {
    const a = envelope();
    // extensions 不在覆盖清单里 → 不影响签名载荷。
    const b = envelope({ extensions: { unrelated: true } });
    expect(canonicalP3394SigningPayload(a)).toBe(canonicalP3394SigningPayload(b));
    // 覆盖字段不同 → 载荷不同（message_id / payload 内容都受保护）。
    expect(canonicalP3394SigningPayload(a)).not.toBe(canonicalP3394SigningPayload(envelope({ message_id: 'other' })));
    expect(canonicalP3394SigningPayload(a)).not.toBe(canonicalP3394SigningPayload(envelope({
      payload: { parts: [{ type: 'text', text: 'changed' }] },
    })));
  });

  it('sign/verify round trip succeeds and attaches extensions.sig', () => {
    const key = generateP3394SigningKeyPair('rt-key');
    const signed = signP3394Envelope(envelope(), key);
    expect(signed.extensions?.sig).toMatchObject({ alg: 'ed25519', keyid: 'rt-key' });
    expect(p3394EnvelopeSignature(signed)?.keyid).toBe('rt-key');
    expect(verifyP3394Envelope(signed, key.public_key)).toBe(true);
    // 原信封不被修改（签名返回新对象）。
    expect(envelope().extensions?.sig).toBeUndefined();
  });

  it('tampering any covered field breaks verification', () => {
    const key = generateP3394SigningKeyPair();
    const signed = signP3394Envelope(envelope(), key);
    // payload 篡改
    const tamperedPayload = { ...signed, payload: { parts: [{ type: 'text', text: 'sign me too' }] } };
    expect(verifyP3394Envelope(tamperedPayload, key.public_key)).toBe(false);
    // 覆盖字段篡改（session_id）
    const tamperedSession = { ...signed, session_id: 'ses-other' };
    expect(verifyP3394Envelope(tamperedSession, key.public_key)).toBe(false);
    // 签名搬运（把 A 的 sig 贴到内容不同的信封上）
    const forged = { ...envelope({ message_id: 'msg-forged' }), extensions: signed.extensions };
    expect(verifyP3394Envelope(forged, key.public_key)).toBe(false);
    // 换一把公钥验证 → 失败
    const otherKey = generateP3394SigningKeyPair();
    expect(verifyP3394Envelope(signed, otherKey.public_key)).toBe(false);
  });

  it('unsigned envelopes have no signature and verifyEnvelope lets them through (compat)', () => {
    const signer = new P3394MessageSigner({ schema_version: 1, identity: generateP3394SigningKeyPair(), trusted: {} });
    // 未启用签名的对端发来的裸信封：verifyEnvelope 放行（渐进部署）。
    expect(signer.verifyEnvelope(envelope())).toEqual({ ok: true });
  });

  it('signer rejects signed envelopes from unknown or untrusted keys', () => {
    const alice = generateP3394SigningKeyPair();
    const signer = new P3394MessageSigner({ schema_version: 1, identity: generateP3394SigningKeyPair(), trusted: {} });
    const signed = signP3394Envelope(envelope(), alice);
    // sender 的公钥不在信任表 → 明确错误。
    expect(signer.verifyEnvelope(signed)).toEqual({ ok: false, error: 'p3394_signature_unknown_key' });
    signer.trustKey('alice', { keyid: alice.keyid, public_key: alice.public_key });
    expect(signer.verifyEnvelope(signed)).toEqual({ ok: true });
    // 信任后篡改 → invalid。
    const tampered = { ...signed, payload: { parts: [{ type: 'text', text: 'nope' }] } };
    expect(signer.verifyEnvelope(tampered)).toEqual({ ok: false, error: 'p3394_signature_invalid' });
  });

  it('loadOrCreate persists the identity at 0600 and reuses it across loads', () => {
    const first = P3394MessageSigner.loadOrCreate();
    const file = path.join(os.homedir(), '.cogseed', 'runtime-variants', variantName, 'p3394-signing-keys.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const second = P3394MessageSigner.loadOrCreate();
    expect(second.keyid).toBe(first.keyid);
    expect(second.publicKey).toBe(first.publicKey);
  });
});
