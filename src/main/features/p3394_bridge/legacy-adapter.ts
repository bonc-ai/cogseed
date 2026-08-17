/**
 * P3394 Legacy Adapter（M-01：显式、可审计的旧调用方适配）。
 *
 * 规范要求 envelope 上线必带 spec_version（缺失 fail-closed）。本模块为确有
 * 需要的旧 P3394 Lite 调用方提供一条显式适配路径：缺失/旧版本 spec_version
 * 的输入被显式归一化为 'p3394/1.0'，并产生一条审计元数据（adapted_from +
 * reason），绝不静默放宽校验。默认关闭，由 wiring 用显式开关启用。
 */

import type { P3394Envelope } from './envelope';
import { P3394_ENVELOPE_VERSION } from './envelope';

export type P3394LegacyAdaptResult =
  | { ok: true; envelope: P3394Envelope; audit: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * 尝试把缺失/旧版本 spec_version 的输入归一化为当前版本。
 * 只有 spec_version 一个字段不符合时才适配（其余字段仍由正式校验器把关）；
 * 若后续正式校验失败，适配结果作废并回退 fail-closed。
 */
export function adaptLegacyEnvelope(input: unknown): P3394LegacyAdaptResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const record = input as Record<string, unknown>;
  const version = record.spec_version;
  // 只有缺失或旧版本允许适配；显式不支持的版本直接拒绝（不猜测意图）。
  if (version === undefined || version === null) {
    return adaptedEnvelope(record, 'missing_spec_version');
  }
  if (typeof version === 'string' && version.trim() !== '' && version.trim() !== P3394_ENVELOPE_VERSION) {
    return adaptedEnvelope(record, 'old_spec_version:' + version.trim().slice(0, 32));
  }
  return { ok: false, reason: 'not_legacy' };
}

function adaptedEnvelope(input: Record<string, unknown>, reason: string): P3394LegacyAdaptResult {
  const adapted = { ...input, spec_version: P3394_ENVELOPE_VERSION } as Record<string, unknown>;
  // 旧 Lite 消息常见的意图映射：无 kind/performative 时不做猜测，交由正式校验
  // 器决定（fail-closed）；这里只统一版本并记录审计事实。
  return {
    ok: true,
    envelope: adapted as unknown as P3394Envelope,
    audit: { adapted_from: 'legacy', reason, applied: true },
  };
}
