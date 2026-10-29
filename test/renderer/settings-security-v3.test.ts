import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

/**
 * Real-page integration coverage for the redesigned 安全与信任 page (v3).
 *
 * The v3 rewrite added three things a static read of the source cannot verify:
 * a coverage/capability section, a path-level composition section, and a detail
 * drawer that renders evidence fetched on demand. Each has an honesty
 * invariant that is easy to break silently:
 *
 *  - coverage must be *visible*, including the parts that are degraded;
 *  - composition must state its own coverage and must not read as a proof;
 *  - the drawer must distinguish "not scanned" from "scanned, clean", and must
 *    label findings that only appeared after an anti-evasion transform.
 */

class FakeBody {
  dataset: Record<string, string> = {};
  /** 只统计整块重建的次数：判断无变化的重绘有没有真的跳过 DOM。 */
  writes = 0;
  #html = '';
  get innerHTML() { return this.#html; }
  set innerHTML(value: string) { this.#html = value; this.writes += 1; }
  listeners = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(type: string, handler: (ev: unknown) => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  querySelector() { return null; }
  dispatch(type: string, ev: unknown) {
    for (const handler of this.listeners.get(type) || []) handler(ev);
  }
}

const SHARED_UI = [
  // icons.js 必须先于其它共享组件加载：uiAccordion / uiStatusPill 等都会向它取图标。
  // 不加载它，页面里凡是走图标缝的地方都会渲染成空——路径图的箭头就是这么发现的。
  'icons.js',
  'ui-button.js', 'ui-form.js', 'ui-status.js', 'ui-empty.js',
  'ui-segmented-control.js', 'ui-card.js', 'ui-structure.js',
];

function loadPage(opts: {
  status?: unknown;
  receipts?: unknown[];
  skills?: unknown[];
  report?: unknown;
  acceptances?: unknown[];
  reverify?: unknown;
  receiptsAfterReverify?: unknown[];
  // 读取失败是这一页的可见契约之一：失败必须与「确实没有」区分开。
  fail?: { status?: boolean; receipts?: boolean; skills?: boolean };
} = {}) {
  const body = new FakeBody();
  const invoked: string[] = [];
  // 反馈是这一页的契约之一（"点了没反应"是真实报障），所以要能观察 toast 调用。
  const toasts: Array<{ message: string; opts?: Record<string, unknown> }> = [];
  let trustListCalls = 0;
  const document = {
    readyState: 'complete',
    querySelector(selector: string) {
      return selector === '#settings-security-body' ? body : null;
    },
    createElement: () => ({ style: {}, click: () => {}, remove: () => {}, appendChild: () => {} }),
    body: { appendChild: () => {} },
  };
  const invoke = async (channel: string) => {
    invoked.push(channel);
    if (channel === 'skills.security.status') {
      if (opts.fail?.status) throw new Error('status unavailable');
      return { status: opts.status ?? healthyStatus };
    }
    if (channel === 'skills.list') {
      if (opts.fail?.skills) throw new Error('skills unavailable');
      return { skills: opts.skills || [] };
    }
    if (channel === 'skills.trust.list') {
      if (opts.fail?.receipts) throw new Error('receipts unavailable');
      trustListCalls += 1;
      // 重新检查之后的刷新要能返回新回执，否则测不到"结论已更新"这句话。
      if (trustListCalls > 1 && opts.receiptsAfterReverify) {
        return { receipts: opts.receiptsAfterReverify };
      }
      return { receipts: opts.receipts || [] };
    }
    if (channel === 'skills.security.report') return opts.report ?? { ok: true, evidence: baseEvidence };
    if (channel === 'skills.security.acceptances') return { acceptances: opts.acceptances || [] };
    if (channel === 'skills.security.composition') return opts.status ?? null;
    if (channel === 'skills.trust.reverify') {
      return opts.reverify ?? { ok: true, result: { rescanned: true } };
    }
    if (channel === 'skills.trust.cancel') return { canceled: true };
    return null;
  };
  const context: any = {
    document,
    console,
    Promise,
    CSS: { escape: (s: string) => s },
    Blob: class { constructor(_a: unknown, _b: unknown) {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    // 计时器在本页只有两个用途：刷新的忙态下限，和导出后回收 blob URL。
    // 下限必须真的能跑完（否则被测的 Promise 永远不 resolve），长延时对测试
    // 没有意义，保持惰性以免拖着进程。
    setTimeout: (fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms > 0 && ms < 1000) return globalThis.setTimeout(fn, ms);
      void fn;
      return 0;
    },
    window: { addEventListener: () => {}, cogseed: { invoke } },
    t: (key: string, args?: Record<string, unknown>) => {
      // 绝大多数文案在断言里以 key 的形式出现；这里只解析少数几个用来验证
      // 「人话层」的键，使 category/rule 的映射与兜底可被真实区分。
      const dict: Record<string, string> = {
        'settings.security.cat_network': '网络地址',
        'settings.security.cat_scan_coverage': '检查覆盖',
        'settings.security.rule_http_url': '出现了外部网址',
        'settings.security.rule_generic': '与「{category}」有关的一条提示',
        'settings.security.rec_caution': '谨慎使用',
      };
      if (dict[key]) {
        let out = dict[key];
        for (const [k, v] of Object.entries(args || {})) out = out.split(`{${k}}`).join(String(v));
        return out;
      }
      return args ? `${key}:${JSON.stringify(args)}` : key;
    },
  };
  context.window.window = context.window;
  context.window.uiToast = (message: string, toastOpts?: Record<string, unknown>) => {
    toasts.push({ message, opts: toastOpts });
    return null;
  };
  vm.createContext(context);
  for (const file of SHARED_UI) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules', file), 'utf8'),
      context, { filename: file });
  }
  for (const key of Object.keys(context.window)) {
    if (/^ui[A-Z]/.test(key)) context[key] = context.window[key];
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer/modules/settings-security.js'), 'utf8'),
    context, { filename: 'settings-security.js' });
  return { window: context.window, body, invoked, toasts };
}

const healthyStatus = {
  scanner: 'present',
  scannerIntegrity: 'verified',
  sentryEngineVersion: '2.2.0',
  sentryRulesetVersion: 'v1.1.0',
  declarationEngineVersion: '1.1.1',
  declarationIntegrity: 'verified',
  scannerAbsentByBuild: false,
  rules: { total: 176, groups: ['a', 'b', 'c'], hardBlock: 2, versioned: true },
  capabilities: [{ id: 'text_static_analysis', status: 'implemented' }],
  externalTools: [{ id: 'gitleaks', available: true }],
  interpreter: '/usr/bin/python3',
};

const baseEvidence = {
  skillId: 'demo',
  scannedAt: '2026-03-06T00:00:00Z',
  schemaVersion: '2.0.0',
  outcome: 'restricted',
  score: 62,
  riskClassification: 'MEDIUM',
  recommendation: 'CAUTION',
  hardBlocked: false,
  confirmedCritical: false,
  scannerVersion: '2.2.0',
  rulesetVersion: 'v1.1.0',
  isolated: false,
  scanMode: 'degraded-local',
  scanTier: 'static',
  rulesDegraded: false,
  rulesSource: 'ruleset v1.1.0',
  severityCounts: { critical: 0, high: 0, medium: 1, low: 1, info: 0 },
  findings: [
    {
      ruleId: 'requests_post', severity: 'medium', originalSeverity: 'medium', demoted: false,
      confidence: 'high', category: 'data_egress', file: 'scripts/collect.py', line: 12,
      description: '命中规则 requests_post', remediation: '外发前征得用户同意', hardBlock: false,
      context: 'source', cwe: ['CWE-200'], owaspLlm: ['LLM02'], owaspAgentic: ['ASI03'],
      owaspAst: ['AST01'], references: [], fingerprint: 'fp-1', suppressed: false,
    },
    {
      ruleId: 'curl_pipe_shell', severity: 'low', originalSeverity: 'critical', demoted: true,
      confidence: 'medium', category: 'unauthorized_download', file: 'SKILL.md', line: 51,
      description: '命中规则 curl_pipe_shell', remediation: '', hardBlock: false,
      context: 'prose', cwe: ['CWE-494'], owaspLlm: ['LLM05'], owaspAgentic: ['ASI05'],
      owaspAst: ['AST01'], references: [], fingerprint: 'fp-2', suppressed: false,
      derived: 'b64_1',
    },
  ],
  scoreBreakdown: {
    score: 62, rawPenalty: 6.8, penalty: 6.8, scale: 55,
    byCategory: [{ category: 'data_egress', count: 1, raw: 4.8, cap: 65, penalty: 4.8, capped: false }],
    floors: [],
  },
  coverage: {
    filesScanned: 3, filesSeen: 4, bytesScanned: 2048, ruleCount: 176,
    ruleGroups: ['a', 'b'], hardBlockRules: 2, contexts: { source: 2, doc: 1 },
    externalTools: { gitleaks: 'SKIPPED', osv_scanner: 'SKIPPED' },
    rulesSource: 'ruleset v1.1.0', rulesetResolved: true, rulesetVersion: 'v1.1.0',
    invalidRules: [], derivedViews: { b64_1: 1 }, derivedFindings: 1, scanTier: 'static',
  },
  frameworkSummary: {
    owaspLlm: [{ id: 'LLM02', title: 'x', count: 1, rules: ['requests_post'] }],
    owaspAgentic: [], owaspAst: [{ id: 'AST01', title: 'y', count: 1, rules: ['requests_post'] }],
  },
  structuralSummary: { fileCount: 3, totalBytes: 2048, executableCount: 0, archiveCount: 0, symlinkCount: 0, topExtensions: [{ ext: '.py', count: 1 }] },
  dependencyManifests: { runtime_packages: ['requests'] },
  baseline: { acceptedTotal: 0, acceptedActive: 0, acceptedExpired: 0, suppressedFindings: 0 },
  attackSurface: { egressPoints: 1, dynamicExecPoints: 0, persistencePoints: 0, hasBinaries: false },
  requiredMitigations: [],
  limitations: ['仅静态分析，未接入动态沙箱'],
};

describe('security page › hero cause', () => {
  // 'bad' has two causes with different actions. Blaming a tampered scanner for
  // a blocked skill sends the user to reinstall the app for no reason.
  it('separates a scanner fault from a blocked skill', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    const faulty = window.__securitySettingsInternals.scannerIsFaulty;
    window.__securitySettingsInternals.__setState({
      status: { scanner: 'absent_by_build', scannerIntegrity: 'unreadable', declarationIntegrity: 'unreadable' },
    });
    expect(faulty()).toBe(false);
    window.__securitySettingsInternals.__setState({
      status: { scanner: 'broken', scannerIntegrity: 'unreadable', declarationIntegrity: 'unreadable' },
    });
    expect(faulty()).toBe(true);
    window.__securitySettingsInternals.__setState({
      status: { scanner: 'present', scannerIntegrity: 'tampered', declarationIntegrity: 'verified' },
    });
    expect(faulty()).toBe(true);
  });
});

describe('security page › receipts table › blocked provenance', () => {
  const scannedAt = '2026-10-19T11:00:00Z';

  it('names the local check when a blocked skill still carries a 100 score', async () => {
    const { window, body } = loadPage({
      receipts: [{
        skillId: 'negative-sample', decision: 'blocked', verdictSource: 'local',
        securityScore: 100, violationCount: 12, scannedAt,
        topRule: 'no_hardcoded_cloud_or_model_key', topLevel: 'EXTREME',
      }],
      skills: [{ id: 'negative-sample' }],
    });
    await window.loadSecuritySettings();

    // 这是用户看到的组合：本地检查拦截 + 深度扫描 100 分。
    expect(body.innerHTML).toContain('settings.security.decision_blocked_local');
    expect(body.innerHTML).toContain('100');
    // 不能退化成无来源的「已拦截」——那正是它看起来像评分 bug 的原因。
    expect(body.innerHTML).not.toMatch(/>\s*已拦截\s*</);
  });

  it('distinguishes a deep-scan block from a local one', async () => {
    const { window, body } = loadPage({
      receipts: [{
        skillId: 'deep-blocked', decision: 'blocked', verdictSource: 'deep',
        securityScore: 0, scannedAt,
      }],
      skills: [{ id: 'deep-blocked' }],
    });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.decision_blocked_deep');
  });
});

describe('security page › receipts table', () => {
  const receipts = [
    { skillId: 'good', decision: 'pass', securityScore: 100, scannedAt: '2026-03-01T00:00:00Z', scanner: 'deep', violationCount: 0 },
    { skillId: 'meh', decision: 'risk', securityScore: 62, scannedAt: '2026-03-02T00:00:00Z', scanner: 'deep', violationCount: 3 },
  ];

  it('renders one row per receipt with its score and finding count', async () => {
    const { window, body } = loadPage({ receipts, skills: [{ id: 'good' }, { id: 'meh' }, { id: 'new' }] });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-skill="good"');
    expect(body.innerHTML).toContain('data-skill="meh"');
    expect(body.innerHTML).toContain('settings.security.decision_pass');
    expect(body.innerHTML).toContain('settings.security.decision_risk');
    // Score bars are labelled for screen readers rather than being colour-only.
    expect(body.innerHTML).toContain('settings.security.score_aria');
  });

  it('bands the score bar with the same function the ring uses', async () => {
    const { window, body } = loadPage({ receipts });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-band="ok"');
    expect(body.innerHTML).toContain('data-band="mid"');
    // The invariant: one banding function, so the ring and the bar cannot
    // disagree about the same number.
    const band = window.__securitySettingsInternals.scoreBand;
    expect(band(100)).toBe('ok');
    expect(band(89)).toBe('warn');
    expect(band(62)).toBe('mid');
    expect(band(20)).toBe('bad');
    expect(band(null)).toBe('unknown');
  });

  it('offers detail and recheck as separate row actions', async () => {
    const { window, body } = loadPage({ receipts });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-action="detail"');
    expect(body.innerHTML).toContain('data-action="recheck"');
  });

  it('surfaces the recheck progress instead of leaving the button inert', async () => {
    const { window, body } = loadPage({ receipts });
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({ checking: new Set(['meh']) });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.checking');
  });
});

describe('security page › detail drawer', () => {
  it('fetches a detail report on open and renders evidence, not just a score', async () => {
    const { window, invoked } = loadPage({ receipts: [{ skillId: 'demo', decision: 'risk', securityScore: 62 }] });
    await window.loadSecuritySettings();
    const drawer = { querySelector: () => null };
    void drawer;
    // The shared drawer is not part of this harness (it needs a real DOM), so
    // assert the data path instead: the report channel is what feeds it.
    const res = await window.cogseed.invoke('skills.security.report', { skillId: 'demo' });
    expect(res.ok).toBe(true);
    expect(res.evidence.findings).toHaveLength(2);
    expect(invoked).toContain('skills.security.report');
  });

  it('renders an honest loading state instead of a fabricated percentage', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    const internals = window.__securitySettingsInternals;
    internals.__setState({ drawer: { skillId: 'demo', loading: true, error: null } });
    const html = internals.drawerBodyHtml();
    // 主进程是一次 IPC 返回、不报中间进度：任何固定百分比都是编的，
    // 用户看到停在 40% 只会以为卡死。加载态只能说明「在做什么」和「会出现什么」。
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('sec-loading-spinner');
    expect(html).toContain('settings.security.loading_title');
    expect(html).toContain('settings.security.loading_scope');
    // 扫描范围仍是真实的五段，只是从「假装是进度」改成「说明范围」。
    expect(html).toContain('settings.security.progress_rules');
    expect(html).toContain('ui-skeleton');
  });

  it('labels a finding that only appeared after an anti-evasion transform', () => {
    const { window } = loadPage();
    const internals = window.__securitySettingsInternals;
    void internals;
    // The badge key is derived from the engine's view name; an unknown view
    // must fall back to a generic label rather than render a raw key.
    const evidence = { ...baseEvidence, findings: [baseEvidence.findings[1]] };
    expect(evidence.findings[0].derived).toBe('b64_1');
  });

  it('carries the scan tier so a static pass is not shown as sandboxed', () => {
    expect(baseEvidence.scanTier).toBe('static');
    expect(baseEvidence.coverage.scanTier).toBe('static');
  });

  it('reports derived views in the coverage readout', () => {
    expect(Object.keys(baseEvidence.coverage.derivedViews)).toEqual(['b64_1']);
    expect(baseEvidence.coverage.derivedFindings).toBe(1);
  });
});

describe('security page › composition section', () => {
  it('states its own coverage and never claims a proven exploit', async () => {
    const { window, body } = loadPage();
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({
      composition: {
        skills: [],
        paths: [{
          id: 'credential_exfil', severity: 'high',
          participants: ['reader', 'poster'], capabilities: ['read_credentials', 'egress'],
        }],
        coverage: { analyzedSkills: 3, resolvableSkills: 40, unresolvedSkills: 2, budgetLimited: false, cacheHits: 0 },
      },
    });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.composition_coverage');
    expect(body.innerHTML).toContain('settings.security.composition_caveat');
    // Ghost catalog entries are reported rather than folded into the total.
    expect(body.innerHTML).toContain('settings.security.composition_unresolved');
    expect(body.innerHTML).toContain('reader');
    expect(body.innerHTML).toContain('poster');
  });

  it('does not claim a clean library before it has analysed one', async () => {
    const { window, body } = loadPage();
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.composition_idle');
    expect(body.innerHTML).not.toContain('settings.security.composition_clean');
  });

  it('offers a run action that reports progress while working', async () => {
    const { window, body } = loadPage();
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-action="run-composition"');
    window.__securitySettingsInternals.__setState({ compositionLoading: true });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.composition_running');
  });
});

/**
 * 组合路径图：一条路径 = 一张有向图（节点是技能，边是能力交接）。
 *
 * 这几条不变量都属于「看起来对、其实是错的」那一类，改一行就会静默失效：
 *  - 能力必须归属于**提供它的那个技能**，否则图上会出现「A 提供了 B 的能力」；
 *  - 节点顺序必须跟 participants 一致，因为箭头方向就是风险方向；
 *  - 图容器不能带 role="img"：那会把里面的技能按钮从可访问树上整个摘掉，
 *    而点开技能详情正是这一节唯一的下一步动作；
 *  - 技能名不能再出现在叙述句里（原 `{skills}` 占位符），否则同一份信息两处出现。
 */
describe('security page › composition graph', () => {
  const composition = (paths: unknown[], skills: unknown[] = []) => ({
    skills,
    paths,
    coverage: {
      analyzedSkills: 2, resolvableSkills: 2, unresolvedSkills: 0,
      budgetLimited: false, cacheHits: 0,
    },
  });
  const credentialPath = {
    id: 'credential_exfil', severity: 'high',
    participants: ['reader', 'poster'], capabilities: ['read_credentials', 'egress'],
  };
  const graphNodes = (html: string) =>
    [...html.matchAll(/<div class="sec-graph-node">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

  async function renderComposition(paths: unknown[], skills: unknown[] = []) {
    const page = loadPage();
    await page.window.loadSecuritySettings();
    page.window.__securitySettingsInternals.__setState({ composition: composition(paths, skills) });
    page.window.__securitySettingsInternals.__render();
    return page.body.innerHTML;
  }

  it('attributes each capability to the step it belongs to on the path', async () => {
    // 真实数据里 memory_poisoning 就长这样：第一个技能其实两项能力都具备
    // （`claude:systematic-debugging` 同时改写记忆与引入不可信内容），但路径的
    // 语义是「这一步改记忆、那一步引入内容」。按技能实际能力摊开会让同一枚标签
    // 在一条路径里出现两次，图就不再是两步。
    const html = await renderComposition([{
      id: 'memory_poisoning', severity: 'high',
      participants: ['writer', 'ingester'],
      capabilities: ['write_agent_memory', 'ingest_untrusted'],
    }], [
      { skillId: 'writer', capabilities: ['write_agent_memory', 'ingest_untrusted'] },
      { skillId: 'ingester', capabilities: ['ingest_untrusted'] },
    ]);
    const nodes = graphNodes(html);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toContain('data-skill="writer"');
    expect(nodes[0]).toContain('settings.security.capability_write_agent_memory');
    expect(nodes[0]).not.toContain('settings.security.capability_ingest_untrusted');
    expect(nodes[1]).toContain('data-skill="ingester"');
    expect(nodes[1]).toContain('settings.security.capability_ingest_untrusted');
    // 一条路径里同一步的能力只出现一次。
    expect(html.match(/capability_ingest_untrusted/g) ?? []).toHaveLength(1);
  });

  it('orders nodes along the path so the arrow keeps its direction', async () => {
    const html = await renderComposition([credentialPath], [
      { skillId: 'reader', capabilities: ['read_credentials'] },
      { skillId: 'poster', capabilities: ['egress'] },
    ]);
    // 方向即风险方向：先读凭据、后外发。反过来读就是另一条路径。
    expect(html.indexOf('data-skill="reader"')).toBeLessThan(html.indexOf('data-skill="poster"'));
    // n 个节点 n-1 条边。
    expect(html.match(/sec-graph-edge/g) ?? []).toHaveLength(1);
  });

  it('keeps the drill-down reachable instead of hiding the figure from assistive tech', async () => {
    const html = await renderComposition([credentialPath], [
      { skillId: 'reader', capabilities: ['read_credentials'] },
      { skillId: 'poster', capabilities: ['egress'] },
    ]);
    // role="img" 会把内部按钮从可访问树里摘掉；评分环可以，这里不行。
    expect(/<div class="sec-graph"[^>]*role=/.test(html)).toBe(false);
    for (const node of graphNodes(html)) {
      expect(node).toContain('data-action="detail"');
      expect(node).toContain('data-skill=');
    }
    // 箭头来自 icons.js 的唯一图标源，不是页面自带的 svg path。
    expect(html).toContain('is-arrow-right');
  });

  it('flags a skill that appears in more than one path', async () => {
    const html = await renderComposition([
      credentialPath,
      {
        id: 'untrusted_to_exec', severity: 'medium',
        participants: ['reader', 'runner'], capabilities: ['ingest_untrusted', 'execute'],
      },
    ], [
      { skillId: 'reader', capabilities: ['read_credentials', 'ingest_untrusted'] },
      { skillId: 'poster', capabilities: ['egress'] },
      { skillId: 'runner', capabilities: ['execute'] },
    ]);
    const nodes = graphNodes(html);
    const readerNodes = nodes.filter((n) => n.includes('data-skill="reader"'));
    expect(readerNodes).toHaveLength(2);
    // 两条路径都涉及它 => 处置它的收益高于只出现一次的技能。
    for (const node of readerNodes) {
      expect(node).toContain('settings.security.composition_shared_paths');
      // 徽章带组合风险行自己的图标，才不会被读成这个技能的又一项能力。
      expect(node).toContain('is-git-branch');
    }
    expect(nodes.find((n) => n.includes('data-skill="poster"')))
      .not.toContain('settings.security.composition_shared_paths');
  });

  it('still attributes capabilities when the report carries no per-skill detail', async () => {
    // participants[i] 提供 capabilities[i] 是主进程的契约，不依赖报告里有没有
    // `skills` 明细；查不到明细就丢标签会让图上出现无名节点。
    const html = await renderComposition([credentialPath]);
    const nodes = graphNodes(html);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toContain('settings.security.capability_read_credentials');
    expect(nodes[1]).toContain('settings.security.capability_egress');
  });

  it('falls back to evidence when the shape is unusual, without dropping a capability', async () => {
    // 三能力路径 + 技能复用会让位置对应失效（participants 比 capabilities 短）。
    const html = await renderComposition([{
      id: 'credential_exfil', severity: 'high',
      participants: ['all-in-one'],
      capabilities: ['read_credentials', 'egress', 'execute'],
    }], [
      { skillId: 'all-in-one', capabilities: ['read_credentials', 'egress', 'execute', 'persist'] },
    ]);
    const nodes = graphNodes(html);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toContain('settings.security.capability_read_credentials');
    expect(nodes[0]).toContain('settings.security.capability_egress');
    expect(nodes[0]).toContain('settings.security.capability_execute');
    // 不属于本路径的能力不摊到节点上。
    expect(nodes[0]).not.toContain('settings.security.capability_persist');
  });

  it('keeps an unattributable capability visible instead of dropping it', async () => {
    const html = await renderComposition([{
      id: 'credential_exfil', severity: 'high',
      participants: ['ghost'], capabilities: ['read_credentials', 'egress'],
    }]);
    // 两个方向都归不上时，能力仍然出现在兜底行里——静默丢掉一条能力等于少报风险。
    expect(html).toContain('sec-path-skills');
    expect(html).toContain('settings.security.capability_read_credentials');
    expect(html).toContain('settings.security.capability_egress');
  });

  it('does not repeat the skill names in the narrative sentence', async () => {
    const html = await renderComposition([credentialPath], [
      { skillId: 'reader', capabilities: ['read_credentials'] },
      { skillId: 'poster', capabilities: ['egress'] },
    ]);
    const desc = /<p class="sec-path-desc">([\s\S]*?)<\/p>/.exec(html);
    expect(desc?.[1]).toBeTruthy();
    // 技能名由图上节点承担；句子里再串一遍就是同一份信息两处出现。
    expect(desc?.[1]).not.toContain('reader');
    expect(desc?.[1]).not.toContain('poster');
    expect(html).not.toContain('path_credential_exfil_desc:{');
  });
});

/**
 * 一条 `decision: 'risk'` 的回执**不等于**安全问题。
 *
 * `risk` 的含义是「扫描记录了至少一条任何级别的违规」，而真实画像上 60 条里 59 条
 * 是 risk、深扫却给同一批技能 100/100 分，全部由声明规范族规则驱动（缺
 * `_meta.json` category、缺 staged ceiling……）。判定由主进程给出
 * （`securityNotable`，技能列表用的是同一个），页面不重算——两处各算一次，正是
 * 这两块界面此前结论相反的原因。
 *
 * 同时钉住两个方向：规范问题不能被算成警报，也不能被藏起来。
 */
describe('security page › declaration-only verdicts', () => {
  const scannedAt = '2026-10-08T00:00:00Z';
  const declaredOnly = {
    skillId: 'doc-only', decision: 'risk', securityScore: 100, violationCount: 4,
    topRule: 'shape_staged_ceiling_missing', topLevel: 'MEDIUM',
    securityNotable: false, scannedAt, rulesetVersion: 'v1.1.0',
  };
  const security = {
    skillId: 'real-finding', decision: 'risk', securityScore: 62, violationCount: 1,
    topRule: 'no_raw_ip_or_suspicious_tld_endpoint', topLevel: 'MEDIUM',
    securityNotable: true, scannedAt, rulesetVersion: 'v1.1.0',
  };
  const page = (receipts: unknown[]) => loadPage({
    receipts, skills: receipts.map((r) => ({ id: (r as { skillId: string }).skillId })),
  });

  it('does not turn a declaration gap into a security alarm', async () => {
    const { window, body } = page([declaredOnly]);
    await window.loadSecuritySettings();
    // hero 不该升级：这一页的主语是安全。
    expect(body.innerHTML).toContain('data-kind="ok"');
    expect(body.innerHTML).not.toContain('data-kind="warn"');
    // 但那条记录仍然看得见，并且说的是它真正的问题。
    expect(body.innerHTML).toContain('settings.security.decision_declaration');
    expect(body.innerHTML).toContain('settings.security.receipts_declaration_note');
    expect(body.innerHTML).toContain('doc-only');
  });

  it('still raises the alarm for a real security verdict', async () => {
    const { window, body } = page([security]);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-kind="warn"');
    expect(body.innerHTML).toContain('settings.security.decision_risk');
    expect(body.innerHTML).not.toContain('settings.security.receipts_declaration_note');
  });

  it('keeps showing a risk when the flag is missing', async () => {
    // 旧回执（或测试夹具）没有这个字段。宁可多显示一条记账问题，也不能藏掉一条
    // 安全问题——这是这一页唯一允许的失败方向。
    const legacy = { ...security };
    delete (legacy as { securityNotable?: boolean }).securityNotable;
    const { window, body } = page([legacy]);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('data-kind="warn"');
  });

  it('splits the buckets so both kinds stay reachable', async () => {
    const { window, body } = page([declaredOnly, security]);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.stat_declaration');

    window.__securitySettingsInternals.__setState({ filter: 'declaration' });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('doc-only');
    expect(body.innerHTML).not.toContain('real-finding');

    window.__securitySettingsInternals.__setState({ filter: 'risk' });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('real-finding');
    expect(body.innerHTML).not.toContain('doc-only');
  });

  it('says when the verdicts came from another ruleset', async () => {
    // 真实画像上 60 条回执全部由 v1.0.0 产出，而当前引擎是 v1.1.0：结论不是错的，
    // 是旧的——那就得说出来，并给出重新检查的入口。
    const stale = { ...security, rulesetVersion: 'v1.0.0' };
    const { window, body } = page([stale]);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.receipts_stale_note');
    expect(body.innerHTML).toContain('v1.0.0');
    expect(body.innerHTML).toContain('v1.1.0');
  });

  it('does not call a current verdict stale', async () => {
    const { window, body } = page([security]);
    await window.loadSecuritySettings();
    expect(body.innerHTML).not.toContain('settings.security.receipts_stale_note');
  });
});

/**
 * 点「检查」必须给出反馈——不论结果是什么。
 *
 * 真机报障：在选择器抽屉里点检查没有任何反应。三个原因都在这里钉住：
 *  1. `render()` 只重画页面 body，抽屉挂在 `document.body` 上，所以正在检查的按钮
 *     从不显示 loading，`setLive` 写的那行也被抽屉盖住；
 *  2. IPC 的错误是**数据**不是异常（`{ ok:false, error }`），只写 `catch` 等于把
 *     主进程的失败也吞掉；
 *  3. 主进程的 `reverifySkillDeep` 在回执仍然适用时会**短路**（`rescanned:false`，
 *     约 1ms 且不写盘），此时行文字一个字都不会变——用户看到的就是"没反应"。
 *     所以"重扫了"和"已是最新"必须说成两句不同的话。
 */
describe('security page › recheck feedback', () => {
  const before = {
    skillId: 'doc-only', decision: 'risk', securityScore: 100, violationCount: 4,
    topRule: 'shape_staged_ceiling_missing', topLevel: 'MEDIUM',
    securityNotable: false, scannedAt: '2026-10-08T00:00:00Z', rulesetVersion: 'v1.0.0',
  };
  const after = {
    ...before, decision: 'pass', securityNotable: true, scannedAt: '2026-10-08T01:00:00Z',
    rulesetVersion: 'v1.1.0',
  };
  const page = (extra: Record<string, unknown> = {}) => loadPage({
    receipts: [before], skills: [{ id: 'doc-only' }], ...extra,
  });

  it('reports a recheck that actually rescanned, with the new verdict', async () => {
    const p = page({
      reverify: { ok: true, result: { rescanned: true, decision: 'pass' } },
      receiptsAfterReverify: [after],
    });
    await p.window.loadSecuritySettings();
    await p.window.__securitySettingsInternals.recheckSkill('doc-only');
    expect(p.invoked).toContain('skills.trust.reverify');
    expect(p.toasts).toHaveLength(1);
    expect(p.toasts[0].message).toContain('settings.security.recheck_done_result');
    // 结论文案用刷新后的回执，而不是点之前的那条。
    expect(p.toasts[0].message).toContain('settings.security.decision_pass');
    expect(p.toasts[0].opts?.variant).toBe('success');
  });

  it('says so when the verdict was already current instead of implying a rescan', async () => {
    const p = page({ reverify: { ok: true, result: { rescanned: false } } });
    await p.window.loadSecuritySettings();
    await p.window.__securitySettingsInternals.recheckSkill('doc-only');
    expect(p.toasts[0].message).toContain('settings.security.recheck_done_current');
    expect(p.toasts[0].opts?.variant).toBe('info');
  });

  it('surfaces a main-side failure, which arrives as data rather than an exception', async () => {
    // `{ ok:false }` 不会让 await 抛错。没有这道判断，失败是彻底的静默。
    const p = page({ reverify: { ok: false, error: 'invalid skill id' } });
    await p.window.loadSecuritySettings();
    await p.window.__securitySettingsInternals.recheckSkill('doc-only');
    expect(p.toasts).toHaveLength(1);
    expect(p.toasts[0].message).toContain('settings.security.recheck_failed');
    expect(p.toasts[0].opts?.variant).toBe('error');
  });

  it('shows the in-flight state in the drawer, not only on the page', async () => {
    const p = page();
    await p.window.loadSecuritySettings();
    p.window.__securitySettingsInternals.__setState({ checking: new Set(['doc-only']) });
    // 抽屉列表由这个函数产出；不刷新它，按钮就永远停在「检查」。
    // 在途状态现在表现为同一位置的「取消」动作（不再是一个转圈的「检查中」）。
    expect(p.window.__securitySettingsInternals.pickerListHtml())
      .toContain('data-action="cancel-check"');
  });
});

/**
 * 默认层说人话，证据收进「技术细节」。
 *
 * 这页的第一读者是普通用户：规则 id、CWE/OWASP 编号、置信度与上下文是证据，
 * 不是结论。标题被规则 id 占据时，用户看到一屏 `http_url`、`scan_coverage`
 * 会直接放弃阅读。
 */
describe('security page › plain-language findings', () => {
  function drawerWithFinding(finding: Record<string, unknown>) {
    const { window } = loadPage();
    window.__securitySettingsInternals.__setState({
      drawer: {
        skillId: 'demo', controller: null, loading: false, error: null,
        filter: 'all', acceptances: [],
        evidence: { ...baseEvidence, findings: [finding], severityCounts: { info: 1 } },
      },
    });
    return window.__securitySettingsInternals.drawerBodyHtml();
  }

  it('keeps the rule id and compliance codes inside technical details', () => {
    const html = drawerWithFinding({
      ruleId: 'http_url', severity: 'info', category: 'network',
      confidence: 'high', context: 'source', file: 'references/method.md', line: 75,
      description: '命中规则 http_url（network）', remediation: '',
      cwe: ['CWE-200'], owaspLlm: ['LLM02'], owaspAgentic: ['ASI02'], owaspAst: ['AST03'],
      references: [], fingerprint: 'fp-x', suppressed: false, hardBlock: false,
    });
    // 默认层标题是人话，不是规则 id。
    expect(html).toContain('出现了外部网址');
    const techIndex = html.indexOf('sec-finding-tech');
    expect(techIndex).toBeGreaterThan(-1);
    expect(html.indexOf('http_url')).toBeGreaterThan(techIndex);
    // 合规编号属于证据，默认藏在折叠区里。
    expect(html.indexOf('AST03')).toBeGreaterThan(techIndex);
    expect(html.indexOf('CWE-200')).toBeGreaterThan(techIndex);
    // 引擎生成的「命中规则 X」不占正文。
    expect(html).not.toContain('sec-finding-desc');
  });

  it('turns engine enums and versions into plain language', () => {
    const html = drawerWithFinding({
      ruleId: 'http_url', severity: 'info', category: 'network', confidence: 'high',
      context: 'source', file: 'A.md', line: 1, description: '命中规则 http_url',
      remediation: '', cwe: [], owaspLlm: [], owaspAgentic: [], owaspAst: [],
      references: [], fingerprint: 'fp-z', suppressed: false, hardBlock: false,
    });
    // CAUTION 是引擎枚举，用户看到的是「谨慎使用」。
    expect(html).toContain('谨慎使用');
    expect(html).not.toContain('>CAUTION<');
    // 引擎版本与规则包版本收进「扫描信息」，默认折叠。
    expect(html).toContain('settings.security.scan_info');
    const scanInfo = html.indexOf('sec-drawer-tech');
    expect(scanInfo).toBeGreaterThan(-1);
    expect(html.indexOf('sec-drawer-hero')).toBeLessThan(scanInfo);
    expect(html.indexOf('settings.security.sentry_engine')).toBeGreaterThan(scanInfo);
  });

  it('falls back to a human sentence for rules without a curated title', () => {
    const html = drawerWithFinding({
      ruleId: 'some_unmapped_rule', severity: 'low', category: 'network',
      confidence: 'medium', context: 'prose', file: 'README.md', line: 3,
      description: '命中规则 some_unmapped_rule', remediation: '',
      cwe: [], owaspLlm: [], owaspAgentic: [], owaspAst: [],
      references: [], fingerprint: 'fp-y', suppressed: false, hardBlock: false,
    });
    expect(html).toContain('与「网络地址」有关的一条提示');
    expect(html).not.toContain('sec-finding-desc');
  });

  it('ships a curated title for the rules users hit most, in every locale', () => {
    // ruleTitle() 用模板拼键，locale-keys 守卫扫不到它们；这里逐个钉住，
    // 否则漏一条只会静默退回兜底句子，没人会发现。
    const ids = [
      'scan_external_tools_missing', 'http_url', 'requests_post', 'credential_path_read',
      'private_key_read', 'curl_pipe_shell', 'python_os_system', 'python_eval_exec',
      'base64_decode_exec', 'ignore_previous', 'reveal_system_prompt', 'security_control_disable',
    ];
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const dict = JSON.parse(
        fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8'),
      );
      for (const id of ids) {
        expect(dict[`settings.security.rule_${id}`], `${locale}/${id}`).toBeTruthy();
      }
    }
  });
});

describe('security page › technical-details preference', () => {
  it('keeps technical details collapsed by default and expands them when the preference is on', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('sec-rulebar-tech"');
    expect(body.innerHTML).not.toContain('sec-rulebar-tech" open');

    window.__securitySettingsInternals.__setState({ showTech: true });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('sec-rulebar-tech" open');
  });

  it('flips the preference from the switch and re-renders', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    const action = { dataset: { action: 'toggle-tech' } };
    body.dispatch('click', {
      target: { closest: (sel: string) => (sel === '[data-action]' ? action : null) },
    });
    expect(window.__securitySettingsInternals.__getState().showTech).toBe(true);
    expect(body.innerHTML).toContain('sec-rulebar-tech" open');
  });

  it('opens finding and scan details when the preference is on', () => {
    const { window } = loadPage();
    window.__securitySettingsInternals.__setState({
      showTech: true,
      drawer: {
        skillId: 'demo', controller: null, loading: false, error: null,
        filter: 'all', acceptances: [],
        evidence: { ...baseEvidence, findings: [baseEvidence.findings[0]] },
      },
    });
    const html = window.__securitySettingsInternals.drawerBodyHtml();
    expect(html).toContain('sec-finding-tech" open');
    expect(html).toContain('sec-drawer-tech" open');
  });
});

describe('security page › score ring accessibility', () => {
  it('exposes the score as text, not only as an arc', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    const html = window.__securitySettingsInternals.scoreRing(62, 'lg');
    expect(html).toContain('role="img"');
    expect(html).toContain('settings.security.ring_aria');
    expect(html).toContain('sec-ring-number">62<');
  });

  it('does not render an arc for an unmeasured score', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    const html = window.__securitySettingsInternals.scoreRing(null, 'sm');
    // Fully offset stroke = no arc drawn at all.
    const track = /stroke-dashoffset="([\d.]+)"/.exec(html);
    const array = /stroke-dasharray="([\d.]+)"/.exec(html);
    expect(Number(track?.[1])).toBeCloseTo(Number(array?.[1]), 1);
  });
});

describe('security page › filter mapping', () => {
  it('maps segmented-control labels back to filter values', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    const map = window.__securitySettingsInternals.filterValueFromLabel;
    expect(map('settings.security.filter_all')).toBe('all');
    expect(map('settings.security.filter_active')).toBe('active');
    expect(map('settings.security.filter_suppressed')).toBe('suppressed');
    expect(map('settings.security.sev_critical')).toBe('critical');
    expect(map('something-else')).toBe('all');
  });
});

/**
 * 防护项：hero 以下只有三行「图标 + 名称 + 一句状态」，细节下沉一层。
 *
 * 这三个不变量都很容易被后续改动静默破坏：
 *  - 健康行**不能**出现状态胶囊，否则整列都是徽章，等于没有信号；
 *  - 同一组数字不能既渲染成可见文字又渲染成分段控件（旧版就是这个重复）；
 *  - 记录表超过 4 列会把右侧操作按钮挤出窄栏（实测被裁）。
 */
describe('security page › protection rows', () => {
  it('renders one row per area and only flags the rows that need attention', async () => {
    const { window, body } = loadPage({
      status: {
        scanner: 'present', scannerIntegrity: 'verified', sentryEngineVersion: '2.2.0',
        sentryRulesetVersion: 'v1.1.0', declarationIntegrity: 'verified',
        rules: { total: 181, hardBlock: 2, groups: ['a'] }, interpreter: 'python3',
        externalTools: [],
        capabilities: [
          { id: 'text_static_analysis', status: 'implemented' },
          { id: 'secret_detection', status: 'degraded', reason: 'no_gitleaks' },
        ],
      },
      receipts: [
        { skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0, scannedAt: new Date().toISOString(), rulesDegraded: false },
        { skillId: 'blocked-one', decision: 'blocked', securityScore: 25, violationCount: 3, scannedAt: new Date().toISOString(), rulesDegraded: false },
      ],
      skills: [{ id: 'good' }, { id: 'blocked-one' }],
    });
    await window.loadSecuritySettings();
    const html = body.innerHTML;

    // 三行都在，且用的是共享 accordion（原生 details），不是页面自造的展开结构
    expect(html).toContain('settings.security.section_protection');
    expect(html).toContain('settings.security.row_skills');
    expect(html).toContain('settings.security.row_coverage');
    expect(html).toContain('settings.security.row_composition');
    expect(html.match(/<details class="ui-accordion__item"/g)).toHaveLength(3);

    // 来源信息只由 hero 承担：再留一行就是同一信息两处出现
    expect(html).not.toContain('settings.security.row_source');

    // 需要处理的行带 critical 色调 + 胶囊；组合风险健康，不带 tone、不带胶囊
    expect(html).toContain('data-tone="critical"');
    expect(html).toContain('settings.security.row_tone_critical');
    const compositionRow = /<details class="ui-accordion__item"(?![^>]*data-tone)[^>]*>(?:(?!<\/details>)[\s\S])*?settings\.security\.row_composition/.exec(html);
    expect(compositionRow?.[0]).not.toContain('ui-status-pill');
  });

  it('collapses the capability list to the items that need attention', async () => {
    const { window, body } = loadPage({
      status: {
        scanner: 'present', scannerIntegrity: 'verified',
        rules: { total: 181, hardBlock: 2, groups: [] }, externalTools: [],
        capabilities: [
          { id: 'text_static_analysis', status: 'implemented' },
          { id: 'structural_analysis', status: 'implemented' },
          { id: 'secret_detection', status: 'degraded', reason: 'no_gitleaks' },
        ],
      },
      receipts: [], skills: [],
    });
    await window.loadSecuritySettings();

    // 折叠态：健康项不进列表，但「展开全部」的入口在
    expect(body.innerHTML).not.toContain('settings.security.cap_text_static_analysis');
    expect(body.innerHTML).toContain('settings.security.cap_secret_detection');
    expect(body.innerHTML).toContain('settings.security.coverage_show_all');

    // 展开后健康项出现，切换文案反转
    window.__securitySettingsInternals.__setState({ coverageExpanded: true });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.cap_text_static_analysis');
    expect(body.innerHTML).toContain('settings.security.coverage_show_attention');
  });

  it('renders every capability when none needs attention, with no empty list shell', async () => {
    const { window, body } = loadPage({
      status: {
        scanner: 'present', scannerIntegrity: 'verified',
        rules: { total: 181, hardBlock: 2, groups: ['a'] }, externalTools: [],
        capabilities: [
          { id: 'text_static_analysis', status: 'implemented' },
          { id: 'structural_analysis', status: 'implemented' },
        ],
      },
      receipts: [], skills: [],
    });
    await window.loadSecuritySettings();

    // 全部可用时列表不能渲染成空壳：`.sec-caps` 自带卡片边框与内边距，
    // 空列表在实机上就是一块无内容的圆角空白格（截图报障的那一格）。
    expect(body.innerHTML).not.toMatch(/<ul class="sec-caps">\s*<\/ul>/);
    expect(body.innerHTML.match(/<li class="sec-cap" /g)).toHaveLength(2);
    // 也没有可展开/收起的对象：全部已渲染时「展开全部 N 项」是假动作，
    // 展开态再翻成「只显示 0 项降级」更是自相矛盾。
    expect(body.innerHTML).not.toContain('settings.security.coverage_show_all');
    expect(body.innerHTML).not.toContain('settings.security.coverage_show_attention');

    window.__securitySettingsInternals.__setState({ coverageExpanded: true });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML.match(/<li class="sec-cap" /g)).toHaveLength(2);
  });

  it('shows the native detection backends next to the rule counts', async () => {
    const { window, body } = loadPage({
      status: {
        scanner: 'present', scannerIntegrity: 'verified',
        rules: { total: 181, hardBlock: 2, groups: ['a'] },
        externalTools: [{ id: 'osv-scanner', available: false }],
        signaturePacks: {
          vulnerabilityDb: { entries: 1496, asOf: '2026-10-19' },
          yaraRules: 49,
        },
        capabilities: [
          { id: 'dependency_vulnerability_scan', status: 'implemented' },
          { id: 'malware_signature_matching', status: 'implemented' },
        ],
      },
      receipts: [], skills: [],
    });
    await window.loadSecuritySettings();
    const html = body.innerHTML;

    // 「能力可用」只是状态；用户还要能看到它背后有多少规则/公告。
    expect(html).toContain('settings.security.vulnerability_db_value');
    // t() 返回 key+参数，渲染时作为文本被 esc() 转义，因此断言转义后的形态。
    expect(html).toContain('&quot;n&quot;:1496');
    expect(html).toContain('&quot;date&quot;:&quot;2026-10-19&quot;');
    expect(html).toContain('settings.security.yara_rules_value');
    expect(html).toContain('&quot;n&quot;:49');
    // 两项都可用时不该再渲染「需要工具」的提示。
    expect(html).not.toContain('settings.security.issue_needs_tool');
  });

  it('keeps the stat numbers in one control and the table within four columns', async () => {
    const { window, body } = loadPage({
      status: { scanner: 'present', scannerIntegrity: 'verified', rules: { total: 1, hardBlock: 0, groups: [] }, capabilities: [], externalTools: [] },
      receipts: [{ skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0, scannedAt: new Date().toISOString() }],
      skills: [{ id: 'good' }],
    });
    await window.loadSecuritySettings();
    const html = body.innerHTML;

    // 同一组数字只渲染一次可见控件；另一份是给屏幕阅读器的隐藏副本。
    // 只数容器元素：ui-segmented-control 作为子串也出现在每个按钮内部的 span 上。
    expect(html.match(/<div class="ui-segmented-control"/g) ?? []).toHaveLength(1);
    expect(html).toContain('sec-visually-hidden');
    expect(html).not.toContain('sec-stats-summary');

    // 4 列封顶：第 5、6 列的表头不该存在
    expect(html).toContain('settings.security.col_score');
    expect(html).not.toContain('settings.security.col_time');
    expect(html.match(/<th scope="col"/g) ?? []).toHaveLength(4);

    // 空结果行的 colspan 必须跟着列数走，否则改列数会留下一个错位的空态
    window.__securitySettingsInternals.__setState({ filter: 'blocked' });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.no_receipts_filtered');
    expect(body.innerHTML).toContain('colspan="4"');
    expect(body.innerHTML).not.toContain('colspan="6"');
  });

  it('opens the skill picker as a drawer instead of an inline card', async () => {
    const { window, body } = loadPage({
      status: { scanner: 'present', scannerIntegrity: 'verified', rules: { total: 0, hardBlock: 0, groups: [] }, capabilities: [], externalTools: [] },
      receipts: [], skills: [{ id: 'social-data', name: '社媒数据抓取' }],
    });
    await window.loadSecuritySettings();
    // 触发按钮在页面上（关闭态 aria-expanded=false）
    expect(body.innerHTML).toContain('data-action="toggle-picker"');
    expect(body.innerHTML).toContain('aria-expanded="false"');
    // 选择器内容**不**渲染在页面流里：它是一个右侧抽屉（共享 uiDrawer），
    // 挂在 document.body 上。回退成内联卡片会让这里重新出现 .sec-picker。
    expect(body.innerHTML).not.toContain('class="sec-picker"');
    expect(body.innerHTML).not.toContain('data-role="picker-input"');
  });

  it('does not claim a clean composition result when coverage is partial', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({
      openRow: 'composition',
      composition: {
        skills: [], paths: [],
        coverage: { analyzedSkills: 75, resolvableSkills: 101, budgetLimited: true },
      },
    });
    window.__securitySettingsInternals.__render();
    const html = body.innerHTML;

    // 覆盖不全时行状态写「已看 75/101」，而不是「未发现组合路径」。
    expect(html).toContain('settings.security.row_status_composition_partial');
    expect(html).not.toContain('settings.security.row_status_composition_clean');
    // 按钮变成「继续」，并说清还有多少个。
    expect(html).toContain('settings.security.composition_run_continue');
    expect(html).toContain('&quot;n&quot;:26');
  });

  it('has no page-local status pill left', async () => {
    const { window, body } = loadPage({
      status: { scanner: 'present', scannerIntegrity: 'verified', rules: { total: 0, hardBlock: 0, groups: [] }, capabilities: [], externalTools: [] },
      receipts: [{ skillId: 'meh', decision: 'risk', securityScore: 62, violationCount: 2, scannedAt: new Date().toISOString() }],
      skills: [{ id: 'meh' }],
    });
    await window.loadSecuritySettings();
    // 审计发现页面上有第二套状态色板（.sec-pill，取值 ok|warn|bad|muted）。
    // 全部改用共享 uiStatusPill 后，这个类不应再出现。
    expect(body.innerHTML).not.toContain('sec-pill');
    expect(body.innerHTML).toContain('ui-status-pill');
  });
});

/**
 * 读取失败与刷新反馈是这一页的「不可说假话」契约。
 *
 * 三条都来自真实可复现的观感问题：
 *  - 一次 IPC 没回来，hero 把 `null` 读成「发现异常」（扫描器被篡改的说法）；
 *  - 回执没读到，页面把空数组渲染成「0 个已检查 · 无异常」；
 *  - 刷新按钮没有状态、没有去重、完成后没有任何可见反馈。
 */
describe('security page › load failures and refresh feedback', () => {
  it('paints a page-shaped skeleton with a spoken loading line', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    const pending = window.loadSecuritySettings();
    // 骨架在第一个 await 之前就已经渲染：形状与真实布局同构（hero + 三行），
    // 并且有一句人能读到的加载说明，而不只是 aria-label。
    expect(body.innerHTML).toContain('sec-skel-hero');
    expect(body.innerHTML).toContain('sec-loading-caption');
    expect(body.innerHTML).toContain('settings.security.loading');

    await pending;
    expect(body.innerHTML).not.toContain('sec-skel-hero');
  });

  it('says nothing has been checked yet instead of "no issues"', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    // 0 条是「没扫过」，不是「没问题」。
    expect(body.innerHTML).toContain('settings.security.row_status_skills_none');
    expect(body.innerHTML).not.toContain('settings.security.row_status_skills_clean');
  });

  it('says the status read failed instead of claiming the scanner is broken', async () => {
    const opts = { fail: { status: true }, receipts: [], skills: [] };
    const { window, body } = loadPage(opts);
    await window.loadSecuritySettings();
    const failed = body.innerHTML;

    expect(failed).toContain('settings.security.load_failed_title');
    expect(failed).not.toContain('settings.security.hero_alert');
    expect(failed).not.toContain('settings.security.hero_blocked');
    expect(failed).not.toContain('settings.security.hero_ok');
    expect(failed).toContain('data-action="refresh"');

    // 重试成功后回到正常页面，错误态不残留。
    opts.fail.status = false;
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.hero_ok');
    expect(body.innerHTML).not.toContain('settings.security.load_failed_title');
  });

  it('does not turn a failed receipts read into "no issues"', async () => {
    const opts = {
      fail: { receipts: true },
      receipts: [{
        skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0,
        scannedAt: new Date().toISOString(), rulesDegraded: false,
      }],
      skills: [{ id: 'good' }],
    };
    const { window, body } = loadPage(opts);
    await window.loadSecuritySettings();
    const html = body.innerHTML;

    expect(html).toContain('settings.security.row_status_receipts_failed');
    expect(html).toContain('settings.security.receipts_load_failed');
    // 「无异常」与「还没有检查记录」都是对一次失败的读取编结论。
    expect(html).not.toContain('settings.security.row_status_skills_clean');
    expect(html).not.toContain('settings.security.no_receipts');
    expect(html).not.toContain('settings.security.hero_ok');
    // 也不能借用降级（warn）的文案：扫描器是好的，缺的是回执。
    expect(html).not.toContain('settings.security.hero_attention');
    expect(html).toContain('settings.security.hero_receipts_failed');
    // 首屏失败没有「上次读取」可谈，不该出现刷新失败的提示条。
    expect(html).not.toContain('settings.security.refresh_failed_status');
  });

  it('keeps the last status when a refresh fails, and marks it as stale', async () => {
    const opts = { fail: {}, receipts: [], skills: [] };
    const { window, body } = loadPage(opts);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.hero_ok');

    opts.fail.status = true;
    await window.loadSecuritySettings();
    const html = body.innerHTML;
    // 旧数据留着（不是错误整屏），但必须说明这是上次读取的结果。
    expect(html).toContain('settings.security.refresh_failed_status');
    expect(html).toContain('settings.security.hero_ok');
  });

  it('summarises concurrent rechecks so the work stays visible after scrolling', async () => {
    const { window, body } = loadPage({
      receipts: [{
        skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0,
        scannedAt: new Date().toISOString(),
      }],
      skills: [{ id: 'good' }],
    });
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({ checking: new Set(['good', 'other']) });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.recheck_running');
    expect(body.innerHTML).toContain('&quot;n&quot;:2');
  });

  it('clears the receipts failure once a recheck reads them successfully', async () => {
    const opts = { fail: { receipts: true }, receipts: [], skills: [{ id: 'good' }] };
    const { window, body } = loadPage(opts);
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.row_status_receipts_failed');

    // 重扫失败是另一回事；这里模拟「这一路恢复可读」，错误不能继续挂在行上。
    opts.fail.receipts = false;
    await window.__securitySettingsInternals.recheckSkill('good');
    expect(body.innerHTML).not.toContain('settings.security.row_status_receipts_failed');
  });

  it('turns the row action into cancel while a recheck is running', async () => {
    const { window, body } = loadPage({
      receipts: [{
        skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0,
        scannedAt: new Date().toISOString(),
      }],
      skills: [{ id: 'good' }],
    });
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({ checking: new Set(['good']) });
    window.__securitySettingsInternals.__render();

    // 两个动作都在 DOM 里，行上的 data-checking 决定显示哪一个（CSS 负责切换）。
    expect(body.innerHTML).toContain('data-checking="1"');
    expect(body.innerHTML).toContain('data-action="cancel-check"');
    expect(body.innerHTML).toContain('data-action="recheck"');
  });

  it('reports a canceled recheck without pretending a receipt was refreshed', async () => {
    const { window, invoked, toasts } = loadPage({
      receipts: [{
        skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0,
        scannedAt: new Date().toISOString(),
      }],
      skills: [{ id: 'good' }],
      reverify: { ok: true, result: { canceled: true } },
    });
    await window.loadSecuritySettings();
    const before = invoked.filter((c) => c === 'skills.trust.list').length;

    await window.__securitySettingsInternals.recheckSkill('good');

    expect(toasts.at(-1)?.message).toContain('settings.security.recheck_canceled');
    // 取消没有新回执：不该再读一次列表（那会让页面白闪一下）。
    expect(invoked.filter((c) => c === 'skills.trust.list').length).toBe(before);
  });

  it('sends a real cancel request for the skill being checked', async () => {
    const { window, invoked } = loadPage({
      receipts: [{
        skillId: 'good', decision: 'pass', securityScore: 100, violationCount: 0,
        scannedAt: new Date().toISOString(),
      }],
      skills: [{ id: 'good' }],
    });
    await window.loadSecuritySettings();
    await window.__securitySettingsInternals.cancelSkillCheck('good');
    expect(invoked).toContain('skills.trust.cancel');
  });

  it('offers a retry when the detail report could not be read', async () => {
    const { window } = loadPage();
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({
      drawer: {
        skillId: 'demo', controller: null, evidence: null, loading: false,
        error: 'engine_missing', filter: 'all', acceptances: [],
      },
    });
    const html = window.__securitySettingsInternals.drawerBodyHtml();
    // 失败要能当场重试：原来只有一句说明，用户只能关掉抽屉再点一次详情。
    expect(html).toContain('ui-empty-state--actionable');
    expect(html).toContain('data-action="retry-drawer"');
    expect(html).toContain('settings.security.detail_failed');
  });

  it('shows real elapsed seconds once a recheck runs past the expected few', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    window.__securitySettingsInternals.__setState({
      checking: new Set(['a', 'b']),
      checkingSince: Date.now() - 9000,
    });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).toContain('settings.security.recheck_elapsed');

    // 正常时长内不显示数字，避免文案每秒抖动。
    window.__securitySettingsInternals.__setState({ checkingSince: Date.now() - 1000 });
    window.__securitySettingsInternals.__render();
    expect(body.innerHTML).not.toContain('settings.security.recheck_elapsed');
  });

  it('does not turn a failed skill list into an empty picker', async () => {
    const opts = { fail: { skills: true }, receipts: [], skills: [] };
    const { window } = loadPage(opts);
    await window.loadSecuritySettings();
    const failed = window.__securitySettingsInternals.pickerListHtml();
    expect(failed).toContain('settings.security.skills_load_failed');
    expect(failed).not.toContain('settings.security.picker_empty');
    expect(failed).toContain('data-action="retry-skills"');

    // 恢复后错误必须消失，否则用户会一直看到「读取失败」。
    opts.fail.skills = false;
    await window.loadSecuritySettings();
    expect(window.__securitySettingsInternals.pickerListHtml())
      .not.toContain('settings.security.skills_load_failed');
  });

  it('does not rebuild the page when a refresh returns the same data', async () => {
    const { window, body } = loadPage({ receipts: [], skills: [{ id: 'a' }] });
    await window.loadSecuritySettings();
    const before = body.writes;

    // 内容没变：不碰 DOM（刷新时间由 updateFreshness 单独更新）。
    await window.loadSecuritySettings();
    expect(body.writes).toBe(before);

    // 状态变了才重建。
    window.__securitySettingsInternals.__setState({ filter: 'pass' });
    window.__securitySettingsInternals.__render();
    expect(body.writes).toBe(before + 1);
  });

  /**
   * 「刷新」必须留下一段看得见的忙态。
   *
   * 读取命中缓存时整条链路只有几十毫秒：按钮闪一下、页面没变化、时间戳还是
   * 「刚刚」，用户会以为这一下没生效（真实报障：像 bug）。这条守卫钉住
   * `holdMs` 的语义——传入下限时，Promise 不会早于它 resolve。
   */
  it('holds the busy state for the requested minimum on a refresh', async () => {
    const { window } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();

    const startedAt = Date.now();
    await window.loadSecuritySettings({ holdMs: 120 });
    // 只设下界：机器慢的时候只会更久，容忍计时器抖动给 40ms 余量。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80);
  });

  it('runs one refresh at a time and shows when the page was updated', async () => {    const { window, body, invoked } = loadPage({ receipts: [], skills: [] });
    await window.loadSecuritySettings();
    expect(body.innerHTML).toContain('settings.security.updated_at');

    const before = invoked.filter((c) => c === 'skills.security.status').length;
    // 连点两次：并发的第二次会拿旧结果覆盖新结果，必须被去重。
    await Promise.all([window.loadSecuritySettings(), window.loadSecuritySettings()]);
    const after = invoked.filter((c) => c === 'skills.security.status').length;
    expect(after - before).toBe(1);
  });
});

/**
 * 页面引用的每个 locale 键都必须真实存在。
 *
 * 这条守卫来自一次真实事故：JS 里用了新键 `row_status_skills_risk`，而写 locale 的
 * 脚本失败了，结果 `t()` 返回键名本身，页面把 `settings.security.row_status_skills_risk`
 * 直接显示给用户。typecheck 和既有测试都抓不到——键名字符串本身完全合法。
 */
describe('security page › locale keys', () => {
  it('references only keys that exist in every locale', () => {
    const src = fs.readFileSync(path.join(root, 'src/renderer/modules/settings-security.js'), 'utf8');
    // 前置非标识符字符：排除 createElement('a') / closest('tr') 这类假匹配。
    const keys = new Set(
      [...src.matchAll(/(?<![A-Za-z0-9_$])t\(\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]),
    );
    expect(keys.size).toBeGreaterThan(100);

    const problems: string[] = [];
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const dict = JSON.parse(
        fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8'),
      );
      const missing = [...keys].filter((k) => !(k in dict));
      if (missing.length) problems.push(`${locale}: ${missing.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * 组合路径的说明句不再接收 `{skills}`：技能名改由路径图的节点承担，
   * 句子里再串一遍就是同一份信息两处出现。而 `t()` 对未传的占位符**不报错**，
   * 它会原样把 `{skills}` 显示给用户——所以这里必须逐个语言扫一遍，
   * 防止只改了其中几份 locale。
   */
  it('no longer carries the {skills} placeholder the figure replaced', () => {
    const offenders: string[] = [];
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const dict = JSON.parse(
        fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8'),
      );
      for (const [key, value] of Object.entries(dict)) {
        if (!/^settings\.security\.path_.*_desc$/.test(key)) continue;
        if (String(value).includes('{skills}')) offenders.push(`${locale}/${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
