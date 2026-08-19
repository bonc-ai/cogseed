import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readClaudeSessionTranscript } from '../../../src/main/features/local_agents/claude_sessions';

const prevHome = process.env.HOME;
const tmpDirs: string[] = [];

/** The reader sandboxes to `~/.claude/projects`, so tests must relocate HOME. */
function mkProjectsHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-claude-tx-'));
  tmpDirs.push(home);
  process.env.HOME = home;
  const dir = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function turn(i: number, role: 'user' | 'assistant'): string {
  return JSON.stringify({
    type: role,
    message: { role, content: [{ type: 'text', text: `turn ${i}` }] },
  });
}

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('claude transcript streaming reader', () => {
  it('reads a small transcript whole without flagging truncation', async () => {
    const dir = mkProjectsHome();
    const file = path.join(dir, 'small.jsonl');
    fs.writeFileSync(file, [turn(1, 'user'), turn(2, 'assistant')].join('\n') + '\n');

    const res = await readClaudeSessionTranscript(file);

    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('small');
    expect(res.truncated).toBeFalsy();
    expect(res.body.trim().split('\n')).toHaveLength(2);
  });

  it('does not truncate a many-turn transcript that stays under the size threshold', async () => {
    const dir = mkProjectsHome();
    const file = path.join(dir, 'many.jsonl');
    const total = 2600;
    fs.writeFileSync(
      file,
      Array.from({ length: total }, (_, i) => turn(i, i % 2 ? 'assistant' : 'user')).join('\n') +
        '\n',
    );

    const res = await readClaudeSessionTranscript(file);

    expect(res.ok).toBe(true);
    expect(res.truncated).toBeFalsy();
    expect(res.body.trim().split('\n')).toHaveLength(total);
  });

  it('keeps only the most recent lines once the transcript passes the size threshold', async () => {
    const dir = mkProjectsHome();
    const file = path.join(dir, 'huge.jsonl');

    // Cross the 50MB threshold with fat lines so the file stays cheap to write
    // while still exercising the real size gate.
    const total = 1300;
    const filler = 'x'.repeat(42 * 1024);
    const out = fs.createWriteStream(file);
    for (let i = 0; i < total; i++) {
      const role = i % 2 ? 'assistant' : 'user';
      const line = JSON.stringify({
        type: role,
        message: { role, content: [{ type: 'text', text: `turn ${i} ${filler}` }] },
      });
      if (!out.write(line + '\n')) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    expect(fs.statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);

    const res = await readClaudeSessionTranscript(file);

    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(1000);

    // Truncation must drop the oldest turns and keep the newest, and every
    // surviving line must still parse — the body is fed to a JSONL parser.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.message.content[0].text.startsWith(`turn ${total - 1} `)).toBe(true);
    const first = JSON.parse(lines[0]);
    expect(first.message.content[0].text.startsWith(`turn ${total - 1000} `)).toBe(true);
  });

  it('skips blank lines rather than emitting unparsable body lines', async () => {
    const dir = mkProjectsHome();
    const file = path.join(dir, 'gaps.jsonl');
    fs.writeFileSync(file, `${turn(1, 'user')}\n\n   \n${turn(2, 'assistant')}\n`);

    const res = await readClaudeSessionTranscript(file);

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('reports a missing file instead of throwing', async () => {
    const dir = mkProjectsHome();

    const res = await readClaudeSessionTranscript(path.join(dir, 'nope.jsonl'));

    expect(res.ok).toBe(false);
    expect(res.body).toBe('');
  });

  it('rejects reads outside the projects root', async () => {
    mkProjectsHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-claude-out-'));
    tmpDirs.push(outside);
    const file = path.join(outside, 'evil.jsonl');
    fs.writeFileSync(file, turn(1, 'user') + '\n');

    const res = await readClaudeSessionTranscript(file);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('out_of_bounds');
    expect(res.body).toBe('');
  });
});
