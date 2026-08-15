import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');
const recallCss = [
  fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8'),
  fs.readFileSync(path.join(__dirname, '../../src/renderer/recall-local.css'), 'utf-8'),
].join('\n');

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
  it('keeps Recall navigation focused on four user workflows', () => {
    for (const page of ['overview', 'captures', 'assets', 'sources']) {
      expect(html).toContain(`data-cognition-page="${page}"`);
      expect(html).toContain(`data-cognition-page-body="${page}"`);
    }
    for (const excluded of ['candidates', 'receipts', 'brain', 'context', 'ontology', 'kstar', 'evolution', 'capability']) {
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

  it('does not retain the retired personal-ontology selectors or event branch', () => {
    const bindings = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf-8');
    const tour = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/interactive-tour.js'), 'utf-8');

    expect(recallCss).not.toContain('#panel-personal-ontology');
    for (const removedNavStyle of [
      '.personal-onto-nav-row-meta',
      '.personal-onto-nav-template-head',
      '.personal-onto-nav-caret',
      '.personal-onto-nav-template-name',
      '.personal-onto-template-badge',
      '.personal-onto-template-install',
    ]) expect(recallCss).not.toContain(removedNavStyle);
    expect(bindings).not.toContain('[data-cognition-candidate-action]');
    expect(bindings).not.toContain('cognition.candidates.decide');
    expect(tour).not.toContain('[data-cognition-candidate-action]');
    expect(tour).toContain('[data-recall-candidate-action="promote"]');
    expect(tour).toContain('[data-cognition-page-link="captures"]');
  });

  it('keeps the original skill library as a sibling panel to Recall', () => {
    expect(html).toContain('id="recall-btn"');
    expect(html).toContain('id="panel-recall"');
    const skillsSectionStart = html.indexOf('id="panel-skills"');
    expect(skillsSectionStart).toBeGreaterThan(0);
    const skillsSectionEnd = html.indexOf('<!-- Agents -->');
    expect(skillsSectionEnd).toBeGreaterThan(skillsSectionStart);
    const skillsTabHtml = html.slice(skillsSectionStart, skillsSectionEnd);
    expect(skillsTabHtml).toContain('id="skills-grid-view"');
    expect(skillsTabHtml).toContain('id="create-skill-btn"');
    expect(skillsTabHtml).toContain('id="skills-more-btn"');
    expect(skillsTabHtml).toContain('id="skills-categories"');
    expect(skillsTabHtml).toContain('id="skills-grid"');
    expect(skillsTabHtml).toContain('id="skills-detail-view"');
    expect(skillsTabHtml).toContain('id="skills-chat-input"');
    expect(skillsTabHtml).not.toContain('data-cognition-page-body');
  });

  it('routes and lazy-loads Skills and Recall as separate primary views', () => {
    const boot = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
    const state = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf-8');
    const lazy = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/lazy-features.js'), 'utf-8');
    expect(state).toContain("_setViewFromSidebar('skills')");
    expect(state).toContain("_setViewFromSidebar('recall')");
    expect(boot).toContain("view === 'skills' ? 'panel-skills'");
    expect(boot).toContain("view === 'recall' ? 'panel-recall'");
    expect(boot).toContain("_loadViewFeature('recall', 'recall'");
    expect(lazy).toMatch(/recall:\s*\[[\s\S]*?\{ src: '\.\/modules\/skills\.js' \}/);
  });

  it('wraps the top navigation and pages in one integrated workspace', () => {
    expect(html).toContain('class="skills-cognition-surface"');
    const surfaceStart = html.indexOf('class="skills-cognition-surface"');
    const surfaceEnd = html.indexOf('<!-- Skills -->');
    expect(surfaceStart).toBeGreaterThan(0);
    expect(surfaceEnd).toBeGreaterThan(surfaceStart);
    const surfaceHtml = html.slice(surfaceStart, surfaceEnd);
    expect(surfaceHtml).toContain('class="skills-cognition-header"');
    expect(surfaceHtml).toContain('class="skills-cognition-workspace"');
    expect(surfaceHtml).toContain('class="skills-cognition-main"');
    expect(surfaceHtml).toContain('id="skills-cognition-tabs"');
    expect(surfaceHtml).toContain('id="skills-cognition-assets"');
    const summaryOffset = surfaceHtml.indexOf('id="skills-cognition-assets-summary"');
    const ontologyOffset = surfaceHtml.indexOf('id="skills-cognition-personal-ontology"');
    const formalAssetsOffset = surfaceHtml.indexOf('id="skills-cognition-formal-assets"');
    expect(summaryOffset).toBeGreaterThan(0);
    expect(ontologyOffset).toBeGreaterThan(summaryOffset);
    expect(formalAssetsOffset).toBeGreaterThan(ontologyOffset);
  });

  it('places Recall navigation in a horizontal top bar', () => {
    const css = recallCss;
    expect(css).toMatch(/\.skills-cognition-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(css).toMatch(/\.skills-cognition-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*border-bottom:/s);
    expect(css).toMatch(/\.skills-cognition-tab-group\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
    expect(css).toMatch(/\.skills-cognition-tab-group-label\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.skills-cognition-tab\.is-active\s*\{[^}]*inset 0 -2px 0/s);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tabs\s*\{[^}]*flex-wrap:\s*nowrap;/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tab \.ui-icon\s*\{[^}]*display:\s*none;/);
  });


  it('keeps the Recall workspace rules outside narrow-screen media queries', () => {
    const css = recallCss;
    const recallRules = css.indexOf('/* Recall cognition console. */');
    expect(recallRules).toBeGreaterThan(0);
    expect(cssBraceDepthAt(css, recallRules)).toBe(0);
  });

  it('keeps review inside capture tasks and exposes memory content as one page', () => {
    expect(html).not.toContain('data-i18n="cognition.candidate_review"');
    expect(html).toContain('data-i18n="cognition.memory_content"');
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

  it('scrolls the combined page while keeping the formal memory list independently scrollable on desktop', () => {
    const css = recallCss;
    const desktopStart = css.indexOf('@media (min-width: 901px)');
    const desktopEnd = css.indexOf('@media (max-width: 900px)', desktopStart);
    const desktopRules = css.slice(desktopStart, desktopEnd);
    expect(desktopRules).toContain('#skills-cognition-assets { overflow-x: hidden; overflow-y: auto; }');
    expect(desktopRules).toContain('#skills-cognition-assets-body { height: min(620px, calc(100vh - 184px)); min-height: 520px; }');
    expect(desktopRules).toMatch(/\.ability-asset-list-body\s*\{[\s\S]*overflow-y:\s*auto;/);
    expect(desktopRules).toMatch(/\.ability-asset-detail\s*\{[\s\S]*height:\s*100%;/);
    expect(desktopRules).toContain('overscroll-behavior: contain');
  });

  it('keeps the cognition asset header compact and removes the personal tag surface', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf-8'));
    expect(html).toContain('<h1 data-i18n="cognition.title">认知资产</h1>');
    expect(zh['cognition.title']).toBe('认知资产');
    expect(recallCss).toMatch(/\.skills-cognition-header\s*\{[^}]*min-height:\s*48px;[^}]*padding:\s*6px 20px;/s);
    expect(recallCss).toMatch(/\.skills-cognition-header h1\s*\{[^}]*font-size:\s*16px;/s);
    expect(recallCss).not.toContain('.ability-profile-');
    expect(recallCss).not.toContain('.ability-personal-memory-');
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.profile.summary'");
    expect(skills).not.toContain('data-personal-ontology-manage');
  });

  it('shows source health and conversation capture next actions in the existing overview', () => {
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
    expect(skills).toContain('skills-cognition-overview');
    expect(skills).toContain('recall-overview-metrics');
    expect(skills).toContain('recall-overview-metric');
    expect(skills).toContain('recall-overview-attention');
    expect(skills).toContain('recall-overview-activity');
    expect(skills).toContain('data-cognition-open-asset');
    expect(skills).toContain('recall-overview-operation-grid');
    expect(skills).not.toContain('skills-cognition-stat-grid');
    expect(css).toContain('.recall-overview-pipeline');
  });

  it('does not load internal Brain, Context Pack, or Ontology data for the four-page snapshot', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    expect(skills).not.toContain("window.cogseed.invoke('recall.projections.list'");
    expect(skills).not.toContain("window.cogseed.invoke('personalOntology.groups.list'");
    expect(skills).not.toContain("window.cogseed.invoke('recall.views.list'");
  });

  it('ships capture feedback in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const messages = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf-8'));
      for (const key of [
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
        'cognition.personal_ontology_section',
        'cognition.personal_ontology_section_hint',
        'cognition.personal_memories_section',
        'cognition.personal_memories_section_hint',
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

});
