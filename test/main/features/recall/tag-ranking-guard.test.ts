import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * specs/012 T026：反漂移断言（钉死「唯一处」，长出第二套就红）。
 *
 * 六条源码级断言按 tasks.md T026 原文：
 *  ① 资产 tags 的写路径只有 updateAbilityAsset 一处；
 *  ② 不存在第二处「标签字段未就位」拒绝；
 *  ③ 资产记录字段表里没有 category（它只是入参别名，归一收编一处）；
 *  ④ 排序的 sort/因子计算只出现在 asset-ranking.ts（提示词与工具两处都调它）；
 *  ⑤ 采用判定只经 listAppliedUsageReceipts（不得新写 status === 'applied' 判定）；
 *  ⑥ tool-catalog.ts 工具名字集合未变（对照 012 开工前 34b87ce8 基线全量冻结）。
 *
 * 另附 T019 回执 ranking 写侧的**行为级**钉子：注入回执的因子拆解只出自
 * 当轮目录构建的那一次 rankAssets（asset-catalog-hint 的 ranked 视图查表），
 * 写侧（bus.ts / recall-tools.ts）不重算；没有当轮视图时不带 ranking
 * （读取侧 explainable:false，如实说「没有记录」）；同回合重复写幂等；
 * 读盘原文不含资产正文（隐私边界 III1）。
 */

const root = path.resolve(__dirname, '../../../..');
const mainSrc = path.join(root, 'src/main');

function read(rel: string): string {
  return fs.readFileSync(path.join(mainSrc, rel), 'utf8');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('反漂移源码级断言（T026）', () => {
  it('① 资产 tags 的写路径只有 updateAbilityAsset 一处（II1）', () => {
    // 标签服务（setAssetTags / batchAssetTags / 联动改写）全部转调
    // updateAbilityAsset，自己不碰资产存储。
    const tagService = read('features/recall/ability-tag-service.ts');
    expect(count(tagService, 'updateAbilityAsset(')).toBeGreaterThanOrEqual(3);
    // 标签服务只写自己的标签库集合（ABILITY_TAG_COLLECTION），不直写资产记录。
    expect(tagService).not.toContain("'ability-assets'");
    // IPC 通道也只是转调标签服务（不另开写通道）。
    const ipc = read('ipc/index.ts');
    expect(ipc).toContain('abilityTags.setAssetTags');
    expect(ipc).toContain('abilityTags.batchAssetTags');
    // 直改既有资产记录（ability-assets）的存储写入：tags 合并只发生在
    // updateAbilityAsset 函数体内（tagsInput 是它的局部量；两处合并行 =
    // 元数据路径 + 内容路径，同一函数）。
    const assetService = read('features/recall/asset-service.ts');
    expect(count(assetService, 'const tagsInput = ')).toBe(1);
    expect(count(assetService, '{ tags: tagsInput }')).toBe(2);
    // ability-assets 的其它触碰者不得写 tags：candidate-service（候选促成 =
    // 创建初始记录，形状里只有可选声明）、family（relations/familyName 直写，
    // 全文零 tags）、experience-migration（迁出 = 物理删记录，不写内容）。
    for (const rel of ['features/recall/candidate-service.ts', 'features/recall/family.ts', 'features/recall/experience-migration.ts']) {
      const src = read(rel);
      expect(src).not.toMatch(/\{\s*tags\s*:/); // 「往记录合并 tags」的写入形态
      expect(src).not.toMatch(/tags\s*=\s*\[/); // 标签数组的赋值加工
    }
  });

  it('② 不存在第二处「标签字段未就位」拒绝', () => {
    for (const file of listTsFiles(mainSrc)) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).not.toContain('字段未就位');
      // 旧拒绝分支的另一半话术（测试钉过的 US-201 提示）同样不得回潮。
      expect(src).not.toContain('标签字段未就位');
    }
    // 解禁后的真实形状：tags/category 进 EDIT_ACCEPTED_FIELDS（工具面白名单），
    // category 收编为标签而不是被拒。
    const steward = read('model/core-agent/asset-steward-tools.ts');
    const accepted = steward.slice(
      steward.indexOf('EDIT_ACCEPTED_FIELDS'),
      steward.indexOf(']', steward.indexOf('EDIT_ACCEPTED_FIELDS')),
    );
    expect(accepted).toContain("'tags'");
    expect(accepted).toContain("'category'");
  });

  it('③ 资产记录字段表里没有 category（入参别名收编归一只有一处）', () => {
    // 记录形状三处（候选记录 / 资产服务 / formal-assets 白名单）都没有 category。
    const candidate = read('features/recall/candidate-service.ts');
    const recordIface = candidate.slice(
      candidate.indexOf('export interface RecallAbilityAssetRecord'),
      candidate.indexOf('\n}', candidate.indexOf('export interface RecallAbilityAssetRecord')),
    );
    expect(recordIface).not.toContain('category');
    expect(read('features/recall/asset-service.ts')).not.toContain('category');
    expect(read('features/recall/formal-assets/types.ts')).not.toContain('category');
    // 收编（category → 并入 tags 后从字段名上消失）只在 asset-steward-tools 一处。
    expect(count(read('model/core-agent/asset-steward-tools.ts'), 'delete fields.category')).toBe(1);
  });

  it('④ 排序的 sort/因子计算只出现在 asset-ranking.ts（两个消费方都调它）', () => {
    // 因子计算的原语只存在于排序唯一处。
    const ranking = read('features/recall/asset-ranking.ts');
    for (const id of ['MATURITY_RAW', 'adoptionRaw', 'sceneRaw', 'relevanceRaw', 'round6']) {
      expect(ranking).toContain(id);
    }
    for (const file of listTsFiles(mainSrc)) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(mainSrc, file);
      if (rel === path.join('features/recall/asset-ranking.ts')) continue;
      for (const id of ['adoptionRaw', 'sceneRaw', 'relevanceRaw', 'MATURITY_RAW', 'round6']) {
        expect({ file: rel, id, present: src.includes(id) }).toEqual({ file: rel, id, present: false });
      }
      // 因子名闭集的导出定义也只有一处（injection-receipt 里的局部校验集合
      // 是形状校验，不是第二套因子计算，不在禁列）。
      if (rel === path.join('features/recall/injection-receipt.ts')) continue;
      expect(src).not.toContain('export const RANKING_FACTORS');
    }
    // 排序只由目录引擎调用；提示词与工具共用回合快照。
    const hint = read('features/recall/asset-catalog-hint.ts');
    const tools = read('model/core-agent/recall-tools.ts');
    const engine = read('features/recall/catalog-engine.ts');
    expect(engine).toContain('rankAssets(');
    expect(hint).not.toContain('rankAssets(');
    expect(tools).not.toContain('rankAssets(');
    expect(hint).toContain('catalogSnapshot(');
    expect(tools).toContain('catalogOrderedToolPool(');
    // bus.ts 的回执写侧只查表透传，不重算（不出现 rankAssets 调用）。
    const bus = read('features/group_chat/bus.ts');
    expect(bus).not.toContain('rankAssets(');
    expect(bus).toContain('lastCatalogRankedForTurn');
  });

  it('⑤ 采用判定只经 listAppliedUsageReceipts（不得新写 status === \'applied\' 判定）', () => {
    // 排序的采用统计提供者（asset-catalog）：只调 listAppliedUsageReceipts，
    // 自己不做状态判定。
    const catalog = read('features/recall/asset-catalog.ts');
    expect(catalog).toContain('listAppliedUsageReceipts(');
    expect(catalog).not.toContain('status === \'applied\'');
    // 其余排序链路文件同样不得出现采用状态判定。
    for (const rel of [
      'features/recall/asset-ranking.ts',
      'features/recall/asset-catalog-hint.ts',
      'model/core-agent/recall-tools.ts',
      'features/group_chat/bus.ts',
    ]) {
      expect(read(rel)).not.toContain('status === \'applied\'');
    }
    // 完整采用判定（applied 且 boundary=real 的组合过滤）在 src/main 里只有
    // asset-usage-receipt.ts 一处。asset-service 的按版本计数（2026-09-16 交付，
    // 版本链视图呈现）只看 status 不看 boundary，是展示聚合不是采用判定——
    // quickstart S3.5 明确保护它的既有口径。
    let combined = 0;
    for (const file of listTsFiles(mainSrc)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes("status === 'applied'")) continue;
      if (/boundary\s*===\s*'real'/.test(src)) combined += 1;
    }
    expect(combined).toBe(1);
  });

  it('⑥ tool-catalog.ts 工具名字集合未变（对照 012 开工前 34b87ce8 的冻结基线，2026-09-28 随本体图谱切片 71→72）', async () => {
    const { TOOL_CATALOG } = await import('../../../../src/main/model/core-agent/tool-catalog');
    const frozen = [
      'add_custom_connector', 'archive_ability_asset', 'ask_materials', 'bash', 'briefing_get', 'briefing_schedule',
      'call_connector_tool', 'chat_read', 'chat_search', 'create_artifact', 'create_docx', 'create_pptx', 'create_xlsx',
      'cross_session_memory', 'delete_ability_asset', 'delete_file', 'edit_ability_asset', 'edit_file', 'edit_office',
      'expense_case_status', 'expense_configuration_status', 'expense_precheck_case', 'feishu_dashboard', 'generate_image',
      'grep_files', 'html_to_pdf', 'interactive_cli_close', 'interactive_cli_read', 'interactive_cli_send',
      'interactive_cli_start', 'kb_list', 'kb_read', 'kb_search', 'list_ability_assets', 'list_asset_change_proposals',
      'list_connector_tools', 'list_files', 'list_ontology_graph', 'list_task_experiences', 'manage_execution_plan', 'markdown_to_pdf',
      'material_list', 'material_search', 'merge_ability_assets', 'messaging_list_targets', 'messaging_send',
      'messaging_send_file', 'metacognition', 'ocr_file', 'office_read', 'office_render', 'p3394_peers',
      'p3394_send', 'p3394_sessions', 'personal_ontology_fields', 'project_instructions', 'publish_outputs',
      'read_ability_asset', 'read_file', 'read_task_experience',
      'research_rerank', 'restore_ability_asset', 'rollback_ability_asset', 'search_ability_assets', 'search_files',
      'stat_file', 'tool_result_read_chunk', 'tool_result_search', 'touchpoint_list', 'web_fetch', 'web_search',
      'write_file',
    ];
    expect(TOOL_CATALOG.map((entry) => entry.name).sort()).toEqual(frozen);
  });
});

/* ───────────── T019 回执 ranking 写侧（行为级钉子） ───────────── */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'tagrankguard';

const embedState = vi.hoisted(() => ({ fail: false }));
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => {
    if (embedState.fail) throw new Error('embed unavailable');
    return texts.map(() => new Array(512).fill(0));
  },
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-tag-rank-guard-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedOne() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const promoted = await candidates.saveRecallCandidate(TEST_UID, {
    judgment: '排序守卫用资产：没有明确场景关联时 scene 因子缺席。',
    summary: '守卫用排序资产',
    suggestedType: 'rule',
    applicableWhen: ['守卫用例'],
    forbiddenWhen: [],
    suggestedScope: 'general',
    sourceRefs: [{ kind: 'execution', id: 'exec-guard-1' }],
  });
  const asset = await candidates.promoteRecallCandidate(TEST_UID, promoted.id, { actor: 'user' });
  return asset.asset;
}

function injectionLines(): string[] {
  const file = path.join(tmpDir, TEST_UID, 'cloud', 'recall', 'jsonl', 'injection-receipts', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

describe('回执 ranking 写侧（T019 行为级钉子）', () => {
  it('agent_read 回执带当轮拆解：与目录构建那一次 rankAssets 的解释逐字一致，不在写侧重算', async () => {
    // 注：不给资产挂 spaceId——运行时准入对空间资产有 scope 闸（与本测试
    // 无关）；scene 用「给了 turnSpaceId 但没有明确关联」保持缺席，钉住新口径。
    const asset = await seedOne();
    // 当轮目录构建（无任务文本 → relevance 缺席）。
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    hint.resetAssetCatalogHintCacheForTest();
    await hint.assetCatalogForPrompt(TEST_UID, 'conv-guard-1', Date.now(), '', { turnSpaceId: 'sp-guard-1' }, undefined, 'turn-guard-a');
    // ranked 视图访问器：同键可查，异会话为空（不串台）。
    const view = hint.lastCatalogRankedForTurn(TEST_UID, 'conv-guard-1', 'turn-guard-a');
    expect(view.size).toBe(1);
    const rankedRow = view.get(asset.id)!;
    expect(rankedRow.factors.map((f) => f.name)).toEqual(['adoption', 'maturity']);
    expect(rankedRow.excluded).toEqual(['relevance', 'scene']);
    expect(hint.lastCatalogRankedForTurn(TEST_UID, 'conv-other').size).toBe(0);
    // 模型自取（正文模式）→ agent_read 回执带上同一份拆解（查表透传）。
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-guard-a', cid: 'conv-guard-1' });
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const receipts = await listInjectionReceipts(TEST_UID, 'turn-guard-a');
    const read = receipts.find((r) => r.channel === 'agent_read');
    expect(read).toBeTruthy();
    expect(read!.ranking).toBeTruthy();
    expect(read!.ranking!.factors).toEqual(rankedRow.factors);
    expect(read!.ranking!.excluded).toEqual(rankedRow.excluded);
    expect(read!.ranking!.sceneExcludedReason).toBe('no_matching_association');
    expect(read!.ranking!.score).toBe(rankedRow.score);
    expect(read!.ranking!.weightsSource).toBe('default');
    // 隐私（III1 读盘原文）：ranking 只存因子名与数值——不含资产正文、任务文本、路径。
    const line = injectionLines().find((l) => l.includes('agent_read'))!;
    expect(line).toContain('"ranking"');
    expect(line).not.toContain('排序守卫用资产');
    expect(JSON.stringify(read!.ranking)).not.toContain('/');
  });

  it('没有当轮目录/会话对不上 → 回执不带 ranking（explainable:false 的数据面），且同回合重复写幂等', async () => {
    const asset = await seedOne();
    const { createRecallTools } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallTools({ userId: TEST_UID, turnId: 'turn-guard-b', cid: 'conv-never-built' });
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    let receipts = await listInjectionReceipts(TEST_UID, 'turn-guard-b');
    const read = receipts.find((r) => r.channel === 'agent_read');
    expect(read).toBeTruthy();
    expect(read!.ranking).toBeUndefined();
    // IPC 读取口的 explainable 就是 Boolean(receipt.ranking)：无 ranking → false（不编造）。
    expect(Boolean(read!.ranking)).toBe(false);
    // 幂等：同回合重复取用不产生第二条回执（ranking 不进幂等键）。
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    receipts = await listInjectionReceipts(TEST_UID, 'turn-guard-b');
    expect(receipts.filter((r) => r.channel === 'agent_read')).toHaveLength(1);
  });
});
