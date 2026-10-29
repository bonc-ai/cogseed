/**
 * transcript-glossary-tools — agent 工具层（会议工作流的"转写 → 纠错"）
 *
 * 这组工具是把**已经存在**的纠错引擎接给 agent 的唯一入口。此前引擎只经
 * `ipc/transcript.ts` 暴露给纠错面板（人点的），agent 调不到，所以会议流程里
 * 断在"取到转写"这一步。
 *
 * 重点覆盖（对齐 AGENTS「测业务不变量、恢复路径、文本陷阱」）：
 *   - 风险面契约：`low` 自动应用、`high` 一律不应用且必须上报待确认；
 *   - **待确认不得静默**：`pendingTotal` 必须如实透出（否则 agent 会直接出纪要）；
 *   - 词表为空时必须显式说明"没纠"，不能返回"看起来成功"的空结果；
 *   - 引擎的分级/校验不被工具层放宽（工具只是传参，不是第二套判断）。
 *
 * 数据隔离：`test/setup-env.ts` 已把 `COGSEED_WORKSPACE_ROOT` 指向本次运行的
 * 临时目录，因此这里的 `upsertEntry` 写的是 throwaway uid，不碰真实词表。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTranscriptGlossaryTools } from '../../../src/main/model/core-agent/transcript-glossary-tools';
import {
  TOOL_CATALOG,
  isToolVisibleToAgent,
  getToolsSystemPromptBlock,
} from '../../../src/main/model/core-agent/tool-catalog';
import * as transcriptGlossary from '../../../src/main/features/transcript_glossary';

/** 每个用例一个独立 uid，避免用例间词表串味。 */
let uid = '';
let tools: ReturnType<typeof createTranscriptGlossaryTools>;

function tool(name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

/** 工具签名要求 ctx，但本组工具只依赖构造期的 userId，这里给最小上下文。 */
async function run(name: string, input: Record<string, unknown>) {
  return tool(name).execute(input, { state: {} });
}

beforeEach(() => {
  uid = `u_tools_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  tools = createTranscriptGlossaryTools({ userId: uid });
});

describe('工具集形状', () => {
  it('scan 的 includeReview 默认必须是"开"（准确优先，不许悄悄改回省钱的默认）', () => {
    const scan = tools.find((t) => t.name === 'transcript_glossary_scan')!;
    const props = (scan.inputSchema as { properties?: Record<string, any> }).properties!;
    expect(props.includeReview, 'scan 应暴露 includeReview 开关').toBeTruthy();
    expect(props.includeReview.type).toBe('boolean');
    // **默认值不能写成 false** —— 实现里是 `!== false`（即默认开）。
    // 这条断言防的是"有人为了省钱把默认改回 false"，那等于把准确率让掉：
    // ASR 错形是开放集，纯查表必然漏。
    expect(props.includeReview.default).toBeUndefined();
  });

  it('暴露 4 个工具，名字与 catalog 登记一致', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'transcript_glossary_apply',
      'transcript_glossary_list',
      'transcript_glossary_scan',
      'transcript_glossary_upsert',
    ]);
  });

  it('每个工具都有 description 与 object 型 inputSchema', () => {
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect((t.inputSchema as { type?: string }).type, t.name).toBe('object');
    }
  });

  it('落盘写入的工具是串行，只读工具是并行', () => {
    expect(tool('transcript_glossary_upsert').executionMode).toBe('sequential');
    expect(tool('transcript_glossary_apply').executionMode).toBe('sequential');
    expect(tool('transcript_glossary_scan').executionMode).toBe('parallel');
    expect(tool('transcript_glossary_list').executionMode).toBe('parallel');
  });
});

describe('词表为空：必须显式说"没纠"，不得返回貌似成功的空结果', () => {
  it('apply 在空词表下不虚报，且明确告知原因', async () => {
    const text = '这是一段没有词表的转写';
    const res = await run('transcript_glossary_apply', { text, docId: 'doc_empty' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('EMPTY');
    expect(res.content).toContain('Seed');
  });

  it('scan 在空词表下同样显式说明', async () => {
    const res = await run('transcript_glossary_scan', { text: '随便什么', docId: 'doc_empty' });
    expect(res.content).toContain('EMPTY');
  });

  it('list 在空词表下不返回空串', async () => {
    const res = await run('transcript_glossary_list', {});
    expect(res.content).toContain('empty');
  });
});

describe('upsert：回写词表', () => {
  it('新建词条并如实回报派生风险等级', async () => {
    const res = await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Created');
    expect(res.content).toContain('coxy');
    expect(res.content).toContain('Cogseed');
    // 3 字符以上、非高危 token → low，会自动应用
    expect(res.content).toContain('risk=low');
    expect(res.content).toContain('applies automatically');
  });

  it('两字中文词被引擎判为 high，工具不得放宽', async () => {
    const res = await run('transcript_glossary_upsert', { wrong: '健全', correct: '鉴权' });
    expect(res.content).toContain('risk=high');
    // 必须明确告知：这类词不会被自动应用
    expect(res.content).toContain('NOT be auto-applied');
  });

  it('显式声明 low 也无法把两字中文词降级（下限只能更严）', async () => {
    const res = await run('transcript_glossary_upsert', { wrong: '图度', correct: '土豆', riskLevel: 'low' });
    expect(res.content).toContain('risk=high');
  });

  it('纯数字变体被引擎拒绝时，工具回 error 而不是假装成功', async () => {
    const res = await run('transcript_glossary_upsert', { wrong: '2024', correct: '二零二四' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('upsert_');
  });

  it('必填缺失 / 超长输入给出可读错误', async () => {
    const missing = await run('transcript_glossary_upsert', { wrong: 'x' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('correct');

    const tooLong = await run('transcript_glossary_upsert', { wrong: 'y'.repeat(200), correct: 'z' });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain('80');
  });
});

describe('scan + apply：纠错主链路', () => {
  beforeEach(async () => {
    // 一个低风险词（会被自动应用）+ 一个两字中文词（高危，必须确认）
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    await run('transcript_glossary_upsert', { wrong: '健全', correct: '鉴权' });
  });

  it('scan 把可自动应用与待确认分开上报，且不改动原文', async () => {
    const text = '我用 coxy 做了个东西，另外生态健全度不足。';
    const res = await run('transcript_glossary_scan', { text, docId: 'doc_scan' });
    expect(res.content).toContain('Auto-applicable');
    expect(res.content).toContain('coxy');
    expect(res.content).toContain('Needs user confirmation');
    expect(res.content).toContain('健全');
    // 明确下一步：先 apply，再确认，再 upsert
    expect(res.content).toContain('transcript_glossary_apply');
    expect(res.content).toContain('transcript_glossary_upsert');
  });

  it('apply 只改低风险词，两字中文词保持原样并计入待确认', async () => {
    const text = '我用 coxy 做了个东西，另外生态健全度不足。';
    const res = await run('transcript_glossary_apply', { text, docId: 'doc_apply' });

    // 低风险词被改
    expect(res.content).toContain('Cogseed');
    // 高危词原文必须完整保留（这是"健全→鉴权"事故的回归线）
    expect(res.content).toContain('生态健全度不足');
    // 且必须上报待确认，让 agent 无法静默跳过
    expect(res.content).toContain('MUST confirm with the user');
    expect(res.content).toMatch(/pendingTotal=[1-9]/);
  });

  it('apply 返回 status=draft 时，产物只能当草稿（不得宣称完成）', async () => {
    const text = '生态健全度不足';
    const res = await run('transcript_glossary_apply', { text, docId: 'doc_draft' });
    expect(res.content).toContain('status: draft');
  });

  it('已确认后可显式放开 high，此时才真正替换', async () => {
    const text = '生态健全度不足';
    const res = await run('transcript_glossary_apply', {
      text,
      docId: 'doc_confirmed',
      acceptRiskLevels: ['low', 'medium', 'high'],
    });
    expect(res.content).toContain('status: applied');
    expect(res.content).toContain('鉴权');
  });

  it('acceptRiskLevels 传空数组时报错，不静默退化成默认面', async () => {
    const res = await run('transcript_glossary_apply', {
      text: '随便',
      docId: 'doc_bad',
      acceptRiskLevels: [],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('at least one');
  });

  it('apply 返回纠正后的正文，供 agent 落盘（工具本身不写文件）', async () => {
    const text = '我用 coxy 做了个东西';
    const res = await run('transcript_glossary_apply', { text, docId: 'doc_text' });
    expect(res.content).toContain('--- corrected transcript ---');
    expect(res.content).toContain('我用 Cogseed 做了个东西');
  });
});

describe('list：查看词表', () => {
  it('按风险等级过滤并输出 kind/risk/scope', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    await run('transcript_glossary_upsert', { wrong: '健全', correct: '鉴权' });

    const all = await run('transcript_glossary_list', {});
    expect(all.content).toContain('coxy');
    expect(all.content).toContain('健全');
    expect(all.content).toMatch(/risk: .*low=1/);
    expect(all.content).toMatch(/high=1/);

    const highOnly = await run('transcript_glossary_list', { riskLevel: 'high' });
    expect(highOnly.content).toContain('健全');
    expect(highOnly.content).not.toContain('coxy');
  });

  it('搜索无命中时明确说"没有匹配"，不是空串', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed' });
    const res = await run('transcript_glossary_list', { search: '不存在的词zzz' });
    expect(res.content).toContain('No glossary entries match');
  });

  it('limit 被夹在合法区间内', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed' });
    const res = await run('transcript_glossary_list', { limit: 99999 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('coxy');
  });
});

describe('作用域：未确认全局时不该变成全局规则', () => {
  it('传 docId 时词条受限，list 标出 scoped', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', docId: 'doc_scope' });
    const res = await run('transcript_glossary_list', {});
    expect(res.content).toContain('scoped');
  });

  it('scoped 词条只在本文档生效：其它文档扫不到它', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', docId: 'doc_A' });
    const other = await run('transcript_glossary_scan', { text: '我用 coxy', docId: 'doc_B' });
    // 另一文档里没有候选（词条不在其作用域内）
    expect(other.content).toContain('Candidates: 0');
  });
});

describe('引擎是唯一判断源：工具层不重复实现分级', () => {
  it('工具回报的 risk 与引擎 deriveRiskLevel 一致', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed' });
    const entry = transcriptGlossary.listEntries(uid).find((e) => e.wrong === 'coxy');
    expect(entry).toBeTruthy();
    expect(entry!.riskLevel).toBe(
      transcriptGlossary.deriveRiskLevel({ wrong: 'coxy', correct: 'Cogseed', action: 'replace' }),
    );
  });
});

describe('接入可见性：工具必须真的进到模型视野', () => {
  // 这一组守的是"注册漏了"这类静默失败：工具实现了、注入了，但没登记进
  // TOOL_CATALOG，`getToolsSystemPromptBlock` 只会打一条 warning 然后跳过——
  // 模型看不到工具，会议流程会静默退回"不纠错直接出纪要"。
  const NAMES = [
    'transcript_glossary_scan',
    'transcript_glossary_apply',
    'transcript_glossary_upsert',
    'transcript_glossary_list',
  ];

  it('4 个工具都在 TOOL_CATALOG 里', () => {
    for (const n of NAMES) {
      expect(TOOL_CATALOG.find((e) => e.name === n), n).toBeTruthy();
    }
  });

  it('工具实现的名字与 catalog 登记的名字逐一对应（防止改名只改一边）', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it('对普通 agent 可见（未声明 ownerAgent = 默认可见）', () => {
    for (const n of NAMES) expect(isToolVisibleToAgent(n, '_default'), n).toBe(true);
  });

  it('渲染出的工具清单带分组标题与四个工具名', () => {
    const block = getToolsSystemPromptBlock(NAMES);
    expect(block).toContain('Meeting transcript correction (glossary)');
    for (const n of NAMES) expect(block, n).toContain(n);
  });

  it('重复 apply 同一份原文返回幂等回执，不再重跑规则产生第二份草稿', async () => {
    await run('transcript_glossary_upsert', { wrong: 'coxy', correct: 'Cogseed', kind: 'product' });
    const text = '我用 coxy 做了个东西';
    const first = await run('transcript_glossary_apply', { text, docId: 'doc_repeat' });
    expect(first.content).toContain('status: applied');

    const second = await run('transcript_glossary_apply', { text, docId: 'doc_repeat' });
    expect(second.content).toContain('status: applied');
    expect(second.content).toContain('already applied for this exact source');
    expect(second.content).not.toContain('MUST confirm with the user');

    // A changed source is a different key: it must still run for real.
    const changed = await run('transcript_glossary_apply', { text: '我又用 coxy 做了个东西', docId: 'doc_repeat' });
    expect(changed.content).not.toContain('already applied for this exact source');
  });

});
