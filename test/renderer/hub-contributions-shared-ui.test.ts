import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const source = read('src/renderer/modules/hub-contributions.js');
const model = read('src/renderer/modules/hub-contributions-model.js');
const css = read('src/renderer/hub-contributions.css');
const style = read('src/renderer/style.css');
const html = read('src/renderer/index.html');
const zh = JSON.parse(read('src/renderer/locales/zh.json'));
const en = JSON.parse(read('src/renderer/locales/en.json'));

describe('Hub contribution pages: shared UI adoption', () => {
  it('builds every control from the shared seams', () => {
    for (const seam of [
      'uiButton', 'uiForm', 'uiField', 'uiCheckbox', 'uiInput', 'uiSegmentedControl', 'uiStatusPill', 'uiSkeleton',
      'uiEmptyState', 'uiModal', 'uiConfirm', 'uiConfirmDanger', 'uiPrompt', 'uiChoice', 'uiAlert', 'uiToast',
      'uiResourceCard', 'uiResourceGrid', 'uiIconHtml', 'hydrateUiFormSelects',
    ]) {
      expect(source).toContain(seam);
    }
    expect(source).toContain("kind: 'select'");
    expect(source).toContain("kind: 'textarea'");
    expect(source).not.toContain("id: 'contrib-security-manifest'");
  });

  it('does not introduce raw controls, inline SVG, emoji icons, literal z-index or page-local overlays', () => {
    expect(source).not.toMatch(/<button\b|<input\b|<textarea\b|<select\b|<dialog\b/i);
    expect(source).not.toMatch(/<svg\b|z-index\s*:/i);
    expect(source).not.toMatch(/modal-overlay|ui-dialog-overlay|createElement\(/);
    expect(model).not.toMatch(/<[a-z]/i);
    expect(html).not.toMatch(/id="skills-contribut[^"]*"[^>]*>\s*<(button|input)/);
  });

  it('uses only design tokens in the page stylesheet', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    for (const match of css.matchAll(/z-index\s*:\s*([^;}]+)/g)) expect(match[1].trim()).toMatch(/^var\(--z-/);
    expect(css).not.toMatch(/font-size\s*:\s*[\d.]+px/);
    expect(css).not.toMatch(/border-radius\s*:\s*[\d.]+px/);
    expect(css).toContain('var(--z-sticky)');
  });

  it('moves the old modal-era styles out of the shared stylesheet', () => {
    expect(style).not.toMatch(/\.contribution-(file|metadata|preview|declarations)/);
    expect(css).toContain('.hubc-steps');
    expect(css).toContain('.hubc-preview');
    expect(css).toContain('.hubc-master');
  });

  it('hosts both pages as same-level views of the Skills grid and detail views', () => {
    expect(html).toContain('id="skills-contribute-view"');
    expect(html).toContain('id="skills-contributions-view"');
    expect(html.indexOf('id="skills-contribute-view"')).toBeLessThan(html.indexOf('id="skills-detail-view"'));
    const skills = read('src/renderer/modules/skills.js');
    expect(skills.match(/window\.hideContributionViews\(\)/g)).toHaveLength(2);
    expect(read('src/renderer/modules/lazy-features.js')).toContain("{ src: './hub-contributions.css', type: 'style' }");
  });

  it('marks the active step for assistive technology and keeps the step list native', () => {
    expect(source).toContain('<ol class="hubc-steps"');
    expect(source).toContain('aria-current="step"');
    expect(source).toContain('ui-visually-hidden');
  });
});

describe('Hub contribution pages: behaviour contracts', () => {
  it('resumes the selected contribution only after the Hub login result succeeds', () => {
    expect(source).toContain("onPushEvent('hub-account:login-result'");
    expect(source).toContain("outcome?.result === 'success'");
    expect(source).toContain("root.cogseed.invoke('contribution.preflight'");
  });

  it('renders Hub terms through the canonical Markdown seam', () => {
    expect(source).toContain('renderMarkdown(terms.body_markdown)');
    expect(source).not.toContain("esc(terms.body_markdown).replace");
  });

  it('keeps cancellable local-check and upload progress ahead of any submission', () => {
    expect(source).toContain('defer_check: true');
    expect(source).toContain("'contribution.recheck'");
    expect(source).toContain("'contribution.cancel'");
    expect(source).toContain("'contribution.abortUpload'");
    // Upload has a single entry point, reached only through the declaration and digest confirmation step.
    expect(source.match(/invoke\('contribution\.submit'/g)).toHaveLength(1);
    expect(source.match(/await sendSubmission\(\)/g)).toHaveLength(1);
    expect(source.indexOf("'contribution.confirm'")).toBeLessThan(source.indexOf('await sendSubmission()'));
    expect(source).toContain("'contribution.confirm'");
    expect(source).toContain("submitted?.error?.retryable === true");
  });

  it('refreshes My contributions only while it is foregrounded', () => {
    expect(source).toContain('MINE_POLL_MS = 55_000');
    expect(source).toContain('viewVisible(\'mine\')');
    expect(source).toContain('stopMinePoll()');
  });

  it('derives statistics, filters and detail actions from the pure view model', () => {
    for (const fn of ['classifyAdmission', 'checkRows', 'normalizeItems', 'historyStats', 'filterHistory', 'detailActions']) {
      expect(model).toContain(fn);
    }
    expect(source).toContain('model.filterHistory(');
    expect(source).toContain('model.historyStats(');
  });
});

describe('Hub contribution pages: localization', () => {
  const literalKeys = Array.from(source.matchAll(/tr\('((?:skills|common)\.[a-z0-9_.]+)'/g)).map((match) => match[1]);

  it('defines every statically referenced key in both renderer locales', () => {
    expect(literalKeys.length).toBeGreaterThan(80);
    const missing = literalKeys.filter((key) => !(key in zh) || !(key in en));
    expect(missing).toEqual([]);
  });

  it('defines every key of the dynamic families the pages compose', () => {
    const families: Record<string, string[]> = {
      'skills.contribute_check_row': ['local', 'ruleset', 'scan', 'instruction', 'declaration'],
      'skills.contribute_check_state': ['ok', 'blocked', 'unavailable', 'skipped'],
      'skills.contribute_missing_item': ['origin', 'origin_note', 'terms', 'maintenance'],
      'skills.contribute_mine_filter': ['all', 'pending', 'rejected', 'published', 'withdrawal'],
      'skills.contribute_mine_msg': ['pending', 'returned', 'withdrawn', 'published', 'accepted'],
      'skills.contribute_origin': ['original', 'derived_from_hub', 'third_party'],
      'skills.contribute_lifecycle': ['disabled', 'withdrawn'],
      'skills.contribute_withdrawal_state': ['PENDING', 'REJECTED', 'WITHDRAWN'],
    };
    for (const [family, names] of Object.entries(families)) {
      for (const name of names) {
        expect(zh[`${family}.${name}`], `${family}.${name} (zh)`).toBeTruthy();
        expect(en[`${family}.${name}`], `${family}.${name} (en)`).toBeTruthy();
      }
    }
  });

  it('localizes every contribution status rendered by the shared status pill', () => {
    for (const status of ['PENDING', 'PENDING_REVIEW', 'PENDING_WITHDRAWAL', 'ACCEPTED', 'PUBLISHED', 'WITHDRAWN', 'APPROVED', 'RETURNED', 'REJECTED', 'FAILED', 'DISABLED', 'REPLACED']) {
      expect(zh[`skills.contribute_status.${status}`]).toBeTruthy();
      expect(en[`skills.contribute_status.${status}`]).toBeTruthy();
    }
  });

  it('re-renders both pages when the language changes', () => {
    expect(source).toContain("addEventListener('i18n-change', onLanguageChange)");
    expect(source).toContain('data-contribution-mine');
  });
});
