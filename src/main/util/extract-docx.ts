/**
 * .docx → markdown. Pure function, reusable anywhere in main/.
 *
 * Uses mammoth's convertToMarkdown to preserve heading/list/emphasis structure
 * (more useful for downstream organizer than raw text).
 */

let _mammothPromise: Promise<any> | null = null;
function loadMammoth(): Promise<any> {
  if (!_mammothPromise) _mammothPromise = import('mammoth' as any);
  return _mammothPromise;
}

/**
 * 内联图片占位（剥掉 base64 后留下"此处原本有图"的信息）。
 * 用全角括号，避免下游把占位符当成 markdown 图片语法。
 */
const IMAGE_PLACEHOLDER = '（图）';

/** `![alt](data:image/jpeg;base64,AAAA…)` —— base64 字母表不含 `)`，故 `[^)]*` 安全。 */
const MD_INLINE_IMAGE_RE = /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]*\)/gi;
/** `<img src="data:image/png;base64,AAAA…">`（mammoth 某些版本/表格内会走 HTML）。 */
const HTML_INLINE_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']data:image\/[a-z0-9.+-]+;base64,[^"']*["'][^>]*>/gi;

/**
 * 剥掉内联 base64 图片数据，只留短占位。**这是文档索引链路的必要一步**：
 *
 * mammoth 会把 docx 里的图片内联成 `![alt](data:image/jpeg;base64,…)`，而 KB 索引
 * 按 `EMBED_MAX_CHARS = 400` 切块——一张 140KB 的截图 base64 后约 19 万字符，
 * 会被切成 ~470 个纯 base64 乱码 chunk，把所有正文块推到几千号 chunk 的位置。
 *
 * 真机案例（2026-09-16，`软件行业的三块地基，正在被AI改写.docx`）：正文只有
 * 5,531 字 / 24 个 chunk，却因为 6 张插图被切成 **2871 个 chunk（114 万字）**，
 * 正文块索引散落在 1,2,3,[541,542,543],[1020…1023],… 之后——于是"取前 N 个
 * chunk"的取样策略永远取不到正文，生成的脑图只剩封面标题。
 *
 * 下游三个消费者（KB 索引 / 全文检索 file_indexer / 飞书分享）都只要文字，
 * 且图片预览走 `docxBufferToHtml`（不经过这里），故在此统一剥离，无副作用。
 */
export function stripInlineImageData(md: string): string {
  return String(md ?? '')
    .replace(MD_INLINE_IMAGE_RE, IMAGE_PLACEHOLDER)
    .replace(HTML_INLINE_IMAGE_RE, IMAGE_PLACEHOLDER);
}

export async function docxBufferToMarkdown(buf: Buffer): Promise<string> {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error('docxBufferToMarkdown: empty or invalid buffer');
  }
  const mammoth: any = await loadMammoth();
  const fn = mammoth.convertToMarkdown ?? mammoth.default?.convertToMarkdown;
  if (typeof fn !== 'function') throw new Error('mammoth.convertToMarkdown unavailable');
  const result = await fn({ buffer: buf });
  // mammoth returns { value, messages }; messages are warnings about unrecognized
  // styles — non-fatal, drop them. Caller can re-extract if needed.
  return stripInlineImageData(String(result?.value ?? '')).trim();
}

/**
 * .docx → HTML for inline preview in the KB viewer. Uses mammoth's HTML
 * converter which preserves headings, lists, bold/italic, tables, and
 * inlines images as base64 data URLs. Loses fine-grained font/page
 * layout (that's inherent to HTML), but good enough for reading prose.
 *
 * Size warning: documents with many images balloon because base64 is ~33%
 * larger than raw bytes. A 10MB docx with embedded photos can become
 * 15-20MB of HTML — caller should budget for that.
 */
export async function docxBufferToHtml(buf: Buffer): Promise<string> {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error('docxBufferToHtml: empty or invalid buffer');
  }
  const mammoth: any = await loadMammoth();
  const fn = mammoth.convertToHtml ?? mammoth.default?.convertToHtml;
  if (typeof fn !== 'function') throw new Error('mammoth.convertToHtml unavailable');
  const result = await fn({ buffer: buf });
  return String(result?.value ?? '').trim();
}

export interface DocxChunkOpts {
  /** Per-chunk char budget. Default 8000 to match extract-pdf's default. */
  maxChars?: number;
}

export interface DocxChunk {
  text: string;
  /** 1-based index, purely informational. */
  index: number;
}

const DEFAULT_MAX_CHARS = 8_000;

/** Extract + chunk. Heading-aware: splits on `##+ ` boundaries first, then
 *  falls back to paragraph / sentence / char packing. Returns at least one
 *  chunk (may be empty for empty docx). */
export async function docxBufferToChunks(buf: Buffer, opts: DocxChunkOpts = {}): Promise<DocxChunk[]> {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const md = await docxBufferToMarkdown(buf);
  if (!md) return [{ text: '', index: 1 }];

  const raw = packByHeading(md, maxChars);
  // Assign 1-based indices at the end so caller can stamp chunk N/total.
  return raw.map((text, i) => ({ text, index: i + 1 }));
}

/** Split a markdown doc into ≤maxChars chunks, preferring heading boundaries. */
function packByHeading(md: string, maxChars: number): string[] {
  // Heading line = ^#{1,6}\s. Break BEFORE each heading; first chunk may be the
  // preamble before the first heading.
  const lines = md.split('\n');
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && cur.length) {
      sections.push(cur.join('\n').trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) sections.push(cur.join('\n').trim());

  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const sec of sections) {
    if (!sec) continue;
    if (sec.length > maxChars) {
      flush();
      for (const piece of splitOversized(sec, maxChars)) chunks.push(piece);
      continue;
    }
    const wouldBe = buf ? buf.length + 2 + sec.length : sec.length;
    if (wouldBe > maxChars && buf) flush();
    buf = buf ? `${buf}\n\n${sec}` : sec;
  }
  flush();
  return chunks.length ? chunks : [''];
}

/** Paragraph → sentence → char, in that order. Mirrors extract-pdf's splitter. */
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = '';
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      const sentences = p.split(/(?<=[.!?。！？\n])\s+/);
      let sb = '';
      for (const s of sentences) {
        if (s.length > maxChars) {
          if (sb.trim()) { out.push(sb.trim()); sb = ''; }
          for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
          continue;
        }
        if (sb.length + 1 + s.length > maxChars && sb.trim()) { out.push(sb.trim()); sb = ''; }
        sb += (sb ? ' ' : '') + s;
      }
      if (sb.trim()) out.push(sb.trim());
      continue;
    }
    if (buf.length + 2 + p.length > maxChars && buf.trim()) push();
    buf += (buf ? '\n\n' : '') + p;
  }
  push();
  return out;
}
