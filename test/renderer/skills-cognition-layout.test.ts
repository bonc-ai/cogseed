import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf-8');

describe('Recall cognition workspace layout', () => {
  it('exposes the complete Recall workspace without KSTAR, Evolution, or Capability pages', () => {
    for (const page of ['overview', 'sources', 'captures', 'brain', 'context', 'ontology', 'candidates', 'assets', 'receipts']) {
      expect(html).toContain(`data-cognition-page="${page}"`);
      expect(html).toContain(`data-cognition-page-body="${page}"`);
    }
    for (const excluded of ['kstar', 'evolution', 'capability']) {
      expect(html).not.toContain(`data-cognition-page="${excluded}"`);
    }
    for (const group of ['cognition.nav_flow', 'cognition.nav_structure', 'cognition.nav_governance']) {
      expect(html).toContain(`data-i18n="${group}"`);
    }
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
    expect(lazy).toMatch(/recall:\s*\[\s*\{ src: '\.\/modules\/skills\.js' \}/);
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
  });

  it('places Recall navigation in a horizontal top bar', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8');
    expect(css).toMatch(/\.skills-cognition-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(css).toMatch(/\.skills-cognition-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*border-bottom:/s);
    expect(css).toMatch(/\.skills-cognition-tab-group\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
    expect(css).toMatch(/\.skills-cognition-tab-group-label\s*\{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.skills-cognition-tab\.is-active\s*\{[^}]*inset 0 -2px 0/s);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tabs\s*\{[^}]*flex-wrap:\s*nowrap;/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.skills-cognition-surface \.skills-cognition-tab \.ui-icon\s*\{[^}]*display:\s*none;/);
  });


  it('uses PRD page semantics for cognition candidates and ability assets', () => {
    expect(html).toContain('data-i18n="cognition.candidate_review"');
    expect(html).toContain('data-i18n="cognition.formal_assets"');
    expect(html).toContain('data-ability-assets-view="list"');
    expect(html).toContain('data-ability-assets-view="tree"');
    expect(html).not.toContain('data-ability-assets-view="evidence"');
    expect(html).toContain('data-ability-assets-view-panel="list"');
    expect(html).toContain('data-ability-assets-view-panel="tree"');
    expect(html).not.toContain('data-ability-assets-view-panel="evidence"');
  });


  it('keeps ability asset status chips compact inside list rows', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8');
    expect(css).toContain('.ability-asset-list-row .skills-cognition-status');
    expect(css).toContain('align-self: start');
    expect(css).toContain('height: fit-content');
  });

  it('shows source health and conversation capture next actions in the existing overview', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    const bindings = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf-8');
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf-8');

    expect(skills).toContain("window.orkas.invoke('recall.sources.list'");
    expect(skills).toContain("window.orkas.invoke('recall.captures.list'");
    expect(skills).toContain('skills-cognition-source-row');
    expect(skills).toContain('skills-cognition-capture-row');
    expect(skills).toContain('data-cognition-page-link="candidates"');
    expect(skills).toContain('data-recall-capture-retry');
    expect(skills).toContain('data-recall-capture-settings');
    expect(bindings).toContain("window.orkas.invoke('recall.captures.retry'");
    expect(bindings).toContain("window.activateSettingsTab('credentials')");
    expect(css).toContain('.skills-cognition-source-state.is-degraded');
  });

  it('provides full source, Brain, Context Pack, and Ontology renderer surfaces', () => {
    const skills = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf-8');
    for (const renderer of ['renderSkillsCognitionSources', 'renderSkillsCognitionBrain', 'renderSkillsCognitionContext', 'renderSkillsCognitionOntology']) {
      expect(skills).toContain(`function ${renderer}`);
    }
    expect(skills).toContain("window.orkas.invoke('recall.projections.list'");
    expect(skills).toContain("window.orkas.invoke('personalOntology.groups.list'");
    expect(skills).toContain("window.orkas.invoke('personalOntology.groups.read'");
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
        'cognition.teaching_title',
        'cognition.teaching_pending',
        'cognition.teaching_revoked',
        'cognition.teaching_revoke',
        'cognition.capture_queued',
        'cognition.capture_extracting',
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
        'cognition.capture_error_unknown',
      ]) expect(messages[key]).toBeTruthy();
    }
  });

});
