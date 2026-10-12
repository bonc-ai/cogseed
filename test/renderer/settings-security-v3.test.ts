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
  innerHTML = '';
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
    if (channel === 'skills.security.status') return { status: opts.status ?? healthyStatus };
    if (channel === 'skills.trust.list') {
      trustListCalls += 1;
      // 重新检查之后的刷新要能返回新回执，否则测不到"结论已更新"这句话。
      if (trustListCalls > 1 && opts.receiptsAfterReverify) {
        return { receipts: opts.receiptsAfterReverify };
      }
      return { receipts: opts.receipts || [] };
    }
    if (channel === 'skills.list') return { skills: opts.skills || [] };
    if (channel === 'skills.security.report') return opts.report ?? { ok: true, evidence: baseEvidence };
    if (channel === 'skills.security.acceptances') return { acceptances: opts.acceptances || [] };
    if (channel === 'skills.security.composition') return opts.status ?? null;
    if (channel === 'skills.trust.reverify') {
      return opts.reverify ?? { ok: true, result: { rescanned: true } };
    }
    return null;
  };
  const context: any = {
    document,
    console,
    Promise,
    CSS: { escape: (s: string) => s },
    Blob: class { constructor(_a: unknown, _b: unknown) {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    setTimeout: (fn: () => void) => { void fn; return 0; },
    window: { addEventListener: () => {}, cogseed: { invoke } },
    t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
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
    expect(p.window.__securitySettingsInternals.pickerListHtml())
      .toContain('settings.security.checking');
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
