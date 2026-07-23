import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('function _collaborationCount');
const end = conversationSource.indexOf('\nfunction _ensureCreateAgentInlineObserver', start);
const collaborationStatusSource = conversationSource.slice(start, end);

function render(snapshot: any): string {
  const sandbox: any = {
    Number,
    String,
    Array,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c] || c)),
    t: (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ':' + JSON.stringify(vars) : ''}`,
  };
  vm.runInNewContext(collaborationStatusSource, sandbox, { filename: 'conversation-collaboration-status.js' });
  return sandbox._renderCollaborationStatusHtml(snapshot);
}

function mount(snapshot: any): { container: any; sandbox: any } {
  const removed: any[] = [];
  const existingCard: any = {
    parentElement: { removeChild: (node: any) => removed.push(node) },
  };
  const container: any = {
    firstChild: { kind: 'first' },
    querySelector: (selector: string) => selector === '.chat-collaboration-status' ? existingCard : null,
    insertBefore: () => { throw new Error('collaboration status card should not be inserted'); },
  };
  const sandbox: any = {
    Number,
    String,
    Array,
    document: { createElement: () => ({ querySelectorAll: () => [], dataset: {} }) },
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => `${key}${vars ? ':' + JSON.stringify(vars) : ''}`,
  };
  vm.runInNewContext(collaborationStatusSource, sandbox, { filename: 'conversation-collaboration-status.js' });
  sandbox._mountCollaborationStatusCard(container, snapshot);
  container.removed = removed;
  return { container, sandbox };
}

describe('conversation collaboration status card', () => {
  it('renders workflow status, step progress, and shared context counts', () => {
    const html = render({
      run_id: 'wf-1',
      objective: 'Coordinate Hermes and Codex',
      status: 'running',
      phase: 'dispatch',
      facts_count: 2,
      decisions_count: 1,
      risks_count: 1,
      open_questions_count: 3,
      artifacts_count: 0,
      steps: [
        { title: 'Ask Hermes', status: 'completed' },
        { title: 'Ask Codex', status: 'running' },
      ],
      facts_preview: [{ text: 'Shared file POC works' }],
      decisions_preview: [{ text: 'Use SharedTaskContext', reason: 'It is local and syncable' }],
      risks_preview: [{ text: 'Concurrent writes', severity: 'medium' }],
      open_questions_preview: [{ text: 'Should gates block later?' }],
      artifacts_preview: [{ type: 'note', summary: 'Tutti research' }],
      recent_events: [{ type: 'context_patch_applied', summary: 'Added state' }],
      blocking_gate: { id: 'wgate-1', name: 'human_review', status: 'needs_review' },
      gates: [{ name: 'human_review', status: 'needs_review', reason: 'Needs approval' }],
    });

    expect(html).toContain('chat.collaboration.title');
    expect(html).toContain('Coordinate Hermes and Codex');
    expect(html).toContain('chat.collaboration.status.running');
    expect(html).toContain('chat.collaboration.steps');
    expect(html).toContain('&quot;completed&quot;:1');
    expect(html).toContain('&quot;running&quot;:1');
    expect(html).toContain('chat.collaboration.counts.open_questions');
    expect(html).toContain('Ask Codex');
    expect(html).toContain('chat.collaboration.details');
    expect(html).toContain('chat.collaboration.detail.steps');
    expect(html).toContain('Ask Hermes (completed)');
    expect(html).toContain('chat.collaboration.detail.gates');
    expect(html).toContain('human_review (needs_review) — Needs approval');
    expect(html).toContain('Shared file POC works');
    expect(html).toContain('Use SharedTaskContext — It is local and syncable');
    expect(html).toContain('Concurrent writes (medium)');
    expect(html).toContain('Should gates block later?');
    expect(html).toContain('note: Tutti research');
    expect(html).toContain('context_patch_applied: Added state');
    expect(html).toContain('chat.collaboration.gate_blocked');
    expect(html).toContain('data-collaboration-gate-review="approve"');
    expect(html).toContain('data-collaboration-gate-review="reject"');
  });

  it('returns an empty string when no collaboration snapshot is present', () => {
    expect(render(null)).toBe('');
  });

  it('does not mount the dispatch status card into chat history', () => {
    const { container, sandbox } = mount({ run_id: 'wf-1', status: 'running', steps: [] });
    expect(sandbox._latestCollaborationSnapshot).toEqual({ run_id: 'wf-1', status: 'running', steps: [] });
    expect(container.removed).toHaveLength(1);
  });
});
