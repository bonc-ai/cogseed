/**
 * 治理待办反漂移守卫（specs/010 T038）。
 *
 * 五条全部**从源码/常量派生**（不抄名单——抄名单的守卫在下一次有人加第二套
 * 机制时不会响）：
 *   ① 分组映射唯一处：kind→治理类别的映射只存在于 formal-assets/inbox.ts，
 *      渲染层（views/core/app）不允许出现第二份映射表；
 *   ② 补条件的门禁唯一处：inbox-adapter 里只有 validatePromotionByAssetType
 *      这一个「什么叫有边界」的判据调用（渲染层零调用）；
 *   ③ 无第二处「已处理标记位」：退场机制只有既有版本/候选/巡检三套，不新增
 *      inboxRead/inboxProcessed 之类的标记文件（敏感级机制连同 escalation-ack
 *      设置型记录已整套删除，2026-09-28 设计 6.1）；
 *   ④ 模型工具面未扩：tool-catalog 的 recall 组工具数不变（治理是用户的
 *      动作，不是模型工具）；
 *   ⑤ tags/category 不做映射：本 feature 的渲染层与主进程写路径不出现
 *      「把 tags/category 映射到 assetType/familyName」的旁路。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const inboxSource = read('src/main/features/recall/formal-assets/inbox.ts');
const adapterSource = read('src/main/features/cognition/inbox-adapter.ts');
// 2026-09-29 views.js 机械拆分：待我处理页（治理行渲染）迁入 review-candidate.js /
// review-views.js，守卫按加载顺序合并三源扫描（断言语义不变）。
const viewsSource = ['views.js', 'review-candidate.js', 'review-views.js']
  .map((file) => read(`src/renderer/modules/cognition-assets/${file}`))
  .join('\n');
const coreSource = read('src/renderer/modules/cognition-assets/core.js');
const appSource = read('src/renderer/modules/cognition-assets/app.js');


describe('governance inbox anti-drift guards (specs/010 T038)', () => {
  it('① kind→治理类别的映射只存在于 formal-assets/inbox.ts（渲染层零映射表）', () => {
    expect(inboxSource).toContain('function governanceCategory');
    // 渲染层三个文件里不允许出现 kind→category 的映射字面量（第二份映射表）。
    for (const [name, source] of [['views.js', viewsSource], ['core.js', coreSource], ['app.js', appSource]] as const) {
      expect(source, `${name} 不应有第二份 kind→category 映射`).not.toMatch(/classification_conflict['"]?\s*[:=]\s*['"]conflict/);
      expect(source, `${name} 不应有第二份 kind→category 映射`).not.toMatch(/['"]rule_boundary_missing['"]\s*:\s*['"]boundary['"]/);
    }
    // 渲染层按 category 字符串取词是消费（GROUP_TITLES 表），不是映射——
    // 但「按 kind 分叉到 category」的写法必须缺席。
    expect(viewsSource).not.toContain("kind === 'classification_conflict' ? 'conflict'");
  });

  it('② 补条件的门禁唯一处：adapter 只经 validatePromotionByAssetType 判「有边界」', () => {
    expect(adapterSource).toContain("validatePromotionByAssetType");
    expect(adapterSource).toContain("rule_boundary_required");
    // 不允许第二套「什么叫有边界」：自写判据（非空即有边界之类）必须缺席。
    expect(adapterSource).not.toMatch(/applicableWhen\.length\s*(>=|>)\s*0\s*(&&|\|\|)/);
    expect(adapterSource).not.toContain('hasBoundary');
    // 渲染层不判定门禁（core.js 的 RECALL_PROMOTION_BLOCK_TEXTS 是既有候选
    // 错误码的**文案**表，不是判据——判据函数必须缺席）。
    for (const [name, source] of [['views.js', viewsSource], ['core.js', coreSource]] as const) {
      expect(source, `${name} 不得调用门禁判据`).not.toContain('validatePromotionByAssetType');
    }
    expect(viewsSource).not.toContain('rule_boundary_required');
  });

  it('③ 无第二处「已处理标记位」：退场只有既有三套机制', () => {
    // 标记位形态的文件名（inbox-read / inbox-processed / inbox-seen）必须缺席。
    for (const source of [adapterSource, coreSource, viewsSource, appSource]) {
      expect(source).not.toMatch(/inbox[-_](read|processed|seen)[-_]?(state|mark|store)/i);
    }
    // 敏感级机制（含 escalation-ack 这一设置型记录）已整套删除：服务文件必须
    // 缺席，适配器不得再接线任何「已读/已确认」标记位。
    expect(fs.existsSync(path.join(ROOT, 'src/main/features/recall/escalation-ack-service.ts'))).toBe(false);
    expect(adapterSource).not.toContain('acknowledgedEscalations');
  });

  it('④ 模型工具面未扩：全量工具名集合保持 72，治理动作不是模型工具', async () => {
    // 从 catalog 常量派生（不抄名单——012 的 tag-ranking-guard 另有全量冻结）。
    const { TOOL_CATALOG } = await import('../../../../src/main/model/core-agent/tool-catalog');
    const names = TOOL_CATALOG.map((tool) => tool.name);
    // 2026-09-28：71→72（09-27 本体图谱切片新增 list_ontology_graph，基线随功能更新）。
    expect(names.length).toBe(72);
    // 本 feature 的新动作名是**用户的界面动作**，不得注册成模型工具。
    for (const notTool of ['classify_ability_assets', 'set_rule_boundary', 'claim_conflict']) {
      expect(names).not.toContain(notTool);
    }
  });

  it('⑤ tags/category 不经本 feature 做映射（Epic 2 前如实拒绝的口径不破）', () => {
    // 写路径不出现「category → assetType / familyName」的映射旁路。
    for (const source of [adapterSource, coreSource]) {
      expect(source).not.toMatch(/category['"]?\s*[:=]\s*[^,;\n]*assetType/i);
      expect(source).not.toMatch(/category['"]?\s*[:=]\s*[^,;\n]*familyName/i);
    }
  });
});
