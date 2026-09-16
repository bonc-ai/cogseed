/* Preview catalog: add an entry here when adding a new preview page.
 * Page samples follow product sidebar order; login precedes the app and settings follows tasks. */
const pages = [
  {"path":"components/navigation/page-header.card.html","group":"组件库","name":"页面顶栏","description":""},
  {"path":"ui_kits/enterprise-app/index.html?page=login","group":"页面","name":"登录","description":"登录入口 · 品牌字标与登录操作"},
  {"path":"ui_kits/enterprise-app/index.html?page=home","group":"页面","name":"默认页面","description":"首页 · 工作输入台、七个快捷建议与接续入口"},
  {"path":"ui_kits/enterprise-app/index.html?page=spaces","group":"页面","name":"工作空间","description":"工作空间 · 搜索排序、继续工作与场景角色模板"},
  {"path":"ui_kits/enterprise-app/index.html?page=space&space=space-0","group":"页面","name":"工作空间详情","description":"任务、产物、资产与空间设置"},
  {"path":"ui_kits/enterprise-app/index.html?page=automation","group":"页面","name":"自动化","description":"自动化 · 紧凑任务行、计划配置与执行记录"},
  {"path":"ui_kits/enterprise-app/cognition.html","group":"页面","name":"认知资产","description":""},
  {"path":"ui_kits/enterprise-app/index.html?page=capabilities","group":"页面","name":"智能体 / 技能 / 连接","description":"五个页签 · 智能体、工具、技能、资料库、IM"},
  {"path":"ui_kits/enterprise-app/index.html?page=capabilities&tab=agents&agent=credit","group":"页面","name":"智能体管理工作台","description":""},
  {"path":"ui_kits/enterprise-app/index.html?page=capabilities&tab=agents&agent=credit&edit=1","group":"页面","name":"智能体编辑","description":""},
  {"path":"ui_kits/enterprise-app/task.html","group":"页面","name":"任务 · 对话详情","description":""},
  {"path":"ui_kits/enterprise-app/index.html?page=settings","group":"页面","name":"设置","description":"设置 · 数据、账号、账号与用量、通用、安全与信任、关于我们"},
  {"path":"components/forms/settings-section.card.html","group":"组件库","name":"设置分组","description":"统一浅边框容器 · 组内紧凑布局"},
  {"path":"components/navigation/sidebar.card.html","group":"组件库","name":"侧边栏导航","description":""},
  {
    "path": "components/actions/buttons.card.html",
    "group": "组件库",
    "name": "按钮",
    "description": "主 / 次 / 文字 / 危险 / 禁用 / 图标钮 · h 28·32·36"
  },
  {
    "path": "components/composer/composer.card.html",
    "group": "组件库",
    "name": "输入台",
    "description": "基础入口 · 发送与排队 · 附件 · 语音 · 正文编辑 · 不可发送"
  },
  {
    "path": "components/cards/cards.card.html",
    "group": "组件库",
    "name": "卡片",
    "description": "基础骨架 · 工作空间 · 自动化 · 能力 · 模板 · 有界宽度"
  },
  {
    "path": "components/data/data.card.html",
    "group": "组件库",
    "name": "数据展示",
    "description": "头像 · 标签 · 数据表 · 任务行 · 滚动区 · 比例容器 · 连接器"
  },
  {
    "path": "components/feedback/feedback.card.html",
    "group": "组件库",
    "name": "覆盖层与反馈",
    "description": "状态 · 提示条 · 通知 · 授权条 · 步骤组 · 骨架 · 空状态 · 对话框"
  },
  {
    "path": "components/forms/fields.card.html",
    "group": "组件库",
    "name": "表单控件",
    "description": "输入框 · 字段 · 选择 · 复选单选 · 开关 · 滑块 · 步进 · 标签输入"
  },
  {
    "path": "components/foundation/icons.card.html",
    "group": "组件库",
    "name": "图标集",
    "description": "线性 · 24px 画板 · 2px 描边 · 单色"
  },
  {
    "path": "components/navigation/navigation.card.html",
    "group": "组件库",
    "name": "导航与结构",
    "description": "导航项 · 页签 · 分段 · 菜单 / 用户菜单 · 折叠 · 面包屑 · 分页"
  },
  {
    "path": "components/retrieval/retrieval.card.html",
    "group": "组件库",
    "name": "检索与录入",
    "description": "命令面板 ⌘K · 日期区间 · 日历 · 文件上传"
  },
  {
    "path": "guidelines/borders.card.html",
    "group": "设计规范",
    "name": "描边阶",
    "description": "hairline 到章节分割线，共 5 阶"
  },
  {
    "path": "guidelines/brand-mist.card.html",
    "group": "设计规范",
    "name": "主视觉 · 渐变雾",
    "description": "仅默认首页背景；其他页面与侧栏使用纯色"
  },
  {
    "path": "guidelines/brand-wordmark.card.html",
    "group": "设计规范",
    "name": "品牌字标",
    "description": "沿用 CogSeed Logo、名称与松鼠品牌图形"
  },
  {
    "path": "guidelines/colors-accent.card.html",
    "group": "设计规范",
    "name": "强调 · 开源绿",
    "description": "低饱和、限量出现：发送键 · 头像 · 选中态 · 渐变雾"
  },
  {
    "path": "guidelines/colors-ink.card.html",
    "group": "设计规范",
    "name": "中性 · 墨",
    "description": "12 阶文字与图标灰阶"
  },
  {
    "path": "guidelines/colors-status.card.html",
    "group": "设计规范",
    "name": "状态 · 三色",
    "description": "只用于表达状态，永不用于强调或装饰"
  },
  {
    "path": "guidelines/colors-surfaces.card.html",
    "group": "设计规范",
    "name": "中性 · 面",
    "description": "工作区、侧栏、文档台面与选中底"
  },
  {
    "path": "guidelines/elevation.card.html",
    "group": "设计规范",
    "name": "阴影阶",
    "description": "层级靠版式与分割线建立，阴影只用于浮起的东西"
  },
  {
    "path": "guidelines/layout.card.html",
    "group": "设计规范",
    "name": "框架尺寸 · 1440×900",
    "description": "侧栏 280 · 标题栏 52 · 对话正文 720–760 · 产物纸张 660"
  },
  {
    "path": "guidelines/motion.card.html",
    "group": "设计规范",
    "name": "动效时长",
    "description": "全局同时最多一个动效焦点；禁止弹跳、缩放入场、渐变流光"
  },
  {
    "path": "guidelines/radius.card.html",
    "group": "设计规范",
    "name": "圆角阶",
    "description": "4 标签 · 7 小钮 · 8 导航 · 9 输入 · 11 浮层 · 12 卡片 · 14 窗口 · 999 胶囊"
  },
  {
    "path": "guidelines/spacing-scale.card.html",
    "group": "设计规范",
    "name": "间距阶 · 4px 基数",
    "description": "同组 8 · 组间 16–24 · 区块间 32–52 · 页面留白 88"
  },
  {
    "path": "guidelines/states.card.html",
    "group": "设计规范",
    "name": "交互态规则",
    "description": "hover / 焦点 / 选中 / 禁用的统一表达"
  },
  {
    "path": "guidelines/type-display.card.html",
    "group": "设计规范",
    "name": "Sans · 问候与标题",
    "description": "系统非衬线 400 — display 34 / heading 22 / dialog 18"
  },
  {
    "path": "guidelines/type-mono.card.html",
    "group": "设计规范",
    "name": "Sans · 数字与标签",
    "description": "系统默认非衬线 — 代码、数字与元数据"
  },
  {
    "path": "guidelines/type-sans.card.html",
    "group": "设计规范",
    "name": "Sans · 界面与正文",
    "description": "系统默认非衬线 — title 15 · body 15 · ui 14 · caption 12.5"
  },
  {
    "path": "guidelines/windows-intranet.card.html",
    "group": "设计规范",
    "name": "Windows 与内网",
    "description": "macOS 基础窗体 · 系统非衬线 · 无字体资源 · 本地脚本"
  }
];
const navigation = document.getElementById('navigation');
const search = document.getElementById('search');
const preview = document.getElementById('preview');
const groups = ['页面', '组件库', '设计规范'];
let selected;
function renderNavigation() {
  const query = search.value.trim().toLocaleLowerCase();
  navigation.replaceChildren();
  let count = 0;
  groups.forEach(group => {
    const matches = pages.filter(page => page.group === group &&
      `${page.name} ${page.description} ${page.path} ${page.group}`.toLocaleLowerCase().includes(query));
    if (!matches.length) return;
    count += matches.length;
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = `${group} · ${matches.length}`;
    section.append(heading);
    matches.forEach(page => {
      const link = document.createElement('a');
      link.href = '#' + encodeURIComponent(page.path);
      link.textContent = page.name;
      link.title = page.description;
      if (page === selected) link.setAttribute('aria-current', 'page');
      section.append(link);
    });
    navigation.append(section);
  });
  document.getElementById('count').textContent = query ? `找到 ${count} 项内容` : `共 ${pages.length} 项内容`;
  if (!count) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '没有匹配的内容，试试“按钮”“颜色”或“输入”。';
    navigation.append(empty);
  }
}
function selectFromHash() {
  let path = '';
  try { path = decodeURIComponent(location.hash.slice(1)); } catch (_) { /* Invalid hashes use the default page. */ }
  if (path === 'ui_kits/enterprise-app/index.html?page=task') path = 'ui_kits/enterprise-app/task.html';
  const page = pages.find(item => item.path === path) || pages[0];
  if (page !== selected) {
    selected = page;
    preview.title = page.name;
    preview.src = page.path;
    document.getElementById('category').textContent = page.group;
    document.getElementById('title').textContent = page.name;
    document.getElementById('description').textContent = page.description;
    document.getElementById('open-page').href = page.path;
    document.title = `${page.name} · CogSeed 设计系统`;
  }
  renderNavigation();
}
search.addEventListener('input', renderNavigation);
window.addEventListener('hashchange', selectFromHash);
selectFromHash();
