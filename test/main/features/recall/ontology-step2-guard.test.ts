/**
 * IPC 通道集合守卫：比较当前通道、冻结基线和后续登记项。
 *  后续认知资产演进新增通道须逐项登记在 registeredPost014；集合仍精确比较，
 *  拒绝未登记的新增与删除；退役通道由 retiredFormationChannels 声明。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
// Registered handlers may be moved to the cognition module without retiring channels.
const ipcSource = ['index.ts', 'cognition.ts'].map(file => fs.readFileSync(path.join(ROOT, 'src/main/ipc', file), 'utf8')).join('\n');

describe('IPC 通道登记一致性', () => {
  it('③ IPC 通道与 014 基线一致，且只允许已登记的后续迁移通道', () => {
    const current = [...ipcSource.matchAll(/^  '([A-Za-z0-9_.-]+)':/gm)].map((m) => m[1]);
    expect(current.length).toBeGreaterThan(300); // 解析护栏：抓不到通道说明正则失效
    const baseline = fs.readFileSync(path.join(__dirname, 'fixtures/ipc-channel-baseline-014.txt'), 'utf8')
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const sneaked = [...new Set(current)].filter((name) => !baseline.includes(name));
    const removed = baseline.filter((name) => !current.includes(name));
    const registeredPost014 = [
      // Restore host-owned correction choices after history repaint/restart.
      'transcript_glossary.pending',
      'transcript_glossary.confirm',
      'transcript_glossary.visible',
      // 本体时点快照导出、命令与历史入口。
      'cognition.ontology.export',
      // Versioned graph snapshots and explicit host-owned graph generation.
      'cognition.ontology.graph.snapshot',
      'cognition.ontology.graph.generate',
      'cognition.ontology.command.commit',
      'cognition.ontology.command.preview',
      // 本体权限批量放开（PR #216）：读取授权的预览与放开走独立通道，不并入 command.*。
      'cognition.ontology.access.preview',
      'cognition.ontology.access.promote',
      // 本体字段编辑走主档命令、回执与回读。
      'cognition.ontology.document.edit',
      'cognition.ontology.history.get',
      'cognition.ontology.history.archive',
      'cognition.ontology.module.lifecycle',
      'cognition.ontology.search',
      'cognition.ontology.snapshot',
      // Manual automation execution uses the existing authenticated IPC router.
      'autoTasks.runNow',
      // Agent replies cite workspace files as inline code (often `.../<dir>/<file>`);
      // the renderer resolves them through the file-action sandbox to open them.
      'workspace.resolvePathHints',
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
      // 2026-09-21 插件平台 OAuth 授权链路（specs/001-plugin-oauth-auth，自
      // feat/space-project-dir 迁移）：发起授权 / 查询状态 / 浏览器回调落地 / 解绑。
      // 实现在 features/plugin_oauth_flow.ts；令牌只落本机，不进日志与聊天。
      // 按字母序排在 po.* 之后。
      'packages.auth.callback',
      'packages.auth.disconnect',
      'packages.auth.start',
      'packages.auth.status',
      // 2026-09-30 托盘常驻：关闭到托盘的偏好通道（7c04fded 加入 handler 表，
      // 按字母序排在 po.* 之后、recall.* 之前）。
      'prefs.getCloseToTray',
      // 关联资产超过形成上限时的清单与合并/保留处置（不建候选）。
      'recall.captures.relatedOverflow.list',
      'recall.captures.relatedOverflow.resolve',
      // waiting_approval 区分等待批准与执行中；返回会话 id 列表供页面同步。
      'conversations.waitingApproval',
      'prefs.setCloseToTray',
      // 转写清理版另存到用户选择的本地文件夹。
      'library.writeTextToLocal',
      // 技能安全扫描、组合风险、风险接受与回执导出。
      // 实现在 features/security/**；accept / revoke 只接受内部技能 id，外部技能
      // 一律返回 external_skill_readonly，不会写用户自己的 ~/.claude 目录。
      'skills.security.report',
      'skills.security.composition',
      'skills.security.acceptances',
      'skills.security.accept',
      'skills.security.revoke',
      'skills.security.export',
      // Agent 安装前的依赖预览。
      // 与 installAgent 共用同一份依赖规划，不写本机。
      'marketplace.agentInstallPlan',
      // 夜间筛选聚合计数只读通道。
      'recall.captures.stats',
      // Nightly formation undo and the explicit manual sweep share canonical handlers.
      'recall.candidates.undoAutomatic',
      'recall.candidates.undoAutomaticPreview',
      'recall.captures.sweep.run',
      'recall.captures.sweep.stop',
      // 候选内容组织结果的可撤销预览、撤销与更新入口。
      'recall.candidates.organization.undoPreview',
      'recall.candidates.organization.undo',
      'recall.candidates.organization.update',
      // 用户标记稍后，候选保留在需要关注中。
      // 独立 candidate-defer 服务保留生命周期与来源，不恢复旧 deferred 静音语义。
      'recall.candidates.defer',
      // 候选历史与审核依据的只读查询。
      'recall.candidates.history',
      'recall.reviewEvidence.read',
      // 多条关联内容的一次性处置：合并旧内容后由所属整理任务重判，或保留全部。
      'recall.candidates.resolveRelated',
      // 用户确认已校验的旧内容整理方案，资产与候选回执同一次提交。
      'recall.candidates.oldContent.confirm',
      // 独立旧内容方案：列表、读取、按资产查询、逐项修订、执行、放弃。
      'recall.oldContent.plan.list',
      'recall.oldContent.plan.review',
      'recall.oldContent.plan.undoPreview',
      'recall.oldContent.plan.undo',
      'recall.oldContent.plan.read',
      'recall.oldContent.plan.forAssets',
      'recall.oldContent.plan.resolve',
      'recall.oldContent.plan.update',
      'recall.oldContent.plan.execute',
      'recall.oldContent.plan.dismiss',
      // 候选收尾：先提交旧内容，再保存新内容，失败可重试。
      'recall.candidates.finalize',
      // 编辑夜间候选后重核关联本体，更新预览，保存需确认。
      'recall.candidates.recheckOntologyFormation',
      // 推理强度按模型声明的能力提供，用户的选择持久化到
      // 该模型（切模型回落 Auto）。读全量小表用于渲染层预取，写单条用于点选落盘。
      'prefs.getModelThinkingLevels',
      'prefs.setModelThinkingLevel',
      // A2A contacts MVP: account-level contact management, per-conversation
      // reception/relay, explicit new/continue sends, and its two consent toggles.
      'contacts.list',
      'contacts.lookupByPhone',
      'contacts.requests',
      'contacts.requestAdd',
      'contacts.acceptRequest',
      'contacts.rejectRequest',
      'contacts.remove',
      'contacts.setDefaultScope',
      'contacts.history',
      'a2a.consultations.list',
      'a2a.consultations.create',
      'a2a.consultations.nudge',
      'a2a.consultations.answer',
      'a2a.reception.preview',
      'a2a.reception.confirm',
      'a2a.reception.pending',
      'a2a.reception.decline',
      'a2a.conversations.listForContact',
      'a2a.conversation.prepare',
      'a2a.question.send',
      'a2a.conversationMarker',
      'prefs.getA2A',
      'prefs.setA2A',
      'kb.download',
      'p3394.requeueIsolatedOutbox',
      'skills.getGlobalRootsEnabled',
      'skills.setGlobalRootsEnabled',
      'skills.trust.cancel',
      // S5 Hub 模板：只读的目录列表 / 详情与本机依赖检查（specs/010 contracts/ui-and-ipc.md）。
      'templates.catalog.list',
      'templates.catalog.detail',
      'templates.refs.resolve',
      'spaces.createFromTemplate',
    ];
    expect(sneaked.sort(), '出现未登记的新通道').toEqual([...registeredPost014].sort());
    // 排除已退役的形成入口；其他基线通道禁止无登记删除。
    const retiredFormationChannels = ["recall.captures.retry", "recall.captures.pause", "recall.captures.resume", "recall.captures.cancel", "recall.captures.runNow", "recall.captures.batchRetry", "recall.captures.batchRunNow", "recall.captures.manualCreate", "recall.captures.historicalAutoStart", "recall.candidates.save", "recall.memory.migrate", "recall.scopedMemoryMigration.preview", "recall.scopedMemoryMigration.run", "cognition.capture.draft", "recall.candidates.importPersonalOntology", "personalOntology.candidates.transferToRecall", "cognition.ontology.import.submit", "transcript.correct.proposeCandidate"];
    expect(removed.sort()).toEqual(baseline.filter(name => retiredFormationChannels.includes(name)).sort());
  });

  it('registers graph channels through the canonical cognition handlers and preload invoke bridge', () => {
    const cognition = fs.readFileSync(path.join(ROOT, 'src/main/ipc/cognition.ts'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'src/main/ipc/index.ts'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
    for (const channel of ['cognition.ontology.graph.snapshot', 'cognition.ontology.graph.generate']) {
      expect([...cognition.matchAll(/^  '([^']+)':/gm)].filter(match => match[1] === channel)).toHaveLength(1);
      expect(main).not.toContain(`'${channel}':`);
    }
    expect(cognition).toContain('entries: await listGraphSnapshotEntries(ctx.userId)');
    expect(cognition).toContain('await requestGraphGeneration({ userId: ctx.userId, scope,');
    expect(main).toContain("invokeHandlers as cognitionHandlers, ontologyErrorDetails } from './cognition'");
    expect(main).toContain('...(cognitionHandlers as Record<string, unknown>)');
    // Invoke channel names travel in the envelope; preload has no per-name invoke list.
    expect(preload).toMatch(/function invoke\(channel, payload\)\s*\{\s*return ipcRenderer\.invoke\('cogseed\.invoke', \{ channel, payload: payload \|\| \{\} \}\);\s*\}/);
    expect(preload).toMatch(/const cogseedApi = \{[\s\S]*?\n  invoke,/);
    expect(preload).toContain("contextBridge.exposeInMainWorld('cogseed', cogseedApi)");
    expect(main).toContain('const handler = invokeHandlers[channel]');
  });
});
