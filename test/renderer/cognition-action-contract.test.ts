/**
 * 认知资产迁移动作契约(施工矩阵的门禁形态)。
 *
 * 依据 `test/renderer/fixtures/cognition-actions.json`(转录自
 * design/认知资产-原型按钮IPC施工矩阵-20260921.md)。四条不变量:
 *
 * 1. **完整性**:views.js 里出现的每个 data-act(含 btn()/moreRow() 生成的)
 *    在 app.js 委托层必须有 case 或 change 选择器——出现即被消费,不允许
 *    渲染出来点了没反应的按钮。
 * 2. **禁入**:batchRunNow 不得出现在认知资产前端(批量立即整理入口
 *    确认不迁移,后端能力保留)。
 * 3. **必达**:fixture 里每个动作在目标模块落地(cognition-assets 看
 *    app.js handler;personal-ontology 看 IPC 通道调用点)。迁移分阶段
 *    推进,该断言在 Phase 5-8 期间逐步由红转绿,是迁移完成的机械判据。
 * 4. **pending 态**:fixture 标 pending=true 的写动作必须在 app.js 的
 *    WRITE_ACTIONS 集合里(点击即禁用,防双击重复提交)。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const core = read('src/renderer/modules/cognition-assets/core.js');
const views = read('src/renderer/modules/cognition-assets/views.js');
const app = read('src/renderer/modules/cognition-assets/app.js');
const ontology = read('src/renderer/modules/personal-ontology.js');
const fixture = JSON.parse(read('test/renderer/fixtures/cognition-actions.json')) as {
  actions: { act: string; module: string; ipc: string | null; write: boolean; pending: boolean; phase: number }[];
  forbidden: { act: string; reason: string }[];
};

/** app.js 委托层实际处理的动作:switch case + change 事件的 data-act 选择器。 */
function handledActs(): Set<string> {
  const acts = new Set<string>();
  for (const m of app.matchAll(/case '([a-z0-9-]+)'/g)) acts.add(m[1]);
  for (const m of app.matchAll(/\[data-act="([a-z0-9-]+)"\]/g)) acts.add(m[1]);
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

  it('批量立即整理入口不进前端(batchRunNow 禁入)', () => {
    for (const banned of fixture.forbidden) {
      expect(views).not.toContain(`data-act="${banned.act}"`);
      expect(app).not.toContain(`case '${banned.act}'`);
    }
    expect(app).not.toContain('batchRunNow');
  });

  it('fixture 动作全部在目标模块落地(迁移完成的机械判据)', () => {
    const handled = handledActs();
    const missing = fixture.actions.filter((entry) => {
      if (entry.module === 'cognition-assets') return !handled.has(entry.act);
      return !ontology.includes(`'${entry.act}'`);
    }).map((entry) => `${entry.module}:${entry.act}`);
    expect(missing).toEqual([]);
  });

  it('写动作的 pending 集合覆盖 fixture 标记', () => {
    const pendingRequired = fixture.actions
      .filter((entry) => entry.module === 'cognition-assets' && entry.pending)
      .map((entry) => entry.act);
    const missing = pendingRequired.filter((act) => !writeActionsBlock.includes(`'${act}'`));
    expect(missing).toEqual([]);
  });

  it('fixture 覆盖了现役全部写通道,未静默漏掉新动作', () => {
    // 反向钳制:app.js WRITE_ACTIONS 里的动作都必须出现在 fixture 里——
    // 未来新增写动作若没登记进施工矩阵,这里会先红。
    const inWriteSet = [...writeActionsBlock.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    const known = new Set(fixture.actions.filter((e) => e.module === 'cognition-assets').map((e) => e.act));
    const unregistered = inWriteSet.filter((act) => !known.has(act));
    expect(unregistered).toEqual([]);
    // 推荐卡确认的核心层动作存在(app.js case 调用它)。
    expect(core).toContain('acknowledgeAssetRecommendation');
  });
});
