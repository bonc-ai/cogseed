import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseClaudeSessionFile } from '../../../src/main/features/local_agents/import_sessions';

describe('local-agents import_sessions', () => {
  it('parses new-format Claude jsonl (string content) into ordered rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-sess-'));
    const f = path.join(dir, 'abc123.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'abc123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我写一个方案' }, timestamp: '2026-08-01T10:00:00' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '好的，方案如下…' }, timestamp: '2026-08-01T10:00:05' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '再改一下' }] }, timestamp: '2026-08-01T10:01:00' }),
    ].join('\n'), 'utf8');

    const rows = await parseClaudeSessionFile(f);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ role: 'user', text: '帮我写一个方案', ts: '2026-08-01T10:00:00' });
    expect(rows[1]).toEqual({ role: 'assistant', text: '好的，方案如下…', ts: '2026-08-01T10:00:05' });
    // array content block + ts inheritance
    expect(rows[2]).toEqual({ role: 'user', text: '再改一下', ts: '2026-08-01T10:01:00' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips metadata lines and empty text, keeps row order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-sess-'));
    const f = path.join(dir, 'def456.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'def456' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: [] }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '' }, timestamp: '2026-08-01T11:00:00' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '   ' }, timestamp: '2026-08-01T11:00:01' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '有效消息' }, timestamp: '2026-08-01T11:00:02' }),
    ].join('\n'), 'utf8');

    const rows = await parseClaudeSessionFile(f);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('有效消息');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for malformed file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-sess-'));
    const f = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(f, 'not json\n{ broken\n', 'utf8');
    const rows = await parseClaudeSessionFile(f);
    expect(rows).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
