/**
 * 014 反漂移守卫（specs/014 T024③）。
 *  本 spec 零新增 IPC 通道：当前通道名集合与开工基线（014 开工前提交
 *  660f82e8 的快照）做**集合比较**（顺序无关）——能抓住「偷偷加通道」。
 *  后续认知资产迁移为显式用户选择新增了两个登记通道；白名单只登记这两个，
 *  仍拒绝任何未登记的新增，同时继续检测基线通道删除（基线随通道退役同步，
 *  如 2026-09-28 敏感级机制删除时下线的 recall.assets.sensitivity.batch）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ipcSource = fs.readFileSync(path.join(ROOT, 'src/main/ipc/index.ts'), 'utf8');

describe('014 anti-drift（specs/014 T024）', () => {
  it('③ IPC 通道与 014 基线一致，且只允许已登记的后续迁移通道', () => {
    const current = [...ipcSource.matchAll(/^  '([A-Za-z0-9_.-]+)':/gm)].map((m) => m[1]);
    expect(current.length).toBeGreaterThan(300); // 解析护栏：抓不到通道说明正则失效
    const baseline = fs.readFileSync(path.join(__dirname, 'fixtures/ipc-channel-baseline-014.txt'), 'utf8')
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const sneaked = [...new Set(current)].filter((name) => !baseline.includes(name));
    const removed = baseline.filter((name) => !current.includes(name));
    const registeredPost014 = [
      'recall.scopedMemoryMigration.preview',
      'recall.scopedMemoryMigration.run',
      // 2026-09-29 个人本体 v2 重构：po.* 干净通道（JSON 单文档存储上的
      // 全 id 寻址业务 API，见 src/main/features/po/api.ts；旧通道保留）。
      'po.snapshot',
      'po.groups.create',
      'po.groups.rename',
      'po.groups.delete',
      'po.groups.restore',
      'po.deleted.list',
      'po.fields.create',
      'po.fields.rename',
      'po.fields.delete',
      'po.fields.setRelation',
      'po.values.add',
      'po.values.update',
      'po.values.delete',
      'po.entries.add',
      'po.entries.delete',
      'po.entries.promote',
      'po.templates.status',
      'po.templates.install',
      'po.templates.uninstall',
      'po.templates.archiveInfo',
      'po.history.list',
      'po.history.restore',
      'po.candidates.confirm',
      'po.candidates.reject',
      'po.data.export',
      'po.data.importPreview',
      'po.data.importApply',
      // 2026-09-30 托盘常驻：关闭到托盘的偏好通道（7c04fded 加入 handler 表，
      // 按字母序排在 po.* 之后、recall.* 之前）。
      'prefs.getCloseToTray',
      'prefs.setCloseToTray',
      // 2026-09-30 合并 origin/develop（#389 KB 另存本地）：转写清理版
      // 「另存到本地文件夹…」的落盘通道，随 develop 正常演进登记。
      'library.writeTextToLocal',
      // 2026-10-08 安全与信任模块（skill-sentry v2.2.0 引擎 + v3 页面）：
      // 详情扫描、跨技能组合风险、风险接受（列表/接受/撤销）与回执导出。
      // 实现在 features/security/**；accept / revoke 只接受内部技能 id，外部技能
      // 一律返回 external_skill_readonly，不会写用户自己的 ~/.claude 目录。
      'skills.security.report',
      'skills.security.composition',
      'skills.security.acceptances',
      'skills.security.accept',
      'skills.security.revoke',
      'skills.security.export',
    ];
    expect(sneaked.sort(), '出现未登记的新通道').toEqual([...registeredPost014].sort());
    expect(removed, '014 期间不应删除通道').toEqual([]);
  });
});
