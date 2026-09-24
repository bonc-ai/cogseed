// 首页提交保护（FR-016 / SC-004；验收报告 MA-04）。
//
// 真机/隔离复现：模型检查尚未返回时连续两次提交（双击发送键或连按 Enter），
// 会产生 **2 次会话创建请求**——首个 await 之前没有 in-flight 保护，禁用按钮又
// 发生得太晚，两个不同 cid 各自带不同幂等身份，后端无法按同会话去重补救。
//
// 这里直接跑真实的 handleNewChatSubmit（从源码抽取），把提交主体替换成可控挂起
// 的 promise，验证：并发只进一次、失败后可恢复、空输入不占锁。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0 ? source.indexOf(asyncMarker) : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

interface Harness {
  submit: () => Promise<void>;
  innerCalls: () => number;
  release: () => void;
  failNext: (error: Error) => void;
  setValue: (value: string) => void;
}

function createHarness(): Harness {
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let innerCalls = 0;
  let nextError: Error | null = null;
  const input = { value: '把这次的材料整理成报告' };

  const sandbox: Record<string, any> = {
    console,
    document: { getElementById: (id: string) => (id === 'new-chat-input' ? input : null) },
    _convLog: { warn: () => {}, info: () => {}, error: () => {} },
    DRAFT_CID: 'new-chat',
    t: (key: string) => key,
    uiAlert: async () => {},
    _getQuotes: () => [],
    _chatAttachList: () => [],
    unresolvedOssTemplatePlaceholder: () => false,
    composerMembers: {
      // 只识别本用例会出现的两个名字（真实实现见 composer-members.js）。
      mentionTokensForTarget: (_target: string, text: string) => {
        const out: Array<{ start: number; end: number }> = [];
        const re = /@(Codex|集成验证Agent)\s?/g;
        let hit: RegExpExecArray | null;
        const src = String(text || '');
        while ((hit = re.exec(src))) out.push({ start: hit.index, end: hit.index + hit[0].length });
        return out;
      },
    },
    _submitNewChatIntent: () => {
      innerCalls += 1;
      if (nextError) {
        const error = nextError;
        nextError = null;
        return Promise.reject(error);
      }
      return new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 模块级在途标志与真实函数一起注入（extractFunction 只抽函数体）。
  vm.runInContext(
    `let _newChatSubmitInFlight = false;\n${extractFunction('_hasTaskIntent')}\n${extractFunction('handleNewChatSubmit')}`,
    sandbox,
    { filename: 'conversation-submit-guard.js' },
  );

  return {
    submit: () => vm.runInContext('handleNewChatSubmit()', sandbox),
    innerCalls: () => innerCalls,
    release: () => { pending.splice(0).forEach((item) => item.resolve()); },
    failNext: (error: Error) => { nextError = error; },
    setValue: (value: string) => { input.value = value; },
  };
}

describe('new-chat submit guard (MA-04)', () => {
  it('两次并发提交只进入一次提交主体（不会创建两个会话）', async () => {
    const h = createHarness();
    const first = h.submit();
    const second = h.submit();
    await Promise.resolve();
    expect(h.innerCalls()).toBe(1);
    h.release();
    await Promise.all([first, second]);
    expect(h.innerCalls()).toBe(1);
  });

  it('提交完成后可以再次提交（连续任务不受影响）', async () => {
    const h = createHarness();
    const first = h.submit();
    await Promise.resolve();
    h.release();
    await first;
    const second = h.submit();
    await Promise.resolve();
    expect(h.innerCalls()).toBe(2);
    h.release();
    await second;
  });

  it('提交失败后锁被释放，用户可以改完草稿立即重试', async () => {
    const h = createHarness();
    h.failNext(new Error('create failed'));
    await h.submit();
    const retry = h.submit();
    await Promise.resolve();
    expect(h.innerCalls()).toBe(2);
    h.release();
    await retry;
  });

  it('仅 @ 成员 / 仅标点 / 空白都不进入提交主体（MA-08）', async () => {
    const h = createHarness();
    h.setValue('@Codex @集成验证Agent ');
    await h.submit();
    expect(h.innerCalls()).toBe(0);
    h.setValue('，。！？');
    await h.submit();
    expect(h.innerCalls()).toBe(0);
    h.setValue('   ');
    await h.submit();
    expect(h.innerCalls()).toBe(0);
    // 有任务文字则照常提交。
    h.setValue('@Codex 帮我核对这份材料');
    const submit = h.submit();
    await Promise.resolve();
    expect(h.innerCalls()).toBe(1);
    h.release();
    await submit;
  });

  it('空输入不占锁：清空正文后的有效提交仍然生效', async () => {
    const h = createHarness();
    h.setValue('   ');
    await h.submit();
    expect(h.innerCalls()).toBe(0);
    h.setValue('真正要做的事');
    const submit = h.submit();
    await Promise.resolve();
    expect(h.innerCalls()).toBe(1);
    h.release();
    await submit;
  });
});
