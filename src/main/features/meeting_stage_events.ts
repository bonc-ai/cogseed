/**
 * 会议环节完成事件 —— 会议域唯一的「环节完成」广播口。
 *
 * 为什么需要这个模块（现状调查结论，见 specs/009-meeting-output-archive/research.md R1）：
 *   - 宿主侧**没有**会议要求的状态机/阶段枚举 —— 所谓「7 步会议流程」只写在 Agent 提示词里；
 *   - 会议域五个 `meeting_*.ts` 与两个 IPC 文件**零事件总线**（无 EventEmitter / 无 emit / 无 listener）；
 *   - 唯一既有埋点口 `meeting_metrics.recordMeetingMetric` 的五类事件里**四类在生产中零调用**
 *     （仅测试写入），不能当作业务触发源。
 * 因此会议产物沉淀需要一个新的、语义明确的环节完成广播 —— 就是本模块。
 *
 * 设计约束（对应 specs/009-meeting-output-archive/contracts/README.md A1）：
 *   1. 事件在构造时 `Object.freeze`，监听者拿到的是不可变快照，不能反向影响发出方；
 *   2. 派发时**逐个 listener 包 try/catch** —— 单个监听者抛错不影响其他监听者，更不影响调用方；
 *   3. `emitMeetingStage` **永不向外抛异常**、**不是 async**。会议主流程不得因沉淀失败而失败
 *      （规格 FR-004）。沉淀的异步工作由监听者自行调度，不在此处等待。
 *
 * 与既有 `group_chat/bus.ts::subscribeTaskTerminals` 同构 —— 那套「冻结事件 + 逐监听者容错」
 * 的形态已在本仓库验证可用（bus.ts:1710 / :2098 / :2126-2130），此处复用同一模式而非另造一套。
 *
 * 发出时机纪律：调用方 MUST 在**写入成功之后**才发事件。若写入成功但事件发出前进程崩溃，
 * 该产物只能靠任务终态兜底补上（规格 FR-033）—— 这是刻意的取舍：宁可依赖兜底，
 * 也不在写入未确认时乐观发事件。
 */

import { createLogger } from '../logger';

const log = createLogger('meeting-stage-events');

/** 会议环节。新增环节必须同时更新本枚举与沉淀编排的映射，否则事件会被静默忽略。 */
export type MeetingStage =
  /** 转写纠错已应用（CorrectionRun: draft → applied）。 */
  | 'transcript_applied'
  /** 清理版另存（到知识库或到本地）。 */
  | 'cleaned_copy_saved'
  /** 纪要条目已确认（MeetingConclusion: → confirmed）。 */
  | 'conclusion_confirmed'
  /** 待办草稿已确认（MeetingActionDraft: → confirmed）。 */
  | 'action_confirmed'
  /** 待办草稿已丢弃（MeetingActionDraft: → discarded）。沉淀方**必须忽略**该事件。 */
  | 'action_discarded';

/** 沉淀关注的产物类别（对应规格里的「会议四件套」）。 */
export type MeetingArtifactKind =
  | 'transcript'
  | 'corrected_transcript'
  | 'minutes'
  | 'actions';

export interface MeetingStageEvent {
  /** 环节标识。 */
  stage: MeetingStage;
  /** 用户标识（不透明路径段；**不得**写入日志正文）。 */
  uid: string;
  /** 会议稳定标识，由 `meeting_doc.docKeyForDocId` 派生。用于归集目录命名（规格 FR-034）。 */
  docKey: string;
  /** 原始文档标识（仅供可读展示与溯源；**不得**直接用作路径段）。 */
  docId?: string;
  /** 触发环节的会话（用于目标判定与终态兜底关联；不用于目录命名）。 */
  conversationId?: string;
  /** 产物类别。 */
  artifactKind: MeetingArtifactKind;
  /** 已落盘成果的绝对路径。与 `sourceText` 至少一个存在；两者都在时以本字段为准。 */
  sourceAbsPath?: string;
  /** 尚未落盘的内容（例如清理版由渲染层传入的正文）。 */
  sourceText?: string;
  /** 该产物是否已被用户确认。决定沉淀后是否保留「未确认」标注（规格 FR-024）。 */
  confirmed: boolean;
  /** 版本标记（run id / v002 等）。存在时用作文件名后缀。 */
  version?: string;
  /** ISO 时间戳。 */
  at: string;
}

export type MeetingStageListener = (event: MeetingStageEvent) => void;

/**
 * 监听者集合挂在 `globalThis` 上，理由与 `group_chat/bus.ts` 一致：
 * 同一模块在 vitest 下可能被以 ESM 与 CJS 两种形态各加载一次，若用模块级变量，
 * 订阅方与派发方会看到**两份不同的注册表**，事件静默丢失。
 */
const LISTENERS_KEY = Symbol.for('cogseed.meetingStage.listeners');

function listeners(): Set<MeetingStageListener> {
  const g = globalThis as unknown as Record<symbol, Set<MeetingStageListener> | undefined>;
  let set = g[LISTENERS_KEY];
  if (!set) {
    set = new Set<MeetingStageListener>();
    g[LISTENERS_KEY] = set;
  }
  return set;
}

/**
 * 订阅会议环节完成事件。返回退订函数（幂等：重复调用安全）。
 * 订阅是进程内的、非持久化的 —— 与 `subscribeTaskTerminals` 语义一致。
 */
export function subscribeMeetingStages(listener: MeetingStageListener): () => void {
  const set = listeners();
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** 供测试与诊断：当前监听者数量。 */
export function meetingStageListenerCount(): number {
  return listeners().size;
}

/**
 * 派发环节事件。
 *
 * 契约保证（契约 A1）：
 *   - 事件被 `Object.freeze`，监听者无法篡改；
 *   - 单个监听者抛错只记日志，不影响其他监听者，也**不向外抛**；
 *   - 无监听者时不抛错、不阻塞；
 *   - 同步返回 —— 不等待任何异步沉淀工作。
 */
export function emitMeetingStage(event: MeetingStageEvent): void {
  let frozen: Readonly<MeetingStageEvent>;
  try {
    frozen = Object.freeze({ ...event });
  } catch (err) {
    // 构造失败属于编程错误，但同样不得影响会议主流程。
    log.warn('meeting stage event construction failed', {
      stage: event?.stage,
      error: (err as Error)?.message,
    });
    return;
  }

  // 快照监听者：派发过程中若有人订阅/退订，不影响本轮派发。
  const snapshot = [...listeners()];
  for (const listener of snapshot) {
    try {
      listener(frozen);
    } catch (err) {
      // 沉淀失败绝不能让会议环节失败（FR-004）。
      log.warn('meeting stage listener threw', {
        stage: frozen.stage,
        error: (err as Error)?.message,
      });
    }
  }
}
