/* ============================================================================
 * 认知资产 · 语义映射层（cognition-assets/vocabulary.js）
 *
 * 后端枚举 / 内部 ID 到用户话术的唯一出口。规矩：
 *  - 后端值（status / statusReason / kind / 记录 ID）禁止在视图里裸上屏，
 *    一律经本模块翻译；
 *  - 未知值原样返回并 console.warn——开发期立刻暴露漏网枚举，而不是
 *    等实机看到一串英文才被发现；
 *  - 字典与后端枚举的一致性由 test/renderer/cognition-vocabulary.test.ts
 *    机械门禁钉住：后端加枚举而这里不加翻译，测试直接红。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets = window.CogAssets || {};
  const T = (key, fallback) => (typeof NS.T === 'function' ? NS.T(key, fallback) : fallback);

  /** 来源类型（键=后端 COGNITION_SOURCE_TYPES 枚举，一字不差）。 */
  const SOURCE_KINDS = {
    conversation: ['cognition.source_conversation', '会话'],
    artifact_file: ['cognition.source_artifact', 'Artifact 与文件'],
    execution_evaluation: ['cognition.source_execution', '执行与评价'],
    user_teaching_signal: ['cognition.source_teaching', '用户教学信号'],
    authorized_external_system: ['cognition.source_external', '授权外部系统'],
  };

  /** 来源生命周期（后端 CognitionSourceLifecycleStatus）。 */
  const SOURCE_STATUS = {
    pending: ['cognition.source_status_pending', '等待就绪'],
    processing: ['cognition.source_status_processing', '读取中'],
    ready: ['cognition.source_status_ready', '可用'],
    failed: ['cognition.source_status_failed', '读取失败'],
    paused: ['cognition.source_status_paused', '已暂停'],
  };

  /** 来源异常/非正常原因（source-catalog.ts 全部 statusReason 字面量）。
   *  用于异常行的"为什么"诊断文案。 */
  const SOURCE_REASON = {
    conversation_processing: ['cognition.source_reason_conversation_processing', '会话还在处理中'],
    connector_connecting: ['cognition.source_reason_connector_connecting', '连接器连接中'],
    connector_disconnected: ['cognition.source_reason_connector_disconnected', '连接器已断开，需要重新连接'],
    connector_degraded: ['cognition.source_reason_connector_degraded', '连接器处于降级状态'],
    connector_error: ['cognition.source_reason_connector_error', '连接器异常'],
    degraded_execution: ['cognition.source_reason_degraded_execution', '执行质量降级，结果仅供参考'],
    execution_queued: ['cognition.source_reason_execution_queued', '执行排队中'],
    execution_running: ['cognition.source_reason_execution_running', '执行进行中'],
    execution_failed: ['cognition.source_reason_execution_failed', '执行失败'],
    execution_timed_out: ['cognition.source_reason_execution_timed_out', '执行超时'],
    file_index_failed: ['cognition.source_reason_file_index_failed', '文件索引失败，可重试'],
    file_index_pending: ['cognition.source_reason_file_index_pending', '文件等待索引'],
    source_unavailable: ['cognition.source_reason_source_unavailable', '来源暂时不可用'],
    source_removed: ['cognition.source_reason_source_removed', '来源已被移除'],
    source_paused: ['cognition.source_reason_source_paused', '你暂停了这个来源的采集'],
    teaching_revoked: ['cognition.source_reason_teaching_revoked', '教学信号已撤销'],
    manual: ['cognition.source_reason_manual', '手动操作'],
  };

  /** 整理任务状态（capture-service.ts 写入记录的全部 status 值，
   *  另含 completed 旧数据兼容）。 */
  const CAPTURE_STATUS = {
    queued: ['cognition.capture_status_queued', '排队中'],
    waiting_completion: ['cognition.capture_status_waiting_completion', '等待会话完成'],
    waiting_manual: ['cognition.capture_status_waiting_manual', '等待手动触发'],
    extracting: ['cognition.capture_status_extracting', '提炼中'],
    writing: ['cognition.capture_status_writing', '写入中'],
    review_ready: ['cognition.capture_status_review', '待确认'],
    completed: ['cognition.capture_status_completed', '已完成'],
    failed: ['cognition.capture_status_failed', '失败'],
    cancelled: ['cognition.capture_status_cancelled', '已取消'],
    paused: ['cognition.capture_status_paused', '已暂停'],
    no_candidate: ['cognition.capture_status_no_candidate', '没有发现可留存的内容'],
    active: ['cognition.capture_status_active', '进行中'],
  };

  function lookup(dict, value, what) {
    if (value === undefined || value === null || value === '') return '';
    const hit = dict[String(value)];
    if (hit) return T(hit[0], hit[1]);
    console.warn(`[cognition-vocabulary] unmapped ${what}: ${value}`);
    return String(value);
  }

  NS.vocabulary = {
    kindLabel: (kind) => lookup(SOURCE_KINDS, kind, 'source kind'),
    sourceStatusText: (status) => lookup(SOURCE_STATUS, status, 'source status'),
    sourceReasonText: (reason) => lookup(SOURCE_REASON, reason, 'source reason'),
    captureStatusText: (status) => lookup(CAPTURE_STATUS, status, 'capture status'),
    /** 整理记录标题：会话标题优先，绝不裸出 rcap- 内部 ID。 */
    recordTitle(record) {
      const raw = record && (record.conversationTitle || record.title);
      const text = String(raw == null ? '' : raw).trim();
      return text || T('cognition.capture_untitled_record', '未命名会话的整理');
    },
  };
})();
