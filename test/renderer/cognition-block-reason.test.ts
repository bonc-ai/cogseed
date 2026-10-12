/**
 * 拦截原因可见性（2026-09-25 验收修复 US-601 AC4 / US-604 AC1、AC3）。
 *
 * 主进程的准入判定给两样东西：code（分类）与 blockRule（具体规则标识）。
 * 修复前渲染层没有出口——attachAssetToConversation 连 try/catch 都没有，失败
 * 只落 logger，用户看到"点了没反应"；即便弹出来也是主进程的英文原文
 * （`explicit projection asset is not active: aa-xxx`），既看不懂是哪条规则，
 * 还把内部 id 露在界面上。这里守住三件事：说得出规则、不露内部 id、不露正文。
 */
import { describe, expect, it } from 'vitest';

import { loadCognitionAssets } from './helpers/cognition-renderer';

const RULES = [
  ['paused', '暂停'],
  ['archived', '归档'],
  ['revoked', '撤回'],
  ['deleted', '删除'],
  ['purged', '彻底删除'],
  ['inactive', '生效状态'],
  ['missing', '不存在'],
  ['source_unavailable', '来源'],
  ['agent', '智能体'],
  ['scope', '作用范围'],
  ['maturity', '使用契约'],
  ['forbidden_context', '禁用场景'],
  ['not_applicable_context', '适用场景'],
  ['version_changed', '版本'],
  ['versions_missing', '快照'],
  ['expired', '过期'],
  ['not_committed', '确认'],
] as const;

const FORBIDDEN_IN_UI = [
  /explicit projection/i,
  /not eligible/i,
  /is not active/i,
  /aa-[0-9a-z]/,
  /proj-[0-9a-z]/,
  /aur-[0-9a-z]/,
  /immediate-[0-9a-f]/,
  /kse-[0-9a-z]/,
];

describe('blockReasonText：每条规则都说人话', () => {
  it('具体规则标识各自翻成对应中文规则名，且互不相同', () => {
    const { ns } = loadCognitionAssets();
    const seen = new Map<string, string>();

    for (const [rule, keyword] of RULES) {
      const text = ns.blockReasonText({ blockRule: rule });
      expect(text, `${rule} 必须有文案`).toBeTruthy();
      expect(text, `${rule} 的文案应说明${keyword}`).toContain(keyword);
      expect(text.startsWith('cognition.'), `${rule} 不得退回 key 原文`).toBe(false);
      seen.set(text, rule);
    }

    // 规则之间不许共用一句话——否则用户仍然分不清是哪条规则拦的（SC-004）。
    expect(seen.size, '每条规则应有各自的说明').toBeGreaterThan(RULES.length - 3);
  });

  it('没有规则标识时退回分类码，仍然说人话', () => {
    const { ns } = loadCognitionAssets();

    expect(ns.blockReasonText({ code: 'projection_asset_ineligible' })).toContain('权限范围');
    expect(ns.blockReasonText({ code: 'projection_asset_inactive' })).toContain('生效状态');
    expect(ns.blockReasonText({ code: 'projection_source_unavailable' })).toContain('来源');
    expect(ns.blockReasonText({ code: 'projection_asset_missing' })).toContain('不存在');
  });

  it('未知码 / 空错误走兜底文案，不编造规则、不抛错', () => {
    const { ns } = loadCognitionAssets();

    expect(ns.blockReasonText({ code: 'E_UNKNOWN' })).toContain('不可引用');
    expect(ns.blockReasonText({})).toContain('不可引用');
    expect(ns.blockReasonText(undefined)).toContain('不可引用');
  });

  it('任何分支都不上屏英文原文或内部 id', () => {
    const { ns } = loadCognitionAssets();
    const inputs: Array<Record<string, unknown>> = [
      ...RULES.map(([rule]) => ({ blockRule: rule })),
      { code: 'projection_asset_ineligible' },
      { code: 'E_UNKNOWN' },
      {},
    ];

    for (const input of inputs) {
      const text = ns.blockReasonText(input);
      for (const pattern of FORBIDDEN_IN_UI) {
        expect(text, `不得出现 ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe('控制动作失败如实反馈（US-604 AC7）', () => {
  it('带准入码的失败翻成「这次操作没有生效：{规则名}」，不上屏英文原文与内部 id', () => {
    const { ns } = loadCognitionAssets();

    const text = ns.recallErrorText({
      code: 'projection_asset_inactive',
      blockRule: 'paused',
      error: 'explicit projection asset is not active: aa-secret01',
    });

    expect(text).toContain('没有生效');
    expect(text).toContain('暂停');
    for (const pattern of FORBIDDEN_IN_UI) {
      expect(text, `失败提示不得出现 ${pattern}`).not.toMatch(pattern);
    }
  });

  it('没有准入码时保持既有翻译链，不吞失败', () => {
    const { ns } = loadCognitionAssets();

    const text = ns.recallErrorText({ code: 'promotion_blocked', promotionReasons: [] });

    expect(text).toContain('候选');
  });
});

describe('reportBlocked：拦截必须可见，且只给标题与规则名', () => {
  it('带资产标题时说明是哪条内容、被哪条规则拦下', async () => {
    const alerts: string[] = [];
    const { ns } = loadCognitionAssets({}, {}, {
      uiAlert: async (message: string) => { alerts.push(String(message)); },
    });

    await ns.reportBlocked(
      Object.assign(new Error('explicit projection asset is not active: aa-secret01'), {
        code: 'projection_asset_inactive',
        blockRule: 'paused',
      }),
      '季度复盘模板',
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('季度复盘模板');
    expect(alerts[0]).toContain('暂停');
    for (const pattern of FORBIDDEN_IN_UI) {
      expect(alerts[0], `提示不得出现 ${pattern}`).not.toMatch(pattern);
    }
  });

  it('拿不到标题时也要说明规则，不静默、不显示 id', async () => {
    const alerts: string[] = [];
    const { ns } = loadCognitionAssets({}, {}, {
      uiAlert: async (message: string) => { alerts.push(String(message)); },
    });

    await ns.reportBlocked(Object.assign(new Error('boom'), { blockRule: 'source_unavailable' }), '');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('来源');
    expect(alerts[0]).not.toContain('boom');
  });

  it('没有 uiAlert 时退回轻提示，反馈不会消失', async () => {
    const toasts: Array<[string, string]> = [];
    const { ns } = loadCognitionAssets({}, {}, {
      uiToast: (message: string, opts: { variant?: string }) => { toasts.push([String(message), String(opts?.variant || '')]); },
    });

    await ns.reportBlocked(Object.assign(new Error('boom'), { blockRule: 'agent' }), '只给某智能体的内容');

    expect(toasts).toHaveLength(1);
    expect(toasts[0][0]).toContain('智能体');
    expect(toasts[0][0]).toContain('只给某智能体的内容');
    expect(toasts[0][1]).toBe('warning');
  });
});
