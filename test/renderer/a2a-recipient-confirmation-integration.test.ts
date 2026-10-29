import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function runPageFixture(scenario = '') {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [resolve(__dirname, 'fixtures/a2a-recipient-confirmation.cjs'), scenario], {
      env, encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL',
    });
    expect(result.status, `${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const line = String(result.stdout).trim().split('\n').filter(Boolean).pop();
    // 没拿到结果就直接带上子进程输出失败：以前回落到 `{}`，Windows 上 stdout 为空
    // 只会表现为 `output.checks` / `output.requests` 是 undefined，看不出是
    // 「fixture 没产出结果」还是「断言写错」。
    expect(line, `fixture produced no JSON result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeTruthy();
    const output = JSON.parse(String(line));
    expect(output.error).toBeUndefined();
    return output;
}

describe('D2 recipient confirmation on the production conversation page', () => {
  it('uses the real shared modal, selector, draft atoms and preload without implicit dispatch', () => {
    const output = runPageFixture();
    expect(output.checks.length).toBeGreaterThanOrEqual(20);
    expect(output.requests.map((request: any) => request.channel)).toEqual([
      'a2a.conversation.prepare', 'a2a.question.send',
    ]);
    expect(output.requests[1].payload).toMatchObject({ contactUserId: 'cs_bob_2', text: 'hello', mode: 'new' });
  }, 50000);

  it.each(['picker-conversation', 'typed-conversation', 'picker-new-chat', 'typed-new-chat'])(
    'keeps external recipients draft-only through real %s selection, successful send and local follow-up', (scenario) => {
      const output = runPageFixture(scenario);
      expect(output.requests.map((request: any) => request.channel)).toEqual([
        'a2a.conversation.prepare', 'a2a.question.send',
      ]);
      expect(output.requests[1].payload).toMatchObject({
        contactUserId: 'cs_bob', text: 'hello again',
        mode: scenario.endsWith('new-chat') ? 'new' : 'continue',
        ...(scenario.endsWith('new-chat') ? {} : { conversationId: 'd2-other' }),
      });
      expect(output.checks).toContain('no contact identity is persisted as a local member');
      expect(output.checks).toContain('local picker still routes the stable local member');
    }, 50000,
  );

  it.each(['local-conversation', 'local-new-chat'])(
    'preserves a trailing-space local confirmation identity through the real %s entry', (scenario) => {
      const output = runPageFixture(scenario);
      expect(output.requests.map((request: any) => request.channel)).toEqual(['conversations.sendStream']);
      const payload = output.requests[0].payload;
      expect(payload).toMatchObject({
        cid: scenario === 'local-new-chat' ? 'd2-local-created' : 'd2-other',
        content: 'hello @Bob', mention_agent_ids: ['local-bob'],
      });
      expect(payload).not.toHaveProperty('member_agent_ids');
      expect(payload).not.toHaveProperty('recipient_agent_id');
      expect(output.checks).toContain('local confirmation never persists membership after send');
    }, 50000,
  );
});
