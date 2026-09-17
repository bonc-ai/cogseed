import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
const recallCss = [
  fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8'),
  fs.readFileSync(path.join(__dirname, '../../src/renderer/recall-local.css'), 'utf-8'),
].join('\n');
const recallLocalCss = fs.readFileSync(path.join(__dirname, '../../src/renderer/recall-local.css'), 'utf-8');

/**
 * 取出一个顶层函数的函数体文本。断言"某个面板出现在哪个视图里"必须限定到
 * 单个函数——在整份 skills.js 上做 toContain 只能证明这段代码存在，证明不了
 * 它挂在哪个页面上，而这里要守的恰恰是归属。
 */
function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  // 到下一个顶层 `function` 声明为止。不数花括号：skills.js 全是嵌套模板字符串，
  // 括号计数会被 `${...}` 和 '{count}' 这类字面量带偏。
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function cssBraceDepthAt(source: string, offset: number): number {
  let depth = 0;
  let quote = '';
  let inComment = false;
  for (let i = 0; i < offset; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return depth;
}

describe('Recall cognition workspace layout', () => {
  /**
   * 四个任务视图回答的是"用户来这里要做什么"：需要我决定什么 / 我拥有什么 /
   * 是否真的有用 / 我怎样控制。它们与"四类资产"（关于我、规则与偏好、模板与
   * 范例、技能与方法）不是一回事——四类资产全部在「我的资产」里面。
   *
   * `overview` 不再是任务视图：总览不是用户要完成的事，深链由
   * switchSkillsCognitionPage 归一化到 inbox，页面上不再有它的 tab / pane。
   */
  it('keeps Recall navigation focused on three user workflows', () => {
    // 2026-09-15 全模块重构：四 tab 收敛为三 tab——我的认知 / 待我处理 / 整理。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    expect(core).toContain("{ id: 'overview', titleKey: 'cognition.tab_overview'");
    expect(core).toContain("{ id: 'review', titleKey: 'cognition.tab_review'");
    expect(core).toContain("{ id: 'organize', titleKey: 'cognition.tab_organize'");
    // tab 由 views.js 渲染进 #ca-root 的 .ca-tabs，数据驱动（data-act="tab"）。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('<nav class="ca-tabs">');
    expect(views).toContain('data-act="tab"');
    // 挂载点是 #panel-recall > #ca-root。
    expect(html).toContain('id="ca-root"');
    // 旧四 tab 骨架不再存在。
    for (const excluded of ['inbox', 'proofs', 'governance', 'candidates', 'receipts', 'brain', 'context', 'ontology']) {
      expect(html).not.toContain(`data-cognition-page="${excluded}"`);
    }
  });

  it('does not ship the removed hidden Recall page implementations', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const bindings = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf-8');

    for (const removedFunction of [
      'renderSkillsCognitionBrain',
      'renderSkillsCognitionContext',
      'renderSkillsCognitionOntology',
      'renderSkillsCognitionReceipts',
      'refreshSkillCognitionSummary',
    ]) {
      expect(skills).not.toContain(`function ${removedFunction}`);
    }
    for (const removedSelector of [
      'skills-cognition-brain-body',
      'skills-cognition-context-body',
      'skills-cognition-ontology-body',
      'skills-cognition-receipts-body',
      'data-recall-context-select',
      'data-recall-ontology-group',
      'data-cognition-open-receipt',
      'data-cognition-rollback-skill',
    ]) {
      expect(skills).not.toContain(removedSelector);
      expect(bindings).not.toContain(removedSelector);
    }
    for (const removedStyle of [
      '.recall-brain-',
      '.recall-context-',
      '.recall-ontology-',
      '.skills-cognition-inline-grid',
      '.skills-cognition-version-list',
      '.skills-cognition-detail-meta',
    ]) {
      expect(recallCss).not.toContain(removedStyle);
    }
  });

  // 「使用与证明」是 CogSeed 区别于普通 Memory / Skill 库的地方：它必须回答
  // "这条资产在哪里用过、真的起作用了吗"，且结论用用户能读懂的话，不露内部枚举。
  it('keeps use-and-proof inside asset detail backed by the timeline', () => {
    // 2026-09-15 重构：独立 proofs 任务视图删除，「使用与证明」并入资产详情。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    // 时间线快照是使用记录的唯一数据源，api.soft 容错。
    expect(core).toContain("api.soft('recall.timeline.list'");
    expect(core).not.toContain('recall.proofs.list');
    // 使用记录区渲染在资产详情里。
    expect(views).toContain('cognition.asset_usage_section');
    // 评价结论文案四值接线（PROOF_FEEDBACKS），不露 better/worse 枚举。
    for (const key of ['cognition.proof_carried_in', 'cognition.proof_rework', 'cognition.proof_no_diff', 'cognition.proof_degraded']) {
      expect(views).toContain(key);
    }
  });

  it('routes each task view through the single CogAssets router', () => {
    // 2026-09-15 重构：视图渲染收敛到单一命名空间（window.CogAssets），
    // 路由走 router.go({name})，不存在第二套页面函数。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    expect(core).toContain('window.CogAssets');
    expect(core).toContain("NS.router = router");
    expect(core).toContain("router.go({ name: 'overview'");
    expect(core).toContain("router.go({ name: 'review' })");
    expect(core).toContain("{ id: 'organize', titleKey: 'cognition.tab_organize'");
    // 旧页面函数全部删除，没有并行数据路径。
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    for (const fn of ['renderSkillsCognitionInbox', 'renderSkillsCognitionAssets', 'renderSkillsCognitionProofs', 'renderSkillsCognitionGovernance', '_renderCognitionTaskHero']) {
      expect(skills).not.toContain(`function ${fn}`);
    }
    // 版本信息以时间线事件形式保留（proof_sentence_version），旧独立
    // 版本/回滚通道随治理视图删除。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('cognition.proof_sentence_version');
  });

  // 任务视图回答"用户来这里要做什么"；来源是输入配置、沉淀活动是后台加工
  // 进度，两者都不是任务，降为页头辅助入口。它们打开的仍是同一批 page body。
  it('keeps sources and capture activity out of the three task tabs', () => {
    // 2026-09-15 重构：来源改为异常驱动、只在「待我处理」出现；沉淀活动是
    // 「整理」tab 内的常态页，两者都不占任务 tab。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    const tabIds = [...core.matchAll(/\{ id: '([a-z]+)', titleKey: 'cognition\.tab_/g)].map((m) => m[1]);
    expect(tabIds).toEqual(['overview', 'review', 'organize']);
    expect(core).toContain('sourceIssueOpen');
    // 来源健康入口只出现在待我处理（review）页。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('sourceIssueOpen');
  });

  // 技能市场与外部 Skill 库是「可用资源」，安装/导入不等于用户已确认拥有，
  // 所以它们不属于个人认知资产，移到连接页「技能」tab。个人已确认的 Skill
  // 仍以 skill_method 正式资产留在认知资产「技能与方法」分类里。
  it('hosts the skill library in the Connections 技能 tab, not inside Recall', () => {
    expect(html).toContain('id="recall-btn"');
    expect(html).toContain('id="panel-recall"');
    expect(html).not.toContain('skills-cognition-my-abilities');
    expect(html).toContain('data-connections-tab="skills"');
    const paneStart = html.indexOf('id="connections-pane-skills"');
    expect(paneStart).toBeGreaterThan(0);
    const paneEnd = html.indexOf('id="connections-pane-sources"', paneStart);
    expect(paneEnd).toBeGreaterThan(paneStart);
    const paneHtml = html.slice(paneStart, paneEnd);
    expect(paneHtml).toContain('id="panel-skills"');
    expect(paneHtml).toContain('id="skills-grid-view"');
    expect(paneHtml).toContain('id="create-skill-btn"');
    expect(paneHtml).toContain('id="skills-more-btn"');
    expect(paneHtml).toContain('id="skills-categories"');
    expect(paneHtml).toContain('id="skills-grid"');
    expect(paneHtml).toContain('id="skills-detail-view"');
    expect(paneHtml).toContain('id="skills-chat-input"');
  });

  it('routes and lazy-loads Skills through Connections', () => {
    const boot = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
    const state = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
    const lazy = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf-8');
    // Skills 没有独立侧栏按钮；技能库挂在连接页「技能」tab，深链切到连接页。
    expect(state).not.toContain("_setViewFromSidebar('skills')");
    expect(state).toContain("_setViewFromSidebar('recall')");
    expect(boot).toContain("view === 'skills' ? 'panel-connections'");
    expect(boot).toContain("view === 'recall' ? 'panel-recall'");
    expect(boot).toContain("_loadViewFeature('recall', 'recall'");
    expect(boot).toContain("activateConnectionsTab('skills')");
    // 2026-09-15 重构：recall 懒加载包改为 cognition-assets 模块组。
    expect(lazy).toMatch(/recall:\s*\[[\s\S]*?\{ src: '\.\/modules\/cognition-assets\/core\.js' \}/);
    expect(lazy).toMatch(/recall:\s*\[[\s\S]*?\{ src: '\.\/modules\/cognition-assets\/app\.js' \}/);
  });

  it('wraps the top navigation and pages in one integrated workspace', () => {
    // 2026-09-15 重构：工作区收敛为 #panel-recall > #ca-root 单一挂载点，
    // 滚动容器是 views.js 渲染的 .ca-scroll。
    const panelStart = html.indexOf('id="panel-recall"');
    expect(panelStart).toBeGreaterThan(0);
    expect(html.indexOf('id="ca-root"')).toBeGreaterThan(panelStart);
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('id="ca-scroll"');
    const app = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/app.js'), 'utf-8');
    expect(app).toContain("getElementById('ca-root')");
  });

  it('presents the three workflows as a tab navigation shell', () => {
    // 2026-09-15 重构：任务卡导航收敛为 .ca-tabs 三 tab（标题+副标题，
    // 窄窗口折行切紧凑模式）。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('<nav class="ca-tabs">');
    expect(views).toContain('data-act="tab"');
    expect(views).toContain('T(tab.titleKey, tab.title)');
    // tab 标题 key 来自 core.js TABS 定义。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    for (const key of ['cognition.tab_overview', 'cognition.tab_review', 'cognition.tab_organize']) {
      expect(core).toContain(key);
    }
    const app = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/app.js'), 'utf-8');
    expect(app).toContain('is-compact');
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/cognition-assets.css'), 'utf-8');
    expect(css).toMatch(/\.ca-tabs\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.ca-tab\s*\{[^}]*display:\s*flex/);
  });

  it('keeps the main Recall content scrollable without a competing page-level scroller', () => {
    expect(recallLocalCss).toMatch(/\.skills-cognition-main\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*scroll;[^}]*overscroll-behavior:\s*auto;/s);
    expect(recallLocalCss).toMatch(/\.skills-cognition-page\s*\{[^}]*min-height:\s*100%;[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
    expect(recallLocalCss).toContain('#skills-cognition-assets { overflow: visible; }');
    // 2026-09-14 认知资产前端重建：主滚动容器改为 #ca-root 内的 .ca-scroll
    //（views.js render 产出，路由切换时 core.js 将其 scrollTop 归零）；
    //「Find scrollable」边缘滚动转发随旧 skills-bindings 认知段删除。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf8');
    expect(views).toContain('id="ca-scroll"');
  });


  it('keeps the Recall workspace rules outside narrow-screen media queries', () => {
    const css = recallCss;
    const recallRules = css.indexOf('/* Recall cognition console. */');
    expect(recallRules).toBeGreaterThan(0);
    expect(cssBraceDepthAt(css, recallRules)).toBe(0);
  });

  it('keeps review inside the review tab and assets inside overview', () => {
    // 2026-09-15 重构：候选复核收敛到「待我处理」（review）tab，
    // 资产与认知树在「我的认知」（overview）。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    expect(core).toContain("router.go({ name: 'review' })");
    expect(core).toContain("router.go({ name: 'overview'");
    expect(html).not.toContain('data-ability-assets-view');
    expect(html).not.toContain('cognition.cognition_tree');
  });


  it('keeps ability asset status chips compact inside list rows', () => {
    const css = recallCss;
    expect(css).toContain('.ability-asset-list-row .skills-cognition-status');
    expect(css).toContain('align-self: start');
    expect(css).toContain('height: fit-content');
  });

  it('bounds the template and asset panes while handing edge scrolling back to the page', () => {
    const css = recallCss;
    const desktopStart = css.indexOf('@media (min-width: 901px)');
    const desktopEnd = css.indexOf('@media (max-width: 900px)', desktopStart);
    const desktopRules = css.slice(desktopStart, desktopEnd);
    expect(html).toContain('class="panel skills-embedded-panel recall-personal-ontology-frame"');
    expect(recallCss).toMatch(/\.recall-personal-ontology-frame\s*\{[^}]*height:\s*clamp\(420px, calc\(100dvh - 300px\), 580px\);[^}]*overflow:\s*hidden;/s);
    expect(recallCss).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.recall-personal-ontology-frame\s*\{[^}]*height:\s*max\(360px, calc\(100dvh - 160px\)\);[^}]*max-height:\s*680px;/);
    expect(recallCss).toMatch(/\.recall-personal-ontology-frame \.personal-onto-modal\s*\{[^}]*max-height:\s*min\(720px, calc\(100dvh - 48px\)\);[^}]*overflow/s);
    expect(recallCss).toMatch(/\.recall-personal-ontology-frame \.personal-onto-library-list\s*\{[^}]*max-height:\s*none;[^}]*overscroll-behavior:\s*auto;/s);
    expect(recallCss).toMatch(/#skills-cognition-assets\s*\{[^}]*overflow-x:\s*hidden;[^}]*overscroll-behavior:\s*auto;/s);
    expect(desktopRules).toContain('#skills-cognition-assets-body { height: clamp(420px, calc(100dvh - 250px), 620px); min-height: 0; }');
    expect(desktopRules).toMatch(/\.ability-asset-list-body\s*\{[\s\S]*overflow-y:\s*auto;/);
    expect(desktopRules).toMatch(/\.ability-asset-detail\s*\{[\s\S]*height:\s*100%;/);
    expect(desktopRules).toContain('overscroll-behavior: auto');
    expect(desktopRules).toContain('scrollbar-gutter: stable');
    expect(recallLocalCss).toMatch(/\.recall-personal-ontology-frame \.personal-onto-nav,[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*auto;/);
  });

  it('uses a task-oriented cognition header and removes the personal tag surface', () => {
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf-8'));
    // 一级页面标题由 hero() 渲染（overview_title），不再有 eyebrow/subtitle 头。
    expect(views).toContain("T('cognition.overview_title'");
    expect(zh['cognition.title']).toBe('认知资产');
    expect(views).not.toContain('eyebrow');
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/cognition-assets.css'), 'utf-8');
    expect(css).not.toContain('.ability-profile-');
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.profile.summary'");
    expect(skills).not.toContain('data-personal-ontology-manage');
  });

  it('bounds expanded execution and evaluation source records inside their own scroller', () => {
    expect(recallLocalCss).toMatch(/\.recall-source-group-advanced \.recall-source-items\s*\{[^}]*max-height:\s*clamp\(240px, calc\(100dvh - 300px\), 420px\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*auto;/s);
    expect(recallLocalCss).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.recall-source-group-advanced \.recall-source-items\s*\{\s*max-height:\s*clamp\(220px, calc\(100dvh - 260px\), 320px\);/);
  });

  /**
   * 进度归进度，决策归决策。这条守的是拆分本身：沉淀进度与来源健康度不能
   * 回流到「待我处理」——一旦回流，"需要我决定"的红点就会被后台噪音顶满，
   * 用户很快就不再点它。
   */
  it('keeps processing status out of the decision inbox', () => {
    // 2026-09-15 重构：进度（来源/沉淀）不回流「待我处理」——review 页只渲染
    // 候选复核与来源异常（sourceIssueOpen），进度归「整理」。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(core).toContain('sourceIssues');
    expect(core).toContain("router.go({ name: 'review' })");
    // 沉淀重试能力仍在（review 失败候选 → organize 任务重试）。
    expect(core).toContain("recall.captures.retry");
    // 旧页面函数已删，无并行渲染路径。
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain('function renderSkillsCognitionSources');
    expect(skills).not.toContain('function renderSkillsCognitionCaptures');
    expect(views).toContain('ca-warn');
  });

  /**
   * 2026-08-17 定：**落地不再跳页，一次也不跳。**
   *
   * 旧规则是"待办为空时首次落地自动切到我的资产"。产品决策把它取消了——认知
   * 资产首页要先回答"现在有什么需要我判断"，用户点进来看到的必须是自己点的
   * 那一页。空的时候由「待我处理」自己的空态给显式入口，跳不跳由用户决定。
   *
   * 这条用例因此从"只跳一次"翻转为"一次都不跳"。原断言编码的是被取消的行为，
   * 不是回归。
   */
  it('lands on overview without auto-redirecting away', () => {
    // 2026-09-15 重构：路由默认 overview（我的认知），不因待办为空自动跳页；
    // 空态给显式入口，跳不跳由用户决定。
    const core = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');
    expect(core).toContain("route: { name: 'overview'");
    expect(core).toContain("Object.assign({ name: 'overview'");
    // 没有 switchSkillsCognitionPage 这类强制跳转残留。
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain('switchSkillsCognitionPage');
    // overview 空态给「去处理」入口（ca-empty + go-review），不自动跳页。
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('ca-empty');
    expect(views).toContain('data-act="go-review"');
  });

  it('routes retired deep links into the new views', () => {
    // 2026-09-15 重构：旧页面名归一化在 recall-information-architecture.js 的
    // normalizeRecallLocation——旧路由全部映射到 overview/assets。
    const ia = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/recall-information-architecture.js'), 'utf-8');
    expect(ia).toContain('normalizeRecallLocation');
    for (const legacy of ['brain', 'context', 'receipts', 'ontology']) {
      expect(ia).toContain(`'${legacy}'`);
    }
    expect(ia).toContain("return { page: 'overview', subview: '' }");
  });

  it('本体绑定控件只在有分组时渲染，且不替用户猜绑定', () => {
    // 2026-09-15 重构后资产编辑器与 ontologyRefs 读写路径整体删除（见下一条
    // 用例）；「不替用户猜绑定」的新守卫是：新模块不携带任何相似度推断。
    const dir = path.join(__dirname, '../../src/renderer/modules/cognition-assets');
    for (const file of ['core.js', 'views.js', 'app.js']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      // 2026-09-17 收窄：recall_candidate_similar_asset / forceCreateSimilar 是
      // 主进程相似闸门的 API 契约词（candidate-service 错误码），不是本体
      // 绑定推断——守卫只拦"本体上下文里的相似度推断"。
      expect(source, `${file} must not guess ontology binding`).not.toMatch(/ontolog(?:y|ies)[^\n]{0,80}(?:similar|match|guess|infer)/i);
    }
  });

  it('资产更新在无绑定控件时不传 ontologyRefs（不清空既有绑定）', () => {
    // 资产编辑器（含本体绑定控件）已随认知资产前端重建删除：新实现
    //（cognition-assets/*）没有资产编辑表单，也不再有 ontologyRefs 的读写
    // 路径——「无控件时误传空数组清空既有绑定」的入口不复存在。守卫：
    // 新模块不再携带 ontologyRefs 载荷。
    const dir = path.join(__dirname, '../../src/renderer/modules/cognition-assets');
    for (const file of ['core.js', 'views.js', 'app.js']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, `${file} must not carry ontologyRefs`).not.toContain('ontologyRefs');
    }
  });

  it('does not load internal Brain, Context Pack, or Ontology data for the four-page snapshot', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain("window.cogseed.invoke('recall.projections.list'");
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.groups.list'");
    expect(skills).not.toContain("window.cogseed.invoke('recall.views.list'");
  });

  it('ships the task shell and capture feedback in every renderer locale', () => {
    // 2026-09-15 全模块重构（3 tab）+ 零引用键清理后，此清单更新为当前 UI
    // 的真实键集：三 tab 壳、来源字典、整理动作/原因、资产详情使用记录区。
    // 旧清单（workspace/pipeline/governance/skill_draft 等）对应的 UI 已随
    // 09-14 前端重建删除，键已按零引用清出四语文件。
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const messages = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf-8'));
      for (const key of [
        'cognition.tab_review',
        'cognition.tab_review_desc',
        'cognition.tab_overview',
        'cognition.tab_overview_desc',
        'cognition.tab_organize',
        'cognition.tab_organize_desc',
        'cognition.source_conversation',
        'cognition.source_artifact',
        'cognition.source_execution',
        'cognition.source_teaching',
        'cognition.source_external',
        'cognition.capture_status_queued',
        'cognition.capture_status_extracting',
        'cognition.capture_status_writing',
        'cognition.capture_status_review',
        'cognition.capture_status_no_candidate',
        'cognition.capture_status_configuration_required',
        'cognition.capture_status_failed',
        'cognition.capture_error_unknown',
        'cognition.capture_stage_asset_write',
        'cognition.capture_action_run_now',
        'cognition.capture_action_retry',
        'cognition.capture_action_pause',
        'cognition.capture_action_resume',
        'cognition.capture_action_cancel',
        'cognition.capture_reason_review_pending',
        'cognition.capture_reason_capture_failed',
        'cognition.capture_bucket_attention',
        'cognition.organize_settings_open',
        'cognition.capture_batch_run_confirm',
        'cognition.asset_usage_section',
        'cognition.overview_failed_tasks',
        'cognition.overview_source_issues',
      ]) expect(messages[key]).toBeTruthy();
    }
  });

  // tab 切换只翻 pane 的 hidden 属性，而 .skills-cognition-page 自带 display，
  // 会盖掉 UA 的 [hidden]{display:none}。少了这条守卫，六个 pane 全部保留布局
  // 竖排在 overflow:hidden 的容器里，只有第一屏露出来，切 tab 像点不动。
  it('keeps the embedded ontology pane hidden until opened', () => {
    // 2026-09-15 重构：旧 .skills-cognition-page 六 pane 结构删除；内嵌本体
    // 骨架默认带 hidden 属性，由 overview 树上的 open-ontology 入口切换。
    expect(html).toContain('id="skills-cognition-personal-ontology" hidden');
    const views = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).toContain('data-act="open-ontology"');
  });

  // 认知资产页把技能库和个人本体整体内嵌，两份骨架很容易在合并时被同时保留。
  // 重复 id 不会报错，只会让 getElementById 命中文档靠前的那一份，被内嵌的
  // tab 就成了收不到渲染的死壳——所以整页 id 唯一性要当契约守住。
  it('keeps every element id unique across the embedded panels', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const seen = new Set<string>();
    const duplicated = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
    expect(duplicated).toEqual([]);
  });

  // 「关于我」不再是独立任务页，而是「我的资产」里的一类。个人本体骨架跟着
  // 搬进 assets 页，但仍然只能有一份——两份同 id 骨架会让渲染落到靠前那份。
  it('renders the personal ontology shell exactly once, inside My assets', () => {
    expect(html).not.toContain('skills-cognition-about-me');
    const sectionStart = html.indexOf('id="skills-cognition-personal-ontology"');
    expect(sectionStart).toBeGreaterThan(-1);
    // 旧四 tab 骨架已删；本体 section 位于 panel-recall 内、ca-root 之后。
    const rootStart = html.indexOf('id="ca-root"');
    expect(rootStart).toBeGreaterThan(-1);
    expect(sectionStart).toBeGreaterThan(rootStart);
    for (const id of ['personal-onto-nav', 'personal-onto-main-body', 'personal-onto-template-library-modal']) {
      const occurrences = [...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))];
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].index).toBeGreaterThan(sectionStart);
    }
  });

});
