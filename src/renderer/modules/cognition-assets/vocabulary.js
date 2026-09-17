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
    waiting_quiet: ['cognition.capture_status_waiting_quiet', '静默期等待'],
    waiting_completion: ['cognition.capture_status_waiting_completion', '等待会话完成'],
    waiting_manual: ['cognition.capture_status_waiting_manual', '等待手动触发'],
    scheduled: ['cognition.capture_status_scheduled', '等待整理窗口'],
    extracting: ['cognition.capture_status_extracting', '提炼中'],
    writing: ['cognition.capture_status_writing', '写入中'],
    review_ready: ['cognition.capture_status_review', '待确认'],
    completed: ['cognition.capture_status_completed', '已完成'],
    failed: ['cognition.capture_status_failed', '失败'],
    cancelled: ['cognition.capture_status_cancelled', '已取消'],
    paused: ['cognition.capture_status_paused', '已暂停'],
    no_candidate: ['cognition.capture_status_no_candidate', '没有发现可留存的内容'],
    configuration_required: ['cognition.capture_status_configuration_required', '需要配置模型'],
    active: ['cognition.capture_status_active', '进行中'],
  };

  /** 展示状态（后端 captureDisplayStatus 的七值全集）。 */
  const CAPTURE_DISPLAY_STATUS = {
    waiting: ['cognition.capture_display_waiting', '等待中'],
    extracting: ['cognition.capture_display_extracting', '提炼中'],
    review_ready: ['cognition.capture_display_review', '待确认'],
    writing: ['cognition.capture_display_writing', '写入中'],
    completed: ['cognition.capture_display_completed', '已完成'],
    failed: ['cognition.capture_display_failed', '失败'],
    cancelled: ['cognition.capture_display_cancelled', '已取消'],
  };

  /** 展示原因（后端 captureDisplayReason 的十七值全集）——状态之外讲清
   *  「为什么停在这个状态」，是整理记录每行的主文案。 */
  const CAPTURE_DISPLAY_REASON = {
    quiet_period: ['cognition.capture_reason_quiet_period', '会话刚结束，正在静默期观察'],
    conversation_active: ['cognition.capture_reason_conversation_active', '会话还在进行，等这轮结束'],
    manual_start_required: ['cognition.capture_reason_manual_start_required', '等你手动开始整理'],
    nightly_window: ['cognition.capture_reason_nightly_window', '等本地夜间整理窗口'],
    queued: ['cognition.capture_reason_queued', '已排队，即将开始'],
    paused: ['cognition.capture_reason_paused', '被暂停'],
    extracting: ['cognition.capture_reason_extracting', '正在提炼候选'],
    asset_write: ['cognition.capture_reason_asset_write', '正在写入资产'],
    review_pending: ['cognition.capture_reason_review_pending', '候选已就绪，等你确认'],
    no_candidate: ['cognition.capture_reason_no_candidate', '整理过，没有发现值得留存的内容'],
    review_completed: ['cognition.capture_reason_review_completed', '候选已处理完'],
    model_not_configured: ['cognition.capture_reason_model_not_configured', '还没有配置可用模型'],
    model_auth_required: ['cognition.capture_reason_model_auth_required', '模型授权已失效，需要重新授权'],
    asset_write_failed: ['cognition.capture_reason_asset_write_failed', '资产写入失败'],
    asset_write_interrupted: ['cognition.capture_reason_asset_write_interrupted', '写入被中断（如应用退出）'],
    capture_failed: ['cognition.capture_reason_capture_failed', '整理没有完成'],
    cancelled: ['cognition.capture_reason_cancelled', '已取消'],
  };

  /** 行内动作（后端 captureActions 的九值全集）：按钮文案的唯一来源。 */
  const CAPTURE_ACTION = {
    run_now: ['cognition.capture_action_run_now', '立即整理'],
    pause: ['cognition.capture_action_pause', '暂停'],
    resume: ['cognition.capture_action_resume', '继续'],
    cancel: ['cognition.capture_action_cancel', '取消任务'],
    review_candidates: ['cognition.capture_action_review_candidates', '去确认'],
    configure_model: ['cognition.capture_action_configure_model', '去配置模型'],
    retry: ['cognition.capture_action_retry', '重试'],
    view_assets: ['cognition.capture_action_view_assets', '查看资产'],
    open_conversation: ['cognition.capture_action_open_conversation', '打开会话'],
  };

  /** 提炼阶段（后端 RecallCaptureStage 五值）：整理详情页讲「现在做到哪一步」。 */
  const CAPTURE_STAGE = {
    model_check: ['cognition.capture_stage_model_check', '检查模型'],
    recall_view: ['cognition.capture_stage_recall_view', '读取会话内容'],
    model_extraction: ['cognition.capture_stage_model_extraction', '模型提炼中'],
    candidate_save: ['cognition.capture_stage_candidate_save', '保存候选'],
    asset_write: ['cognition.capture_stage_asset_write', '写入资产'],
  };

  /** 价值信号（后端 RecallCaptureValueSignal 九值）：这段对话被判为值得
   *  整理的依据，详情页以 chips 形式给出「为什么是它」。 */
  const CAPTURE_VALUE_SIGNAL = {
    preference: ['cognition.capture_signal_preference', '用户偏好'],
    rule: ['cognition.capture_signal_rule', '规则'],
    decision: ['cognition.capture_signal_decision', '决策'],
    template: ['cognition.capture_signal_template', '模板'],
    method: ['cognition.capture_signal_method', '方法'],
    artifact: ['cognition.capture_signal_artifact', '产物'],
    reusable_outcome: ['cognition.capture_signal_reusable_outcome', '可复用成果'],
    substantive_exchange: ['cognition.capture_signal_substantive_exchange', '实质性交流'],
    manual_selection: ['cognition.capture_signal_manual_selection', '手动选择'],
  };

  /** 筛选原因（后端 RecallCaptureFilterReason 六值）：任务没产出候选时的
   *  「为什么没有」白话。 */
  const CAPTURE_FILTER_REASON = {
    trivial_exchange: ['cognition.capture_filter_trivial_exchange', '只是一轮简单交流'],
    no_result: ['cognition.capture_filter_no_result', '没有得到结果'],
    low_reuse_value: ['cognition.capture_filter_low_reuse_value', '没有值得留存的可复用内容'],
    model_no_candidate: ['cognition.capture_filter_model_no_candidate', '模型判断这轮没有可沉淀的内容'],
    candidate_unparsable: ['cognition.capture_filter_candidate_unparsable', '提取结果无法解析（质量异常）'],
    candidate_quality: ['cognition.capture_filter_candidate_quality', '提取内容未达质量门槛'],
  };

  /** 分桶（后端 captureBucket 四值）：整理记录的筛选口径。注意「需要我处理」
   *  是分桶口径（含待确认/被暂停），比「待我处理」页的失败计数宽。
   *  excluded（无需沉淀）是会话维度分类（非 capture 分桶）：失败/寒暄会话。 */
  const CAPTURE_BUCKET = {
    attention: ['cognition.capture_bucket_attention', '需要我处理'],
    active: ['cognition.capture_bucket_active', '进行中'],
    silent: ['cognition.capture_bucket_silent', '无留存内容'],
    done: ['cognition.capture_bucket_done', '已完成'],
    excluded: ['cognition.capture_bucket_excluded', '无需沉淀'],
  };

  /** 未命中兜底：字典没有的枚举值绝不裸出原始字符串（机器码），统一落到
   *  「其他/未知」类文案；console.warn 留给排查「后端加枚举、字典没跟上」。 */
  function lookup(dict, value, what, fallback) {
    if (value === undefined || value === null || value === '') return '';
    const hit = dict[String(value)];
    if (hit) return T(hit[0], hit[1]);
    console.warn(`[cognition-vocabulary] unmapped ${what}: ${value}`);
    return T(fallback[0], fallback[1]);
  }

  NS.vocabulary = {
    kindLabel: (kind) => lookup(SOURCE_KINDS, kind, 'source kind', ['cognition.source_kind_other', '其他来源']),
    sourceStatusText: (status) => lookup(SOURCE_STATUS, status, 'source status', ['cognition.source_status_other', '状态未知']),
    sourceReasonText: (reason) => lookup(SOURCE_REASON, reason, 'source reason', ['cognition.source_reason_other', '原因未记录']),
    captureStatusText: (status) => lookup(CAPTURE_STATUS, status, 'capture status', ['cognition.capture_status_other', '状态未知']),
    captureDisplayStatusText: (status) => lookup(CAPTURE_DISPLAY_STATUS, status, 'capture display status', ['cognition.capture_display_status_other', '状态未知']),
    captureReasonText: (reason) => lookup(CAPTURE_DISPLAY_REASON, reason, 'capture display reason', ['cognition.capture_display_reason_other', '原因未记录']),
    captureActionText: (action) => lookup(CAPTURE_ACTION, action, 'capture action', ['cognition.capture_action_other', '其他操作']),
    captureBucketText: (bucket) => lookup(CAPTURE_BUCKET, bucket, 'capture bucket', ['cognition.capture_bucket_other', '其他状态']),
    captureStageText: (stage) => lookup(CAPTURE_STAGE, stage, 'capture stage', ['cognition.capture_stage_other', '其他步骤']),
    captureSignalText: (signal) => lookup(CAPTURE_VALUE_SIGNAL, signal, 'capture value signal', ['cognition.capture_signal_other', '其他信号']),
    captureFilterReasonText: (reason) => lookup(CAPTURE_FILTER_REASON, reason, 'capture filter reason', ['cognition.capture_filter_other', '其他原因']),
    /** 整理记录标题：会话标题优先，绝不裸出 rcap- 内部 ID。 */
    recordTitle(record) {
      const raw = record && (record.conversationTitle || record.title);
      const text = String(raw == null ? '' : raw).trim();
      return text || T('cognition.capture_untitled_record', '未命名会话的整理');
    },
  };
})();
