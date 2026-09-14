// EduSeed 智教助手 —— 确认面板（CogSeed 插件 UI：只做确认，不做操作）。
//
// 渲染在对话里的确认卡片中（宿主 = 插件随附的 confirm-host 模板，经
// chat-app 协议沙箱加载）。本页面只读 URL 里的 op + payload，展示摘要，
// 用户点「确认/取消」后向父级 postMessage；后续写入由对话里的智能体执行，
// 本页面永远不直接发数据。
(function () {
  'use strict';

  var body = document.getElementById('c-body');
  var titleEl = document.getElementById('c-title');
  var subEl = document.getElementById('c-sub');
  var confirmBtn = document.getElementById('c-confirm');
  var cancelBtn = document.getElementById('c-cancel');

  var OP_LABELS = {
    'submit-project': '确认提交项目',
    'publish-challenge': '确认发布挑战',
    'submit-review': '确认终审意见'
  };
  var OP_TITLES = {
    'submit-project': '提交项目',
    'publish-challenge': '发布挑战',
    'submit-review': '教师终审'
  };
  // Bug2（2026-09-14）：字段键名展示映射——技术键名换成中文标签，
  // 挑战名（challengeTitle）与 ID 分开呈现，不再只露一串裸 ID。
  var FIELD_LABELS = {
    '提交身份': '提交身份',
    'studentId': '学号',
    'challengeTitle': '挑战名称',
    'challengeId': '挑战 ID',
    'projectTitle': '项目标题',
    'githubRepoUrl': 'GitHub 仓库',
    'aarText': 'AAR 自述',
    'selfEvaluation': '自评',
    'projectSummary': '项目摘要',
    'isPublic': '是否公开',
    'workdir': '工作目录',
    'requiredDelivery': '必交交付物',
    'cohort': '班级'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseQuery() {
    var q = new URLSearchParams(location.search);
    var op = q.get('op') || '';
    var payload = null;
    var raw = q.get('payload');
    if (raw) {
      try { payload = JSON.parse(raw); } catch (e) { payload = null; }
    }
    return { op: op, payload: payload };
  }

  function renderError(msg) {
    body.innerHTML = '<div class="ed-error-box">' + esc(msg || '无法读取待确认内容') + '</div>';
    confirmBtn.disabled = true;
  }

  function render() {
    var q = parseQuery();
    if (!q.op || !q.payload) { renderError('缺少待确认内容（op/payload）'); return; }
    var label = OP_LABELS[q.op] || q.op;
    var title = OP_TITLES[q.op] || '操作确认';
    titleEl.textContent = label;
    subEl.textContent = 'EduSeed 智教助手 · 你确认后才会写入平台';
    var rows = Object.keys(q.payload).map(function (k) {
      var v = q.payload[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      return '<div class="ed-kv"><span class="ed-kv-label">' + esc(FIELD_LABELS[k] || k) + '</span><span>' + esc(v) + '</span></div>';
    }).join('');
    // A2-2（2026-09-07）：提交类操作必须明示身份；缺失时醒目警告（不阻断，但提示风险）
    var identityWarn = '';
    if (q.op === 'submit-project') {
      var hasIdentity = !!q.payload && !!(q.payload['提交身份'] || q.payload.studentId || q.payload['student_id']);
      if (!hasIdentity) {
        identityWarn = '<div class="ed-error-box" style="margin-bottom:8px">⚠ 摘要未标明提交身份（学号）——请回到对话，要求智能体在摘要中补充「提交身份」后再确认。</div>';
      }
      // Bug2（2026-09-14）：挑战必须同时呈现名称（challengeTitle）；缺失仅警示，
      // 仍显示 challengeId（不静默隐藏，避免把 ID 误当名称）。
      var hasTitle = !!q.payload && !!(q.payload.challengeTitle || q.payload['挑战名称']);
      if (!hasTitle) {
        identityWarn += '<div class="ed-error-box" style="margin-bottom:8px">⚠ 摘要未标明挑战名称（challengeTitle）——请回到对话，要求智能体补充挑战名称后再确认。</div>';
      }
    }
    body.innerHTML =
      identityWarn +
      '<div class="ed-confirm-op"><span class="ed-chip">' + esc(title) + '</span></div>' +
      '<div class="ed-confirm-rows">' + rows + '</div>' +
      '<p class="ed-confirm-hint">确认后，对话里的智能体将把以上内容写入平台。写错了点「取消」，在对话里让它改。</p>';
    resize();
  }

  function resize() {
    try {
      var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (h > 0) parent.postMessage({ __cogseedPlugin: true, type: 'resize', height: h }, '*');
    } catch (e) {}
  }

  confirmBtn.addEventListener('click', function () {
    var q = parseQuery();
    parent.postMessage({ __cogseedPlugin: true, type: 'confirm', op: q.op, payload: q.payload }, '*');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '已确认，等待智能体执行…';
  });
  cancelBtn.addEventListener('click', function () {
    var q = parseQuery();
    parent.postMessage({ __cogseedPlugin: true, type: 'cancel', op: q.op }, '*');
    cancelBtn.disabled = true;
    cancelBtn.textContent = '已取消';
  });

  window.addEventListener('load', resize);
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(resize).observe(document.documentElement); } catch (e) {}
  }
  render();
})();
