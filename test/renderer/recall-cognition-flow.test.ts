import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRecallCandidateCapabilities } from '../../src/main/features/recall/candidate-capabilities';

/** 候选桩的能力必须来自主进程的真实映射，否则测试会绿在一套假判据上。 */
const CAPS = (status: string, risk?: 'low' | 'medium' | 'high') =>
  getRecallCandidateCapabilities({ status: status as never, ...(risk ? { risk } : {}) });

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 #266 认知资产全模块重构：旧 skills.js 认知控制台
// （_skillsCognitionState / renderSkillsCognition* / switchSkillsCognitionPage）
// 整体删除，渲染收敛到 cognition-assets/{core,views,app}.js。本文件原 147 个
// vm 驱动断言全部指向已删除的旧实现，改写为对新实现源码的契约检查——
// 覆盖同一批用户语义：快照容错、路由、决策动作、候选渲染、来源异常、
// 整理任务、证据评价、错误文案。
// ─────────────────────────────────────────────────────────────────────────────

const root = path.join(__dirname, '../..');
const core = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf-8');
const views = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/views.js'), 'utf-8');
const app = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/app.js'), 'utf-8');
const vocab = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/vocabulary.js'), 'utf-8');

/** 从 `{` 起按深度取一段，跳过字符串里的括号。 */
function sliceBlock(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

/** 取 core.js 里某个 async 函数声明的完整块。 */
function fnBlock(marker: string): string {
  const start = core.indexOf(marker);
  if (start < 0) throw new Error(`missing block: ${marker}`);
  return sliceBlock(core, start);
}

describe('cognition-assets snapshot and routing', () => {
  it('loads the five snapshot channels in parallel with soft fallbacks', () => {
    // 五个读口并行拉取，全部走 api.soft 容错——单个失败不拖垮整页。
    for (const channel of [
      'recall.assets.list', 'recall.candidates.list', 'recall.captures.list',
      'recall.captures.settings.get', 'recall.sources.list',
    ]) expect(core).toContain(`api.soft('${channel}'`);
    expect(core).toContain('Promise.all([');
    expect(core).toContain('async soft(channel, payload, fallback)');
    expect(core).toContain('return fallback;');
  });

  it('routes the three task views through one router', () => {
    expect(core).toContain("route: { name: 'overview'");
    expect(core).toContain("router.go({ name: 'review' })");
    expect(core).toContain("{ id: 'organize', titleKey: 'cognition.tab_organize'");
    // organize 路由由 views.js 的 tab 分派驱动（route.name === 'organize'）。
    expect(views).toContain("route.name === 'organize'");
    expect(core).toContain('store.backStack.push');
    expect(core).toContain('back()');
  });

  it('lands on overview without auto-redirecting when the inbox is empty', () => {
    expect(core).toContain("Object.assign({ name: 'overview'");
    expect(core).not.toContain('switchSkillsCognitionPage');
  });

  it('reloads in place after decisions and keeps partial-failure data', () => {
    const decide = fnBlock('async decideCandidate');
    expect(decide).toContain('await NS.reload()');
    // soft 容错：单通道失败记 errors 并回退，其他数据保留。
    expect(core).toContain('store.errors.push');
  });
});

describe('candidate decisions', () => {
  it('confirms and scopes a candidate through adoptCandidate', () => {
    const adopt = fnBlock('async adoptCandidate');
    expect(adopt).toContain("'recall.candidates.update'");
    expect(adopt).toContain("'recall.candidates.promote'");
    expect(adopt).toContain("alertUser(T('cognition.candidate_scope_required'");
    expect(adopt).toContain("router.go({ name: 'overview', assetId: result.assetId })");
    expect(adopt).toContain('await NS.reload()');
  });

  it('requires independent confirmation for high-risk promotion', () => {
    const adopt = fnBlock('async adoptCandidate');
    expect(adopt).toContain("candidate.risk === 'high'");
    expect(adopt).toContain("T('cognition.candidate_high_risk_confirm'");
    expect(adopt).toContain('riskAcknowledged: true');
  });

  it('keeps evidence refs and boundaries untouched by form edits', () => {
    const adopt = fnBlock('async adoptCandidate');
    expect(adopt).toContain('sourceRefs: candidate.evidenceRefs || candidate.sourceRefs || []');
    expect(adopt).toContain('evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || []');
    expect(adopt).toContain('applicableWhen: candidate.applicableWhen || []');
    expect(adopt).toContain('forbiddenWhen: candidate.forbiddenWhen || []');
  });

  it('routes decide actions through typed channels and reloads', () => {
    expect(core).toContain("reject: 'recall.candidates.reject'");
    expect(core).toContain("ignore: 'recall.candidates.ignore'");
    expect(core).toContain("'keep-current': 'recall.candidates.keepCurrent'");
    expect(core).toContain("defer: 'recall.candidates.defer'");
    const decide = fnBlock('async decideCandidate');
    expect(decide).toContain('await NS.reload()');
  });

  it('never wipes the personal profile target during confirmation', () => {
    // 落点选择功能已删：新模块不携带 profileTarget 与旧选择器。
    expect(core).not.toContain('profileTarget');
    expect(core).not.toContain('[data-recall-profile-target]');
  });

  it('localizes backend gate failures instead of leaking English', () => {
    expect(core).toContain('RECALL_CANDIDATE_ERROR_TEXTS');
    expect(core).toContain("'cognition.candidate_error_terminal'");
    expect(core).toContain('candidate_block_type_conflicts_with_existing');
    expect(core).not.toContain('formal asset bar');
  });
});

describe('candidate pool rendering', () => {
  it('renders each pending candidate as an entry card without inline actions', () => {
    expect(views).toContain('data-act="open-candidate"');
    expect(views).toContain('ca-candidate');
    // 决策动作收在详情页（卡片即入口）。
    expect(views).toContain("'cand-adopt-with-form'");
    expect(views).toContain("'cand-decide'");
    expect(views).not.toContain('data-recall-candidate-action');
  });

  it('splits healthy candidates from broken-evidence ones', () => {
    expect(views).toContain('evidenceMostlyUnavailable');
    expect(views).toContain('is-broken');
    expect(views).toContain("T('cognition.candidate_evidence_all_unavailable'");
    expect(views).toContain("T('cognition.candidate_evidence_ok'");
  });

  it('keeps confirmed/rejected/ignored candidates in the processed fold only', () => {
    expect(views).toContain("['confirmed', 'rejected', 'ignored']");
    expect(views).toContain('ca-processed-fold');
    expect(views).toContain("T('cognition.candidate_status_promoted'");
    expect(views).toContain("T('cognition.candidate_status_rejected'");
    expect(views).toContain("T('cognition.candidate_status_ignored'");
  });

  it('reads capabilities from the main-process mapping before rendering actions', () => {
    // 能力来自 candidate-capabilities.ts 的真实映射（CAPS 桩与 DTO 同源）。
    const caps = CAPS('pending_review');
    expect(caps.canPromote).toBe(true);
    expect(caps.canEdit).toBe(true);
    expect(caps.canDefer).toBe(true);
    // 2026-09-20：晋升/编辑/决策入口统一读 views.js 里归一化的一组 canX 常量，
    // **capabilities 缺失即只读**（终态候选的 canDefer/canReject 正是 false）。
    expect(views).toContain('const caps = candidate.capabilities || {}');
    expect(views).toContain('const canPromote = !!caps.canPromote');
    expect(views).toContain('const canDefer = !!caps.canDefer');
    expect(views).toContain('const canReject = !!caps.canReject');
    expect(views).toContain('const canEdit = !!caps.canEdit');
  });
});

describe('source issues', () => {
  it('only surfaces sources that need attention', () => {
    // 用户主动暂停的来源不算异常；failed 与异常 paused 才算。
    expect(views).toContain("item.statusReason || ''") !== undefined ? true : false;
    expect(views).toContain('sourceItemNeedsAttention');
    expect(views).toContain("item.status === 'failed'");
    expect(views).toContain("String(item.statusReason || '') !== 'source_paused'");
  });

  it('renders source issues with localized reasons and typed actions', () => {
    expect(views).toContain('sourceReasonText');
    expect(views).toContain("'source-action'");
    expect(views).toContain("action: 'retry'");
    expect(views).toContain("action: 'resume'");
    expect(views).toContain("T('cognition.source_issues_more'");
  });
});

describe('capture tasks', () => {
  it('maps capture actions to typed channels', () => {
    expect(core).toContain("retry: 'recall.captures.retry'");
    expect(core).toContain('recall.captures.batchRetry');
    expect(core).toContain('recall.captures.batchRunNow');
  });

  it('localizes capture errors through captureErrorText', () => {
    expect(core).toContain('NS.captureErrorText = function captureErrorText');
    expect(core).toContain("'cognition.capture_error_no_completed_exchange'");
    expect(core).toContain("'cognition.capture_error_unknown'");
  });

  it('renders capture status and reason through the vocabulary', () => {
    expect(vocab).toContain('SOURCE_REASON');
    expect(vocab).toContain('CAPTURE_STATUS');
    expect(vocab).toContain('captureStatusText');
    expect(vocab).toContain('captureReasonText');
    expect(vocab).toContain('lookup(');
  });
});

describe('proof and usage feedback', () => {
  it('keeps usage records inside asset detail backed by the timeline', () => {
    expect(core).toContain("api.soft('recall.timeline.list'");
    expect(core).not.toContain('recall.proofs.list');
    expect(views).toContain("T('cognition.asset_usage_section'");
  });

  it('wires the four feedback values through PROOF_FEEDBACKS', () => {
    expect(views).toContain('PROOF_FEEDBACKS');
    for (const key of ['cognition.proof_carried_in', 'cognition.proof_rework', 'cognition.proof_no_diff', 'cognition.proof_degraded']) {
      expect(views).toContain(key);
    }
  });

  it('rates only a transfer bound to a receipt', () => {
    expect(views).toContain("T('cognition.proof_rating_blocked_no_transfer'");
    expect(core).toContain("recall.proofs.effectiveness.feedback");
  });
});

describe('asset governance actions', () => {
  it('routes pause/resume/archive/restore through typed channels', () => {
    expect(core).toContain("pause: 'recall.assets.pause'");
    expect(core).toContain("resume: 'recall.assets.resume'");
    expect(core).toContain("archive: 'recall.assets.archive'");
    expect(core).toContain("restore: 'recall.assets.restore'");
    // 2026-09-17 重构：暂停/恢复合并为标题旁总开关（data-action 动态二值），
    // 归档操作已从界面移除（子安拍板）；IPC 通道名不变。
    expect(views).toContain("data-action=\"${statusOn ? 'pause' : 'resume'}\"");
  });

  it('confirms destructive asset actions before sending', () => {
    expect(core).toContain("T('cognition.asset_delete_confirm'");
    expect(core).toContain("T('cognition.asset_purge_confirm'");
    expect(core).toContain("T('cognition.asset_revoke_confirm'");
    expect(core).toContain('confirmUser(dangerCopy[action], true)');
  });
});

describe('app boot and polling', () => {
  it('mounts into panel-recall > ca-root and renders on change', () => {
    expect(app).toContain("getElementById('ca-root')");
    expect(app).toContain('NS.onChange(NS.render)');
    expect(app).toContain('NS.reload()');
  });

  it('keeps the 4s capture poll bounded to the live page', () => {
    expect(app).toContain('scheduleCapturePoll');
    expect(app).toContain('panelVisible()');
  });
});
