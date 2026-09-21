import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const modulesRoot = path.join(root, 'src/renderer/modules');

const sharedControlFactories = new Set([
  'ui-button.js',
  'ui-card.js',
  'ui-drawer.js',
  'ui-user-menu.js',
  'ui-form.js',
  'ui-segmented-control.js',
  'ui-status.js',
  'ui-structure.js',
  'ui-tabs.js',
]);

const legacyRawControlBaseline: Record<string, number> = {
  'account-chip.js': 4,
  'agents.js': 6,
  'auto.js': 1,
  'avatar-picker.js': 2,
  'bash_permission.js': 5,
  'boot.js': 1,
  'chat-artifact.js': 1,
  'chat-file-viewer.js': 3,
  'chat-input-form.js': 2,
  'chat-lightbox.js': 3,
  'cognition/pages.js': 5,
  'connectors.js': 2,
  'context-menu.js': 1,
  'contexts.js': 0,
  'continue-work.js': 3,
  'conversation-info.js': 6,
  'conversation.js': 17,
  'delete-file-confirm.js': 2,
  'dialogs.js': 9,
  'hub-account.js': 1,
  'import-check-modal.js': 5,
  'interactive-cli.js': 5,
  'interactive-tour.js': 4,
  'kb-eco.js': 1,
  // cognition-assets/views.js: 资产详情总开关（role="switch"，无文字 label）。
  // uiButton 强制可见文字 label，表达不了纯状态控件——与 run-center 的
  // 复合控件豁免同构（2026-09-17 认知资产迭代）。
  'cognition-assets/views.js': 1,
  'kb-notes.js': 24,
  'kb-workbench.js': 13,
  'library-transfer.js': 7,
  'marketplace.js': 7,
  'md-view-edit.js': 5,
  'memory.js': 1,
  'model-authorization.js': 3,
  'model-guard.js': 2,
  'onboarding.js': 21,
  'oss.js': 1,
  'personal-ontology.js': 5,
  'plugins.js': 2,
  'queue-draft.js': 5,
  'recall-projection-card.js': 4,
  'run-center-agents.js': 5,
  'run-center-board.js': 3,
  'search.js': 3,
  'settings-security.js': 0,
  'settings.js': 2,
  'skills.js': 2,
  'terminal-panel.js': 3,
  'text-view-edit.js': 3,
  'touchpoint-settings.js': 5,
  'user-workspace.js': 1,
  'utils.js': 4,
  'validation-report-view.js': 2,
  'workspace.js': 11,
};

const legacyDynamicControlBaseline: Record<string, number> = {
  'chat-artifact.js': 1,
  'chat-citation.js': 1,
  'chat-input-form.js': 9,
  'chat-stream.js': 5,
  'conversation.js': 4,
  'expense-agent-cards.js': 5,
  'interactive-cli.js': 1,
  'kb-notes.js': 2,
  'kb-quiz.js': 19,
  'kb-workbench.js': 10,
  'messaging-settings.js': 27,
  'model-chip.js': 6,
  'settings.js': 3,
  'user-workspace.js': 3,
  'utils.js': 1,
};

const legacyRawCheckboxBaseline: Record<string, number> = {
  'chat-input-form.js': 2,
  'hub-account.js': 1,
  'interactive-cli.js': 1,
  'kb-workbench.js': 1,
  'messaging-settings.js': 1,
  'onboarding.js': 12,
  'settings.js': 4,
  'touchpoint-settings.js': 1,
  'utils.js': 1,
};

const legacyIndexRawControlBaseline = 191;
const legacyIndexRawCheckboxBaseline = 3;

// Detail extraction moved legacy markup out of run-center.js. Freeze the two
// files as one owner so the extraction cannot raise the former 52-control
// budget. The remaining raw detail controls are composite, roving-tab widgets
// whose rich-content contract is not represented by uiButton.
const extractedLegacyGroups = [{
  label: 'Run Center controller and extracted detail renderer',
  files: ['run-center.js', 'run-center-detail.js'],
  limit: 33,
}];
const extractedLegacyFiles = new Set(extractedLegacyGroups.flatMap((group) => group.files));

function rendererModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererModules(absolutePath);
    if (!entry.isFile() || !entry.name.endsWith('.js')) return [];
    return [path.relative(modulesRoot, absolutePath).split(path.sep).join('/')];
  });
}

function rawControlCount(source: string): number {
  return (source.match(/<(?:button|input|textarea|select)\b/gi) || []).length;
}

function dynamicControlCount(source: string): number {
  return (source.match(/\b(?:document\.)?createElement\(\s*['"](?:button|input|textarea|select)['"]\s*\)/gi) || []).length
    + (source.match(/\bel\(\s*['"](?:button|input|textarea|select)['"]/gi) || []).length;
}

function rawCheckboxCount(source: string): number {
  return (source.match(/<input\b[^>]*\btype\s*=\s*['"]checkbox['"]/gi) || []).length
    + (source.match(/\.type\s*=\s*['"]checkbox['"]/gi) || []).length;
}

/**
 * 另外三个渲染层维度——**此前没有任何闸门**，所以存量可以无限增长而套件全绿：
 *   1. 用 emoji 当图标（规范：图标必须来自 `modules/icons.js`）；
 *   2. 内联 `<svg>` 画图标（同上）；
 *   3. 字面 `z-index`（规范：层序只能用 tokens.css 的 `--z-*`）。
 * 口径与裸控件一致：**冻结存量、禁止新增**。
 * 这些快照是"当前树的实测值"；合并了别的分支后需要按新树**重算**，
 * 但**不许为了过闸门而抬高**——抬高就等于绕过迁移与评审（与裸控件基线同一条纪律）。
 */
const emojiAsIconBaseline: Record<string, number> = {
  'bash_permission.js': 2,
  'chat-artifact.js': 1,
  'conversation.js': 3,
  // kb-notes.js / kb-quiz.js 的 emoji 已全部迁移到 icons.js（2026-09-21），基线随之删除：
  // 这两个文件再出现 emoji 就会直接红。
  // kb-workbench.js 的 emoji 已全部迁移到 icons.js（2026-09-21），基线随之删除。
  'model-authorization.js': 2,
  'onboarding.js': 8,
  'settings.js': 1,
  'skills.js': 1,
  'touchpoint-settings.js': 1,
  'workspace.js': 11,
};

/**
 * 内联 `<svg>` 的冻结值。**`icons.js` 豁免**：它就是图标的唯一合法源头，
 * 往它里面加图标正是规范要求的做法，冻死它等于堵掉正确路径。
 */
const inlineSvgBaseline: Record<string, number> = {
  'avatar.js': 4,
  'cognition/pages.js': 1,
  'cognition-assets/views.js': 1,
  'dashboard.js': 2,
  'import-check-modal.js': 1,
  'kb-workbench.js': 4,
  'marketplace.js': 1,
  'utils.js': 3,
};
const iconSourceFiles = new Set(['icons.js']);

const literalZIndexBaseline: Record<string, number> = {
  'kb-workbench.js': 3,
};
/**
 * 各 CSS 文件的字面 z-index 存量（层序应走 tokens.css 的 `--z-*`）。
 * `tokens.css` 豁免：它就是层序的唯一定义处；`vendor/**` 豁免：第三方样式不改。
 * 说明：这份快照是逐文件实测出来的——第一次跑这条闸门就抓到了此前无人量的
 * `cognition-assets.css`，正好证明"没闸门 = 没人知道有多少"。
 */
const styleZIndexBaseline: Record<string, number> = {
  'style.css': 7,
};
const styleTokensFile = 'tokens.css';
const styleVendorPrefix = 'vendor/';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/** 含 emoji 的**行数**（一行里多个只算一次：关心的是"这处 UI 用了 emoji"）。 */
function emojiLineCount(source: string): number {
  return source.split('\n').filter((line) => EMOJI_RE.test(line)).length;
}

function inlineSvgCount(source: string): number {
  return (source.match(/<svg\b/gi) || []).length;
}

function literalZIndexCount(source: string): number {
  return [...source.matchAll(/z-index\s*:\s*([^;}]+)/gi)]
    .filter((match) => !/var\(\s*--z-/i.test(match[1] || ''))
    .length;
}

function styleZIndexDeclarationCount(source: string): number {
  return literalZIndexCount(source);
}

describe('renderer shared UI adoption guard', () => {
  it('does not increase legacy raw-control usage or introduce it in new modules', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      if (extractedLegacyFiles.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyRawControlBaseline[relativePath] || 0;
      expect(
        rawControlCount(source),
        `${relativePath} adds raw controls; use the shared Renderer primitives instead`,
      ).toBeLessThanOrEqual(allowed);
    }
    for (const group of extractedLegacyGroups) {
      const actual = group.files.reduce((count, relativePath) => count
        + rawControlCount(fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8')), 0);
      expect(actual, `${group.label} adds raw controls; use the shared Renderer primitives instead`)
        .toBeLessThanOrEqual(group.limit);
    }
  });

  it('does not hide new raw controls behind createElement or local element helpers', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyDynamicControlBaseline[relativePath] || 0;
      expect(
        dynamicControlCount(source),
        `${relativePath} adds dynamically-created controls; use the shared Renderer primitives instead`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it('freezes raw controls in index.html and native checkbox debt across the Renderer', () => {
    const indexSource = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    expect(rawControlCount(indexSource), 'index.html adds raw controls; migrate through shared Renderer primitives')
      .toBeLessThanOrEqual(legacyIndexRawControlBaseline);
    expect(rawCheckboxCount(indexSource), 'index.html adds native checkboxes; use uiCheckbox or uiSwitch')
      .toBeLessThanOrEqual(legacyIndexRawCheckboxBaseline);

    for (const relativePath of rendererModules(modulesRoot)) {
      if (sharedControlFactories.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const allowed = legacyRawCheckboxBaseline[relativePath] || 0;
      expect(
        rawCheckboxCount(source),
        `${relativePath} adds native checkboxes; use uiCheckbox or uiSwitch`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it('does not use emoji as UI icons (icons must come from icons.js)', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const actual = emojiLineCount(source);
      const allowed = emojiAsIconBaseline[relativePath] || 0;
      expect(
        actual,
        `${relativePath} adds emoji used as UI icons (${actual} > ${allowed}); `
        + 'add an icon name to modules/icons.js and render it through uiIconHtml/hydrateUiIcons instead',
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it('does not inline <svg> icons outside icons.js', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      if (iconSourceFiles.has(relativePath)) continue;
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const actual = inlineSvgCount(source);
      const allowed = inlineSvgBaseline[relativePath] || 0;
      expect(
        actual,
        `${relativePath} inlines <svg> icons (${actual} > ${allowed}); `
        + 'define the icon in modules/icons.js and render it through uiIconHtml instead',
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it('does not add literal z-index values outside tokens.css', () => {
    for (const relativePath of rendererModules(modulesRoot)) {
      const source = fs.readFileSync(path.join(modulesRoot, relativePath), 'utf8');
      const actual = literalZIndexCount(source);
      const allowed = literalZIndexBaseline[relativePath] || 0;
      expect(
        actual,
        `${relativePath} adds a literal z-index (${actual} > ${allowed}); `
        + 'use the --z-* layer tokens from tokens.css',
      ).toBeLessThanOrEqual(allowed);
    }
    const stylesRoot = path.join(root, 'src/renderer');
    const cssFiles = fs.readdirSync(stylesRoot, { withFileTypes: true })
      .flatMap((entry) => {
        if (entry.isFile() && entry.name.endsWith('.css')) return [entry.name];
        if (entry.isDirectory() && entry.name === 'vendor') {
          return fs.readdirSync(path.join(stylesRoot, entry.name))
            .filter((n) => n.endsWith('.css'))
            .map((n) => `${entry.name}/${n}`);
        }
        return [];
      });
    // vendor 下的第三方样式（xterm 等）不改，也不纳入冻结
    const vendorCss = new Set(cssFiles.filter((f) => f.startsWith(styleVendorPrefix)));
    for (const file of cssFiles) {
      if (file === styleTokensFile || vendorCss.has(file)) continue;
      const source = fs.readFileSync(path.join(stylesRoot, file), 'utf8');
      const actual = styleZIndexDeclarationCount(source);
      const allowed = styleZIndexBaseline[file] || 0;
      expect(
        actual,
        `${file} adds literal z-index declarations (${actual} > ${allowed}); `
        + 'use the --z-* layer tokens from tokens.css',
      ).toBeLessThanOrEqual(allowed);
    }
  });

  /**
   * 绊线自检：**确认这些计数器真的能抓到违规**。
   * 一个写坏的正则会让闸门静默放行一切——那比没有闸门更危险（看着是绿的）。
   */
  it('the counters actually detect violations (a broken regex must not pass silently)', () => {
    expect(emojiLineCount('<span>📁 库根</span>')).toBe(1);
    expect(emojiLineCount('<span>普通文案</span>')).toBe(0);
    expect(emojiLineCount('💡 一句话\n💡 又一句')).toBe(2);
    expect(inlineSvgCount('a<svg viewBox="0 0 1 1"></svg>b')).toBe(1);
    expect(inlineSvgCount('<svgViewer>')).toBe(0); // 不是 svg 标签，别误伤
    expect(literalZIndexCount('.a { z-index: 40; }')).toBe(1);
    expect(literalZIndexCount('// discusses z-index without declaring one')).toBe(0);
    expect(styleZIndexDeclarationCount('.a { z-index: 40; }')).toBe(1);
    expect(styleZIndexDeclarationCount('.a { z-index: var(--z-modal); }')).toBe(0);
    expect(styleZIndexDeclarationCount('.a { z-index: calc(var(--z-modal) + 1); }')).toBe(0);
    expect(styleZIndexDeclarationCount('.a { --x: z-index-ish; }')).toBe(0);
    // 冻结值必须覆盖当前树的实测值，否则下面的"不得增长"就是空话
    for (const [file, count] of Object.entries(emojiAsIconBaseline)) {
      const source = fs.readFileSync(path.join(modulesRoot, file), 'utf8');
      expect(emojiLineCount(source), `${file} 基线高于实测，说明已被清理：请下调基线`).toBe(count);
    }
    for (const [file, count] of Object.entries(inlineSvgBaseline)) {
      const source = fs.readFileSync(path.join(modulesRoot, file), 'utf8');
      expect(inlineSvgCount(source), `${file} 基线高于实测，说明已被清理：请下调基线`).toBe(count);
    }
    for (const [file, count] of Object.entries(literalZIndexBaseline)) {
      const source = fs.readFileSync(path.join(modulesRoot, file), 'utf8');
      expect(literalZIndexCount(source), `${file} 基线高于实测，说明已被清理：请下调基线`).toBe(count);
    }
    for (const [file, count] of Object.entries(styleZIndexBaseline)) {
      const source = fs.readFileSync(path.join(root, 'src/renderer', file), 'utf8');
      expect(styleZIndexDeclarationCount(source), `${file} 基线高于实测，说明已被清理：请下调基线`).toBe(count);
    }
  });
});
