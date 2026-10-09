// ─── Dashboard 卡片渲染器（:::dashboard JSON 组件树 → HTML） ─────────────
//
// 独立域模块（自 utils.js 迁出，2026-09-08 重构）。职责边界：
//   renderDashboard(spec)           — 组件树 → HTML（唯一公开渲染入口）
//   parseDashboardSpec(body)        — 容错解析（严格 → 有界修复 → undefined）
//   renderDashboardFromJsonBlock()  — ```json 围栏识别
//   dashboardStandaloneReplacer()   — 裸 JSON 段落抢救（正文无围栏时）
//
// 设计约定：
//   组件注册表单源驱动——`_DB_COMPONENTS` 一张表同时承担「合法类型白名单」
//   与「渲染分发」两个职责（旧实现是 _DB_COMPONENT_TYPES 白名单 + switch-case
//   两份手工同步的名单，漏改一处即识别/渲染漂移）。新增组件只改这一张表。
//   所有渲染器统一签名 (props, children) => string。
//
// 安全：所有模型可控字符串一律过 escapeHtml；本模块不产出可执行内容。

// ── 依赖注入（classic script：utils.js 在本文件前加载，直接引用其全局） ──

/** escapeHtml 由 utils.js 提供（classic script 全局函数；测试环境经
 * bridge 注入 window 级 stub）。这里包一层别名保持本模块自洽可测。 */
const _dbEscapeHtml = (typeof escapeHtml === 'function')
  ? escapeHtml
  : (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

// ── 枚举与常量 ──────────────────────────────────────────────────────────

const _DB_GAP = { sm: 'sm', md: 'md', lg: 'lg' };
const _DB_TONE = { positive: 'positive', negative: 'negative', neutral: 'neutral', warning: 'warning' };
const _DB_LEVEL = { info: 'info', success: 'success', warning: 'warning', error: 'error' };
const _DB_CHART_KIND = { line: 'line', bar: 'bar', area: 'area', pie: 'pie' };
const _DB_JSON_FENCE_LANGS = { '': true, json: true, dashboard: true, jsonc: true };
// 调色板循环上限：CSS 按 data-idx 提供 6 色循环（饼图扇区/柱/折线点/图例共用）。
const _DB_PALETTE_CYCLE = 6;

// ── 小工具 ──────────────────────────────────────────────────────────────

function _dbEnum(table, val, dflt) {
  return (val && Object.prototype.hasOwnProperty.call(table, val)) ? table[val] : dflt;
}

/** 统一「可空值 → 转义文本」：替代散落各渲染器 6+ 处的
 * escapeHtml(String(x == null ? '' : x)) 样板。 */
function _dbText(value) {
  return _dbEscapeHtml(value == null ? '' : String(value));
}

/** 空状态占位：三类组件（Table/Timeline/Chart）共用同一形态，
 * data-kind 供 CSS 区分最小高度。 */
function _dbEmptyState(kind) {
  return `<div class="db-empty" data-kind="${kind}"></div>`;
}

/** data 属性开关（替代 `cond ? ' data-x="1"' : ''` 样板）。 */
function _dbFlag(attr, on) {
  return on ? ` data-${attr}="1"` : '';
}

// ── 布局原语 ────────────────────────────────────────────────────────────

function _dbStack(props, children, deps) {
  const dir = props.direction === 'horizontal' ? 'horizontal' : 'vertical';
  const gap = _dbEnum(_DB_GAP, props.gap, 'md');
  return `<div class="db-stack" data-direction="${dir}" data-gap="${gap}">${_dbChildren(children, deps)}</div>`;
}

function _dbGrid(props, children, deps) {
  const cols = Math.min(4, Math.max(1, Number(props.columns) || 2));
  const gap = _dbEnum(_DB_GAP, props.gap, 'md');
  return `<div class="db-grid" data-columns="${cols}" data-gap="${gap}">${_dbChildren(children, deps)}</div>`;
}

function _dbCard(props, children, deps) {
  const tone = _dbEnum(_DB_TONE, props.tone, 'neutral');
  const title = props.title ? `<div class="db-card-title">${_dbText(props.title)}</div>` : '';
  return `<section class="db-card" data-tone="${tone}">${title}<div class="db-card-body">${_dbChildren(children, deps)}</div></section>`;
}

// ── 内容组件 ────────────────────────────────────────────────────────────

function _dbMetric(props) {
  const tone = _dbEnum(_DB_TONE, props.tone, 'neutral');
  const delta = props.delta != null
    ? `<div class="db-metric-delta" data-tone="${tone}">${_dbText(props.delta)}</div>` : '';
  return `<div class="db-metric" data-tone="${tone}">
    <div class="db-metric-label">${_dbText(props.label)}</div>
    <div class="db-metric-value">${_dbText(props.value)}</div>
    ${delta}
  </div>`;
}

function _dbAlert(props, children = [], deps) {
  const level = _dbEnum(_DB_LEVEL, props.level, 'info');
  const titleRaw = props.title ?? props.heading ?? props.label ?? props.name;
  const bodyRaw = props.body ?? props.message ?? props.text ?? props.content ?? props.description;
  const titleText = String(titleRaw == null ? '' : titleRaw);
  const bodyText = String(bodyRaw == null ? '' : bodyRaw);
  // Fallback: some models put the alert copy in child nodes (e.g. a nested
  // Markdown) instead of a text prop. Render those as the body so the alert
  // is not silently dropped to an empty string.
  const childHtml = (!titleText && !bodyText && children.length) ? _dbChildren(children, deps) : '';
  if (!titleText && !bodyText && !childHtml) return '';
  const content = childHtml
    ? `<div class="db-alert-body">${childHtml}</div>`
    : `<div class="db-alert-title">${_dbText(titleText || bodyText)}</div>${
        titleText && bodyText ? `<div class="db-alert-body">${_dbText(bodyText)}</div>` : ''}`;
  return `<div class="db-alert" data-level="${level}" role="status">
    <span class="db-alert-icon" aria-hidden="true"></span>
    <div class="db-alert-content">${content}</div>
  </div>`;
}

function _dbTable(props) {
  const cols = Array.isArray(props.columns) ? props.columns : [];
  const rows = Array.isArray(props.rows) ? props.rows : [];
  if (!cols.length) return _dbEmptyState('table');
  const head = cols.map((c) => `<th${_dbFlag('numeric', !!(c && c.numeric))}>${_dbText(c && (c.label || c.key))}</th>`).join('');
  const body = rows.map((r) => {
    const cells = cols.map((c) => {
      const k = c && c.key;
      const v = (k && r && Object.prototype.hasOwnProperty.call(r, k)) ? r[k] : '';
      return `<td${_dbFlag('numeric', !!(c && c.numeric))}>${_dbText(v)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<div class="db-table-wrap"><table class="db-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function _dbTimeline(props) {
  const items = Array.isArray(props.items) ? props.items : [];
  if (!items.length) return _dbEmptyState('timeline');
  const lis = items.map((it) => {
    const body = it && it.body ? `<div class="db-timeline-body">${_dbText(it.body)}</div>` : '';
    return `<li class="db-timeline-item">
      <div class="db-timeline-time">${_dbText(it && it.time)}</div>
      <div class="db-timeline-label">${_dbText(it && it.label)}</div>
      ${body}
    </li>`;
  }).join('');
  return `<ol class="db-timeline">${lis}</ol>`;
}

function _dbCode(props) {
  const lang = _dbText(props.lang);
  const langAttr = lang ? ` data-lang="${lang}"` : '';
  return `<pre class="db-code"${langAttr}><code>${_dbText(props.code)}</code></pre>`;
}

function _dbMarkdown(props, children, deps) {
  // Accept `text` (schema name) or `content` (common model guess) — without
  // this alias the model's `{ Markdown: { content: "..." } }` silently
  // collapses to an empty bubble and the section disappears.
  const raw = props.text != null ? props.text : props.content;
  const text = String(raw == null ? '' : raw);
  // Recursive call back into the markdown pipeline keeps the same feature set
  // (tables / lists / inline code / autolinks); strip leading `:::dashboard`
  // re-entry to prevent an infinite-render loop if the model nests one.
  const cleaned = text.replace(/:::dashboard[\s\S]*?:::/g, '');
  const renderFull = deps.renderMarkdownFull;
  return `<div class="db-markdown">${renderFull(cleaned)}</div>`;
}

function _dbImage(props) {
  const src = String(props.src || '');
  if (!src) return '';
  const caption = props.caption
    ? `<figcaption class="db-image-caption">${_dbText(props.caption)}</figcaption>` : '';
  return `<figure class="db-image"><img src="${_dbText(src)}" alt="${_dbText(props.alt)}" data-monitor-resource="dashboard-image">${caption}</figure>`;
}

// ── 图表（内联 SVG：line/bar/area/pie） ─────────────────────────────────

function _dbChart(props) {
  const kind = _dbEnum(_DB_CHART_KIND, props.kind, 'bar');
  const data = Array.isArray(props.data) ? props.data : [];
  if (!data.length) return _dbEmptyState('chart');
  if (kind === 'pie') return _dbPie(data);
  return _dbXyChart(kind, data);
}

function _dbPie(data) {
  // data: [{label, value}, ...]
  const items = data.filter((d) => d && Number.isFinite(Number(d.value)) && Number(d.value) > 0);
  const total = items.reduce((a, d) => a + Number(d.value), 0);
  if (!total) return _dbEmptyState('chart');
  const cx = 50, cy = 50, r = 45;
  let acc = 0;
  const segs = items.map((d, i) => {
    const v = Number(d.value);
    const startAngle = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const endAngle = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = (v / total) > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
    return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" class="db-chart-slice" data-idx="${i % _DB_PALETTE_CYCLE}"></path>`;
  }).join('');
  const legend = items.map((d, i) =>
    `<li data-idx="${i % _DB_PALETTE_CYCLE}"><span class="db-chart-swatch"></span>${_dbText(d.label)} <span class="db-chart-val">${_dbText(d.value)}</span></li>`
  ).join('');
  return `<div class="db-chart" data-kind="pie">
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" class="db-chart-svg">${segs}</svg>
    <ol class="db-chart-legend">${legend}</ol>
  </div>`;
}

function _dbXyChart(kind, data) {
  // data: [{x, y}, ...] — x is label (string), y is numeric.
  const points = data.map((d) => ({ x: String((d && d.x) ?? ''), y: Number((d && d.y) ?? 0) }))
    .filter((p) => Number.isFinite(p.y));
  if (!points.length) return _dbEmptyState('chart');
  const W = 320, H = 140, padL = 32, padR = 8, padT = 8, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxY = Math.max(...points.map((p) => p.y), 0);
  const minY = Math.min(...points.map((p) => p.y), 0);
  const span = (maxY - minY) || 1;
  const xOf = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yOf = (y) => padT + innerH - ((y - minY) / span) * innerH;
  const yTicks = [0, 0.5, 1].map((ratio) => {
    const y = padT + innerH - ratio * innerH;
    const val = minY + ratio * span;
    const label = Math.abs(val) >= 10 ? Math.round(val) : Number(val.toFixed(1));
    return `<line x1="${padL}" y1="${y.toFixed(2)}" x2="${W - padR}" y2="${y.toFixed(2)}" class="db-chart-gridline"></line>` +
      `<text x="${(padL - 6).toFixed(2)}" y="${(y + 3).toFixed(2)}" class="db-chart-ylabel" text-anchor="end">${_dbText(label)}</text>`;
  }).join('');
  const axis = `<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="db-chart-axis"></line>`;
  let body = '';
  if (kind === 'bar') {
    const barW = innerW / points.length * 0.6;
    body = points.map((p, i) => {
      const x = xOf(i) - barW / 2;
      const y = yOf(Math.max(p.y, 0));
      const h = Math.abs(yOf(p.y) - yOf(0));
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="3" class="db-chart-bar-rect" data-idx="${i % _DB_PALETTE_CYCLE}"></rect>`;
    }).join('');
  } else {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(' ');
    if (kind === 'area') {
      const area = `M${xOf(0).toFixed(2)},${yOf(minY).toFixed(2)} ` +
        points.map((p, i) => `L${xOf(i).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(' ') +
        ` L${xOf(points.length - 1).toFixed(2)},${yOf(minY).toFixed(2)} Z`;
      body = `<path d="${area}" class="db-chart-area"></path><path d="${path}" class="db-chart-line"></path>`;
    } else {
      body = `<path d="${path}" class="db-chart-line"></path>` +
        points.map((p, i) => `<circle cx="${xOf(i).toFixed(2)}" cy="${yOf(p.y).toFixed(2)}" r="2.5" class="db-chart-dot" data-idx="${i % _DB_PALETTE_CYCLE}"></circle>`).join('');
    }
  }
  const labels = points.map((p, i) => {
    if (points.length > 8 && i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return '';
    return `<text x="${xOf(i).toFixed(2)}" y="${(H - 6).toFixed(2)}" class="db-chart-xlabel" text-anchor="middle">${_dbText(p.x)}</text>`;
  }).join('');
  return `<div class="db-chart" data-kind="${kind}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="db-chart-svg">
      ${yTicks}${axis}${body}${labels}
    </svg>
  </div>`;
}

// ── 组件注册表（单源：类型合法性 + 渲染分发共用这一张表） ────────────────

const _DB_COMPONENTS = {
  // ── Layout ──
  Stack: _dbStack,
  Grid: _dbGrid,
  Card: _dbCard,
  Separator: () => '<hr class="db-separator">',
  // ── Content ──
  Metric: _dbMetric,
  Chart: _dbChart,
  Table: _dbTable,
  Alert: _dbAlert,
  Timeline: _dbTimeline,
  Code: _dbCode,
  Markdown: _dbMarkdown,   // (props, children, deps) — 需 renderMarkdownFull
  Image: _dbImage,
};

function _dbChildren(children, deps) {
  return children.map((child) => _renderDbNode(child, deps)).join('');
}

function _renderDbNode(node, deps) {
  if (!node || typeof node !== 'object') return '';
  const render = Object.prototype.hasOwnProperty.call(_DB_COMPONENTS, node.type)
    ? _DB_COMPONENTS[node.type]
    : null;
  if (!render) return `<div class="db-unknown" data-type="${_dbText(node.type)}"></div>`;
  // props 双形态兼容：React 风格（{type, props:{...}}）与扁平风格
  // （{type, label, value, ...}——不少模型把属性直接平铺在节点上）。
  // children 同款双形态兜底（React 式 props.children）；props 缺失时节点
  // 自身就是属性袋——否则整卡渲染成空壳（真机：5 个 Metric 全空白）。
  const props = (node.props && typeof node.props === 'object') ? node.props : node;
  const children = Array.isArray(node.children)
    ? node.children
    : (Array.isArray(props.children) ? props.children : []);
  return render(props, children, deps);
}

// ── markdown 管线绑定（utils.js 加载完成后注册；解决 classic-script
//    加载序下 dashboard.js 先于 utils.js、拿不到其函数声明的问题） ──

let _dbMarkdownRenderer = null;
function bindMarkdownRenderer(fn) {
  if (typeof fn === 'function') _dbMarkdownRenderer = fn;
}

/** 入口：spec → HTML。deps.renderMarkdownFull 供 Markdown 组件递归回
 * 完整 markdown 管道；缺省查 utils.js 的运行期绑定；都无（独立测试）
 * 退化纯文本。 */
function renderDashboard(spec, deps) {
  if (!spec || typeof spec !== 'object') return '';
  const renderFull = (deps && deps.renderMarkdownFull)
    || _dbMarkdownRenderer
    || ((s) => _dbText(s));
  const effectiveDeps = { renderMarkdownFull: renderFull };
  const theme = spec.theme || {};
  const themeColor = _dbEnum({ neutral: 'neutral', brand: 'brand', success: 'success', warning: 'warning', danger: 'danger' }, theme.color, 'neutral');
  const themeStyle = _dbEnum({ minimal: 'minimal', card: 'card' }, theme.style, 'minimal');
  const inner = _renderDbNode(spec.root, effectiveDeps);
  return `<div class="dashboard" data-theme-color="${themeColor}" data-theme-style="${themeStyle}">${inner}</div>`;
}


// ── 解析与容错修复（LLM 手写 JSON 的常见缺陷：串内未转义引号、多余的
//    根闭括号、尾随散文、截断缺闭括号、子对象缺闭——严格 parse 全拒，
//    有界修复后重试；全部失败返回 undefined，调用方落 parse-error 兜底） ──

function _tryParseDashboardJson(text) {
  try { return JSON.parse(text); } catch (_) { return undefined; }
}

function _tryDashboardRepairVariants(text) {
  const strict = _tryParseDashboardJson(text);
  if (strict !== undefined) return strict;

  const extraCloserRepaired = _repairDashboardJsonExtraClosers(text);
  if (extraCloserRepaired !== text) {
    const parsed = _tryParseDashboardJson(extraCloserRepaired);
    if (parsed !== undefined) return parsed;
    const mismatchAfterExtra = _repairDashboardJsonMismatchedClosers(extraCloserRepaired);
    if (mismatchAfterExtra !== extraCloserRepaired) {
      const afterMismatch = _tryParseDashboardJson(mismatchAfterExtra);
      if (afterMismatch !== undefined) return afterMismatch;
      const tailAfterMismatch = _repairDashboardJsonTail(mismatchAfterExtra);
      if (tailAfterMismatch !== undefined) return tailAfterMismatch;
    }
    const tailAfterExtra = _repairDashboardJsonTail(extraCloserRepaired);
    if (tailAfterExtra !== undefined) return tailAfterExtra;
  }

  const mismatchRepaired = _repairDashboardJsonMismatchedClosers(text);
  if (mismatchRepaired !== text) {
    const parsed = _tryParseDashboardJson(mismatchRepaired);
    if (parsed !== undefined) return parsed;
    const tailAfterMismatch = _repairDashboardJsonTail(mismatchRepaired);
    if (tailAfterMismatch !== undefined) return tailAfterMismatch;
  }

  return _repairDashboardJsonTail(text);
}


function _dashboardFenceLang(lang) {
  return String(lang || '').trim().split(/\s+/)[0].toLowerCase();
}

function _isDashboardJsonFenceLang(lang) {
  const key = _dashboardFenceLang(lang);
  return Object.prototype.hasOwnProperty.call(_DB_JSON_FENCE_LANGS, key);
}

function _dashboardJsonFenceCandidate(lang, code) {
  const rawLang = String(lang || '');
  const rawCode = String(code == null ? '' : code);
  if (_isDashboardJsonFenceLang(rawLang)) return rawCode;

  const info = rawLang.trimStart();
  const namedInline = info.match(/^(jsonc?|dashboard)\b([\s\S]*)$/i);
  if (namedInline) {
    const inline = String(namedInline[2] || '').trimStart();
    if (inline.startsWith('{') || inline.startsWith('[')) {
      return inline + (rawCode ? `\n${rawCode}` : '');
    }
  }
  if (info.startsWith('{') || info.startsWith('[')) {
    return info + (rawCode ? `\n${rawCode}` : '');
  }
  return null;
}

function _unwrapDashboardSpecBody(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return '';
  const fenced = text.match(/^(```|~~~)([^\n`]*)\n([\s\S]*?)\n?\1\s*$/);
  if (fenced && _isDashboardJsonFenceLang(fenced[2])) return fenced[3].trim();
  return text;
}

function _isDashboardNode(node) {
  return !!(
    node && typeof node === 'object' && !Array.isArray(node)
    && typeof node.type === 'string'
    && Object.prototype.hasOwnProperty.call(_DB_COMPONENTS, node.type)
  );
}

function _looksLikeDashboardSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const hasRoot = Object.prototype.hasOwnProperty.call(spec, 'root');
  if (!hasRoot) return false;
  if (spec.root == null) return spec.schema_version != null;
  return _isDashboardNode(spec.root);
}

function _renderDashboardFromJsonBlock(lang, code, deps) {
  const body = _dashboardJsonFenceCandidate(lang, code);
  if (body == null) return '';
  const spec = _parseDashboardSpec(body);
  if (!_looksLikeDashboardSpec(spec)) return '';
  return renderDashboard(spec, deps);
}

function _protectedDashboardPlaceholder(body, protectedBlocks) {
  const m = String(body || '').trim().match(/^\x00BLOCK(\d+)\x00$/);
  if (!m) return '';
  const html = protectedBlocks[Number(m[1])] || '';
  return /^<div class="dashboard"(?:\s|>)/.test(html) ? m[0] : '';
}

function _findJsonRootEnd(text, start) {
  let inString = false;
  let escaped = false;
  let opened = false;
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); opened = true; continue; }
    if (c === '}' || c === ']') {
      if (!stack.length) return -1;
      const open = stack.pop();
      if ((open === '{' && c !== '}') || (open === '[' && c !== ']')) return -1;
      if (opened && stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function _replaceStandaloneDashboardJsonBlocks(md, protect, deps) {
  const text = String(md || '');
  if (text.indexOf('"root"') < 0 || text.indexOf('{') < 0) return text;
  const startRe = /(^|\n)([ \t]*)\{/g;
  let out = '';
  let cursor = 0;
  let m;
  while ((m = startRe.exec(text)) !== null) {
    const start = m.index + m[1].length + m[2].length;
    if (start < cursor) continue;
    const end = _findJsonRootEnd(text, start);
    if (end < 0) continue;
    const tail = text.slice(end);
    if (!/^[ \t]*(?:\r?\n|$)/.test(tail)) {
      startRe.lastIndex = start + 1;
      continue;
    }
    const candidate = text.slice(start, end);
    const spec = _parseDashboardSpec(candidate);
    if (!_looksLikeDashboardSpec(spec)) {
      startRe.lastIndex = start + 1;
      continue;
    }
    out += text.slice(cursor, start) + protect(renderDashboard(spec, deps));
    cursor = end;
    startRe.lastIndex = end;
  }
  return out + text.slice(cursor);
}

function _escapeLikelyUnescapedStringQuotes(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) {
      out += c;
      if (c === '"') { inString = true; escaped = false; }
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j] || '';
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        out += c;
        inString = false;
      } else {
        out += '\\"';
        changed = true;
      }
      continue;
    }
    out += c;
  }
  return changed ? out : text;
}

function _repairDashboardJsonTail(text) {
  let inString = false;
  let escaped = false;
  let opened = false;
  let balancedEnd = -1;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); opened = true; }
    else if (c === '}' || c === ']') {
      if (stack.length) stack.pop();
      // First time the root value closes: everything after is trailing tail.
      if (opened && stack.length === 0) { balancedEnd = i + 1; break; }
    }
  }

  // Repair 1: a complete root value followed by trailing garbage (extra `}`).
  if (balancedEnd > 0 && balancedEnd < text.length) {
    const parsed = _tryParseDashboardJson(text.slice(0, balancedEnd));
    if (parsed !== undefined) return parsed;
  }
  // Repair 2: unclosed tree — append the closers it still needs, innermost first.
  if (opened && stack.length && !inString) {
    const closers = stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    const parsed = _tryParseDashboardJson(text + closers);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function _repairDashboardJsonMismatchedClosers(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  const stack = [];
  const closeFor = (c) => (c === '{' ? '}' : ']');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { out += c; inString = true; continue; }
    if (c === '{' || c === '[') { out += c; stack.push(closeFor(c)); continue; }
    if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) {
        stack.pop();
        out += c;
        continue;
      }
      const parentIdx = stack.lastIndexOf(c);
      if (parentIdx >= 0) {
        while (stack.length - 1 > parentIdx) {
          out += stack.pop();
          changed = true;
        }
        stack.pop();
      }
      out += c;
      continue;
    }
    out += c;
  }
  return changed ? out : text;
}

function _nextNonWhitespaceChar(text, pos) {
  let i = pos + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] || '';
}

function _repairDashboardJsonExtraClosers(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  const stack = [];
  const closeFor = (c) => (c === '{' ? '}' : ']');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { out += c; inString = true; continue; }
    if (c === '{' || c === '[') { out += c; stack.push(closeFor(c)); continue; }
    if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) {
        stack.pop();
        out += c;
        continue;
      }
      // Common model slip inside children/rows arrays: it closes a sibling
      // node one brace too far (`] } } }, { "type": ...`). If the next real
      // token is a comma, the array/object is still continuing, so this closer
      // is extra rather than a missing-inner-closer case.
      const next = _nextNonWhitespaceChar(text, i);
      if (stack.length && (next === ',' || next === stack[stack.length - 1])) {
        changed = true;
        continue;
      }
      if (!stack.includes(c)) {
        changed = true;
        continue;
      }
    }
    out += c;
  }
  return changed ? out : text;
}


// ── 公开 API ────────────────────────────────────────────────────────────

/** 容错解析入口：严格 parse → 有界修复链（多余闭括/错位闭括/截断尾/
 * 串内未转义引号）→ 全部失败返回 undefined（调用方落 parse-error 兜底，
 * 原文永不静默丢弃）。 */
function _parseDashboardSpec(body) {
  const text = _unwrapDashboardSpecBody(body);
  if (!text) return undefined;
  const repaired = _tryDashboardRepairVariants(text);
  if (repaired !== undefined) return repaired;

  const quoteRepaired = _escapeLikelyUnescapedStringQuotes(text);
  if (quoteRepaired !== text) {
    const parsed = _tryDashboardRepairVariants(quoteRepaired);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

const DashboardRenderer = {
  renderDashboard,
  parseDashboardSpec: _parseDashboardSpec,
  renderDashboardFromJsonBlock: (lang, code) => _renderDashboardFromJsonBlock(lang, code),
  dashboardStandaloneReplacer: (md, protect, deps) => _replaceStandaloneDashboardJsonBlocks(md, protect, deps),
  isDashboardJsonFenceLang: _isDashboardJsonFenceLang,
  dashboardJsonFenceCandidate: _dashboardJsonFenceCandidate,
  protectedDashboardPlaceholder: _protectedDashboardPlaceholder,
  unwrapDashboardSpecBody: _unwrapDashboardSpecBody,
  bindMarkdownRenderer,
  _DB_COMPONENT_TYPES: Object.fromEntries(Object.keys(_DB_COMPONENTS).map((k) => [k, true])),
};

// window 挂载（classic script 全局；utils.js 在其后加载并桥接）
if (typeof window !== 'undefined') window.DashboardRenderer = DashboardRenderer;

// Test bridge（与 utils.js 同款约定：浏览器 no-op，仅纯函数）。
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    renderDashboard,
    _parseDashboardSpec,
    DashboardRenderer,
    _DB_COMPONENTS,
    bindMarkdownRenderer,
  };
}
