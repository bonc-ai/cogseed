/**
 * 三项声明：齐备判定、不可由渲染层伪造的字段、派生来源格式与预填。
 */
import { describe, expect, it } from 'vitest';

import {
  emptyDeclarations, declareOrigin, acceptTerms, confirmMaintenance,
  missingDeclarations, termsStale, isOriginType, prefillOrigin, parseManualForkedFrom,
} from '../../../../src/main/features/contribution/declarations';

const TERMS = { version: '1.0', effective_at: '2026-09-20T00:00:00Z', body_markdown: '# 条款' };

describe('三项齐备判定指出缺项', () => {
  it('全空时三项都缺', () => {
    expect(missingDeclarations(emptyDeclarations())).toEqual(['origin', 'terms', 'maintenance']);
  });

  it('齐备后为空数组', () => {
    const d = emptyDeclarations();
    d.origin = declareOrigin('original', '');
    d.terms = acceptTerms(TERMS);
    d.maintenance = confirmMaintenance();
    expect(missingDeclarations(d)).toEqual([]);
  });

  it('只缺条款时只报条款 —— C-FR-005 要求指出缺项而非只拒绝', () => {
    const d = emptyDeclarations();
    d.origin = declareOrigin('original', '');
    d.maintenance = confirmMaintenance();
    expect(missingDeclarations(d)).toEqual(['terms']);
  });
});

describe('来源声明', () => {
  it.each(['original', 'derived_from_hub', 'third_party'])('接受类型 %s', (v) => {
    expect(isOriginType(v)).toBe(true);
  });

  it.each(['', 'other', 'ORIGINAL', null, 42])('拒绝非法类型 %s', (v) => {
    expect(isOriginType(v)).toBe(false);
  });

  it('第三方材料必须说明来源 —— 空说明等于没声明', () => {
    expect(() => declareOrigin('third_party', '   ')).toThrow('third_party_note_required');
  });

  it('原创可以不填说明', () => {
    expect(declareOrigin('original', '').type).toBe('original');
  });

  it('派生来源缺少不可变 forked_from 时拒绝', () => {
    expect(() => declareOrigin('derived_from_hub', '手填的派生说明')).toThrow('forked_from_required');
    expect(declareOrigin('derived_from_hub', '', { content_id: '8a4f01c29d7e', version: '1.0.0' }).forked_from)
      .toEqual({ content_id: '8a4f01c29d7e', version: '1.0.0' });
  });

  it('手填派生关联只接受 Hub 稳定 ID 和 SemVer', () => {
    expect(parseManualForkedFrom({ content_id: '8a4f01c29d7e', version: '1.0.0' }))
      .toEqual({ content_id: '8a4f01c29d7e', version: '1.0.0' });
    expect(() => parseManualForkedFrom({ content_id: '../secret', version: '1.0.0' })).toThrow('invalid_forked_from');
    expect(() => parseManualForkedFrom({ content_id: '8a4f01c29d7e', version: 'latest' })).toThrow('invalid_forked_from');
  });
});

describe('forked_from 预填', () => {
  it('没有提交副本时返回未预填、未锁定、无派生关联', () => {
    expect(prefillOrigin()).toEqual({ type: null, forked_from: null, locked: false });
  });
});

describe('条款版本不可由调用方伪造', () => {
  it('acceptTerms 只从条款对象取版本', () => {
    expect(acceptTerms(TERMS).version).toBe('1.0');
  });

  it('条款对象缺版本时抛错，不记一个空版本', () => {
    expect(() => acceptTerms({ version: '', effective_at: '', body_markdown: 'x' })).toThrow('terms_version_missing');
  });

  it('接受时间是本机生成的 ISO 串', () => {
    expect(acceptTerms(TERMS).accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('条款改版判定', () => {
  it('版本一致时不算过期', () => {
    expect(termsStale(acceptTerms(TERMS), TERMS)).toBe(false);
  });

  it('Hub 改版后判为过期 —— 要重新确认的是条款而不是内容', () => {
    const accepted = acceptTerms(TERMS);
    expect(termsStale(accepted, { ...TERMS, version: '1.1' })).toBe(true);
  });

  it('尚未接受或拿不到当前条款时不判过期', () => {
    expect(termsStale(null, TERMS)).toBe(false);
    expect(termsStale(acceptTerms(TERMS), null)).toBe(false);
  });
});
