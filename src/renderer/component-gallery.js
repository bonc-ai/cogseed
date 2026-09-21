(function initComponentGallery() {
  'use strict';

  const galleryTranslations = {
    'ai_select.placeholder': '请选择',
    'ai_select.empty': '没有可选项',
    'ai_select.loading': '正在读取选项…',
    'ai_select.no_results': '未找到与「{query}」匹配的选项',
    'ai_select.result_count': '显示 {visible} / {total} 项',
    'ai_select.search_placeholder': '搜索选项…',
    'sidebar.search_title': '全局搜索 (Cmd/Ctrl+K)',
    'sidebar.collapse_title': '收起侧边栏',
    'sidebar.expand_title': '展开侧边栏',
  };
  window.t = window.t || ((key, values = {}) => String(galleryTranslations[key] || key)
    .replace(/\{([a-z]+)\}/gi, (_, name) => values[name] == null ? '' : values[name]));

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

  function renderSidebarTools() {
    const cases = [
      {
        collapsed: false,
        label: '侧栏展开',
        note: '原生窗口控件在左·搜索与收起在右',
      },
      {
        collapsed: true,
        label: '侧栏收起',
        note: '只保留可聚焦、可恢复的展开入口',
      },
    ];
    byId('sidebar-tools-specimens').innerHTML = cases.map((item) => specimen(
      item.label,
      item.note,
      `<div class="gallery-window-chrome${item.collapsed ? ' is-collapsed' : ''}">
        <span class="gallery-window-chrome__native">原生窗口控件区</span>
        <div class="sidebar-tools">${uiSidebarTools({ collapsed: item.collapsed })}</div>
      </div>`,
    )).join('');
  }

  function renderSidebarAppearance() {
    const navItem = (icon, label, active = false) => `<button type="button" class="sidebar-btn${active ? ' active' : ''}">
      <span data-ui-icon="${icon}" data-ui-icon-class="sidebar-btn-icon"></span><span>${label}</span>
    </button>`;
    const task = (title, time, active = false) => `<div class="conv-item${active ? ' active' : ''}">
      <div class="conv-item-row"><div class="conv-item-title">${title}</div><span class="conv-item-time">${time}</span></div>
    </div>`;
    const sidebar = (selected) => `<div class="gallery-sidebar-frame"><aside class="sidebar">
      <div class="sidebar-logo"><img class="logo-icon" src="../resources/icons/logo.png" alt="" /><span class="logo-text">CogSeed</span></div>
      <div class="sidebar-actions">
        ${navItem('plus', '新建任务', !selected)}
        ${navItem('folder', '工作空间')}
        ${navItem('git-branch', '认知资产')}
        ${navItem('clock', '自动化')}
        ${navItem('plug', '智能体 / 技能 / 连接')}
      </div>
      <div class="sidebar-conversation-nav"><div class="sidebar-section sidebar-conversations-section"><div class="conversation-list">
        <div class="conv-list-section-header conv-list-space-title"><button type="button" class="conv-list-section-fold"><span data-ui-icon="chevron-down" data-ui-icon-class="conv-list-section-caret-icon"></span><span class="conv-list-section-label">最近任务</span></button></div>
        ${task('项目里程碑与提醒', '2分', selected)}
        ${task('资料来源与引用复核', '昨天')}
        <div class="conv-list-section-header conv-list-space-title"><button type="button" class="conv-list-section-fold"><span data-ui-icon="chevron-down" data-ui-icon-class="conv-list-section-caret-icon"></span><span class="conv-list-section-label">空间</span></button></div>
      </div></div></div>
      <div class="sidebar-footer-actions"><div class="sidebar-footer-account"><button type="button" class="hub-chip">
        <span class="hub-chip-avatar is-gradient" aria-hidden="true">陈</span><span class="hub-chip-meta"><span class="hub-chip-name">陈昱</span><span class="hub-chip-sub">个人工作空间</span></span><span class="hub-chip-chev" data-ui-icon="chevron-down"></span>
      </button></div></div>
    </aside></div>`;
    byId('sidebar-appearance-specimens').innerHTML = [
      specimen('默认侧栏', 'F4F8F5 主面 · 400 导航字重 · 500 用户名', sidebar(false)),
      specimen('任务选中', '绿色 wash 只表达当前位置，不额外加粗', sidebar(true)),
    ].join('');
  }

  function renderUserMenus() {
    const identity = {
      name: '陈昱',
      description: '个人工作空间',
      avatar: { text: '陈', variant: 'gradient' },
    };
    const trigger = (open) => uiUserMenuTrigger({
      ...identity,
      id: `gallery-user-menu-${open ? 'open' : 'closed'}`,
      open,
      ariaLabel: '陈昱的用户菜单',
    });
    const panel = uiUserMenuPanel({
      ...identity,
      items: [
        { action: 'settings', label: '设置', icon: 'settings' },
        { action: 'sign-out', label: '退出登录', icon: 'log-out', danger: true, separatorBefore: true },
      ],
    });
    byId('user-menu-specimens').innerHTML = [
      specimen('默认入口', '头像 · 名称 · 工作空间 · 展开箭头', `<div class="gallery-user-menu-demo">${trigger(false)}</div>`),
      specimen('菜单展开', '顶部身份 · 设置 · 危险操作', `<div class="gallery-user-menu-demo is-open">${trigger(true)}<div class="hub-chip-menu" role="menu">${panel}</div></div>`),
    ].join('');
  }

  function renderTabs() {
    byId('tabs-specimens').innerHTML = specimen(
      '主页面导航',
      '单一 Tab 入口 · 下划线选中 · 绿色键盘焦点',
      uiTabs({
        ariaLabel: '能力页面',
        value: 'agents',
        items: [
          { value: 'agents', label: '智能体', count: 6 },
          { value: 'tools', label: 'MCP 与工具', count: 4 },
          { value: 'skills', label: '技能', count: 18 },
          { value: 'library', label: '资料库' },
          { value: 'im', label: 'IM' },
        ],
      }),
    );
    hydrateUiTabs(byId('tabs-specimens'));
  }

  function renderResourcePages() {
    const tab = (label, selected) => `<button type="button" class="skills-cognition-tab ui-tab${selected ? ' is-active' : ''}" role="tab" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}" data-gallery-resource-tab>${label}</button>`;
    const empty = (title, hint) => uiEmptyState({ kind: 'explained', title, hint });
    byId('resource-page-specimens').innerHTML = [
      specimen(
        '无页签资源页',
        '32px 桌面留白 · 1232px 内容上限 · 窄宽自动收敛',
        `<div class="ui-resource-page gallery-resource-page-preview">
          <div class="ws-center-header">${uiPageHeader({ title: '工作空间', actions: [{ label: '新建空间', icon: 'plus' }] })}</div>
          <div class="auto-scroll">${empty('还没有工作空间', '正文与标题使用同一套响应式边距。')}</div>
        </div>`,
      ),
      specimen(
        '带页签资源页',
        '透明选中态 · Header 后 12px · 页签与正文共用水平起点',
        `<div class="ui-resource-page gallery-resource-page-preview">
          <div class="skills-cognition-surface">
            <div id="cognition-page-header">${uiPageHeader({ title: '认知资产' })}</div>
            <div class="skills-cognition-tabs">
              <div class="skills-cognition-tabs-row">
                <div class="skills-cognition-tab-group" role="tablist" aria-label="认知资产页签预览">${tab('我的认知树', true)}${tab('待我处理', false)}${tab('复用与证明', false)}</div>
              </div>
            </div>
            <div class="skills-cognition-page">${empty('当前分类暂无内容', '页签行为仍由业务页面负责。')}</div>
          </div>
        </div>`,
      ),
    ].join('');
  }

  function renderResourceCards() {
    byId('resource-card-specimens').innerHTML = [
      { title: '产品研发', description: '组织需求、设计与研发交付，保留最近任务上下文。', icon: 'folder', status: '刚刚更新', action: '继续工作' },
      { title: '每日工作收尾', description: '下班前整理当天进展、风险和明日待办。', icon: 'clock', status: '每天 18:00', action: '使用模板' },
      { title: '项目分析师', description: '核对材料并整理风险线索，适用于通用分析任务。', icon: 'users', status: '可使用', action: '使用智能体' },
      { title: '需求证据整理', description: '把多来源反馈整理成可追溯的问题主题与证据账本。', icon: 'database', status: '已启用', action: '使用技能' },
      { title: 'GitHub', description: '查找和管理代码仓库、Issue、PR、文件与代码。', icon: 'globe', status: '未连接', action: '连接账户' },
      { title: '每天整理工作日报', description: '每天 18:30 · 这台 Mac · 汇总当日任务与交付。', icon: 'clock', status: '已启用 · 最近运行 18:30', action: '查看记录', layout: 'row' },
    ].map((item) => uiResourceCard({ ...item, action: { label: item.action } })).join('');
    hydrateUiIcons(byId('resource-card-specimens'));
  }

  function renderStatusDisplay() {
    byId('status-display-specimens').innerHTML = [
      specimen('标签与筛选', 'Tag 不交互 · Chip 使用原生按钮', `<div class="gallery-inline-row">${uiTag({ label: '知识库', variant: 'solid' })}${uiTag({ label: 'v1.0.2', variant: 'version' })}${uiTag({ label: '已合规', variant: 'success' })}${uiChip({ label: '只看已引用', selected: true, icon: 'check' })}${uiChip({ label: '包含归档' })}</div>`),
      specimen('状态语义', '列表用状态点 · 标题或摘要用胶囊', `<div class="gallery-inline-row">${uiStatusDot({ label: '运行中', tone: 'attention' })}${uiStatusPill({ label: '已完成', tone: 'success', check: true })}${uiStatusPill({ label: '需要处理', tone: 'critical' })}${uiBadge({ label: '待开发', tone: 'neutral' })}</div>`),
      specimen('加载反馈', '能估算用进度条 · 未知耗时用骨架', `<div class="gallery-loading-stack">${uiProgressBar({ ariaLabel: '索引进度', value: 64 })}${uiSkeleton({ ariaLabel: '正在载入资料卡片', lines: [48, 92], withMedia: true })}</div>`),
    ].join('');
    hydrateUiIcons(byId('status-display-specimens'));
  }

  function renderStructuredData() {
    const table = uiDataTable({
      label: '知识来源状态',
      columns: [
        { key: 'name', label: '来源', primary: true },
        { key: 'status', label: '状态' },
        { key: 'count', label: '资料数', align: 'right', sortable: true },
      ],
      rows: [
        { name: '飞书 Wiki', status: '已连接', count: 18 },
        { name: '个人资料库', status: '可检索', count: 42 },
      ],
      sortKey: 'count',
      sortDir: -1,
    });
    const accordion = uiAccordion({
      items: [
        { title: '索引范围', meta: '3 项', bodyHtml: '<p>正文、标题与来源元数据。</p>' },
        { title: '同步记录', meta: '12:40', bodyHtml: '<p>最近一次同步成功。</p>' },
      ],
    });
    const tree = uiTree({
      ariaLabel: '知识库目录',
      items: [
        { id: 'personal', label: '个人资料库', expanded: true, children: [{ id: 'handoff', label: 'SM 交接', selected: true }, { id: 'notes', label: '会议笔记' }] },
        { id: 'shared', label: '共享资料库', children: [{ id: 'team', label: '团队资料' }] },
      ],
    });
    byId('structured-data-specimens').innerHTML = [
      specimen('DataTable', '原生表格 · 可排序表头 · 数值右对齐', table),
      specimen('Accordion', '独立展开 · 左侧恒定箭头 · 右侧元数据', accordion),
      specimen('Tree', '方向键导航 · 展开/收起 · 单一 Tab 入口', tree),
    ].join('');
    hydrateUiIcons(byId('structured-data-specimens'));
    hydrateUiTrees(byId('structured-data-specimens'));
  }

  function renderSettingsSections() {
    const section = (title, rows, action = '') => `<section class="ui-settings-section" aria-label="${title}">
      <header class="ui-settings-section__header"><h3 class="ui-settings-section__title">${title}</h3>${action}</header>
      <div class="ui-settings-section__body">${rows.map(([label, value]) => `<div class="gallery-settings-row"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
    </section>`;
    byId('settings-section-specimens').innerHTML = [
      section('通用', [['语言', '简体中文'], ['默认推理强度', '中等']]),
      section('数据', [['资料库', '3 个来源'], ['数据目录', '本机']], uiButton({ label: '打开目录', role: 'secondary', size: 'sm' })),
    ].join('');
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
      for (const size of ['lg', 'md', 'sm']) {
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
      { label: '导入内容', icon: 'upload', variant: 'plain' },
      { label: '关闭弹窗', icon: 'x', variant: 'plain' },
      { label: '删除记忆', icon: 'bookmark', variant: 'plain' },
      { label: '删除任务', icon: 'trash-2', variant: 'danger' },
    ];
    const rows = cases.map((item) => `<tr><td>${item.label}</td>${states.map((state) => `<td><div class="gallery-matrix__control">${uiIconButton({
      ...item,
      disabled: state === 'disabled',
      attrs: state === 'hover' || state === 'active' || state === 'focus' ? { 'data-preview-state': state } : {},
    })}</div></td>`).join('')}</tr>`).join('');
    byId('icon-button-matrix').innerHTML = `<table class="gallery-matrix"><thead><tr><th>可读名称</th>${labels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderSegmentedControls() {
    const cases = [
      {
        label: '基础筛选', note: '默认 · 选中 · 悬停 · 键盘焦点',
        html: uiSegmentedControl({
          ariaLabel: '资产范围',
          value: 'all',
          attrs: { 'data-gallery-segmented': '' },
          items: [
            { value: 'all', label: '全部' },
            { value: 'mine', label: '我负责' },
            { value: 'archived', label: '已归档' },
          ],
        }),
      },
      {
        label: '带数量', note: '数量跟随标签，不渲染徽标气泡',
        html: uiSegmentedControl({
          ariaLabel: '证明记录筛选',
          value: 'used',
          attrs: { 'data-gallery-segmented': '' },
          items: [
            { value: 'all', label: '全部', count: 24 },
            { value: 'used', label: '已引用', count: 8 },
            { value: 'verified', label: '效果已验证', count: 3 },
          ],
        }),
      },
      {
        label: '二级页面切换', note: '与技能分类同形 · 保留 Tab 语义与方向键切换',
        html: uiSegmentedControl({
          ariaLabel: 'MCP与工具',
          role: 'tablist',
          value: 'mcp',
          items: [
            { value: 'mcp', label: 'MCP 连接器' },
            { value: 'plugins', label: '插件' },
          ],
        }),
      },
    ];
    byId('segmented-control-specimens').innerHTML = cases.map((item) => specimen(item.label, item.note, item.html)).join('');
  }

  function composerToolbar({ conversation = false } = {}) {
    const permission = conversation
      ? '<span class="chat-permission-chip"><span data-ui-icon="lock" data-ui-icon-class="chat-permission-chip-icon"></span><span class="chat-permission-select ai-select"><button type="button" class="ai-select-trigger" aria-label="访问权限：请求批准" aria-haspopup="listbox" aria-expanded="false"><span class="ai-select-label"><span>请求批准</span></span><span data-ui-icon="chevron-down" data-ui-icon-class="ai-select-caret"></span></button></span></span>'
      : '';
    return `<div class="chat-bottom-bar">
      <button type="button" class="chat-attach-btn" aria-label="添加附件">+</button>
      <span class="chat-composer-divider" aria-hidden="true"></span>
      <button type="button" class="chat-recipient-chip" aria-label="选择智能体、技能与引用"><span class="chat-recipient-prefix">@</span><span class="chat-recipient-name">项目助理</span></button>
      <button type="button" class="workspace-chip" aria-label="选择工作空间"><span data-ui-icon="layout-grid" data-ui-icon-class="workspace-chip-icon"></span><span class="workspace-chip-prefix">工作空间：</span><span class="workspace-chip-label">默认工作区</span><span data-ui-icon="chevron-down" data-ui-icon-class="workspace-chip-chevron"></span></button>
      ${permission}
      <button type="button" class="model-chip exec-config-chip" aria-label="执行配置（本次任务）"><span data-ui-icon="settings" data-ui-icon-class="model-chip-icon"></span><span class="model-chip-label">DeepSeek V4 Flash</span><span class="exec-config-effort">自动</span><span data-ui-icon="chevron-down" data-ui-icon-class="model-chip-chevron"></span></button>
      <button type="button" class="chat-stt-btn" aria-label="语音输入"><span data-ui-icon="mic" data-ui-icon-class="chat-stt-icon"></span></button>
      <button type="button" class="chat-send-btn" aria-label="发送消息"><span data-ui-icon="send" data-ui-icon-class="send-icon"></span></button>
    </div>`;
  }

  function composerDemo({ conversation = false, narrow = false, value = '' } = {}) {
    const areaClass = conversation ? 'chat-input-area' : 'new-chat-input-area';
    const demoClass = `gallery-composer-demo${conversation ? ' is-conversation' : ''}${narrow ? ' is-narrow' : ''}`;
    const area = `<div class="${areaClass}">
      <div class="chat-input-rich-wrap"><div class="chat-rich-editor" role="textbox" aria-multiline="true" data-placeholder="描述一项工作，或粘贴一份材料。输入 @ 选择智能体与技能。">${value}</div></div>
      ${composerToolbar({ conversation })}
    </div>`;
    return `<div class="${demoClass}">${conversation ? `<div id="panel-conversation">${area}</div>` : area}</div>`;
  }

  function composerPopoverMatrix() {
    const agent = `<div class="skill-picker composer-popover gallery-composer-popover">
      <div class="skill-picker-tabs"><button type="button" class="skill-picker-tab active">智能体</button><button type="button" class="skill-picker-tab">技能</button></div>
      <div class="skill-picker-header"><input type="text" value="" placeholder="搜索智能体…" /></div>
      <div class="skill-picker-list"><div class="skill-picker-item active"><div class="skill-picker-item-name">cogseed</div><div class="skill-picker-item-desc">默认接收者，无需 @</div></div><div class="skill-picker-item"><div class="skill-picker-item-name">WorkBuddy</div><div class="skill-picker-item-desc">本地代码研发智能体</div></div></div>
    </div>`;
    const workspace = `<div class="workspace-menu space-menu composer-popover gallery-composer-popover">
      <input class="workspace-menu-search" type="text" placeholder="搜索工作空间…" />
      <div class="workspace-menu-list"><button type="button" class="workspace-menu-item workspace-menu-item--active"><span>默认工作区</span><span class="workspace-menu-check"><span data-ui-icon="check" data-ui-icon-class="workspace-check-icon"></span></span></button><button type="button" class="workspace-menu-item"><span>教育</span></button></div>
    </div>`;
    const permission = `<div class="ai-select-popover composer-popover chat-permission-popover gallery-composer-popover" role="listbox">
      <div class="ai-select-options"><div class="ai-select-item" role="option" aria-selected="false"><div class="ai-select-item-label">完全访问</div></div><div class="ai-select-item" role="option" aria-selected="false"><div class="ai-select-item-label">帮我批准</div></div><div class="ai-select-item active" role="option" aria-selected="true"><div class="ai-select-item-label">请求批准</div></div></div>
    </div>`;
    return `<div class="gallery-composer-popover-grid"><div><strong>@ 智能体 / 技能</strong>${agent}</div><div><strong>工作空间</strong>${workspace}</div><div><strong>访问权限</strong>${permission}</div></div>`;
  }

  function renderComposerSpecimens() {
    const cases = [
      ['首页 / 900px', '完整标签 · 空正文使用安静发送键', composerDemo()],
      ['已有对话 / 760px', '64–200px 正文 · 有内容时发送键转为品牌主操作', composerDemo({ conversation: true, value: '请核对这份项目材料。' })],
      ['窄宽 / 480px', '按输入台自身宽度收起标签，不依赖页面宽度', composerDemo({ narrow: true, value: '请按团队整理客户信息。' })],
    ];
    byId('composer-specimens').innerHTML = cases.map(([label, note, html]) => specimen(label, note, `<div class="gallery-composer-stage">${html}</div>`)).join('')
      + specimen('弹层 / 统一外壳', '互斥打开 · 同一描边、圆角、层级与阴影', composerPopoverMatrix());
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
    )).join('')
      + `<div class="gallery-control-state"><span>复选框</span><label class="gallery-inline-control">${uiCheckbox({ id: 'gallery-checkbox', label: '启用联网搜索', name: 'gallery-capability', value: 'search', checked: true })}启用联网搜索</label></div>`
      + `<div class="gallery-control-state"><span>开关</span><span class="gallery-inline-control">${uiSwitch({ label: '夜间自动沉淀', checked: true })}夜间自动沉淀</span></div>`
      + `<div class="gallery-control-state gallery-control-state--wide"><span>多行</span>${uiTextarea({ id: 'gallery-textarea', placeholder: '描述希望自动执行的工作' })}</div>`;

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
    })
      // 2026-09-14 新增契约：整卡都必填时不逐条标"必填/选填"（供应商详情卡）。
      // required 语义仍在控件上，去掉的只是每个字段的标注文案。
      + specimen(
        'B / 整卡必填：不逐条标注',
        'showRequirement: false —— 控件仍带 required，标签行不再出现必填/选填',
        uiForm({
          ariaLabel: '供应商详情示例',
          columns: 2,
          fields: [
            { html: uiField({ id: 'gallery-quiet-name', label: '名称', required: true, showRequirement: false, control: { kind: 'input', value: 'command' } }) },
            { html: uiField({ id: 'gallery-quiet-format', label: 'API 格式', required: true, showRequirement: false, control: { kind: 'select', value: 'openai', options: [{ value: 'openai', label: 'Chat Completions' }, { value: 'anthropic', label: 'Anthropic Messages' }] } }) },
            { wide: true, html: uiField({ id: 'gallery-quiet-key', label: 'API Key', showRequirement: false, hint: '留空表示不修改；输入新值即替换。', control: { kind: 'input', type: 'password', value: '' } }) },
          ],
        }),
      );
    hydrateUiFormSelects(byId('form-composition-specimen'));
  }

  function renderSearchSelectionComponents() {
    const commandStates = [
      ['default', '默认'], ['open', '打开'], ['loading', '搜索中'], ['empty', '无结果'],
      ['error', '错误'], ['narrow', '窄宽'], ['keyboard', '键盘 / IME'],
    ];
    const selectStates = [
      ['default', '默认'], ['open', '打开'], ['loading', '搜索中'], ['empty', '无结果'],
      ['disabled', '禁用'], ['error', '错误'], ['narrow', '窄宽'],
    ];
    const stateButtons = (states, attr, selected) => states.map(([id, label]) => uiButton({
      label,
      role: 'secondary',
      size: 'sm',
      className: id === selected ? 'is-selected' : '',
      attrs: { [attr]: id },
    })).join('');
    byId('command-palette-state-tabs').innerHTML = stateButtons(commandStates, 'data-command-state', 'default');
    byId('searchable-select-state-tabs').innerHTML = stateButtons(selectStates, 'data-search-select-state', 'default');

    const renderCommandState = (state) => {
      const host = byId('command-palette-specimen');
      const query = state === 'empty' ? '不存在的资料' : '季度复盘';
      let body = '<div class="search-empty">输入关键词开始搜索</div>';
      if (state === 'open' || state === 'narrow') {
        body = '<div class="search-section-label">任务</div><div class="search-result active" role="option" aria-selected="true"><div class="search-result-head"><span class="search-result-kind is-chat">任务</span><span class="search-result-title">产品季度复盘</span><span class="search-result-meta">我 · 今天 11:20</span></div><div class="search-result-snippet">核对<strong>季度复盘</strong>材料与交付时间</div></div>';
      } else if (state === 'loading') {
        body = '<div class="search-empty search-loading" role="status">正在搜索“季度复盘”…</div>';
      } else if (state === 'empty') {
        body = '<div class="search-empty">未找到“不存在的资料”相关内容</div>';
      } else if (state === 'error') {
        body = '<div class="search-empty search-error">搜索失败，请稍后重试</div>';
      } else if (state === 'keyboard') {
        body = '<div class="gallery-command__state" id="gallery-command-key-state">方向键移动，Enter 打开；组合输入期间动作键保持静默。</div>';
      }
      host.classList.toggle('is-narrow', state === 'narrow');
      host.innerHTML = `<div class="gallery-command gallery-command--inline"><div class="gallery-command__input-row"><span data-ui-icon="search"></span><input type="text" aria-label="全局搜索" value="${state === 'default' ? '' : query}" /><kbd>⌘K</kbd></div><div class="search-body">${body}</div></div>`;
      const input = host.querySelector('input');
      if (state === 'keyboard' && input) {
        input.addEventListener('keydown', (event) => {
          const status = byId('gallery-command-key-state');
          if (event.isComposing || event.keyCode === 229) {
            status.textContent = 'IME 组合中：未执行导航或打开动作。';
            return;
          }
          if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
            event.preventDefault();
            status.textContent = `已识别键盘动作：${event.key}`;
          }
        });
        input.focus();
      }
      hydrateUiIcons(host);
      byId('command-palette-state-tabs').querySelectorAll('[data-command-state]').forEach((button) => {
        button.classList.toggle('is-selected', button.dataset.commandState === state);
      });
    };

    const selectOptions = [
      { value: 'core', label: 'Core Agent', hint: '内置模型' },
      { value: 'openai', label: 'OpenAI', hint: 'API Key / OAuth' },
      { value: 'anthropic', label: 'Anthropic', hint: 'API Key' },
      { value: 'google', label: 'Google Gemini', hint: 'API Key' },
      { value: 'custom', label: '自定义供应商', hint: 'OpenAI 兼容协议' },
    ];
    let selectApi = null;
    const renderSelectState = (state) => {
      selectApi?.close();
      const host = byId('searchable-select-specimen');
      host.classList.toggle('is-narrow', state === 'narrow');
      host.innerHTML = uiSelect({
        id: 'gallery-search-select',
        ariaLabel: '模型或供应商',
        placeholder: '选择模型或供应商',
        options: selectOptions,
        searchable: true,
        total: 47,
        loading: state === 'loading',
        initialQuery: state === 'empty' ? '不存在' : '',
        disabled: state === 'disabled',
        invalid: state === 'error',
      });
      [selectApi] = hydrateUiFormSelects(host);
      if (['open', 'loading', 'empty'].includes(state)) selectApi.open();
      byId('searchable-select-state-tabs').querySelectorAll('[data-search-select-state]').forEach((button) => {
        button.classList.toggle('is-selected', button.dataset.searchSelectState === state);
      });
    };

    byId('date-range-picker-specimen').innerHTML = [
      ['默认', uiDateRangePicker({ id: 'gallery-date-range-default', ariaLabel: '报告日期范围', startLabel: '开始日期', endLabel: '结束日期', separator: '至', start: '2026-09-01', end: '2026-09-14' })],
      ['错误', uiDateRangePicker({ id: 'gallery-date-range-error', ariaLabel: '无效日期范围', startLabel: '开始日期', endLabel: '结束日期', separator: '至', start: '2026-09-20', end: '2026-09-14', invalidStart: true, invalidEnd: true })],
      ['窄宽 / 焦点', uiDateRangePicker({ id: 'gallery-date-range-narrow', className: 'is-narrow', ariaLabel: '窄宽日期范围', startLabel: '开始日期', endLabel: '结束日期', separator: '至', start: '2026-09-01', end: '2026-09-14', startPreviewState: 'focus' })],
    ].map(([label, html]) => `<div class="gallery-control-state"><span>${label}</span>${html}</div>`).join('');

    byId('command-palette-state-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-command-state]');
      if (button) renderCommandState(button.dataset.commandState);
    });
    byId('searchable-select-state-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-search-select-state]');
      if (button) renderSelectState(button.dataset.searchSelectState);
    });
    renderCommandState('default');
    renderSelectState('default');
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
    byId('modal-launchers').innerHTML = cases.map(([id, code, title, note]) => `<article class="gallery-modal-launcher"><span>${code}</span><strong>${title}</strong><p>${note}</p>${uiButton({ label: '打开', role: 'secondary', size: 'sm', attrs: { 'data-modal-demo': id } })}</article>`).join('')
      + `<article class="gallery-modal-launcher"><span>DRW-01</span><strong>侧边抽屉</strong><p>焦点约束、遮罩与 Escape 关闭</p>${uiButton({ label: '打开', role: 'secondary', size: 'sm', attrs: { 'data-drawer-demo': 'detail' } })}</article>`;
  }

  function openDrawerDemo(trigger) {
    uiDrawer({
      title: '产物详情',
      closeLabel: '关闭抽屉',
      trigger,
      bodyHtml: '<p>抽屉承载补充信息或辅助操作，不替代需要用户决策的 Modal。</p><p>按 Escape、点击遮罩或关闭按钮均可返回触发位置。</p>',
      footerHtml: uiButton({ label: '完成', role: 'primary', size: 'sm', attrs: { 'data-ui-drawer-close': 'true' } }),
    });
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
    document.querySelectorAll('[data-gallery-segmented]').forEach((group) => {
      group.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !group.contains(button)) return;
        group.querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', item === button ? 'true' : 'false'));
      });
    });
    document.addEventListener('click', (event) => {
      const drawerTrigger = event.target.closest('[data-drawer-demo]');
      if (drawerTrigger) {
        openDrawerDemo(drawerTrigger);
        return;
      }
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
  renderSidebarTools();
  renderSidebarAppearance();
  renderUserMenus();
  renderResourcePages();
  renderTabs();
  renderStatusDisplay();
  renderStructuredData();
  renderResourceCards();
  renderSettingsSections();
  renderButtons();
  renderIconButtons();
  renderSegmentedControls();
  renderComposerSpecimens();
  renderFormControls();
  renderSearchSelectionComponents();
  renderEmptyStates();
  renderModalLaunchers();
  renderAutomation();
  hydrateUiIcons(document);
  wireInteractions();
})();
