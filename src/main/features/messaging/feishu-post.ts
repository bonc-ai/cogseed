/**
 * Feishu/Lark outbound rich-text helpers.
 *
 * Mirrors Nous Research Hermes-Agent's Feishu adapter
 * (`plugins/platforms/feishu/adapter.py`): a message is rendered as a Feishu
 * `post` payload whose rows are whole-markdown `md` elements, except that
 * triple-backtick code fences are isolated into their own rows — the Feishu
 * `md` renderer swallows everything after a fence inside a long block.
 *
 * Plain text stays `msg_type: text`; the markdown hint regex decides which
 * path to take. Long markdown replies are chunked below the message cap with
 * code-block carry-over and `(1/2)` indicators.
 */

const MARKDOWN_HINT_PATTERN = [
  // Pipe table: any header line + separator line both starting with '|'.
  '(^\\|.*\\|\\s*\\n\\|[-:|\\s]+\\|)',
  // Headings, lists, code, bold/italic/strike/underline, links, blockquotes.
  '(^#{1,6}\\s)',
  '(^\\s*[-*]\\s)',
  '(^\\s*\\d+\\.\\s)',
  '(^\\s*---+\\s*$)',
  '(```)',
  '(`[^`\\n]+`)',
  '(\\*\\*[^*\\n].+?\\*\\*)',
  '(~~[^~\\n].+?~~)',
  '(<u>.+?</u>)',
  '(\\*[^*\\n]+\\*)',
  '(\\[[^\\]]+\\]\\([^)]+\\))',
  '(^>\\s)',
].join('|');

/** A markdown hint on any branch marks the whole message as rich text. */
const MARKDOWN_HINT_RE = new RegExp(MARKDOWN_HINT_PATTERN, 'm');

const FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const BLOCKQUOTE_RE = /^>\s?/m;
const HR_RE = /^\s*---+\s*$/m;
const STRIKE_RE = /~~([^~\n]+)~~/g;
const UNDERLINE_RE = /<u>([\s\S]*?)<\/u>/g;
const BOLD_RE = /\*\*(.+?)\*\*/gs;
const ITALIC_STAR_RE = /\*(.+?)\*/gs;
const BOLD_UNDER_RE = /\b__(?![\s_])(.+?)(?<![\s_])__\b/g;
const ITALIC_UNDER_RE = /\b_(?![\s_])(.+?)(?<![\s_])_\b/g;
const CODE_FENCE_RE = /```[a-zA-Z0-9_+-]*\n?/g;
const INLINE_CODE_RE = /`(.+?)`/g;
const HEADING_RE = /^#{1,6}\s+/gm;
const MULTI_NEWLINE_RE = /\n{3,}/g;

/** Feishu `post` message cap. Mirrors Hermes MAX_MESSAGE_LENGTH. */
export const MAX_MESSAGE_LENGTH = 8_000;
/** Room reserved for the ` (1/2)` chunk indicator. */
const INDICATOR_RESERVE = 10;
const FENCE_CLOSE = '\n```';

export function isMarkdown(text: string): boolean {
  return MARKDOWN_HINT_RE.test(text);
}

/**
 * Split content into post rows. Without fences the whole markdown becomes a
 * single `md` row; with fences, each complete code block (fence lines
 * included) is isolated into its own row so the Feishu `md` renderer does
 * not drop the text that follows it.
 */
export function buildMarkdownPostRows(content: string): Array<Array<{ tag: 'md'; text: string }>> {
  if (!content) return [[{ tag: 'md', text: '' }]];
  if (!content.includes('```')) return [[{ tag: 'md', text: content }]];

  const rows: Array<Array<{ tag: 'md'; text: string }>> = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flush = (): void => {
    const segment = current.join('\n');
    if (segment.trim()) rows.push([{ tag: 'md', text: segment }]);
    current = [];
  };

  for (const rawLine of content.split('\n')) {
    const stripped = rawLine.trim();
    const isFence = inCodeBlock
      ? FENCE_CLOSE_RE.test(stripped)
      : FENCE_OPEN_RE.test(stripped);
    if (isFence) {
      if (!inCodeBlock) flush();
      current.push(rawLine);
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) flush();
      continue;
    }
    current.push(rawLine);
  }
  flush();
  return rows.length ? rows : [[{ tag: 'md', text: content }]];
}

/**
 * Build the Feishu `post` message content JSON. One locale (`zh_cn`) and one
 * `md` element per row; Feishu's client renders the markdown natively.
 */
export function buildMarkdownPostPayload(content: string): string {
  return JSON.stringify({ zh_cn: { content: buildMarkdownPostRows(content) } });
}

/**
 * Degrade markdown to plain text for the `msg_type: text` fallback path,
 * restoring links as `label (url)` and stripping formatting markers.
 */
export function stripMarkdownToPlainText(text: string): string {
  let plain = text.replace(/\r\n/g, '\n');
  plain = plain.replace(LINK_RE, (_match, label: string, url: string) => `${label} (${url.trim()})`);
  plain = plain.replace(BLOCKQUOTE_RE, '');
  plain = plain.replace(HR_RE, '---');
  plain = plain.replace(STRIKE_RE, '$1');
  plain = plain.replace(UNDERLINE_RE, '$1');
  plain = plain.replace(BOLD_RE, '$1');
  plain = plain.replace(ITALIC_STAR_RE, '$1');
  plain = plain.replace(BOLD_UNDER_RE, '$1');
  plain = plain.replace(ITALIC_UNDER_RE, '$1');
  plain = plain.replace(CODE_FENCE_RE, '');
  plain = plain.replace(INLINE_CODE_RE, '$1');
  plain = plain.replace(HEADING_RE, '');
  plain = plain.replace(MULTI_NEWLINE_RE, '\n\n');
  return plain.trim();
}

/** Measure a string in Unicode code points (Hermes' default `len`). */
function cpLength(value: string): number {
  return [...value].length;
}

/**
 * Split a long message into chunks below `maxLength`, preserving code-block
 * boundaries: a chunk that ends inside a fence closes it and the next chunk
 * reopens it with the same language tag. Multi-chunk replies get `(i/n)`
 * indicators. Mirrors Hermes `truncate_message`.
 */
export function chunkMarkdownMessage(content: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (cpLength(content) <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;
  let carryLang: string | null = null;

  while (remaining) {
    // Reopen the carried code block with its original language tag.
    const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : '';

    let headroom = maxLength - INDICATOR_RESERVE - cpLength(prefix) - cpLength(FENCE_CLOSE);
    if (headroom < 1) headroom = Math.max(1, Math.floor(maxLength / 2));

    // Everything remaining fits in one final chunk.
    if (cpLength(prefix) + cpLength(remaining) <= maxLength - INDICATOR_RESERVE) {
      let finalChunk = prefix + remaining;
      if (carryLang !== null) {
        let inCode = true;
        for (const line of remaining.split('\n')) {
          const stripped = line.trim();
          if (!stripped.startsWith('```')) continue;
          if (inCode) {
            inCode = false;
          } else {
            inCode = true;
          }
        }
        if (inCode) finalChunk += FENCE_CLOSE;
      }
      chunks.push(finalChunk);
      break;
    }

    const region = [...remaining].slice(0, headroom).join('');
    let splitAt = region.lastIndexOf('\n');
    if (splitAt < Math.floor(headroom / 2)) {
      splitAt = region.lastIndexOf(' ');
    }
    if (splitAt < 1) splitAt = Math.max(1, headroom);

    // Avoid splitting inside an inline code span: an odd number of unescaped
    // backticks before the split means the chunk would carry an unpaired
    // backtick.
    const candidate = remaining.slice(0, splitAt);
    const backtickCount = candidate.split('`').length - 1 - (candidate.split('\\`').length - 1);
    if (backtickCount % 2 === 1) {
      let lastBt = candidate.lastIndexOf('`');
      while (lastBt > 0 && candidate[lastBt - 1] === '\\') {
        lastBt = candidate.lastIndexOf('`', lastBt - 1);
      }
      if (lastBt > 0) {
        const safeSplit = Math.max(candidate.lastIndexOf(' ', lastBt), candidate.lastIndexOf('\n', lastBt));
        if (safeSplit > Math.floor(headroom / 4)) splitAt = safeSplit;
      }
    }

    const chunkBody = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\s+/, '');

    let fullChunk = prefix + chunkBody;

    // Determine whether the chunk ends inside an open code block (walk only
    // the body, not the prepended prefix).
    let inCode = carryLang !== null;
    let lang = carryLang || '';
    for (const line of chunkBody.split('\n')) {
      const stripped = line.trim();
      if (!stripped.startsWith('```')) continue;
      if (inCode) {
        inCode = false;
        lang = '';
      } else {
        inCode = true;
        const tag = stripped.slice(3).trim();
        lang = tag.split(/\s+/)[0] || '';
      }
    }

    if (inCode) {
      fullChunk += FENCE_CLOSE;
      carryLang = lang;
    } else {
      carryLang = null;
    }

    chunks.push(fullChunk);
  }

  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((chunk, index) => `${chunk} (${index + 1}/${total})`);
  }
  return chunks;
}

export const _feishuPostTestHooks = { MARKDOWN_HINT_RE, cpLength };
