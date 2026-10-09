import { docxBufferToHtml } from './extract-docx';
import { pptxBufferToHtml, xlsxBufferToHtml } from './extract-office';

export type OfficePreviewKind = 'word' | 'spreadsheet' | 'presentation';

function escapePreviewHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function officePreviewKindForExt(ext: string): OfficePreviewKind | null {
  const e = String(ext || '').toLowerCase();
  if (e === '.docx' || e === '.docm') return 'word';
  if (e === '.xlsx' || e === '.xlsm') return 'spreadsheet';
  if (e === '.pptx' || e === '.pptm') return 'presentation';
  return null;
}

/**
 * Office 预览外壳：**全产品唯一一份**（`kb.openFile`、`produced.officePreviewHtml`、
 * 资料/项目文件预览都走这里）。
 *
 * 历史教训（2026-09-16 → 09-18）：本函数与 `src/main/ipc/index.ts` 里曾各有一份
 * 外壳 CSS，修图片溢出时只改了本文件，而知识库查看器（`kb.openFile`）用的是 ipc
 * 里那份私有副本 → 真机"依旧溢出"。**不要再复制这份 CSS**，紧凑模式走 `opts.compact`。
 *
 * @param opts.compact 卡片缩略模式：小字号、去留白、紧贴顶部（资料卡片/面板预览）。
 */
export function wrapOfficePreviewHtml(
  kind: OfficePreviewKind,
  title: string,
  body: string,
  opts?: { compact?: boolean },
): string {
  const safeTitle = escapePreviewHtml(title || 'Office preview');
  // 卡片缩略模式：整页紧贴顶部、小字号、去留白——小卡里「全而不大」。
  // 只覆盖字号/留白，**不碰图片与表格的限宽护栏**（`.office-word img` 等见下方基础 CSS）。
  const compactCss = opts?.compact ? `
  <style>
    body { background: #fff; font-size: 11px; }
    .office-preview { padding: 0; min-height: 0; }
    .office-word { max-width: none; min-height: 0; margin: 0; padding: 12px 14px; border: 0; box-shadow: none; }
    .office-word h1 { margin: 0 0 8px; font-size: 16px; }
    .office-word h2 { margin: 12px 0 6px; font-size: 13px; }
    .office-word h3 { margin: 10px 0 5px; font-size: 12px; }
    .office-word p, .office-word li { margin: 0 0 6px; font-size: 11px; line-height: 1.5; }
    .office-word ul, .office-word ol { margin: 0 0 8px 18px; }
    .office-word table, .office-table-wrap table { margin: 8px 0; font-size: 10px; }
    .office-word th, .office-word td, .office-table-wrap th, .office-table-wrap td { padding: 3px 5px; }
    .office-spreadsheet { padding: 6px; }
    .office-sheet { margin: 0 0 10px; padding: 8px; }
    .office-sheet h2 { margin: 0 0 8px; font-size: 12px; }
    .office-table-wrap { max-height: none; }
    .office-table-wrap td { min-width: 60px; }
    .office-presentation { padding: 6px; gap: 8px; }
    .office-slide { width: 100%; padding: 12px 14px; border-radius: 4px; }
    .office-slide-body p { margin: 0 0 6px; font-size: 12px; }
    .office-slide-body p:first-child { font-size: 14px; }
  </style>` : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef2f7;
      color: #0f172a;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .office-preview {
      width: 100%;
      min-height: 100vh;
      margin: 0 auto;
      padding: 24px;
    }
    .office-word {
      max-width: 820px;
      background: #fff;
      min-height: calc(100vh - 48px);
      margin: 20px auto 32px;
      padding: 56px 64px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.06);
    }
    .office-spreadsheet {
      max-width: none;
      padding: 12px;
      min-height: 0;
    }
    .office-word h1, .office-word h2, .office-word h3 {
      line-height: 1.3;
      color: #111827;
    }
    .office-word h1 {
      margin: 0 0 22px;
      font-size: 28px;
      font-weight: 700;
    }
    .office-word h2 {
      margin: 26px 0 12px;
      font-size: 21px;
      font-weight: 650;
    }
    .office-word h3 {
      margin: 22px 0 10px;
      font-size: 17px;
      font-weight: 650;
    }
    .office-word p,
    .office-word li {
      margin: 0 0 13px;
      font-size: 15px;
      line-height: 1.72;
      color: #111827;
    }
    .office-word ul,
    .office-word ol {
      margin: 0 0 16px 24px;
      padding: 0;
    }
    /* docx 里的图片是 mammoth 内联的 base64 data URI，**不带任何宽高属性**：
       没有这条约束时它们按固有像素渲染（真机案例：1080px 宽的图塞进 692px 的正文
       栏 → 右侧溢出、与原文排版不符）。 */
    .office-word img,
    .office-word svg,
    .office-word video {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 14px auto;
    }
    /* 长串（URL、无空格长文）与宽表格同样不该把正文页撑破 */
    .office-word p,
    .office-word li,
    .office-word td,
    .office-word th,
    .office-word a {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .office-word table {
      border-collapse: collapse;
      width: 100%;
      max-width: 100%;
      margin: 16px 0;
    }
    .office-word th, .office-word td,
    .office-table-wrap th, .office-table-wrap td {
      border: 1px solid #cbd5e1;
      padding: 7px 9px;
      vertical-align: top;
    }
    .office-sheet {
      margin: 0 0 12px;
      padding: 16px 16px 10px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
    }
    .office-sheet:last-child {
      margin-bottom: 0;
    }
    .office-sheet h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .office-table-wrap {
      overflow: auto;
      max-height: 560px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
    }
    .office-table-wrap table {
      border-collapse: collapse;
      min-width: 100%;
      background: #fff;
      font-size: 13px;
    }
    .office-table-wrap td {
      min-width: 96px;
      white-space: pre-wrap;
    }
    .office-empty-cell, .office-muted { color: #64748b; }
    .office-presentation {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
      padding: 24px;
    }
    .office-slide {
      width: min(1120px, calc(100vw - 64px));
      aspect-ratio: 16 / 9;
      margin: 0 auto;
      padding: clamp(32px, 5vw, 64px);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      display: flex;
      align-items: center;
    }
    .office-slide-body p {
      margin: 0 0 18px;
      font-size: clamp(18px, 2vw, 30px);
      line-height: 1.35;
    }
    .office-slide-body p:first-child {
      font-size: clamp(26px, 3vw, 44px);
      font-weight: 600;
      line-height: 1.2;
    }
    @media (max-width: 720px) {
      .office-preview { padding: 12px; }
      .office-word {
        margin: 0 auto;
        min-height: calc(100vh - 24px);
        padding: 32px 24px;
      }
      .office-word h1 { font-size: 24px; }
      .office-word p,
      .office-word li { font-size: 14px; }
      .office-presentation { padding: 12px; gap: 14px; }
      .office-slide {
        width: calc(100vw - 24px);
        padding: 24px;
      }
      .office-slide-body p { font-size: 16px; }
      .office-slide-body p:first-child { font-size: 22px; }
    }
  </style>
  ${compactCss}
</head>
<body>
  <main class="office-preview office-${kind}">
    ${body}
  </main>
</body>
</html>`;
}

/** 提不出任何可见文字的转换结果（`<p></p>` / 空串 / 纯空白都算空）。 */
export function officeFragmentHasText(fragment: string): boolean {
  return Boolean(String(fragment || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim());
}

/**
 * Office 预览提不出正文时给一句能照做的说明，而不是空白页。
 * 只给"整页阅读"的查看器用（知识库 `kb.openFile`）：卡片缩略 / 面板预览刻意
 * 保持空白（见本文件测试里 "blank … without placeholder text" 那组断言）——小
 * 尺寸卡片里塞一段说明更吵。
 *
 * Word 的两种真实原因分开说，用户才知道下一步做什么：
 *   - `word/embeddings/*`：整份内容塞进了嵌入对象（Word 里要双击那个对象才看得到），
 *     HTML 里提不出任何正文（真机案例：一份"报告.docx"里只有一个 OLE 包）；
 *   - 其余：正文是图片/扫描件（mammoth 只提文字）。
 * docx 是 zip，条目名在字节里就是明文，直接扫即可——为一句提示引 zip 依赖不划算。
 */
export function officeEmptyBodyHtml(kind: OfficePreviewKind, buf?: Buffer): string {
  const embedded = Boolean(buf && Buffer.isBuffer(buf) && buf.includes('word/embeddings/'));
  if (kind === 'word' && embedded) {
    return '<p class="office-muted">这份 Word 的正文全在嵌入对象里（Word 里要双击那个对象才看得到），HTML 提不出文字。点右上角「在系统中打开」用本机 Office 打开原文件。</p>';
  }
  const what = kind === 'word' ? 'Word' : kind === 'spreadsheet' ? '表格' : '演示文稿';
  return `<p class="office-muted">这份 ${what} 里没有可直接提取的文字（内容可能在图片、扫描件或嵌入对象里）。点右上角「在系统中打开」用本机 Office 查看原排版。</p>`;
}

export function esticogseedOfficePreviewHeight(kind: OfficePreviewKind, fragment: string): number | undefined {
  if (kind !== 'spreadsheet') return undefined;
  const sectionRe = /<section class="office-sheet">[\s\S]*?<\/section>/g;
  const sections = fragment.match(sectionRe) || [];
  const sheetFragments = sections.length ? sections : [fragment];
  const tableMaxHeight = 560;
  const mainPadding = 24;
  const sheetChrome = 66;
  const sheetGap = 12;
  const rowHeight = 35;
  const sheetHeights = sheetFragments.reduce((total, sheet) => {
    const rows = Math.max(1, (sheet.match(/<tr>/g) || []).length);
    return total + sheetChrome + Math.min(tableMaxHeight, rows * rowHeight);
  }, 0);
  return mainPadding + sheetHeights + Math.max(0, sheetFragments.length - 1) * sheetGap;
}

export async function officeBufferToPreviewHtml(
  kind: OfficePreviewKind,
  title: string,
  buf: Buffer,
): Promise<{ html: string; kind: OfficePreviewKind; previewHeight?: number }> {
  let fragment = '';
  if (kind === 'word') {
    fragment = await docxBufferToHtml(buf);
  } else if (kind === 'spreadsheet') {
    fragment = xlsxBufferToHtml(buf);
  } else {
    fragment = pptxBufferToHtml(buf);
  }
  // 卡片刻意保持空白（见测试断言），说明文案只给整页查看器用
  const previewHeight = esticogseedOfficePreviewHeight(kind, fragment);
  return {
    html: wrapOfficePreviewHtml(kind, title, fragment),
    kind,
    ...(previewHeight ? { previewHeight } : {}),
  };
}
