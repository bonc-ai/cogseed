// Renders the 安全与信任 page in real Chromium with production CSS and modules,
// for review screenshots. Fixture data, no user data, no IPC.
//
// This is a *preview harness*, not the Electron shell: it loads the same
// `src/renderer/**` files the app loads, stubs `window.cogseed.invoke` with
// realistic payloads, and captures the result. It exists so a reviewer can see
// the page without installing skills or waiting for a real scan.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../src/renderer');
const LOCALES = path.join(ROOT, 'locales');
const OUT = path.resolve(__dirname, '../../../design/security-preview');

const STYLES = ['tokens.css', 'ui-components.css', 'style.css'];

// Loaded in dependency order; these are the same classic scripts index.html loads.
const SCRIPTS = [
  'modules/icons.js',
  'modules/ui-button.js',
  'modules/ui-form.js',
  'modules/ui-status.js',
  'modules/ui-structure.js',
  'modules/ui-card.js',
  'modules/ui-empty.js',
  'modules/ui-modal.js',
  'modules/ui-drawer.js',
  'modules/ui-segmented-control.js',
  'modules/ui-tabs.js',
];

const HEALTHY_STATUS = {
  scanner: 'present',
  scannerIntegrity: 'verified',
  sentryEngineVersion: '2.2.0',
  sentryRulesetVersion: 'v1.1.0',
  declarationEngineVersion: '1.1.1',
  declarationIntegrity: 'verified',
  scannerAbsentByBuild: false,
  rules: {
    total: 181,
    groups: ['dangerous_commands', 'dynamic_execution', 'network_egress', 'persistence',
      'prompt_injection_payloads', 'reverse_shell', 'credential_expansion', 'surveillance',
      'crypto_mining', 'untrusted_input_execution', 'sql_injection', 'suspicious_addresses'],
    hardBlock: 2,
    versioned: true,
  },
  capabilities: [
    { id: 'text_static_analysis', status: 'implemented' },
    { id: 'context_awareness', status: 'implemented' },
    { id: 'negative_example_recognition', status: 'implemented' },
    { id: 'instruction_analysis', status: 'implemented' },
    { id: 'hidden_content_detection', status: 'implemented' },
    { id: 'obfuscation_detection', status: 'implemented' },
    { id: 'supply_chain_analysis', status: 'implemented' },
    { id: 'structural_analysis', status: 'implemented' },
    { id: 'scoring_explainability', status: 'implemented' },
    { id: 'framework_mapping', status: 'implemented' },
    { id: 'sarif_export', status: 'implemented' },
    { id: 'risk_acceptance', status: 'implemented' },
    { id: 'secret_detection', status: 'degraded', reason: 'no_gitleaks' },
    { id: 'dependency_vulnerability_scan', status: 'degraded', reason: 'no_osv_scanner' },
    { id: 'binary_static_analysis', status: 'implemented' },
    { id: 'malware_signature_matching', status: 'partial', reason: 'no_yara_engine' },
  ],
  externalTools: [{ id: 'gitleaks', available: false }, { id: 'osv-scanner', available: false }],
  interpreter: '/usr/bin/python3',
};

const RECEIPTS = [
  { skillId: 'skill-creator', decision: 'pass', securityScore: 100, scannedAt: ago(6), scanner: 'deep', violationCount: 0, isolated: false, rulesetVersion: 'v1.1.0' },
  { skillId: 'integration-map', decision: 'pass', securityScore: 97, scannedAt: ago(41), scanner: 'deep', violationCount: 2, isolated: false, rulesetVersion: 'v1.1.0' },
  { skillId: 'e7f5c0e6f1be', decision: 'risk', securityScore: 62, scannedAt: ago(180), scanner: 'deep', violationCount: 7, isolated: false, rulesetVersion: 'v1.1.0' },
  { skillId: 'social-data', decision: 'risk', securityScore: 74, scannedAt: ago(1500), scanner: 'local', violationCount: 3, rulesDegraded: true, isolated: false },
  { skillId: 'agent-creator', decision: 'blocked', securityScore: 25, scannedAt: ago(2900), scanner: 'deep', violationCount: 11, isolated: false, rulesetVersion: 'v1.1.0' },
];

const SKILLS = [
  ...RECEIPTS.map((r) => ({ id: r.skillId, name: r.skillId })),
  { id: 'packaging-helper', name: 'packaging-helper' },
  { id: 'release-notes', name: 'release-notes' },
];

const EVIDENCE = {
  skillId: 'e7f5c0e6f1be',
  scannedAt: new Date().toISOString(),
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
  rulesSource: 'ruleset v1.1.0: secret-patterns.yaml, text-rules.yaml, 12 组规则',
  severityCounts: { critical: 1, high: 2, medium: 3, low: 5, info: 96 },
  findings: [
    {
      ruleId: 'curl_pipe_shell', severity: 'critical', originalSeverity: 'critical', demoted: false,
      confidence: 'medium', category: 'unauthorized_download', file: 'scripts/bootstrap.sh', line: 14,
      description: 'shell 中「下载后管道给 shell 执行」：载荷不落盘，无法审计',
      remediation: '不要 curl|sh。改为固定版本 + 校验哈希后下载，再由用户确认安装。',
      hardBlock: false, context: 'source', cwe: ['CWE-494', 'CWE-78'], owaspLlm: ['LLM05', 'LLM06'],
      owaspAgentic: ['ASI05'], owaspAst: ['AST01', 'AST02'],
      references: ['https://cwe.mitre.org/data/definitions/494.html'],
      fingerprint: 'a1b2c3d4e5f60718293a', suppressed: false, derived: 'b64_1',
    },
    {
      ruleId: 'credential_path_read', severity: 'high', originalSeverity: 'critical', demoted: true,
      confidence: 'high', category: 'credential_access', file: 'SKILL.md', line: 51,
      description: '命中规则 credential_path_read（network_egress）',
      remediation: '不要读取用户凭据文件；改由用户显式提供所需的值。',
      hardBlock: false, context: 'prose', cwe: ['CWE-522', 'CWE-359'], owaspLlm: ['LLM02'],
      owaspAgentic: ['ASI03'], owaspAst: ['AST01', 'AST03'],
      references: ['https://cwe.mitre.org/data/definitions/522.html'],
      fingerprint: 'b2c3d4e5f60718293a4b', suppressed: false,
      derived: 'normalized',
    },
    {
      ruleId: 'agent_config_write', severity: 'high', originalSeverity: 'high', demoted: false,
      confidence: 'high', category: 'mcp_config', file: 'SKILL.md', line: 88,
      description: '写入宿主代理（Claude/Cursor/Codex 等）的配置目录',
      remediation: '不要改写宿主或其它 Agent 的 MCP/工具配置；连接器应由用户在应用界面里显式添加。',
      hardBlock: false, context: 'source', cwe: ['CWE-506', 'CWE-1357'], owaspLlm: ['LLM03', 'LLM06'],
      owaspAgentic: ['ASI02', 'ASI04'], owaspAst: ['AST05', 'AST09'],
      references: [], fingerprint: 'c3d4e5f60718293a4b5c', suppressed: false,
    },
    {
      ruleId: 'unpinned_runtime_install', severity: 'medium', originalSeverity: 'medium', demoted: false,
      confidence: 'medium', category: 'supply_chain', file: 'SKILL.md', line: 132,
      description: '运行时安装未固定版本：npx some-helper',
      remediation: '固定依赖版本（tag/commit/digest）并提交 lockfile。',
      hardBlock: false, context: 'source', cwe: ['CWE-1357', 'CWE-1104'], owaspLlm: ['LLM03'],
      owaspAgentic: ['ASI04'], owaspAst: ['AST02'], references: [],
      fingerprint: 'd4e5f60718293a4b5c6d', suppressed: false,
    },
    {
      ruleId: 'typosquat_suspected', severity: 'medium', originalSeverity: 'medium', demoted: false,
      confidence: 'low', category: 'typosquat', file: 'package.json', line: 9,
      description: '依赖名 reqeusts 与流行包 requests 高度相似：可能是拼写伪装',
      remediation: '核对该依赖是否为官方包名；确需使用则固定到具体版本与哈希。',
      hardBlock: false, context: 'source', cwe: ['CWE-1357'], owaspLlm: ['LLM03'],
      owaspAgentic: ['ASI04'], owaspAst: ['AST02'], references: [],
      fingerprint: 'e5f60718293a4b5c6d7e', suppressed: false,
    },
    {
      ruleId: 'raw_ip_url', severity: 'low', originalSeverity: 'medium', demoted: true,
      confidence: 'high', category: 'network', file: 'scripts/fetch.py', line: 27,
      description: '命中规则 raw_ip_url（suspicious_addresses）',
      remediation: '核对每个外部地址是否必要；把域名写入 allowlist 并在 SKILL.md 声明。',
      hardBlock: false, context: 'comment', cwe: ['CWE-200'], owaspLlm: ['LLM02'],
      owaspAgentic: ['ASI02'], owaspAst: ['AST03'], references: [],
      fingerprint: 'f60718293a4b5c6d7e8f', suppressed: false,
    },
    {
      ruleId: 'http_url', severity: 'info', originalSeverity: 'info', demoted: false,
      confidence: 'high', category: 'network', file: 'SKILL.md', line: 12,
      description: '命中规则 http_url（network_egress）', remediation: '',
      hardBlock: false, context: 'doc', cwe: ['CWE-200'], owaspLlm: ['LLM02'],
      owaspAgentic: ['ASI02'], owaspAst: ['ASI03'], references: [],
      fingerprint: '0718293a4b5c6d7e8f90', suppressed: false,
    },
  ],
  scoreBreakdown: {
    score: 62, rawPenalty: 78.4, penalty: 78.4, scale: 55,
    byCategory: [
      { category: 'unauthorized_download', count: 1, raw: 24, cap: 60, penalty: 24, capped: false },
      { category: 'mcp_config', count: 1, raw: 20, cap: 55, penalty: 20, capped: false },
      { category: 'credential_access', count: 1, raw: 20, cap: 70, penalty: 20, capped: false },
      { category: 'supply_chain', count: 1, raw: 4.8, cap: 45, penalty: 4.8, capped: false },
      { category: 'typosquat', count: 1, raw: 3, cap: 45, penalty: 3, capped: false },
      { category: 'network', count: 1, raw: 3, cap: 20, penalty: 3, capped: false },
    ],
    floors: [],
  },
  coverage: {
    filesScanned: 9, filesSeen: 12, bytesScanned: 84_512, ruleCount: 181,
    ruleGroups: ['credential_expansion', 'dangerous_commands', 'dynamic_execution', 'network_egress'],
    hardBlockRules: 2, contexts: { source: 5, doc: 3, prose: 1 },
    externalTools: { gitleaks: 'SKIPPED', osv_scanner: 'SKIPPED', binary_strings: 'static-only' },
    rulesSource: 'ruleset v1.1.0: secret-patterns.yaml, text-rules.yaml, 12 组规则',
    rulesetResolved: true, rulesetVersion: 'v1.1.0', invalidRules: [],
    derivedViews: { b64_1: 1, normalized: 2 }, derivedFindings: 3, scanTier: 'static',
  },
  frameworkSummary: {
    owaspLlm: [
      { id: 'LLM02', title: '敏感信息泄露', count: 3, rules: ['credential_path_read'] },
      { id: 'LLM03', title: '供应链', count: 3, rules: ['unpinned_runtime_install'] },
      { id: 'LLM05', title: '不当输出处理', count: 1, rules: ['curl_pipe_shell'] },
      { id: 'LLM06', title: '过度代理', count: 2, rules: ['agent_config_write'] },
    ],
    owaspAgentic: [], owaspAst: [
      { id: 'AST01', title: '恶意技能', count: 2, rules: ['curl_pipe_shell'] },
      { id: 'AST02', title: '供应链投毒', count: 3, rules: ['unpinned_runtime_install'] },
      { id: 'AST03', title: '过度授权', count: 2, rules: ['credential_path_read'] },
      { id: 'AST05', title: '不可信外部指令', count: 1, rules: ['agent_config_write'] },
    ],
  },
  structuralSummary: {
    fileCount: 12, totalBytes: 84_512, executableCount: 2, archiveCount: 0,
    symlinkCount: 0, topExtensions: [{ ext: '.py', count: 5 }, { ext: '.md', count: 3 }, { ext: '.json', count: 2 }],
  },
  dependencyManifests: { npm_dependencies: ['lodash@^4.17.21', 'reqeusts@1.0.0'], runtime_packages: ['some-helper'] },
  baseline: { acceptedTotal: 2, acceptedActive: 1, acceptedExpired: 1, suppressedFindings: 1 },
  attackSurface: { egressPoints: 3, dynamicExecPoints: 4, persistencePoints: 2, hasBinaries: false },
  requiredMitigations: [{ id: 'SR-04', name: '外部网络与数据外发' }],
  limitations: [
    '文本检测以正则/关键词为主，存在误报与漏报，分数为启发式而非绝对度量',
    '不可见内容（零宽字符 / Unicode 标签块 / 双向控制符）不做上下文降权——它们不可见这一事实与所在目录无关',
    '二进制扫描当前仅静态层（strings+指标），未接入动态沙箱，无法确认真实运行时行为',
    '依赖漏洞(CVE)、密钥扫描依赖外部工具（osv-scanner/gitleaks），未安装时能力降级',
  ],
};

const COMPOSITION = {
  skills: [],
  paths: [
    {
      id: 'credential_exfil', severity: 'high',
      participants: ['e7f5c0e6f1be', 'release-notes'],
      capabilities: ['read_credentials', 'egress'],
    },
    {
      id: 'untrusted_to_exec', severity: 'medium',
      participants: ['integration-map', 'agent-creator'],
      capabilities: ['ingest_untrusted', 'execute'],
    },
  ],
  coverage: {
    analyzedSkills: 48, resolvableSkills: 66, unresolvedSkills: 32,
    budgetLimited: true, cacheHits: 24, rulesetVersion: 'v1.1.0',
  },
};

function ago(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function readLocale(locale) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, `${locale}.json`), 'utf8'));
}

const I18N_STUB = `
  window.__locale = window.__locale || {};
  window.t = function (key, args) {
    var raw = window.__locale[key];
    if (raw == null) raw = window.__localeFallback[key];
    if (raw == null) return key;
    if (args) {
      Object.keys(args).forEach(function (k) {
        raw = String(raw).split('{' + k + '}').join(String(args[k]));
      });
    }
    return raw;
  };
`;

function pageHtml(locale, en) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head>
<body class="settings-body">
  <div class="settings-pane"><div id="settings-security-body"></div></div>
  <script>
    window.__locale = ${JSON.stringify(locale)};
    window.__localeFallback = ${JSON.stringify(en)};
    ${I18N_STUB}
    window.__fixtures = {};
    window.cogseed = {
      invoke: function (channel) {
        var F = window.__fixtures;
        if (channel === 'skills.security.status') return Promise.resolve({ status: F.status });
        if (channel === 'skills.trust.list') return Promise.resolve({ receipts: F.receipts });
        if (channel === 'skills.list') return Promise.resolve({ skills: F.skills });
        if (channel === 'skills.security.report') return Promise.resolve({ ok: true, evidence: F.evidence });
        if (channel === 'skills.security.acceptances') return Promise.resolve({ acceptances: [] });
        if (channel === 'skills.security.composition') return Promise.resolve(F.composition);
        return Promise.resolve(null);
      }
    };
  </script>
</body></html>`;
}

const SUFFIX = process.env.SHOT_SUFFIX || '';

async function shoot(win, name) {
  await new Promise((r) => setTimeout(r, 350));
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  if (png.length < 5000) throw new Error(`suspiciously small capture for ${name}: ${png.length} bytes`);
  fs.writeFileSync(path.join(OUT, `${name}${SUFFIX}.png`), png);
  const size = image.getSize();
  console.log(`shot ${name}: ${size.width}x${size.height} ${png.length} bytes`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const en = readLocale('en');
  const zh = readLocale('zh');

  const width = Number(process.env.SHOT_WIDTH || 1180);
  const height = Number(process.env.SHOT_HEIGHT || 1560);
  const win = new BrowserWindow({
    show: true,
    x: -4000,
    y: 0,
    width,
    height,
    webPreferences: { sandbox: true, contextIsolation: false, nodeIntegration: false },
  });

  const html = pageHtml(zh, en);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  for (const file of STYLES) {
    await win.webContents.insertCSS(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  for (const file of SCRIPTS) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, file), 'utf8'), true);
  }

  // Scenario A: healthy scanner with degraded optional tooling (this machine's
  // real state), mixed receipts, and a composition path found.
  await win.webContents.executeJavaScript(`
    window.__fixtures.status = ${JSON.stringify(HEALTHY_STATUS)};
    window.__fixtures.receipts = ${JSON.stringify(RECEIPTS)};
    window.__fixtures.skills = ${JSON.stringify(SKILLS)};
    window.__fixtures.evidence = ${JSON.stringify(EVIDENCE)};
    window.__fixtures.composition = ${JSON.stringify(COMPOSITION)};
    true;
  `, true);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'modules/settings-security.js'), 'utf8'), true);
  await win.webContents.executeJavaScript('window.loadSecuritySettings()', true);

  // 主屏默认形态：hero + 三行防护项，全部收起。这就是用户第一眼看到的东西，
  // 也是这一版与旧版 dashboard 最大的差别，所以单独截一张。
  await shoot(win, '01-overview-collapsed');

  // 展开三行，把下沉到行内的内容截全。行是共享 uiAccordion 的原生 <details>，
  // 直接设 open 即可，不需要点击坐标。
  await win.webContents.executeJavaScript(`
    document.querySelectorAll('#settings-security-body .ui-accordion__item')
      .forEach(function (el) { el.open = true; });
    true;
  `, true);
  await shoot(win, '02-overview-expanded');
  await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true);
  await shoot(win, '03-overview-expanded-bottom');

  // Scenario B: the skill picker. It is a right-side drawer (shared uiDrawer), so the
  // list gets the full height instead of the old 280px band at the bottom of the page.
  await win.webContents.executeJavaScript(`
    document.querySelectorAll('#settings-security-body .ui-accordion__item')
      .forEach(function (el) { el.open = false; });
    window.scrollTo(0, 0);
    document.querySelector('[data-action="toggle-picker"]').click();
    true;
  `, true);
  await shoot(win, '04-picker-drawer', { settle: 600 });
  await win.webContents.executeJavaScript(`
    (function () {
      var input = document.querySelector('[data-role="picker-input"]');
      if (input) { input.value = 'data'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`, true);
  await shoot(win, '05-picker-filtered', { settle: 400 });
  await win.webContents.executeJavaScript(
    `document.querySelector('.ui-drawer__close').click(); true;`, true);
  await new Promise((r) => setTimeout(r, 300));

  // Scenario C: the detail drawer for one skill.
  await win.webContents.executeJavaScript(
    `(function(){var rows=document.querySelectorAll('[data-action="detail"]');
       rows[2].click(); return true;})()`, true);
  await new Promise((r) => setTimeout(r, 900));
  await shoot(win, '06-drawer-findings');
  await win.webContents.executeJavaScript(
    `(function(){var b=document.querySelector('.ui-drawer__body'); b.scrollTop = b.scrollHeight*0.62; return true;})()`, true);
  await shoot(win, '07-drawer-breakdown');

  // Scenario D: a scanner-free build, to show the alert wording.
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-ui-drawer-close]').click(); true;`, true);
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`
    window.__fixtures.status = Object.assign({}, ${JSON.stringify(HEALTHY_STATUS)}, {
      scanner: 'absent_by_build', scannerIntegrity: 'unreadable',
      sentryEngineVersion: '', sentryRulesetVersion: '', rules: { total: 0, groups: [], hardBlock: 0, versioned: false },
      capabilities: [], externalTools: [], interpreter: ''
    });
    window.loadSecuritySettings(); true;
  `, true);
  // Scenario C is about the hero wording, so capture the top of the page.
  await win.webContents.executeJavaScript('window.scrollTo(0, 0)', true);
  await shoot(win, '08-scanner-absent');

  win.destroy();
  app.quit();
}).catch((err) => {
  console.error('SHOT FAILED', err);
  app.exit(1);
});
