/**
 * 认知资产动作契约，以 fixtures/cognition-actions.json 为动作清单。
 * 渲染动作须由委托层处理，禁用入口不得出现；写动作须具备 pending 保护，
 * 防止重复提交。清单与委托层双向核对，避免新增入口遗漏登记。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const core = read('src/renderer/modules/cognition-assets/core.js');
// 扫描各业务渲染模块，覆盖它们共用的动作委托。
const views = ['views.js', 'settings.js', 'library.js', 'review-candidate.js', 'review-views.js']
  .map((file) => read(`src/renderer/modules/cognition-assets/${file}`))
  .join('\n');
const app = read('src/renderer/modules/cognition-assets/app.js');
const activityController = loadCognitionAssets({}, { name: 'activity' }).ns.activityController;
const fixture = JSON.parse(read('test/renderer/fixtures/cognition-actions.json')) as {
  actions: { act: string; module: string; ipc: string | null; write: boolean; pending: boolean }[];
  forbidden: { act: string; reason: string }[];
};

/** app.js 委托层实际处理的动作:switch case + change 事件的 data-act 选择器。 */
function handledActs(): Set<string> {
  const acts = new Set<string>();
  for (const m of app.matchAll(/case '([a-z0-9-]+)'/g)) acts.add(m[1]);
  for (const m of app.matchAll(/\[data-act="([a-z0-9-]+)"\]/g)) acts.add(m[1]);
  for (const act of activityController.handledActions) acts.add(act);
  for (const act of loadCognitionAssets().ns.library.handledActions) acts.add(act);
  return acts;
}

/** views.js 里引用的动作:data-act 字面量 + btn() 第二参 + moreRow() 第三参
 *  (btn/moreRow 是本模块生成 data-act 的两个 helper,roleBtn/svg 的 data-act
 *  以字面量出现)。 */
function referencedActs(): Set<string> {
  const acts = new Set<string>();
  for (const m of views.matchAll(/data-act="([a-z0-9-]+)"/g)) acts.add(m[1]);
  for (const m of views.matchAll(/\bbtn\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*'([a-z0-9-]+)'/g)) acts.add(m[1]);
  for (const m of views.matchAll(/\bmoreRow\(\s*[^,]+,\s*[^,]+,\s*'([a-z0-9-]+)'/g)) acts.add(m[1]);
  return acts;
}

const writeActionsBlock = (() => {
  const start = app.indexOf('const WRITE_ACTIONS = new Set([');
  if (start < 0) return '';
  const end = app.indexOf(']);', start);
  return app.slice(start, end);
})();

describe('认知资产动作契约', () => {
  it('views.js 渲染的每个动作都有 app.js 委托处理', () => {
    const handled = handledActs();
    const orphan = [...referencedActs()].filter((act) => !handled.has(act)).sort();
    expect(orphan).toEqual([]);
  });

  it('独立活动控制器由真实委托调用，登记的写动作都有内部 pending 与真实 IPC 路径', () => {
    expect(app).toContain('NS.activityController.handleClick(el)');
    expect(activityController.handleClick).toBeTypeOf('function');
    const handler = String(activityController.handleClick);
    expect(handler).toContain('ACTIVITY_ACTIONS.includes(act)');
    expect(handler).toContain('ACTIVITY_WRITE_ACTIONS.includes(act)');
    expect(handler).toContain("getAttribute('aria-busy') === 'true'");
    expect(handler).toContain("setAttribute('disabled', 'disabled')");
    expect(handler).toContain("removeAttribute('disabled')");
    for (const entry of fixture.actions.filter(entry => activityController.writeActions.includes(entry.act))) expect(handler).toContain(entry.ipc);
  });

  it('批量立即整理入口不进前端(batchRunNow 禁入)', () => {
    for (const banned of fixture.forbidden) {
      expect(views).not.toContain(`data-act="${banned.act}"`);
      expect(app).not.toContain(`case '${banned.act}'`);
    }
    expect(app).not.toContain('batchRunNow');
  });

  it('app.js switch 的 case 名不得重复(重复时仅首个匹配执行,后续分支永不可达)', () => {
    // 同一 switch 中的重复 case 会使后续分支不可达。
    const names = [...app.matchAll(/case '([a-z0-9-]+)'/g)].map((m) => m[1]);
    const seen = new Set<string>();
    const dup = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    expect(dup, `app.js 存在重复 case(仅首个执行):${dup.join(', ')}`).toEqual([]);
  });

  it('fixture 动作全部在目标模块落地', () => {
    const handled = handledActs();
    const missing = fixture.actions.filter((entry) => entry.module === 'cognition-assets' && !handled.has(entry.act))
      .map((entry) => `${entry.module}:${entry.act}`);
    expect(missing).toEqual([]);
  });

  it('写动作的 pending 集合覆盖 fixture 标记', () => {
    const pendingRequired = fixture.actions
      .filter((entry) => entry.module === 'cognition-assets' && entry.pending)
      .map((entry) => entry.act);
    const missing = pendingRequired.filter((act) => !writeActionsBlock.includes(`'${act}'`) && !activityController.writeActions.includes(act));
    expect(missing).toEqual([]);
  });

  it('fixture 覆盖了现役全部写通道,未静默漏掉新动作', () => {
    // 反向钳制:app.js WRITE_ACTIONS 里的动作都必须出现在 fixture 里——
    // 新增写动作须登记在动作清单中。
    const inWriteSet = [...writeActionsBlock.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).concat(activityController.writeActions);
    const known = new Set(fixture.actions.filter((e) => e.module === 'cognition-assets').map((e) => e.act));
    const unregistered = inWriteSet.filter((act) => !known.has(act));
    expect(unregistered).toEqual([]);
    // 推荐卡确认的核心层动作存在(app.js case 调用它)。
    expect(core).toContain('acknowledgeAssetRecommendation');
  });
});

/* confirmUser 经 NS 暴露；委托层使用命名空间引用，避免 ReferenceError。 */
describe('app.js 委托层的 helper 引用', () => {
  it('confirmUser 一律经 NS.confirmUser——裸引用即红', () => {
    const bare = [...app.matchAll(/(?<!NS\.)\bconfirmUser\s*\(/g)];
    expect(bare.map((m) => m[0]), `app.js 存在裸 confirmUser 调用（真机会 ReferenceError）：${bare.length} 处`).toHaveLength(0);
    expect(app).toContain('NS.confirmUser');
  });
});
