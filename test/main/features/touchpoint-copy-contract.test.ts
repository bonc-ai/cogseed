import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveTouchpointSettingsModel, ISSUE_COPY } = require('../../../src/renderer/modules/touchpoint-settings-model.js');

const ZH = JSON.parse(readFileSync(new URL('../../../src/renderer/locales/zh.json', import.meta.url), 'utf-8'));
const EN = JSON.parse(readFileSync(new URL('../../../src/renderer/locales/en.json', import.meta.url), 'utf-8'));

// locale 文件是顶层扁平键结构（如 "touchpoint_settings.issue.generic.title" 是单个 key），
// 因此按完整 key 直接查找，不做嵌套对象遍历。
function keyIn(locale: Record<string, unknown>, key: string): boolean {
  return locale[key] !== undefined;
}

describe('touchpoint copy contract', () => {
  it('every issue view model key exists in zh.json and en.json', () => {
    const model = deriveTouchpointSettingsModel({
      mode: 'real',
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'needs_reauth', providerId: 'feishu' },
      resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
      sync: { state: 'failed', lastRunAt: null, nextRunAt: null, processed: 0, failed: 1 },
      review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 },
      briefing: { state: 'not_configured', destination: null, lastDelivery: null, pendingCandidateCount: 0 },
      actions: [],
      overall: {
        status: 'attention',
        chain: { connection: 'ok', authorization: 'broken', delivery: 'broken' },
        issues: [
          { severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' },
          { severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' },
        ],
      },
    }, []);
    for (const issue of model.issues) {
      expect(keyIn(ZH, issue.titleKey), `${issue.titleKey} missing in zh.json`).toBe(true);
      expect(keyIn(EN, issue.titleKey), `${issue.titleKey} missing in en.json`).toBe(true);
      expect(keyIn(ZH, issue.detailKey)).toBe(true);
      expect(keyIn(EN, issue.detailKey)).toBe(true);
      if (issue.actionLabelKey) {
        expect(keyIn(ZH, issue.actionLabelKey)).toBe(true);
        expect(keyIn(EN, issue.actionLabelKey)).toBe(true);
      }
    }
  });

  it('every ISSUE_COPY entry resolves in zh.json and en.json', () => {
    // 全量枚举防漏：fixture 只覆盖 2 个 reason，这里遍历 ISSUE_COPY 全部条目，
    // 确保每个 reason 的 titleKey/detailKey/actionLabelKey 都存在于 zh/en（本次 briefing.schedule 就是漏检的）。
    expect(Object.keys(ISSUE_COPY).length).toBeGreaterThan(0);
    for (const [reason, copy] of Object.entries(ISSUE_COPY)) {
      expect(keyIn(ZH, copy.titleKey), `${reason}: ${copy.titleKey} missing in zh.json`).toBe(true);
      expect(keyIn(EN, copy.titleKey), `${reason}: ${copy.titleKey} missing in en.json`).toBe(true);
      expect(keyIn(ZH, copy.detailKey), `${reason}: ${copy.detailKey} missing in zh.json`).toBe(true);
      expect(keyIn(EN, copy.detailKey), `${reason}: ${copy.detailKey} missing in en.json`).toBe(true);
      if (copy.actionLabelKey) {
        expect(keyIn(ZH, copy.actionLabelKey), `${reason}: ${copy.actionLabelKey} missing in zh.json`).toBe(true);
        expect(keyIn(EN, copy.actionLabelKey), `${reason}: ${copy.actionLabelKey} missing in en.json`).toBe(true);
      }
    }
  });

  it('all issue copy values are free of developer terms', () => {
    const BANNED = ['ou_', 'Card JSON', '颗粒度', '实例', '回调地址', 'redirect'];
    const walk = (obj: unknown, path: string): string[] => {
      const hits: string[] = [];
      if (typeof obj === 'string') {
        for (const word of BANNED) if (obj.includes(word)) hits.push(`${path}: ${obj}`);
      } else if (Array.isArray(obj)) {
        obj.forEach((item, i) => hits.push(...walk(item, `${path}[${i}]`)));
      } else if (obj && typeof obj === 'object') {
        Object.entries(obj as Record<string, unknown>).forEach(([k, v]) => hits.push(...walk(v, `${path}.${k}`)));
      }
      return hits;
    };
    // 扁平键结构：直接筛选 issue./chain. 前缀的键值做黑名单扫描
    const hits = Object.entries(ZH as Record<string, unknown>)
      .filter(([k]) => k.startsWith('touchpoint_settings.issue.') || k.startsWith('touchpoint_settings.chain.'))
      .flatMap(([k, v]) => walk(v, k));
    expect(hits).toEqual([]);
  });
});
