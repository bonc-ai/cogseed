import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-inherit-inject-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const UID = 'user-inject';
const AGENT_ID = 'ag-inject';
const CID = 'conv-inject';

async function seedAsset(statement: string, id: string): Promise<RecallAbilityAssetRecord> {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: statement,
    suggestedType: 'rule',
    suggestedScope: 'delivery',
    sourceRefs: [{ kind: 'execution', id: `exec-${id}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate(UID, candidate.id, {
    forbiddenWhen: id === 'b' ? ['在客户现场不要引用内部估算'] : undefined,
  });
  return asset;
}

async function recordBirth(assets: RecallAbilityAssetRecord[], createdAt = new Date().toISOString()) {
  const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
  return recordAgentInheritance(UID, {
    agentId: AGENT_ID,
    rolePrompt: '你负责交付评审。',
    assets,
    createdAt,
  });
}

async function block(): Promise<string> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildInheritedCognitionBlockForTest(UID, CID, AGENT_ID);
}

describe('继承认知注入 Agent 运行时', () => {
  it('把冻结的资产语句与版本号注入提示', async () => {
    const a = await seedAsset('动手前先把验收标准写成可勾选的清单。', 'a');
    await recordBirth([a]);

    const out = await block();
    expect(out).toContain('### Inherited cognition');
    expect(out).toContain('动手前先把验收标准写成可勾选的清单。');
    expect(out).toContain(`[${a.id} v1]`);
  });

  it('禁用条件一并注入，模型才可能遵守', async () => {
    const b = await seedAsset('对外报价前先过一遍内部估算口径。', 'b');
    await recordBirth([b]);

    const out = await block();
    expect(out).toContain('禁用：在客户现场不要引用内部估算');
    expect(out).toContain('Respect every stated');
  });

  it('资产在 Agent 生成之后被撤销，立即停止注入', async () => {
    const a = await seedAsset('这条稍后会被撤销。', 'a');
    await recordBirth([a]);
    expect(await block()).toContain('这条稍后会被撤销。');

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(UID, a.id, 'unsafe');

    // 冻结的是内容，不是授权——撤销必须对已生成的 Agent 立刻生效。
    const after = await block();
    expect(after).not.toContain('这条稍后会被撤销。');
    expect(after).toBe('');
  });

  it('被暂停的资产同样不注入，并在块里说明扣了几条', async () => {
    const a = await seedAsset('这条会被暂停。', 'a');
    const b = await seedAsset('这条保持生效。', 'b');
    await recordBirth([a, b]);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(UID, a.id, 'under review');

    const out = await block();
    expect(out).not.toContain('这条会被暂停。');
    expect(out).toContain('这条保持生效。');
    expect(out).toContain('1 inherited item(s) withheld');
  });

  it('注入的是出生时的冻结文本，资产事后被编辑不改变已生成 Agent 的行为', async () => {
    const a = await seedAsset('原始判断。', 'a');
    await recordBirth([a]);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(UID, a.id, { statement: '后来改过的判断。' });

    const out = await block();
    expect(out).toContain('原始判断。');
    expect(out).not.toContain('后来改过的判断。');
    // 版本号仍是出生时那一版，回执才说得清当时用的是第几版。
    expect(out).toContain(`[${a.id} v1]`);
  });

  it('能力包过期后整份不注入', async () => {
    const a = await seedAsset('过期包里的判断。', 'a');
    // 出生时间设在两年前，出生包 TTL 一年，必然过期。
    const longAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    await recordBirth([a], longAgo);

    expect(await block()).toBe('');
  });

  it('没有继承记录的 Agent 注入空串，不报错也不编造', async () => {
    expect(await block()).toBe('');
  });
});

describe('术语表继承', () => {
  async function birthWithGlossary(glossary: Array<{ term: string; definition: string }>) {
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    return recordAgentInheritance(UID, {
      agentId: AGENT_ID,
      rolePrompt: '你负责交付评审。',
      assets: [],
      glossary,
      createdAt: new Date().toISOString(),
    });
  }

  it('术语与释义注入提示，模型才不会按通识重新解释', async () => {
    await birthWithGlossary([{ term: 'KSTAR', definition: '认知评估机制，不是核聚变装置' }]);
    const out = await block();
    expect(out).toContain('### Inherited glossary');
    expect(out).toContain('- KSTAR: 认知评估机制，不是核聚变装置');
    expect(out).toContain('do not');
  });

  it('一条资产都没带上时，术语表照样给', async () => {
    // 术语解决的是「被问到专有名词只能瞎猜」，和有没有认知资产是两回事。
    await birthWithGlossary([{ term: '能力包', definition: '交给执行端的最小认知集合' }]);
    const out = await block();
    expect(out).toContain('能力包');
    expect(out).not.toContain('### Inherited cognition');
  });

  it('既无资产也无术语时仍返回空串，不留空壳标题', async () => {
    await birthWithGlossary([]);
    expect(await block()).toBe('');
  });
});

describe('出生上下文采集', () => {
  it('只收有实际内容的分组，不用标题硬凑空释义', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const withContent = await groups.createGroup(UID, '交付节奏');
    await groups.createGroup(UID, '空分组');
    await groups.writeGroupContent(
      UID,
      withContent.group!.group_id,
      '## 字段\n\n### 周期\n- 两周一个迭代 [用户]\n',
    );

    const { collectAgentBirthContext } = await import('../../../../src/main/features/agent_inheritance');
    const collected = await collectAgentBirthContext(UID);

    expect(collected.glossary.map((e) => e.term)).toEqual(['交付节奏']);
    expect(collected.glossary[0].definition).toContain('两周一个迭代');
    // 记忆引用记全部分组 id（只记 id，不搬正文）。
    expect(collected.memoryRefs).toHaveLength(2);
  });

  it('没有任何分组时返回空，不报错', async () => {
    const { collectAgentBirthContext } = await import('../../../../src/main/features/agent_inheritance');
    expect(await collectAgentBirthContext(UID)).toEqual({ glossary: [], memoryRefs: [] });
  });

  it('只有骨架的角色模板不产出术语（真机抓到的回归）', async () => {
    // 真实装机上 software_engineer 模板就是这个形状：装了但一条都没填。
    // parseGroupContent 对它不做结构解析，会把整份原文当成一条 entry 返回；
    // 早先版本直接拿来当释义，注入给 Agent 的是一堆章节标题加模板元数据。
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '软件工程师');
    await groups.writeGroupContent(UID, created.group!.group_id, [
      '# 软件工程师（模板）',
      '',
      '> 模板: software_engineer@0.2.0-review.1 | 已安装: 2026-08-09T19:13:55',
      '',
      '## 技术专长',
      '',
      '### 语言与框架',
      '',
      '### 流水',
      '',
      '## 编码偏好',
      '',
      '### 评审偏好',
      '',
    ].join('\n'));

    const { collectAgentBirthContext } = await import('../../../../src/main/features/agent_inheritance');
    const collected = await collectAgentBirthContext(UID);

    // 空骨架没有释义，整条不收——宁可术语表为空，也不能拿标题冒充定义。
    expect(collected.glossary).toEqual([]);
    // 分组本身仍然被记为记忆引用。
    expect(collected.memoryRefs).toEqual([created.group!.group_id]);
  });

  it('骨架里填了内容后，只取内容不取标题', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '交付节奏');
    await groups.writeGroupContent(UID, created.group!.group_id, [
      '# 交付节奏（模板）',
      '',
      '> 模板: delivery@1.0 | 已安装: 2026-08-09T19:13:55',
      '',
      '## 周期',
      '',
      '两周一个迭代，周五封版。',
      '',
    ].join('\n'));

    const { collectAgentBirthContext } = await import('../../../../src/main/features/agent_inheritance');
    const collected = await collectAgentBirthContext(UID);

    expect(collected.glossary).toHaveLength(1);
    expect(collected.glossary[0].definition).toBe('两周一个迭代，周五封版。');
    // 标题与模板元数据不得混进释义。
    expect(collected.glossary[0].definition).not.toMatch(/#|模板:|已安装/);
  });
});

async function readReceiptFor(cid = CID) {
  const { readReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
  const crypto = await import('node:crypto');
  const { readAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
  const inheritance = await readAgentInheritance(UID, AGENT_ID);
  const digest = crypto.createHash('sha256')
    .update(`${cid}\n${AGENT_ID}\n${inheritance!.capabilityPack.contentHash}`)
    .digest('hex').slice(0, 24);
  return readReceipt(UID, `exec-inherit-${digest}`);
}

describe('注入即生成复用回执（链路最后一跳）', () => {
  it('注入后生成回执，记下带了哪几条及其版本', async () => {
    const a = await seedAsset('回执要记住这条。', 'a');
    await recordBirth([a]);
    await block();

    const receipt = await readReceiptFor();
    expect(receipt.targetSessionId).toBe(`gmember-${CID}-${AGENT_ID}`);
    expect(receipt.reusedRefs).toEqual([`asset:${a.id}@v1`]);
    expect(receipt.boundary).toBe('real');
    // 继承注入是只读的——Agent 拿到判断但不能改写认知资产。
    expect(receipt.permissionMode).toBe('read-only');
  });

  it('被撤销而没带上的条目记进 omittedRefs，不是悄悄消失', async () => {
    const a = await seedAsset('这条会被暂停。', 'a');
    const b = await seedAsset('这条带得上。', 'b');
    await recordBirth([a, b]);

    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(UID, a.id, 'under review');
    await block();

    const receipt = await readReceiptFor();
    expect(receipt.reusedRefs).toEqual([`asset:${b.id}@v1`]);
    expect(receipt.omittedRefs).toEqual([`asset:${a.id}@v1:paused`]);
  });

  it('同一个包重复注入同一会话只记一张回执，不按轮次刷', async () => {
    const a = await seedAsset('反复注入的判断。', 'a');
    await recordBirth([a]);

    await block();
    await block();
    await block();

    // 第二轮起 prepareReceipt 抛「已存在」是预期路径；回执内容不该被覆盖或重复。
    const receipt = await readReceiptFor();
    expect(receipt.status).toBe('prepared');
    expect(receipt.reusedRefs).toEqual([`asset:${a.id}@v1`]);
  });

  it('一条都没带上时不记回执——没有复用就没有复用证明', async () => {
    const a = await seedAsset('这条会被撤销。', 'a');
    await recordBirth([a]);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(UID, a.id, 'unsafe');

    expect(await block()).toBe('');
    await expect(readReceiptFor()).rejects.toThrow('not found');
  });
});
