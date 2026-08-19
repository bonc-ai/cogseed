import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/companion-repro.js'), 'utf8');

function loadModule() {
  const sandbox: any = {
    window: {},
    document: { addEventListener() {} },
    console,
    String,
    Array,
    t: (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ':' + JSON.stringify(vars) : ''}`,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] || c)),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'companion-repro.js' });
  return sandbox.window.CompanionRepro;
}

describe('companion repro renderer', () => {
  it('guides a natural-language request into missing setup steps', () => {
    const CompanionRepro = loadModule();
    const html = CompanionRepro.renderState({ draft: null });

    expect(html).toContain('companion.repro.guide.title');
    expect(html).toContain('companion.repro.guide.intent_first');
    expect(html).toContain('companion.repro.guide.need_import');
    expect(html).toContain('data-companion-repro-field="user_intent"');
  });

  it('preserves draft values in the guided form after refresh', () => {
    const CompanionRepro = loadModule();
    const html = CompanionRepro.renderState({
      draft: {
        paper_title: 'Tiny Paper',
        paper_selection: 'Selected experiment paragraph',
        repo_url: 'https://github.com/example/repo',
        commit: 'abc123',
        workspace_path: '/tmp/repo',
        user_intent: '帮我跑一下这篇论文对应的 GitHub 项目。',
      },
      reference_manifest: { included_files: [], skipped_files: [] },
    });

    expect(html).toContain('value="Tiny Paper"');
    expect(html).toContain('Selected experiment paragraph');
    expect(html).toContain('value="https://github.com/example/repo"');
    expect(html).toContain('帮我跑一下这篇论文对应的 GitHub 项目。');
    expect(html).toContain('companion.repro.guide.need_context');
  });

  it('renders guide messages as the visible interaction record', () => {
    const CompanionRepro = loadModule();
    const html = CompanionRepro.renderState({
      guide_messages: [
        { role: 'user', text: '帮我跑一下这篇论文对应的 GitHub 项目。' },
        { role: 'assistant', text: '请把论文选区贴过来。' },
      ],
    });
    expect(html).toContain('companion.repro.guide.history');
    expect(html).toContain('帮我跑一下这篇论文对应的 GitHub 项目。');
    expect(html).toContain('请把论文选区贴过来。');
    expect(html).toContain('companion-repro-guide-message is-user');
    expect(html).toContain('companion-repro-guide-message is-assistant');
  });

  it('detects natural paper repro requests from the normal chat composer', () => {
    const CompanionRepro = loadModule();
    expect(CompanionRepro.shouldHandleChatMessage('帮我跑一下这篇论文对应的 GitHub 项目。')).toBe(true);
    expect(CompanionRepro.shouldHandleChatMessage('今天天气怎么样')).toBe(false);
  });

  it('renders disabled execution before task contract confirmation', () => {
    const CompanionRepro = loadModule();
    const html = CompanionRepro.renderState({
      reference_manifest: { included_files: [{ path: 'README.md' }], skipped_files: [{ path: '.env', reason: 'sensitive' }] },
      project_context: { project_goal: 'Run minimal repro', tech_stack: ['Python'], uncertainties: ['README may differ'], review_decisions: [] },
      task_contract: { goal: 'Run it', success_criteria: ['exit 0'], plan: ['run sample'], risks: ['dependency mismatch'], confirmed_at: null },
    });

    expect(html).toContain('companion.repro.title');
    expect(html).toContain('README.md');
    expect(html).toContain('Python');
    expect(html).toContain('exit 0');
    expect(html).toContain('data-companion-repro-action="start" disabled');
  });

  it('enables execution after task contract confirmation', () => {
    const CompanionRepro = loadModule();
    const html = CompanionRepro.renderState({
      task_contract: { goal: 'Run it', success_criteria: [], plan: [], risks: [], confirmed_at: '2026-07-23T17:00:00' },
    });
    expect(html).toContain('data-companion-repro-action="start"');
    expect(html).not.toContain('data-companion-repro-action="start" disabled');
  });
});
