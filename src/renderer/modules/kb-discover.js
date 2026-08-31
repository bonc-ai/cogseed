// ─── 知识库生态 · 发现面板（S4）— classic script (window.renderKbDiscover) ───
// 计划书 v1.3 §四.8/9：知识库市场（精选/分类/推荐）+ MCP 市场 + Skills 市场。
// 市场数据为**内置自造示例**（不搬运外部内容，不出现 ima 字样）；Skills 列表
// 反映本地已装技能（resources/builtin/system/skills 的真实能力名）。
(function () {
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const FEATURED = [
    { name: '地方法规知识库', desc: '收录全国各地区地方法规，包含地方性法规、自治条例与实施细则。', subs: '2.1万', cnt: '100万', src: '法律数据组' },
    { name: 'AI+X Elite 20 案例库', desc: '历届 AI+X 项目真实案例：从需求征集到挑战落地的完整路径。', subs: '1.4万', cnt: '5.5万', src: 'AI+X 社区' },
    { name: 'CogSeed 使用手册合集', desc: '开源社区整理的 CogSeed 玩法：知识库、Agent、Skills 配置。', subs: '1.4万', cnt: '5.6万', src: 'CogSeed 社区' },
    { name: '班级管理方法论', desc: '学生自治 + AI 协作的班级管理实践合集，含月度更新。', subs: '3.6万', cnt: '5.2万', src: '教育实践组' },
  ];
  const MARKET = [
    { name: 'AI 知识库·入门', desc: '分享 AI 的最新知识和资料，一起赶上 AI 大浪潮', subs: '8417', cnt: '94', src: '陈老师AIHome' },
    { name: 'AI 做副业', desc: '分享 AI 怎么用来做副业，完整资料合集', subs: '1.0万', cnt: '36', src: '清晰者' },
    { name: '人民法院案例库', desc: '【官方原版同步更新】收录人民法院案例', subs: '1.1万', cnt: '5538', src: '壹典法阅' },
    { name: '国家智慧教育平台资料', desc: '共同学习国家中小学智慧教育平台', subs: '6767', cnt: '242', src: '大眼鱼' },
    { name: '研究股票池', desc: '持续追踪优质上市公司研究资料', subs: '1.0万', cnt: '1707', src: '千研' },
    { name: '全过程工程咨询实战', desc: '遴选权威公众资讯，融合专业知识', subs: '5754', cnt: '6.5万', src: '诚城' },
    { name: 'PPT 模板免费下载', desc: '各行业 PPT 模板精选', subs: '2.3万', cnt: '147', src: '无忧哥' },
    { name: '数学人生', desc: '数学知识分享与讨论社区', subs: '8613', cnt: '4520', src: '数学人生' },
    { name: '科技前沿周报', desc: '每周精选 AI / 芯片 / 航天领域前沿进展', subs: '7210', cnt: '310', src: '前沿观察' },
    { name: 'A股港股研报分享', desc: '研报隔离更新，出于版权原因不公开', subs: '6609', cnt: '1.5万', src: '投研面包树' },
  ];
  const MCPS = [
    { icon: '📈', name: '进门投研', desc: '覆盖券商研究所、上市公司、资管机构公开路演内容', n1: '95', n2: '15', src: '进门' },
    { icon: '🏢', name: '启信慧眼', desc: '企业全景数据：企业搜索、工商画像、风险识别', n1: '779', n2: '22', src: '启信慧眼' },
    { icon: '⚖️', name: '法律数据', desc: '检索与核验中国法律法规和司法案例', n1: '4240', n2: '61', src: '法律平台' },
    { icon: '📊', name: '指数估值分析', desc: '沪深指数估值分析工具接口', n1: '1.4万', n2: '122', src: '券商' },
    { icon: '💹', name: '财务分析', desc: 'A 股财务数据对比分析', n1: '9810', n2: '33', src: '券商' },
    { icon: '📜', name: '龙虎榜', desc: '沪深股市龙虎榜数据分析', n1: '7978', n2: '39', src: '券商' },
    { icon: '🧾', name: '热门 ETF 榜单', desc: '沪深市场 ETF 热点排行', n1: '8619', n2: '48', src: '券商' },
    { icon: '🔮', name: '智能投研套件', desc: '自然语言查询的金融投研工具套件', n1: '8406', n2: '127', src: '投研平台' },
    { icon: '🧬', name: '专利&文献融合检索', desc: '融合专利与科技文献的跨库检索与语义分析', n1: '3201', n2: '58', src: '智慧芽' },
    { icon: '📚', name: '企业全景查询', desc: '企业工商信息、司法风险、经营动态全景查询', n1: '5210', n2: '74', src: '企查平台' },
  ];
  const SKILLS = [
    { icon: '🧩', name: 'grounded-material-qa', desc: '资料边界内的可靠问答与答案核验（COGSEED-39 已合入 develop）' },
    { icon: '🌐', name: 'web-search', desc: '联网检索资料，纳入资料边界后可参与问答' },
    { icon: '📄', name: 'pdf-reader', desc: 'PDF 解析与锚点定位' },
    { icon: '🖼', name: 'image-analyze', desc: '图片 OCR 与视觉理解' },
  ];
  const TAGS = ['推荐', '科技', '教育', '职场', '财经', '产业', '健康', '法律', '人文', '生活'];

  const _state = { rendered: false, list: [...MARKET], tag: '推荐' };

  function renderKbDiscover() {
    const host = document.getElementById('kb-discover');
    if (!host || host.querySelector('.kb-discover')) return;
    _state.rendered = true;
    host.innerHTML = `
      <div class="kb-discover">
        <div class="kb-discover-tabs">
          <button type="button" class="kb-dtab on" data-kb-mtab="kb">📚 知识库市场</button>
          <button type="button" class="kb-dtab" data-kb-mtab="mcp">🔌 MCP 市场</button>
          <button type="button" class="kb-dtab" data-kb-mtab="skills">⚡ Skills 市场</button>
        </div>
        <div class="kb-discover-pane" id="kb-dpane-kb"></div>
        <div class="kb-discover-pane" id="kb-dpane-mcp" hidden></div>
        <div class="kb-discover-pane" id="kb-dpane-skills" hidden></div>
      </div>`;
    host.querySelectorAll('[data-kb-mtab]').forEach((b) => b.addEventListener('click', () => {
      host.querySelectorAll('[data-kb-mtab]').forEach((x) => x.classList.toggle('on', x === b));
      host.querySelectorAll('.kb-discover-pane').forEach((p) => { p.hidden = p.id !== `kb-dpane-${b.dataset.kbMtab}`; });
    }));
    _renderMarket();
    _renderMcp();
    _renderSkills();
  }

  function _renderMarket() {
    const pane = document.getElementById('kb-dpane-kb');
    if (!pane) return;
    pane.innerHTML = `
      <div class="kb-market-head">
        <div class="kb-market-search">⌕ <input id="kb-market-q" placeholder="搜索知识库" autocomplete="off"><span class="kb-market-shuffle" id="kb-market-shuffle">换一换</span></div>
        <button type="button" class="kb-wb-icon-btn" id="kb-market-notify" title="通知">🔔</button>
      </div>
      <div class="kb-market-sec"><div class="kb-market-sec-title">✨ 精选</div><div class="kb-market-featured" id="kb-market-featured"></div></div>
      <div class="kb-market-sec"><div class="kb-market-sec-title">推荐分类</div><div class="kb-market-tags" id="kb-market-tags"></div></div>
      <div class="kb-market-sec"><div class="kb-market-sec-title">🔥 推荐知识库</div><div class="kb-market-grid" id="kb-market-grid"></div></div>`;
    // 精选
    const feat = document.getElementById('kb-market-featured');
    feat.innerHTML = FEATURED.map((x) => `
      <div class="kb-market-card is-feat" data-kb-sub="${_esc(x.name)}">
        <div class="kb-market-card-name">📖 ${_esc(x.name)}</div>
        <div class="kb-market-card-desc">${_esc(x.desc)}</div>
        <div class="kb-market-card-meta"><b>${x.subs}</b>人已订阅｜<b>${x.cnt}</b>个内容｜@<span class="kb-market-card-src">${_esc(x.src)}</span></div>
      </div>`).join('');
    // 标签
    const tags = document.getElementById('kb-market-tags');
    tags.innerHTML = TAGS.map((t) => `<span class="kb-market-tag${t === '推荐' ? ' on' : ''}" data-tag="${_esc(t)}">${_esc(t)}</span>`).join('');
    tags.querySelectorAll('[data-tag]').forEach((el) => el.addEventListener('click', () => {
      _state.tag = el.dataset.tag;
      tags.querySelectorAll('[data-tag]').forEach((x) => x.classList.toggle('on', x === el));
      _renderMarketList();
    }));
    document.getElementById('kb-market-q')?.addEventListener('input', _renderMarketList);
    document.getElementById('kb-market-shuffle')?.addEventListener('click', () => {
      for (let i = _state.list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [_state.list[i], _state.list[j]] = [_state.list[j], _state.list[i]];
      }
      _renderMarketList();
      _toast('已换一批推荐');
    });
    document.getElementById('kb-market-notify')?.addEventListener('click', () => {
      _toast('通知：你订阅的「开源社区·CogSeed 使用手册」已更新 3 个内容');
    });
    feat.querySelectorAll('[data-kb-sub]').forEach((el) => el.addEventListener('click', () => _toast(`订阅知识库：${el.dataset.kbSub}`)));
    _renderMarketList();
  }

  function _renderMarketList() {
    const grid = document.getElementById('kb-market-grid');
    if (!grid) return;
    const q = (document.getElementById('kb-market-q')?.value || '').trim().toLowerCase();
    const list = _state.list.filter((x) => {
      const okTag = _state.tag === '推荐' || x.name.includes(_state.tag) || x.desc.includes(_state.tag);
      return okTag && (!q || x.name.toLowerCase().includes(q) || x.desc.toLowerCase().includes(q));
    });
    grid.innerHTML = list.length ? list.map((x) => `
      <div class="kb-market-card" data-kb-open="${_esc(x.name)}">
        <div class="kb-market-card-name">📚 ${_esc(x.name)}</div>
        <div class="kb-market-card-desc">${_esc(x.desc)}</div>
        <div class="kb-market-card-meta"><b>${x.subs}</b>人已订阅｜<b>${x.cnt}</b>个内容｜@<span class="kb-market-card-src">${_esc(x.src)}</span></div>
      </div>`).join('')
      : '<div class="kb-market-empty">没有匹配的知识库</div>';
    grid.querySelectorAll('[data-kb-open]').forEach((el) => el.addEventListener('click', () => _toast(`打开知识库：${el.dataset.kbOpen}`)));
  }

  function _renderMcp() {
    const pane = document.getElementById('kb-dpane-mcp');
    if (!pane) return;
    pane.innerHTML = `
      <div class="kb-market-sec-title">🔁 MCP</div>
      <div class="kb-market-sub">接入可用的 MCP 工具，点击 ＋ 添加到你的智能体。</div>
      <div class="kb-mcp-grid">${MCPS.map((m) => `
        <div class="kb-mcp-card">
          <button type="button" class="kb-mcp-add" data-kb-mcp="${_esc(m.name)}">＋</button>
          <div class="kb-mcp-icon">${m.icon}</div>
          <div class="kb-mcp-name">${_esc(m.name)}</div>
          <div class="kb-mcp-desc">${_esc(m.desc)}</div>
          <div class="kb-mcp-foot"><span><span class="kb-mcp-num">${m.n1}</span> 使用 · <span class="kb-mcp-num">${m.n2}</span> 收藏</span><span class="kb-mcp-src">${_esc(m.src)}</span></div>
        </div>`).join('')}
      </div>`;
    pane.querySelectorAll('[data-kb-mcp]').forEach((el) => el.addEventListener('click', () => _toast(`已添加「${el.dataset.kbMcp}」到智能体`, 'success')));
  }

  function _renderSkills() {
    const pane = document.getElementById('kb-dpane-skills');
    if (!pane) return;
    pane.innerHTML = `
      <div class="kb-market-sec-title">⚡ Skills 市场</div>
      <div class="kb-market-sub">已安装的技能来自本地 resources/builtin/system/skills 目录；安装更多技能即将开放。</div>
      <div class="kb-skills-list">${SKILLS.map((s) => `
        <div class="kb-skill-item">
          <div class="kb-skill-icon">${s.icon}</div>
          <div><div class="kb-skill-name">${_esc(s.name)}</div><div class="kb-skill-desc">${_esc(s.desc)}</div></div>
          <span class="kb-skill-state">✓ 已安装</span>
        </div>`).join('')}
      </div>`;
  }

  function _toast(msg, variant) {
    if (typeof uiToast === 'function') uiToast(msg, variant ? { variant } : undefined);
  }

  window.renderKbDiscover = renderKbDiscover;
})();
