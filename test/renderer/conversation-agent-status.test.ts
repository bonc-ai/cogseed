import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('let _agentStatusPopover');
const end = conversationSource.indexOf('\nfunction _bindChatHeaderActions', start);
const agentStatusSource = conversationSource.slice(start, end);

function render(snapshot: any): string {
  const sandbox: any = {
    Array,
    Math,
    Set,
    String,
    window: { innerWidth: 1024, innerHeight: 768 },
    document: { getElementById: () => null },
    _groupMembersCache: new Map(),
    _membersRequestUrl: (cid: string) => `/members/${cid}`,
    _commanderAvatar: () => ({ icon: 'bot', color: 'slate' }),
    _normaliseActiveTurns: (raw: any[]) => Array.isArray(raw)
      ? raw.map((t) => ({ actor: String(t.actor || ''), turn_id: String(t.turn_id || ''), msg_id: '', started_at_ms: 1 })).filter((t) => t.actor && t.turn_id)
      : [],
    renderAvatarHtml: (_icon: string, _color: string, opts: any) => `<span class="avatar" data-seed="${opts.seed}"></span>`,
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c] || c)),
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'chat.agent_status.title': 'Agent status',
        'chat.agent_status.summary': `${vars?.running} running · ${vars?.agents} agents`,
        'chat.agent_status.source_note': 'runtime-backed status',
        'chat.agent_status.kind.commander': 'Commander',
        'chat.agent_status.kind.agent': 'Agent',
        'chat.agent_status.state.running': 'Running',
        'chat.agent_status.state.active': 'Current recipient',
        'chat.agent_status.state.joined': 'Joined',
        'chat.agent_status.turn_id': `turn ${vars?.id}`,
        'chat.agent_status.floor': 'receives next message',
        'chat.agent_status.empty': 'No agents',
        'common.close': 'Close',
      };
      return dict[key] || key;
    },
  };
  vm.runInNewContext(agentStatusSource, sandbox, { filename: 'conversation-agent-status.js' });
  return sandbox._renderAgentStatusPanelHtml(snapshot);
}

describe('conversation agent status panel', () => {
  it('marks agents running only from runtime in_flight / active_turns', () => {
    const html = render({
      actors: [
        { kind: 'commander', id: 'commander', name: 'Commander' },
        { kind: 'agent', id: 'deep', name: 'DeepResearcher' },
        { kind: 'agent', id: 'writer', name: 'ContentWriter' },
      ],
      runtime: {
        in_flight: ['deep'],
        active_turns: [{ actor: 'deep', turn_id: 'turn-1' }],
        active_recipient: 'writer',
      },
    });

    expect(html).toContain('1 running · 2 agents');
    expect(html).toContain('runtime-backed status');
    expect(html).toContain('DeepResearcher');
    expect(html).toContain('data-agent-status-actor="deep"');
    expect(html).toContain('agent-status-pill is-running');
    expect(html).toContain('turn turn-1');
    expect(html).toContain('ContentWriter');
    expect(html).toContain('agent-status-pill is-active');
    expect(html).toContain('receives next message');
  });

  it('shows joined instead of running when dispatch was only claimed in text', () => {
    const html = render({
      actors: [{ kind: 'agent', id: 'deep', name: 'DeepResearcher' }],
      runtime: { in_flight: [], active_turns: [] },
    });

    expect(html).toContain('0 running · 1 agents');
    expect(html).toContain('DeepResearcher');
    expect(html).toContain('agent-status-pill is-joined');
    expect(html).not.toContain('agent-status-pill is-running');
  });

  it('shows runtime-only actors even before members refresh catches up', () => {
    const html = render({
      actors: [{ kind: 'commander', id: 'commander', name: 'Commander' }],
      runtime: {
        in_flight: ['deep'],
        active_turns: [{ actor: 'deep', turn_id: 'turn-runtime' }],
      },
    });

    expect(html).toContain('1 running · 1 agents');
    expect(html).toContain('deep');
    expect(html).toContain('data-agent-status-actor="deep"');
    expect(html).toContain('agent-status-pill is-running');
    expect(html).toContain('turn turn-runtime');
  });

});
