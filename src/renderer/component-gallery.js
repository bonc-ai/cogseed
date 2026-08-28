(function initComponentGallery() {
  'use strict';

  const galleryTranslations = {
    'ai_select.placeholder': '请选择',
    'ai_select.empty': '没有可选项',
  };
  window.t = window.t || ((key) => galleryTranslations[key] || key);

  const byId = (id) => document.getElementById(id);

  function specimen(label, note, content) {
    return `<article class="gallery-specimen"><div class="gallery-specimen__label"><strong>${label}</strong><span>${note}</span></div><div class="gallery-specimen__body">${content}</div></article>`;
  }

  function renderPageHeaders() {
    const cases = [
      {
        label: '列表页 / 自动化', note: '标题 + 数量 + 一个操作',
        options: {
          title: '自动化', meta: '3 项任务',
          actions: [{ label: '新建自动化任务', icon: 'plus' }],
        },
      },
      {
        label: '详情页 / 项目', note: '不超过三个，全部 secondary / sm',
        options: {
          title: 'CogSeed 官网改版',
          actions: [
            { label: '打开目录', icon: 'folder-open' },
            { label: '项目设置', icon: 'settings' },
            { label: '新建任务', icon: 'plus' },
          ],
        },
      },
      {
        label: '空白页 / 认知资产', note: '没有操作也保留同一骨架',
        options: { title: '认知资产' },
      },
    ];
    byId('page-header-specimens').innerHTML = cases.map((item) => specimen(
      item.label,
      item.note,
      uiPageHeader(item.options),
    )).join('');
  }

  function buttonForState(role, size, state) {
    return uiButton({
      label: state === 'loading' ? '处理中' : role.label,
      role: role.id,
      size,
      disabled: state === 'disabled',
      loading: state === 'loading',
      attrs: state === 'hover' || state === 'active' || state === 'focus'
        ? { 'data-preview-state': state }
        : {},
    });
  }

  function renderButtons() {
    const roles = [
      { id: 'primary', label: '创建' },
      { id: 'secondary', label: '取消' },
      { id: 'danger', label: '删除' },
      { id: 'ghost', label: '了解详情' },
    ];
    const states = ['default', 'hover', 'active', 'focus', 'disabled', 'loading'];
    const stateLabels = ['默认', '悬停', '按下', '焦点', '禁用', '加载'];
    const rows = [];
    for (const role of roles) {
      for (const size of ['md', 'sm']) {
        rows.push(`<tr><td>${role.id} / ${size}</td>${states.map((state) => `<td><div class="gallery-matrix__control">${buttonForState(role, size, state)}</div></td>`).join('')}</tr>`);
      }
    }
    byId('button-matrix').innerHTML = `<table class="gallery-matrix"><thead><tr><th>角色 / 尺寸</th>${stateLabels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function renderIconButtons() {
    const states = ['default', 'hover', 'active', 'focus', 'disabled'];
    const labels = ['默认', '悬停', '按下', '焦点', '禁用'];
    const cases = [
      { label: '更多操作', icon: 'more-horizontal', variant: 'plain' },
      { label: '关闭弹窗', icon: 'x', variant: 'plain' },
      { label: '删除任务', icon: 'trash-2', variant: 'danger' },
    ];
    const rows = cases.map((item) => `<tr><td>${item.label}</td>${states.map((state) => `<td><div class="gallery-matrix__control">${uiIconButton({
      ...item,
      disabled: state === 'disabled',
      attrs: state === 'hover' || state === 'active' || state === 'focus' ? { 'data-preview-state': state } : {},
    })}</div></td>`).join('')}</tr>`).join('');
    byId('icon-button-matrix').innerHTML = `<table class="gallery-matrix"><thead><tr><th>可读名称</th>${labels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderFormControls() {
    const inputStates = [
      ['默认', { placeholder: '输入任务名称' }],
      ['悬停', { placeholder: '输入任务名称', previewState: 'hover' }],
      ['焦点', { value: '每天整理日报', previewState: 'focus' }],
      ['禁用', { value: '由系统生成', disabled: true }],
      ['只读', { value: 'task_20260826', readOnly: true }],
      ['错误', { value: 'A', invalid: true, previewState: 'error' }],
    ];
    byId('input-control-states').innerHTML = inputStates.map(([label, options], index) => (
      `<div class="gallery-control-state"><span>${label}</span>${uiInput({ id: `gallery-input-${index}`, ...options })}</div>`
    )).join('') + `<div class="gallery-control-state gallery-control-state--wide"><span>多行</span>${uiTextarea({ id: 'gallery-textarea', placeholder: '描述希望自动执行的工作' })}</div>`;

    const frequencyOptions = [
      { value: 'daily', label: '每天' },
      { value: 'weekly', label: '每周' },
      { value: 'monthly', label: '每月' },
    ];
    const selectStates = [
      ['默认', { value: 'daily' }],
      ['焦点', { value: 'weekly', previewState: 'focus' }],
      ['禁用', { value: 'monthly', disabled: true }],
      ['错误', { value: 'daily', invalid: true, previewState: 'error' }],
    ];
    byId('select-control-states').innerHTML = selectStates.map(([label, options], index) => (
      `<div class="gallery-control-state"><span>${label}</span>${uiSelect({ id: `gallery-select-${index}`, options: frequencyOptions, ...options })}</div>`
    )).join('') + `<div class="gallery-control-state gallery-control-state--wide"><span>带说明的 Select</span>${uiSelect({
      id: 'gallery-select-rich',
      value: 'mac',
      options: [
        { value: 'mac', label: '这台 Mac', hint: '当前设备' },
        { value: 'windows', label: '办公室 Windows', hint: '远程设备' },
      ],
    })}</div>`;
    hydrateUiFormSelects(byId('select-control-states'));

    byId('form-composition-specimen').innerHTML = uiForm({
      ariaLabel: '新建自动化任务示例',
      columns: 2,
      fields: [
        { html: uiField({ id: 'gallery-form-name', label: '任务名称', required: true, hint: '用于任务列表和通知。', control: { kind: 'input', placeholder: '例如：每天整理工作日报' } }) },
        { html: uiField({ id: 'gallery-form-frequency', label: '运行频率', required: true, control: { kind: 'select', value: 'daily', options: frequencyOptions } }) },
        { wide: true, html: uiField({ id: 'gallery-form-content', label: '任务内容', required: true, control: { kind: 'textarea', placeholder: '说明任务目标、输入和期望结果' } }) },
        { wide: true, html: uiField({ id: 'gallery-form-project', label: '关联项目', error: '当前项目不可用，请重新选择。', control: { kind: 'input', value: 'CogSeed 官网改版' } }) },
      ],
      actions: [
        { label: '取消', role: 'secondary' },
        { label: '创建自动化任务', role: 'primary' },
      ],
    });
    hydrateUiFormSelects(byId('form-composition-specimen'));
  }

  function renderEmptyStates() {
    const cases = [
      {
        label: 'A / 安静告知', note: '无图标 · 无操作',
        html: uiEmptyState({ kind: 'quiet', title: '没有匹配的任务' }),
      },
      {
        label: 'B / 解释原因', note: '解释下一步 · 无按钮',
        html: uiEmptyState({ kind: 'explained', icon: 'clock', title: '还没有执行记录', hint: '任务首次运行后，执行结果会显示在这里。' }),
      },
      {
        label: 'C / 引导行动', note: '有且只有一个主操作',
        html: uiEmptyState({ kind: 'actionable', icon: 'sparkles', title: '还没有自动化任务', hint: '创建任务后，CogSeed 会按计划重复执行。', action: { label: '新建自动化任务', icon: 'plus' } }),
      },
    ];
    byId('empty-state-specimens').innerHTML = cases.map((item) => specimen(item.label, item.note, item.html)).join('');
  }

  function modalBody(kind) {
    if (kind === 'form') {
      return uiForm({
        columns: 2,
        fields: [
          { wide: true, html: uiField({ id: 'gallery-task-content', label: '任务内容', required: true, hint: '支持选择 Agent、Skill、Connector 和附件。', control: { kind: 'textarea', placeholder: '输入要按计划执行的任务' } }) },
          { html: uiField({ id: 'gallery-task-frequency', label: '频率', required: true, control: { kind: 'select', value: 'daily', options: [{ value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' }] } }) },
        ],
      });
    }
    if (kind === 'danger') {
      return '<p>删除后任务将停止运行，历史会话仍然保留。此操作无法撤销。</p>';
    }
    if (kind === 'popover') {
      return '<div class="ui-field gallery-popover-anchor"><label>运行设备</label><button type="button" class="ui-button ui-button--secondary ui-button--md" id="gallery-device-trigger" data-gallery-popover-trigger><span class="ui-button__label">这台 Mac</span><span data-ui-icon="chevron-down" data-ui-icon-class="ui-button__icon"></span></button><div class="ui-modal__popover" data-ui-modal-popover data-open="false" data-trigger-id="gallery-device-trigger" hidden><div class="gallery-popover-options"><button type="button">这台 Mac</button><button type="button">办公室 Windows</button></div></div><p class="ui-field__hint">打开选择器后按 ESC，应先关闭选择器，再次按 ESC 才关闭弹窗。</p></div>';
    }
    if (kind === 'long') {
      return `<div class="gallery-long-copy">${Array.from({ length: 14 }, (_, index) => `<p><strong>说明 ${index + 1}</strong><br />长内容只在弹窗正文区域内滚动，标题、关闭按钮和底部操作保持可见。</p>`).join('')}</div>`;
    }
    return '<p>这个弹窗使用真实 Modal 运行时。关闭后，焦点应回到刚才点击的“打开”按钮。</p>';
  }

  function openModalDemo(kind) {
    const configs = {
      default: {
        title: '确认自动化设置', description: '保存后将按当前计划执行。', bodyHtml: modalBody('default'), size: 'sm',
        actions: [{ id: 'cancel', label: '取消', role: 'secondary' }, { id: 'save', label: '保存', role: 'primary' }],
      },
      form: {
        title: '新建自动化任务', description: '填写任务内容与运行频率。', bodyHtml: modalBody('form'), size: 'lg', initialFocus: '#gallery-task-content',
        actions: [{ id: 'cancel', label: '取消', role: 'secondary' }, { id: 'create', label: '创建', role: 'primary' }],
      },
      danger: {
        title: '删除自动化任务？', bodyHtml: modalBody('danger'), size: 'sm', tone: 'danger',
        actions: [{ id: 'cancel', label: '取消', role: 'secondary' }, { id: 'delete', label: '删除', role: 'danger' }],
      },
      long: {
        title: '任务执行说明', description: '验证长内容滚动边界。', bodyHtml: modalBody('long'), size: 'md',
        actions: [{ id: 'close', label: '知道了', role: 'primary' }],
      },
      popover: {
        title: '选择运行设备', description: '验证弹窗内浮层和两级 ESC。', bodyHtml: modalBody('popover'), size: 'md',
        actions: [{ id: 'cancel', label: '取消', role: 'secondary' }, { id: 'save', label: '保存', role: 'primary' }],
      },
    };
    const modal = uiModal({ ...configs[kind], closeLabel: '关闭弹窗' });
    hydrateUiFormSelects(modal.overlay);
    requestAnimationFrame(() => hydrateUiIcons(modal.overlay));
  }

  function renderModalLaunchers() {
    const cases = [
      ['default', 'MOD-01', '默认确认', '确认信息与两项操作'],
      ['form', 'MOD-02', '表单弹窗', '初始焦点进入任务内容'],
      ['danger', 'MOD-03', '危险确认', '危险语义与安全默认'],
      ['long', 'MOD-04', '长内容', '正文独立滚动'],
      ['popover', 'MOD-05', '内嵌选择器', '浮层位于 Modal 之上'],
    ];
    byId('modal-launchers').innerHTML = cases.map(([id, code, title, note]) => `<article class="gallery-modal-launcher"><span>${code}</span><strong>${title}</strong><p>${note}</p>${uiButton({ label: '打开', role: 'secondary', size: 'sm', attrs: { 'data-modal-demo': id } })}</article>`).join('');
  }

  const automationStates = [
    ['list', '列表态'], ['loading', '加载态'], ['empty', '空态'], ['error', '失败态'],
  ];

  function renderAutomationState(state) {
    byId('automation-state-tabs').querySelectorAll('[data-auto-state]').forEach((button) => {
      button.classList.toggle('is-selected', button.dataset.autoState === state);
    });
    let content = '';
    if (state === 'list') {
      content = '<div class="gallery-auto-list"><article class="gallery-auto-row"><div><strong>每天整理工作日报</strong><p>每天 18:30 · 这台 Mac · 未绑定项目</p></div><span class="gallery-auto-status">已启用</span></article><article class="gallery-auto-row"><div><strong>检查 CogSeed 发布状态</strong><p>每周一 09:00 · 办公室 Windows · CogSeed 项目</p></div><span class="gallery-auto-status">已启用</span></article></div>';
    } else if (state === 'loading') {
      content = '<div class="gallery-loading"><div><i aria-hidden="true"></i><p>正在读取自动化任务…</p></div></div>';
    } else if (state === 'empty') {
      content = uiEmptyState({ kind: 'actionable', icon: 'sparkles', title: '还没有自动化任务', hint: '创建任务后，CogSeed 会按计划重复执行。', action: { label: '新建自动化任务', icon: 'plus', attrs: { 'data-modal-demo': 'form' } } });
    } else {
      content = `<div class="gallery-error"><strong>自动化任务读取失败</strong><p>暂时无法获取任务列表。请检查网络后重试。</p>${uiButton({ label: '重试', role: 'secondary', icon: 'refresh' })}</div>`;
    }
    byId('automation-preview').innerHTML = uiPageHeader({
      title: '自动化',
      meta: state === 'list' ? '2 项任务' : '',
      actions: [{ label: '新建自动化任务', icon: 'plus', attrs: { 'data-modal-demo': 'form' } }],
    }) + `<div class="gallery-auto-content">${content}</div>`;
    hydrateUiIcons(byId('automation-preview'));
  }

  function renderAutomation() {
    byId('automation-state-tabs').innerHTML = automationStates.map(([id, label]) => uiButton({
      label,
      role: 'secondary',
      size: 'sm',
      className: id === 'list' ? 'is-selected' : '',
      attrs: { 'data-auto-state': id, role: 'tab' },
    })).join('');
    renderAutomationState('list');
  }

  let commandReturnFocus = null;
  function openCommand() {
    const overlay = byId('gallery-command-overlay');
    commandReturnFocus = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(() => byId('gallery-command-input').focus());
  }
  function closeCommand() {
    byId('gallery-command-overlay').hidden = true;
    if (commandReturnFocus && typeof commandReturnFocus.focus === 'function') commandReturnFocus.focus();
  }

  function wireInteractions() {
    document.addEventListener('click', (event) => {
      const modalTrigger = event.target.closest('[data-modal-demo]');
      if (modalTrigger) {
        openModalDemo(modalTrigger.dataset.modalDemo);
        return;
      }
      const stateTrigger = event.target.closest('[data-auto-state]');
      if (stateTrigger) {
        renderAutomationState(stateTrigger.dataset.autoState);
        return;
      }
      const popoverTrigger = event.target.closest('[data-gallery-popover-trigger]');
      if (popoverTrigger) {
        const popover = popoverTrigger.parentElement.querySelector('[data-ui-modal-popover]');
        const nextOpen = popover.dataset.open !== 'true';
        popover.dataset.open = String(nextOpen);
        popover.hidden = !nextOpen;
        if (nextOpen) popover.querySelector('button').focus();
      }
    });
    document.addEventListener('keydown', (event) => {
      const commandOpen = !byId('gallery-command-overlay').hidden;
      if (commandOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCommand();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && document.querySelector('[data-ui-modal-root]')) {
        event.preventDefault();
        openCommand();
      }
    }, true);
    byId('gallery-command-close').addEventListener('click', closeCommand);
    document.querySelectorAll('.ui-form').forEach((form) => form.addEventListener('submit', (event) => event.preventDefault()));
  }

  renderPageHeaders();
  renderButtons();
  renderIconButtons();
  renderFormControls();
  renderEmptyStates();
  renderModalLaunchers();
  renderAutomation();
  hydrateUiIcons(document);
  wireInteractions();
})();
