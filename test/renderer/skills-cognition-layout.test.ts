import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
const recallCss = [
  fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8'),
  fs.readFileSync(path.join(__dirname, '../../src/renderer/recall-local.css'), 'utf-8'),
].join('\n');

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
  it('keeps Recall navigation focused on four user workflows', () => {
    for (const page of ['inbox', 'assets', 'proofs', 'governance']) {
      expect(html).toContain(`data-cognition-page="${page}"`);
      expect(html).toContain(`data-cognition-page-body="${page}"`);
    }
    // 来源与沉淀活动降为页头辅助入口：仍有 pane，但不占任务视图的位置。
    for (const aux of ['sources', 'captures']) {
      expect(html).toContain(`data-cognition-page="${aux}"`);
      expect(html).toContain(`data-cognition-page-body="${aux}"`);
    }
    const tabNav = html.slice(html.indexOf('id="skills-cognition-tabs"'), html.indexOf('</nav>', html.indexOf('id="skills-cognition-tabs"')));
    for (const aux of ['sources', 'captures']) {
      expect(tabNav).not.toContain(`data-cognition-page="${aux}"`);
    }
    for (const excluded of ['overview', 'candidates', 'receipts', 'brain', 'context', 'ontology', 'kstar', 'evolution', 'capability']) {
      expect(html).not.toContain(`data-cognition-page="${excluded}"`);
      expect(html).not.toContain(`data-cognition-page-body="${excluded}"`);
    }
    expect(html).toContain('id="skills-cognition-capture-review-body"');
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
  it('exposes use-and-proof as its own task view backed by the fact chain', () => {
    expect(html).toContain('data-cognition-page="proofs"');
    expect(html).toContain('data-cognition-page-body="proofs"');
    expect(html).toContain('id="skills-cognition-proofs-body"');

    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).toContain('recall.timeline.list');
    // 治理事件属于「版本与治理」，不能混进这一页。
    expect(skills).toMatch(/_COGNITION_PROOF_KINDS[\s\S]{0,240}effectiveness_recorded/);
    expect(skills).not.toMatch(/_COGNITION_PROOF_KINDS[\s\S]{0,240}asset_rolled_back/);
    // 结果状态必须翻译成用户说法，不能直接把 better/worse 打到界面上。
    for (const key of [
      'cognition.proof_carried_in', 'cognition.proof_effective', 'cognition.proof_no_diff',
      'cognition.proof_negative', 'cognition.proof_degraded', 'cognition.proof_rework',
    ]) expect(skills).toContain(key);
  });

  it('applies the task-oriented hierarchy inside all four views without adding a parallel data path', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const bindings = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf-8');

    expect(skills).toContain('function _renderCognitionTaskHero');
    for (const [view, key] of [
      ['renderSkillsCognitionInbox', 'cognition.inbox_title'],
      ['renderSkillsCognitionAssets', 'cognition.assets_title'],
      ['renderSkillsCognitionProofs', 'cognition.proofs_title'],
      ['renderSkillsCognitionGovernance', 'cognition.governance_title'],
    ]) {
      expect(sliceFunction(skills, view)).toContain(key);
    }

    const proofs = sliceFunction(skills, 'renderSkillsCognitionProofs');
    expect(proofs).toContain('recall-proof-timeline');
    expect(proofs).toContain('recall-proof-event');
    expect(proofs).toContain("item.kind === 'effectiveness_recorded'");

    const governance = sliceFunction(skills, 'renderSkillsCognitionGovernance');
    expect(governance).toContain('cognition-governance-workbench');
    expect(governance).toContain('cognition-governance-asset-list');
    expect(governance).toContain('data-cognition-governance-action');
    expect(governance).toContain('_recallAssetActions(selected.status)');
    expect(governance).toContain('_renderRecallAssetHistory(selected.id)');
    expect(governance).toContain('_renderRecallAssetChain(selected.id)');
    expect(bindings).toContain("window.cogseed.invoke('recall.assets.versions'");
    expect(bindings).toContain("window.cogseed.invoke('recall.assets.rollback'");
    expect(bindings).toContain('[data-cognition-governance-action]');
    expect(bindings).toContain('[data-cognition-governance-select]');

    expect(recallCss).toContain('.cognition-task-hero');
    expect(recallCss).toContain('.recall-proof-timeline');
    expect(recallCss).toContain('.cognition-governance-workbench');
  });

  // 任务视图回答"用户来这里要做什么"；来源是输入配置、沉淀活动是后台加工
  // 进度，两者都不是任务，降为页头辅助入口。它们打开的仍是同一批 page body。
  it('keeps sources and capture activity as header entries, not task tabs', () => {
    const navStart = html.indexOf('id="skills-cognition-tabs"');
    const navEnd = html.indexOf('</nav>', navStart);
    expect(navStart).toBeGreaterThan(0);
    const navHtml = html.slice(navStart, navEnd);
    for (const page of ['sources', 'captures']) {
      expect(navHtml).not.toContain(`data-cognition-page="${page}"`);
      // 页面本体仍在，只是入口换了位置。
      expect(html).toContain(`data-cognition-page-body="${page}"`);
      expect(html).toContain(`class="btn btn-sm cognition-aux-entry" data-cognition-page="${page}"`);
    }
    // 辅助入口不得伪装成 tab：没有 role="tab"，就不该出现在 tablist 语义里。
    const headerStart = html.indexOf('class="skills-cognition-header"');
    const headerHtml = html.slice(headerStart, html.indexOf('</header>', headerStart));
    expect(headerHtml).toContain('cognition-aux-entry');
    expect(headerHtml).not.toContain('role="tab"');
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
    expect(lazy).toMatch(/recall:\s*\[[\s\S]*?\{ src: '\.\/modules\/skills\.js' \}/);
  });

  it('wraps the top navigation and pages in one integrated workspace', () => {
    expect(html).toContain('class="skills-cognition-surface"');
    const surfaceStart = html.indexOf('class="skills-cognition-surface"');
    const surfaceEnd = html.indexOf('</main>', surfaceStart);
    expect(surfaceStart).toBeGreaterThan(0);
    expect(surfaceEnd).toBeGreaterThan(surfaceStart);
    const surfaceHtml = html.slice(surfaceStart, surfaceEnd);
    expect(surfaceHtml).toContain('class="skills-cognition-header"');
    expect(surfaceHtml).toContain('class="skills-cognition-workspace"');
    expect(surfaceHtml).toContain('class="skills-cognition-main"');
    expect(surfaceHtml).toContain('id="skills-cognition-tabs"');
    expect(surfaceHtml).toContain('id="skills-cognition-assets"');
  });

  it('presents the four user workflows as a task-card navigation shell', () => {
    const css = recallCss;
    const navStart = html.indexOf('id="skills-cognition-tabs"');
    const navHtml = html.slice(navStart, html.indexOf('</nav>', navStart));
    expect(html).toContain('class="skills-cognition-heading"');
    expect(html).toContain('class="skills-cognition-header-actions"');
    expect(html).toContain('data-i18n="cognition.workspace_eyebrow"');
    expect(navHtml).toContain('data-i18n-aria-label="cognition.task_views"');
    for (const key of ['inbox_desc', 'my_assets_desc', 'proofs_desc', 'governance_desc']) {
      expect(navHtml).toContain(`data-i18n="cognition.${key}"`);
    }
    expect(css).toMatch(/\.skills-cognition-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(css).toMatch(/\.skills-cognition-tabs\s*\{[^}]*display:\s*block;[^}]*border-bottom:/s);
    expect(css).toMatch(/\.skills-cognition-tab-group\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,/s);
    expect(css).toMatch(/\.skills-cognition-tab-group-label\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.skills-cognition-tab\.is-active\s*\{[^}]*inset 3px 0 0/s);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-tab-group\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tab \.ui-icon\s*\{[^}]*display:\s*inline-block;/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tabs\s*\{[^}]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.skills-cognition-tab-group\s*\{[^}]*display:\s*flex;/);
  });


  it('keeps the Recall workspace rules outside narrow-screen media queries', () => {
    const css = recallCss;
    const recallRules = css.indexOf('/* Recall cognition console. */');
    expect(recallRules).toBeGreaterThan(0);
    expect(cssBraceDepthAt(css, recallRules)).toBe(0);
  });

  it('keeps review inside capture tasks and exposes memory content as one page', () => {
    expect(html).not.toContain('data-i18n="cognition.candidate_review"');
    expect(html).toContain('data-i18n="cognition.my_assets"');
    expect(html).not.toContain('data-ability-assets-view');
    expect(html).not.toContain('data-ability-assets-view-panel');
    expect(html).not.toContain('cognition.cognition_tree');
  });


  it('keeps ability asset status chips compact inside list rows', () => {
    const css = recallCss;
    expect(css).toContain('.ability-asset-list-row .skills-cognition-status');
    expect(css).toContain('align-self: start');
    expect(css).toContain('height: fit-content');
  });

  it('uses one page scroller for My assets so nested panes cannot trap wheel gestures', () => {
    const css = recallCss;
    const desktopStart = css.indexOf('@media (min-width: 901px)');
    const desktopEnd = css.indexOf('@media (max-width: 900px)', desktopStart);
    const desktopRules = css.slice(desktopStart, desktopEnd);
    expect(desktopRules).toContain('#skills-cognition-assets { overflow-x: hidden; overflow-y: auto; }');
    expect(desktopRules).toContain('#skills-cognition-assets-body { height: auto; min-height: 0; }');
    expect(desktopRules).toMatch(/\.ability-asset-list-body\s*\{[\s\S]*overflow:\s*visible;/);
    expect(desktopRules).toMatch(/\.ability-asset-detail\s*\{[\s\S]*height:\s*auto;[\s\S]*overflow:\s*visible;/);
    expect(desktopRules).not.toContain('overscroll-behavior: contain');
  });

  it('uses a task-oriented cognition header and removes the personal tag surface', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf-8'));
    expect(html).toContain('<h1 data-i18n="cognition.title">认知资产</h1>');
    expect(html).toContain('data-i18n="cognition.workspace_eyebrow"');
    expect(zh['cognition.title']).toBe('认知资产');
    expect(zh['cognition.subtitle']).toContain('管理资产');
    expect(recallCss).toMatch(/\.skills-cognition-header\s*\{[^}]*padding:\s*24px 28px 20px;/s);
    expect(recallCss).toMatch(/\.skills-cognition-header h1\s*\{[^}]*font-size:\s*24px;/s);
    expect(recallCss).not.toContain('.ability-profile-');
    expect(recallCss).not.toContain('.ability-personal-memory-');
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.profile.summary'");
    expect(skills).not.toContain('data-personal-ontology-manage');
  });

  /**
   * 进度归进度，决策归决策。这条守的是拆分本身：沉淀进度与来源健康度不能
   * 回流到「待我处理」——一旦回流，"需要我决定"的红点就会被后台噪音顶满，
   * 用户很快就不再点它。
   */
  it('keeps processing status out of the decision inbox', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const bindings = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf-8');
    const css = recallCss;

    expect(skills).toContain("window.cogseed.invoke('recall.sources.list'");
    expect(skills).toContain("window.cogseed.invoke('recall.captures.list'");
    expect(skills).toContain('skills-cognition-source-row');
    expect(skills).toContain('skills-cognition-capture-row');
    expect(skills).toContain('data-cognition-page-link="captures"');
    expect(skills).toContain('data-recall-capture-retry');
    expect(skills).toContain('data-recall-capture-settings');
    expect(bindings).toContain("window.cogseed.invoke('recall.captures.retry'");
    expect(bindings).toContain("window.activateSettingsTab('credentials')");
    expect(css).toContain('.skills-cognition-source-state.is-degraded');
    expect(css).toContain('.recall-overview-pipeline');
    expect(skills).not.toContain('skills-cognition-stat-grid');

    expect(skills).toContain('recall-overview-attention');
    const inbox = sliceFunction(skills, 'renderSkillsCognitionInbox');
    expect(inbox).toContain('_renderCognitionOverviewAttention()');
    expect(inbox).toContain('cognition.inbox_empty');
    // 进度面板不在待我处理里。
    expect(inbox).not.toContain('_renderCognitionPipelineStatus');
    expect(inbox).not.toContain('_renderCognitionSourceStatus');
    expect(inbox).not.toContain('_renderCognitionCaptureStatus');
    expect(inbox).not.toContain('_renderCognitionRecentActivity');

    // 进度面板落在沉淀活动；来源健康度落在管理来源；最近变化落在我的资产。
    const captures = sliceFunction(skills, 'renderSkillsCognitionCaptures');
    expect(captures).toContain('_renderCognitionPipelineStatus()');
    expect(captures).toContain('_renderCognitionCaptureStatus()');
    expect(captures).toContain('includeProcessing: true');
    expect(sliceFunction(skills, 'renderSkillsCognitionSources')).toContain('_renderCognitionSourceStatus()');
    expect(sliceFunction(skills, 'renderSkillsCognitionAssets')).toContain('_renderCognitionRecentActivity()');
    expect(skills).toContain('data-cognition-open-asset');
  });

  /**
   * 落地规则只准作用一次、且只在初始化里：用户主动点「待我处理」时不得被
   * 弹到别处，否则空状态永远见不到，用户也无从区分"真的没事"和"页面坏了"。
   */
  it('only redirects away from an empty inbox on first landing, never on an explicit tab click', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const init = sliceFunction(skills, 'initSkillsCognitionConsole');
    expect(init).toContain('_cognitionInboxIsEmpty()');
    expect(init).toContain("switchSkillsCognitionPage('assets')");
    expect(sliceFunction(skills, 'switchSkillsCognitionPage')).not.toContain('_cognitionInboxIsEmpty');
  });

  it('routes the retired overview and about-me deep links into the new views', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const aliases = sliceFunction(skills, 'switchSkillsCognitionPage');
    expect(aliases).toContain("overview: 'inbox'");
    for (const legacy of ['brain', 'context', 'ontology']) {
      expect(aliases).toContain(`${legacy}: 'assets'`);
    }
    expect(skills).not.toContain('function renderSkillsCognitionOverview');
    expect(skills).not.toContain("getElementById('skills-cognition-overview-body')");
  });

  it('does not load internal Brain, Context Pack, or Ontology data for the four-page snapshot', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain("window.cogseed.invoke('recall.projections.list'");
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.groups.list'");
    expect(skills).not.toContain("window.cogseed.invoke('recall.views.list'");
  });

  it('ships the task shell and capture feedback in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const messages = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf-8'));
      for (const key of [
        'cognition.workspace_eyebrow',
        'cognition.task_views',
        'cognition.inbox_desc',
        'cognition.inbox_title',
        'cognition.inbox_confirm_now',
        'cognition.my_assets_desc',
        'cognition.assets_title',
        'cognition.proofs_desc',
        'cognition.proofs_title',
        'cognition.proofs_assets_covered',
        'cognition.governance_desc',
        'cognition.governance_title',
        'cognition.governance_use_control',
        'cognition.governance_asset_body',
        'cognition.source_status',
        'cognition.source_conversation',
        'cognition.source_artifact_file',
        'cognition.source_execution_evaluation',
        'cognition.source_user_teaching_signal',
        'cognition.source_authorized_external_system',
        'cognition.pipeline_title',
        'cognition.pipeline_sources',
        'cognition.pipeline_candidates',
        'cognition.pipeline_next_conversation',
        'cognition.pipeline_next_wait',
        'cognition.pipeline_next_review',
        'cognition.pipeline_next_retry',
        'cognition.pipeline_next_configure',
        'cognition.overview_metrics',
        'cognition.overview_active_tasks',
        'cognition.overview_skill_candidates',
        'cognition.overview_attention',
        'cognition.overview_attention_hint',
        'cognition.overview_model_required',
        'cognition.overview_failed_tasks',
        'cognition.overview_source_issues',
        'cognition.overview_recent_activity',
        'cognition.overview_activity_capture',
        'cognition.overview_activity_memory',
        'cognition.overview_activity_asset',
        'cognition.overview_activity_empty',
        'cognition.teaching_title',
        'cognition.teaching_pending',
        'cognition.teaching_revoked',
        'cognition.teaching_revoke',
        'cognition.capture_queued',
        'cognition.capture_waiting',
        'cognition.capture_extracting',
        'cognition.capture_writing',
        'cognition.capture_review_ready',
        'cognition.capture_no_candidate',
        'cognition.capture_configuration_required',
        'cognition.capture_failed',
        'cognition.capture_error_model_not_configured',
        'cognition.capture_error_model_auth_required',
        'cognition.capture_error_source_unavailable',
        'cognition.capture_error_recall_view_failed',
        'cognition.capture_error_model_failed',
        'cognition.capture_error_invalid_model_output',
        'cognition.capture_error_candidate_save_failed',
        'cognition.capture_error_asset_write_failed',
        'cognition.capture_error_asset_write_interrupted',
        'cognition.capture_stage_asset_write',
        'cognition.capture_review_title',
        'cognition.capture_review_hint',
        'cognition.capture_review_empty',
        'cognition.memory_content',
        'cognition.personal_memories_section',
        'cognition.personal_memories_section_hint',
        'cognition.ability_assets',
        'cognition.generate_skill',
        'cognition.add_to_skill_library',
        'cognition.skill_draft_title',
        'cognition.skill_draft_level_a_passed',
        'cognition.skill_draft_level_a_failed',
        'cognition.skill_draft_hint',
        'cognition.skill_created',
        'cognition.capture_error_unknown',
      ]) expect(messages[key]).toBeTruthy();
    }
  });

  // tab 切换只翻 pane 的 hidden 属性，而 .skills-cognition-page 自带 display，
  // 会盖掉 UA 的 [hidden]{display:none}。少了这条守卫，六个 pane 全部保留布局
  // 竖排在 overflow:hidden 的容器里，只有第一屏露出来，切 tab 像点不动。
  it('keeps hidden cognition panes out of the layout', () => {
    const guard = /\.skills-cognition-page\[hidden\][^{]*\{[^}]*display\s*:\s*none/;
    expect(guard.test(recallCss)).toBe(true);
    const match = recallCss.match(guard);
    expect(cssBraceDepthAt(recallCss, match!.index!)).toBe(0);
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
    const assetsStart = html.indexOf('data-cognition-page-body="assets"');
    expect(assetsStart).toBeGreaterThan(-1);
    expect(sectionStart).toBeGreaterThan(assetsStart);
    for (const id of ['personal-onto-nav', 'personal-onto-main-body', 'personal-onto-template-library-modal']) {
      const occurrences = [...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))];
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].index).toBeGreaterThan(sectionStart);
    }
  });

});
