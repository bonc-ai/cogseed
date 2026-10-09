import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listClaudeSessions } from '../../../../src/main/features/local_agents/claude_sessions';
import { listWorkbuddySessions } from '../../../../src/main/features/local_agents/workbuddy_sessions';

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-session-recency-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('local session recency', () => {
  it('uses the latest Claude Code event while keeping the opening prompt as the title', async () => {
    const home = makeHome();
    const file = path.join(home, '.claude', 'projects', 'demo', 'session.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T09:00:00Z', cwd: '/demo', message: { role: 'user', content: 'opening prompt' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-02T11:30:00Z', message: { role: 'assistant', content: [] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-02T12:00:00Z', cwd: '/demo', message: { role: 'user', content: 'follow-up' } }),
    ].join('\n'));

    const [session] = await listClaudeSessions(home);

    expect(session.firstMessage).toBe('opening prompt');
    expect(session.timestamp).toBe('2026-08-01T09:00:00.000Z');
    expect(session.lastActivityAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('uses the latest WorkBuddy event while keeping the opening query as the title', async () => {
    const home = makeHome();
    const file = path.join(home, '.workbuddy', 'projects', 'Users-demo', 'session.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'message', role: 'user', timestamp: 1785546000000, content: [{ type: 'input_text', text: 'opening query' }] }),
      JSON.stringify({ type: 'message', role: 'assistant', timestamp: 1785636000000, content: [{ type: 'text', text: 'answer' }] }),
      JSON.stringify({ type: 'message', role: 'user', timestamp: 1785643200000, content: [{ type: 'input_text', text: 'follow-up' }] }),
    ].join('\n'));

    const [session] = await listWorkbuddySessions(home);

    expect(session.firstMessage).toBe('opening query');
    expect(session.lastActivityAt).toBe(new Date(1785643200000).toISOString());
  });
});
