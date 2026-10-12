/**
 * meeting.* IPC — 会议引用层（specs/013 · contracts/ipc.md · T013）
 *
 * 分层规则（照 transcript.ts:3-6，AGENTS.md §Layering）：本文件只做
 * **参数收敛 + 调用 features**，不写业务逻辑。所有 feature 调用都把
 * `ctx.userId` 作为首参，因此不存在"用当前活跃用户写别人的库"这条隐式路径。
 *
 * 通道列表（contracts/ipc.md §1 的完整规划；⏳ = features 未就绪，接线随
 * 对应任务（T034/T040/T050/T053/T054）补，不在 IPC 层预写空壳）：
 *   meeting.doc.get            —— 读统一文档模型（惰性创建；create:false 只读探测）
 *   meeting.assets.attach      —— 挂载资产引用（冻结版，幂等不覆盖 version）
 *   meeting.assets.detach      —— 摘除引用（只摘引用，不动资产）
 *   meeting.assets.list        —— 引用清单（现状对比/stale 是读时派生，T037）
 *   meeting.conclusions.list / save / confirm —— 纪要条目（T034）
 *   meeting.conclusions.precipitate —— 已退役（2026-09-29 第 5 批：渲染层零调用，
 *                                      且与「会议内容不进认知主线」红线冲突）
 *   meeting.actions.list / confirm / discard —— 待办草稿（T040~T042；confirm 是
 *   唯一落点入口，内部过外发闸 assertActionDraftSendable；save 属后续任务）
 *   meeting.refs.related       —— 跨会议关联（T050，只读只给建议，不自动建立；
 *                                 历史缺结构化引用 ⇒ 该条不进结果不报错，T052）
 *   meeting.receipts.list    —— 回执汇总（T053，读既有 review-decision 账本过滤）
 *   meeting.metrics.summary  —— 会议指标（T054/T055，独立文件 meeting-metrics.jsonl）
 *
 * 错误口径：features 抛 `MeetingRefError` / `MeetingDocError` /
 * `MeetingConclusionError` / `MeetingActionDraftError`（均带稳定 code 字段），
 * ipc/index.ts 的 dispatcher 会把 `err.code` 透传到 `{ ok:false, code }`——
 * 渲染层按 code 翻四语（kb.meetingRef.error_*），不上屏英文原文。
 */

import { safeId } from '../storage';
import * as meetingDoc from '../features/meeting_doc';
import * as meetingRefs from '../features/meeting_refs';
import * as meetingConclusions from '../features/meeting_conclusions';
import * as meetingActionDrafts from '../features/meeting_action_drafts';
import * as meetingMetrics from '../features/meeting_metrics';

interface IpcContext {
  userId: string;
}

type Payload = Record<string, unknown>;

/** `docId` 非空 ≤1000（与 meeting_doc/meeting_refs 的 MAX_DOC_ID_CHARS 同界）。 */
function requireDocId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > meetingDoc.MAX_DOC_ID_CHARS) {
    throw new meetingDoc.MeetingDocError('invalid meeting docId', 'invalid_doc_id');
  }
  return id;
}

/** `assetId` 形状 + `safeId`（契约 §1.2：id 过 safeId，路径语义交给 features）。 */
function requireAssetId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 128 || !safeId(id)) {
    throw new meetingRefs.MeetingRefError('invalid meeting assetId', 'invalid_asset_id');
  }
  return id;
}

/** `via ∈ {attach, conclusion, action_draft}`（缺省 attach；语义归 features）。 */
function optionalVia(value: unknown): meetingRefs.MeetingRefVia | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'attach' || value === 'conclusion' || value === 'action_draft') return value;
  throw new meetingRefs.MeetingRefError('invalid meeting ref via', 'invalid_via');
}

/** 结论条目 id：非空 ≤128（confirm/precipitate 共用；形状外的语义归 features）。 */
function requireConclusionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > meetingConclusions.MAX_CONCLUSION_ID_CHARS) {
    throw new meetingConclusions.MeetingConclusionError('invalid meeting conclusion id', 'invalid_item_id');
  }
  return id;
}

/** 草稿 id：非空字符串（长度/形态的细判在 features，码域同 invalid_input 族）。 */
function requireDraftId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) {
    throw new meetingActionDrafts.MeetingActionDraftError('invalid meeting action draft id', 'invalid_input');
  }
  return id;
}

/** 可选 `docId`：缺省 undefined（= 全库口径）；给出时与必填同界（§1.6/§1.7）。 */
function optionalDocId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > meetingDoc.MAX_DOC_ID_CHARS) {
    throw new meetingDoc.MeetingDocError('invalid meeting docId', 'invalid_doc_id');
  }
  return id;
}

/** `limit` 1~200（契约 §1.6；越界按形状拒绝——静默夹取会掩盖调用方口径错误）。 */
function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const limit = Math.floor(Number(value));
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    throw new meetingDoc.MeetingDocError('invalid meeting receipts limit', 'invalid_input');
  }
  return limit;
}

/**
 * `assetIds` 清单（契约 §1.5：每项过 `safeId`、整表 ≤50）。给出但形状不合法 ⇒
 * 按形状拒绝（invalid_asset_id 族）；缺省 ⇒ undefined（features 按「空路」处理）。
 */
function optionalAssetIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new meetingDoc.MeetingDocError('invalid meeting related assetIds', 'invalid_input');
  }
  return value.map((item) => requireAssetId(item));
}

/** `terms` 清单（契约 §1.5：每项非空 ≤60、整表 ≤20；越界按形状拒绝）。 */
function optionalTerms(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new meetingDoc.MeetingDocError('invalid meeting related terms', 'invalid_input');
  }
  return value.map((item) => {
    const term = typeof item === 'string' ? item.trim() : '';
    if (!term || term.length > 60) {
      throw new meetingDoc.MeetingDocError('invalid meeting related term', 'invalid_input');
    }
    return term;
  });
}

export const invokeHandlers = {
  // ── 统一文档模型 ───────────────────────────────────────────────────────
  /**
   * `meeting.doc.get`：读/建/刷新会议文档（contracts/ipc.md §1.1）。
   * `displayPath` 只作展示标题（≤120 由 features 兜底截断）；说话人由主进程
   * 现算（渲染层不传正文/说话人，防时钟格式漂移事故）。`create:false` 且缺失
   * → `doc:null`（只读探测，不报错）。
   */
  'meeting.doc.get': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const displayPath = typeof payload?.displayPath === 'string' ? payload.displayPath.trim() : '';
    if (displayPath.length > meetingDoc.MAX_TITLE_CHARS) {
      throw new meetingDoc.MeetingDocError('invalid meeting doc displayPath', 'invalid_input');
    }
    const create = payload?.create !== false;
    const doc = meetingDoc.getMeetingDoc(ctx.userId, docId, {
      create,
      ...(displayPath ? { title: displayPath } : {}),
    });
    return { doc, degraded: doc?.degraded ?? [] };
  },

  // ── 资产引用包 ─────────────────────────────────────────────────────────
  /**
   * `meeting.assets.attach`：挂载/确认一条资产引用（contracts/ipc.md §1.2）。
   * 准入判据、冻结版取值、幂等语义全在 meeting_refs（IPC 不重算）。
   */
  'meeting.assets.attach': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const assetId = requireAssetId(payload?.assetId);
    const via = optionalVia(payload?.via);
    const { ref, pack } = await meetingRefs.attachMeetingAsset(ctx.userId, docId, assetId, via);
    return { ref, pack };
  },

  /** `meeting.assets.detach`：摘除一条引用（幂等：不存在时返回当前包）。 */
  'meeting.assets.detach': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const assetId = requireAssetId(payload?.assetId);
    const pack = await meetingRefs.detachMeetingAsset(ctx.userId, docId, assetId);
    return { pack };
  },

  /**
   * `meeting.assets.list`：本会议的引用清单（只读；缺失 → 空数组）。
   * 返回**读时派生视图** `MeetingAssetRefView[]`（contracts/ipc.md §1.2：
   * currentVersion/currentTitle/stale/available 现算，不落库——冻结版永不回写）。
   */
  'meeting.assets.list': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const refs = await meetingRefs.listMeetingAssetRefViews(ctx.userId, docId);
    return { refs };
  },

  // ── 纪要条目（T034 save/list/confirm + T046 precipitate）──────────────
  /** `meeting.conclusions.list`：本会议的纪要结论清单（只读；缺失 → 空数组）。 */
  'meeting.conclusions.list': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    return { conclusions: meetingConclusions.listMeetingConclusions(ctx.userId, docId) };
  },

  /** `meeting.conclusions.save`：保存/编辑一条结论（幂等 upsert；语义全在 features）。 */
  'meeting.conclusions.save': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const conclusion = meetingConclusions.saveMeetingConclusion(
      ctx.userId,
      docId,
      (payload?.conclusion ?? {}) as meetingConclusions.MeetingConclusionInput,
      {
        ...(payload?.id !== undefined ? { id: String(payload.id) } : {}),
        ...(typeof payload?.text === 'string' ? { text: payload.text } : {}),
      },
    );
    return { conclusion };
  },

  /** `meeting.conclusions.confirm`：确认一条结论（draft → confirmed；零候选/资产副作用）。 */
  'meeting.conclusions.confirm': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const conclusion = meetingConclusions.confirmMeetingConclusion(
      ctx.userId,
      docId,
      requireConclusionId(payload?.conclusionId),
    );
    return { conclusion };
  },

  // 2026-09-29 第 5 批·退役：`meeting.conclusions.precipitate` 通道移除——渲染层
  // 零调用（注册后从未接线），且与既有红线冲突：会议纪要不进认知主线（capture
  // 侧 personal 明确排除会议内容；kb-meeting-refs 引用链只依赖资产 id/版本/标题
  // /摘要）。服务函数 precipitateMeetingConclusion 保留在 features 层，随
  // 「通道退役大批」统一处置；contracts/ipc.md §1.3 的对应条目同步作废。

  // ── 待办草稿（T040~T042：默认 draft、状态机封闭、外发闸唯一处）──────────
  /** `meeting.actions.list`：本会议的待办草稿清单（只读；draft 态照常返回，可续办）。 */
  'meeting.actions.list': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    return { drafts: meetingActionDrafts.listActionDrafts(ctx.userId, docId) };
  },

  /**
   * `meeting.actions.confirm`：确认一条草稿（draft → confirmed）。
   * **唯一**允许触发落点的通道：`target` 给出时再走 `applyActionDraftTarget`，
   * 落点写入在 features 内部先过外发闸 `assertActionDraftSendable`（T041）——
   * IPC 只校验 `kind` 形状（`invalid_target` 语义按 §1.4 码化为 invalid_input 族）。
   */
  'meeting.actions.confirm': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const draftId = requireDraftId(payload?.draftId);
    let draft = meetingActionDrafts.confirmActionDraft(ctx.userId, docId, draftId);
    const target = payload?.target;
    if (target !== undefined && target !== null) {
      if (typeof target !== 'object') {
        throw new meetingActionDrafts.MeetingActionDraftError('invalid meeting action target', 'invalid_input');
      }
      const kind = (target as { kind?: unknown }).kind;
      if (kind !== 'local' && kind !== 'scheduled_task' && kind !== 'session_task') {
        throw new meetingActionDrafts.MeetingActionDraftError('invalid meeting action target kind', 'invalid_input');
      }
      const rawRef = (target as { ref?: unknown }).ref;
      const ref = typeof rawRef === 'string' ? rawRef : undefined;
      draft = meetingActionDrafts.applyActionDraftTarget(
        ctx.userId,
        docId,
        draftId,
        { kind, ...(ref !== undefined ? { ref } : {}) },
      );
    }
    return { draft };
  },

  /** `meeting.actions.discard`：丢弃一条草稿（draft → discarded；条目保留，显示取舍在渲染层）。 */
  'meeting.actions.discard': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    return { draft: meetingActionDrafts.discardActionDraft(ctx.userId, docId, requireDraftId(payload?.draftId)) };
  },

  // ── 跨会议关联（US-505 / T050+T052：只读建议，不自动建立引用）────────────
  /**
   * `meeting.refs.related`（contracts/ipc.md §1.5）：确定性「上次提到」检索——
   * 按 `assetIds` 反查历史结论的 assetRefs + 按 `terms` 对挂载资产规范名做
   * 折叠等值命中（判据全在 meeting_refs，IPC 只收敛参数）；**不走语义、不走
   * 模型**。两路都空 ⇒ 空数组（不报错）；历史缺结构化引用的条目不进结果
   * （T052 降级）。只给建议——建立引用只能走面板点按 `meeting.assets.attach`
   * / `meeting.conclusions.save`（T051，不新建写通道）。
   */
  'meeting.refs.related': async (payload: Payload, ctx: IpcContext) => {
    const docId = requireDocId(payload?.docId);
    const assetIds = optionalAssetIds(payload?.assetIds);
    const terms = optionalTerms(payload?.terms);
    return {
      related: await meetingRefs.relatedMeetingRefs(ctx.userId, {
        docId,
        ...(assetIds !== undefined ? { assetIds } : {}),
        ...(terms !== undefined ? { terms } : {}),
      }),
    };
  },

  // ── 回执与指标（US-506：读既有账本过滤 + 独立读口，不混流）──────────────
  /**
   * `meeting.receipts.list`：会议侧回执（contracts/ipc.md §1.6）。
   * 读**既有** review-decision 账本按 `meeting:` 前缀过滤（features 层）；
   * `docId` 可选收窄，`limit` 1~200 缺省 50（越界如实的按形状拒绝，不静默夹取）。
   */
  'meeting.receipts.list': async (payload: Payload, ctx: IpcContext) => {
    const docId = optionalDocId(payload?.docId);
    const limit = optionalLimit(payload?.limit);
    return {
      receipts: await meetingMetrics.listMeetingReceipts(
        ctx.userId,
        { ...(docId !== undefined ? { docId } : {}), ...(limit !== undefined ? { limit } : {}) },
      ),
    };
  },

  /**
   * `meeting.metrics.summary`：五口径汇总（contracts/ipc.md §1.7）。
   * 读**独立文件** meeting-metrics.jsonl（与既有 transcript.metrics.summary
   * 两数据源两读口，互不混流）；`docId` 缺省 = 全库会议累计。文件缺失/全坏行
   * ⇒ features 返回全 0 + `rate:null`（不编数字）。
   */
  'meeting.metrics.summary': async (payload: Payload, ctx: IpcContext) => {
    const docId = optionalDocId(payload?.docId);
    const summary = meetingMetrics.summarizeMeetingMetrics(
      meetingMetrics.readMeetingEvents(ctx.userId),
      docId !== undefined ? { docId } : {},
    );
    return { summary };
  },
};
