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
    // 扁平键结构：整个 touchpoint_settings 段做黑名单扫描（覆盖 issue./chain./action./
    // advanced./disconnect. 等全部前缀）；回调地址引导卡 setup_guide 是白名单例外（
    // 其文案必须含"回调地址/redirect"才能指导用户），扫描时排除。
    const hits = Object.entries(ZH as Record<string, unknown>)
      .filter(([k]) => k.startsWith('touchpoint_settings.') && !k.includes('setup_guide'))
      .flatMap(([k, v]) => walk(v, k));
    expect(hits).toEqual([]);
  });
});

describe('touchpoint action mapping', () => {
  // model 全部可能输出的 actionId（primaryAction + issues[].actionId）必须在
  // touchpoint-settings.js 的 ACTION_HANDLERS 注册，否则待办卡按钮点击静默无操作。
  const SOURCE = readFileSync(new URL('../../../src/renderer/modules/touchpoint-settings.js', import.meta.url), 'utf-8');
  const HANDLERS = SOURCE.match(/ACTION_HANDLERS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
  const handlerIds = new Set(
    [...HANDLERS.matchAll(/^\s{4}'([^']+)':/gm)].map((m) => m[1]),
  );

  it('every actionId the model can emit has a registered handler', () => {
    // 枚举 model 全部可能输出的 actionId：primaryAction + issues[].actionId
    const candidates = new Set<string>(['connection.connect']);
    const fixtures: Array<Record<string, unknown>> = [
      { overall: { status: 'off', chain: { connection: 'missing', authorization: 'missing', delivery: 'missing' }, issues: [] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'broken', delivery: 'missing' }, issues: [{ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'broken' }, issues: [{ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'missing', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorization.begin' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'delivery', reason: 'no_resources', actionId: 'resources.discover' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'delivery', reason: 'not_configured', actionId: 'briefing.schedule' }] } },
    ];
    for (const fixture of fixtures) {
      const model = deriveTouchpointSettingsModel({ mode: 'real', messaging: { instanceId: 'f', botConnected: true, ownerConfigured: true }, authorization: { kind: 'connected', providerId: 'feishu' }, resources: { discovered: 1, selected: 1, ready: 1, failed: 0, unsupported: 0 }, sync: { state: 'ready', lastRunAt: null, nextRunAt: null, processed: 1, failed: 0 }, review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 }, briefing: { state: 'preview_ready', destination: null, lastDelivery: null, pendingCandidateCount: 0 }, actions: [], overall: fixture.overall }, []);
      candidates.add(model.primaryAction);
      for (const issue of model.issues) if (issue.actionId) candidates.add(issue.actionId);
    }
    for (const id of candidates) {
      expect(handlerIds.has(id), `actionId '${id}' 未在 touchpoint-settings.js ACTION_HANDLERS 注册`).toBe(true);
    }
  });
});
