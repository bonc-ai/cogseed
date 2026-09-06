/**
 * P3394 message signing (ed25519) — optional integrity layer for envelopes.
 *
 * 框架定位（标准 §15 Peer Authentication 的可选补充）：默认关闭
 * （COGSEED_P3394_SIGNING=1 才启用），未启用时零开销零影响。启用后：
 *
 * - 出站：send() 前对本节点信封附加 envelope.extensions.sig；
 * - 入站：携带 sig 的信封验签失败 → 拒绝（p3394_signature_invalid）；
 *   不带 sig 的信封放行（兼容未启用签名的对端，渐进部署）。
 *
 * 签名载荷不依赖对象键序：用显式字段清单（message_id / session_id /
 * kind / performative / sender / recipients / payload 摘要）构造定长结构
 * 后再序列化——比"稳定键序 JSON"简单可靠，且对端可按同一清单重建比对。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { p3394StateFile } from './runtime-paths';
import { createLogger } from '../../logger';
import type { P3394Envelope } from './envelope';

const log = createLogger('p3394-bridge:message-signing');

export interface P3394SigningKeyPair {
  keyid: string;
  /** PKCS#8 PEM 私钥（仅落 0600 私有文件，永不外发）。 */
  private_key: string;
  /** SPKI PEM 公钥（可随 manifest/hello 分发）。 */
  public_key: string;
  created_at: string;
}

/** 信任的对端验签公钥（按 agent_id 索引）。 */
export interface P3394TrustedSigningKey {
  keyid: string;
  public_key: string;
  added_at: string;
}

interface SigningStateFile {
  schema_version: 1;
  identity: P3394SigningKeyPair;
  /** by sender agent_id */
  trusted: Record<string, P3394TrustedSigningKey>;
}

export type P3394SignatureVerdict = { ok: true } | { ok: false; error: string };

/** envelope.extensions.sig 的形状（alg 固定 ed25519）。 */
export interface P3394EnvelopeSignature {
  alg: 'ed25519';
  keyid: string;
  payload: string;
  sig: string;
}

function signingStateFile(): string {
  return p3394StateFile('p3394-signing-keys.json');
}

/** 生成一对 ed25519 密钥（node:crypto，无第三方依赖）。 */
export function generateP3394SigningKeyPair(keyid?: string): P3394SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyid: keyid && keyid.trim() ? keyid.trim().slice(0, 64) : 'k-' + crypto.randomBytes(8).toString('hex'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    created_at: new Date().toISOString(),
  };
}

/** 显式字段清单的 canonical 载荷：字段顺序固定、payload 取 sha256 摘要。
 *  签名与验签共用——任何被覆盖字段被篡改都会导致重建结果不一致。 */
export function canonicalP3394SigningPayload(envelope: P3394Envelope): string {
  const payloadDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(envelope.payload))
    .digest('hex');
  return JSON.stringify([
    envelope.message_id,
    envelope.session_id,
    envelope.kind,
    envelope.performative,
    envelope.sender.agent_id,
    envelope.recipients.map((recipient) => recipient.agent_id),
    payloadDigest,
  ]);
}

/** 附加签名（返回新信封，不改入参）。 */
export function signP3394Envelope(envelope: P3394Envelope, key: P3394SigningKeyPair): P3394Envelope {
  const payload = canonicalP3394SigningPayload(envelope);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(key.private_key));
  const extension: P3394EnvelopeSignature = {
    alg: 'ed25519',
    keyid: key.keyid,
    payload,
    sig: signature.toString('base64'),
  };
  return { ...envelope, extensions: { ...(envelope.extensions ?? {}), sig: extension } };
}

/** 取信封上的签名扩展（无签名返回 null）。 */
export function p3394EnvelopeSignature(envelope: P3394Envelope): P3394EnvelopeSignature | null {
  const raw = envelope.extensions?.sig;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<P3394EnvelopeSignature>;
  if (candidate.alg !== 'ed25519' || typeof candidate.keyid !== 'string'
    || typeof candidate.payload !== 'string' || typeof candidate.sig !== 'string') {
    return null;
  }
  return candidate as P3394EnvelopeSignature;
}

/** 用给定公钥验签。覆盖字段被篡改（canonical 重建不一致）同样判失败。 */
export function verifyP3394Envelope(envelope: P3394Envelope, publicKeyPem: string): boolean {
  const signature = p3394EnvelopeSignature(envelope);
  if (!signature) return false;
  if (canonicalP3394SigningPayload(envelope) !== signature.payload) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(signature.payload, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signature.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * 本节点签名器：持有本节点密钥（p3394StateFile，0600 原子落盘）与按
 * agent_id 索引的信任公钥表。app-wiring 在 COGSEED_P3394_SIGNING=1 时
 * 创建并注入 http-channel（send 签名 / subscribe 验签）。
 */
export class P3394MessageSigner {
  private identity: P3394SigningKeyPair;
  private trusted: Record<string, P3394TrustedSigningKey>;

  constructor(state: SigningStateFile) {
    this.identity = state.identity;
    this.trusted = state.trusted ?? {};
  }

  /** 载入或首次生成本节点密钥（原子写 + 0600）。 */
  static loadOrCreate(): P3394MessageSigner {
    const file = signingStateFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SigningStateFile>;
      if (parsed && parsed.schema_version === 1 && parsed.identity && typeof parsed.identity.private_key === 'string') {
        return new P3394MessageSigner(parsed as SigningStateFile);
      }
    } catch { /* missing / malformed → generate below */ }
    const state: SigningStateFile = {
      schema_version: 1,
      identity: generateP3394SigningKeyPair(),
      trusted: {},
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    // 0600：文件含 ed25519 私钥，必须仅本用户可读。
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
    log.info('P3394 signing identity generated', { keyid: state.identity.keyid });
    return new P3394MessageSigner(state);
  }

  get keyid(): string {
    return this.identity.keyid;
  }

  get publicKey(): string {
    return this.identity.public_key;
  }

  signEnvelope(envelope: P3394Envelope): P3394Envelope {
    return signP3394Envelope(envelope, this.identity);
  }

  /** 入站验签：无签名扩展 → 放行（兼容未启用签名的对端）；有签名但发送方
   *  公钥未信任或验签失败 → 拒绝（明确错误码）。 */
  verifyEnvelope(envelope: P3394Envelope): P3394SignatureVerdict {
    if (!p3394EnvelopeSignature(envelope)) return { ok: true };
    const sender = envelope.sender.agent_id;
    const trustedKey = this.trusted[sender];
    if (!trustedKey) return { ok: false, error: 'p3394_signature_unknown_key' };
    if (!verifyP3394Envelope(envelope, trustedKey.public_key)) {
      return { ok: false, error: 'p3394_signature_invalid' };
    }
    return { ok: true };
  }

  /** 信任一个对端公钥（hello/manifest 分发或手工配置）。持久化。 */
  trustKey(agentId: string, key: Pick<P3394TrustedSigningKey, 'keyid' | 'public_key'>): void {
    const id = String(agentId || '').trim();
    if (!id || !key.public_key) return;
    this.trusted[id] = { keyid: key.keyid, public_key: key.public_key, added_at: new Date().toISOString() };
    this.persist();
  }

  private persist(): void {
    const file = signingStateFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ schema_version: 1, identity: this.identity, trusted: this.trusted } satisfies SigningStateFile, null, 2) + '\n', 'utf8');
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
      fs.renameSync(tmp, file);
    } catch (error) {
      log.warn('P3394 signing state persist failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
