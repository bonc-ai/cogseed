/**
 * transcript_speaker_merge — 同人连续发言合并 + 时间锚点（方案 v0.2 §五 P1-2）
 *
 * 实测（09-05 验收稿）：477 个发言槽 → 合并后 **122 块**（人工基线是 126），
 * 这是效果④ 的主要来源——477 个块头里 355 个属于"同一人连说"。
 *
 * 设计要点（为什么这样做）：
 *   1. **合并 = 编辑集，不是第二套流水线**。保留每组第一个块头**原文**
 *      （于是块头里的错词仍能被词表正常纠正），在其后插入 `—<结束时间>`，
 *      并把后续同人块头整行删除。这样 offsetMap / diff / 回滚仍然只有一套事实。
 *   2. **不重排、不润色、不合并正文行**：正文逐字保留（只删冗余块头），
 *      句子级改写是方案明令不做的。
 *   3. 解析尽量宽：`名字 2026-09-05 19:31:32`、`名字｜19:31:32`、`名字 19:31:32`
 *      都能认出；认不出就整份不动（宁可少做，不能猜坏）。
 *
 * 本模块纯函数、零 IO：给一段文本，返回编辑集与锚点。
 */

export interface TranscriptBlock {
  speaker: string;
  /** 原始时间串（可能含日期）。 */
  at: string;
  /** 归一化到 `HH:MM:SS`（取不到就为空串）。 */
  clock: string;
  headerStart: number;
  headerEnd: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface SpeakerMergeEdit {
  action: 'replace' | 'delete';
  /** 原文片段（delete = 被删掉的块头；replace = 空串表示纯插入）。 */
  wrong: string;
  correct: string;
  span: { start: number; end: number };
  reason: 'merge_header' | 'insert_time_range';
}

export interface SpeakerAnchor {
  speaker: string;
  at: string;
  endAt: string;
  /** 该合并块在原文里的范围（块头起点 → 最后一块正文结束）。 */
  sourceSpan: { start: number; end: number };
}

export interface SpeakerMergeResult {
  edits: SpeakerMergeEdit[];
  anchors: SpeakerAnchor[];
  blocksBefore: number;
  blocksAfter: number;
  /** 认出的发言人（保序）。 */
  speakers: string[];
}

/**
 * 块头识别：名字（≤24 字，不含换行）+ 时间（可带日期）。
 * 时间允许 **1~3 段**：腾讯会议同一份导出里整点前是相对时钟（`王伟 02:45`），
 * 整点后才是 `李强 01:00:35`。只认三段会把整点前的发言整段漏掉，与 renderer
 * `anchored-source-view.splitDialogueBlocks` 必须保持同一套规则（两边各存一份）。
 */
const HEADER_WITH_DATE = /^(.{1,24}?)\s+(\d{4}-\d{2}-\d{2})[ T](\d{1,2}(?::\d{2}){1,2})\s*$/;
const HEADER_PIPE = /^(.{1,24}?)\s*[｜|]\s*(\d{1,2}(?::\d{2}){1,2})\s*$/;
const HEADER_PLAIN_TIME = /^(.{1,24}?)\s+(\d{1,2}(?::\d{2}){1,2})\s*$/;

/** 把一行解析成块头（认不出返回 null）。 */
export function parseHeaderLine(line: string): { speaker: string; at: string; clock: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const withDate = trimmed.match(HEADER_WITH_DATE);
  if (withDate) {
    return {
      speaker: withDate[1].trim(),
      at: `${withDate[2]} ${withDate[3]}`,
      clock: withDate[3],
    };
  }
  const piped = trimmed.match(HEADER_PIPE);
  if (piped) return { speaker: piped[1].trim(), at: piped[2], clock: piped[2] };
  const plain = trimmed.match(HEADER_PLAIN_TIME);
  if (plain) return { speaker: plain[1].trim(), at: plain[2], clock: plain[2] };
  return null;
}

/** 扫描全文，切出发言块（块头 + 正文范围）。 */
export function parseTranscriptBlocks(text: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const lines = text.split('\n');
  let cursor = 0;
  let current: TranscriptBlock | null = null;
  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    cursor = lineEnd + 1; // 吃掉换行（末行可能没有）
    const header = parseHeaderLine(line);
    if (header) {
      if (current) current.bodyEnd = lineStart;
      current = {
        speaker: header.speaker,
        at: header.at,
        clock: header.clock,
        headerStart: lineStart,
        headerEnd: lineEnd,
        bodyStart: lineEnd + 1 > text.length ? lineEnd : lineEnd + 1,
        bodyEnd: lineEnd,
      };
      blocks.push(current);
    }
  }
  if (current) current.bodyEnd = text.length;
  return blocks;
}

/**
 * 生成合并编辑集。
 *
 * 每个"同人连续段"（值 ≥2 块）：
 *   - 在第 1 个块头**末尾**插入 `—<结束时间>`（结束时间取该段最后一块的 clock；
 *     与起始时间相同则不插）；
 *   - 删除第 2..N 个块头整行。
 * 段落只有 1 块时不动。
 */
export function mergeSpeakerEdits(text: string): SpeakerMergeResult {
  const blocks = parseTranscriptBlocks(text);
  const edits: SpeakerMergeEdit[] = [];
  const anchors: SpeakerAnchor[] = [];
  const speakers: string[] = [];
  let blocksAfter = 0;

  let i = 0;
  while (i < blocks.length) {
    const first = blocks[i];
    let j = i;
    while (j + 1 < blocks.length && blocks[j + 1].speaker === first.speaker) j += 1;
    const last = blocks[j];
    blocksAfter += 1;
    if (!speakers.includes(first.speaker)) speakers.push(first.speaker);

    if (j > i && first.clock && last.clock && first.clock !== last.clock) {
      edits.push({
        action: 'replace',
        wrong: '',
        correct: `—${last.clock}`,
        span: { start: first.headerEnd, end: first.headerEnd },
        reason: 'insert_time_range',
      });
    }
    for (let k = i + 1; k <= j; k += 1) {
      const block = blocks[k];
      edits.push({
        action: 'delete',
        wrong: text.slice(block.headerStart, block.headerEnd),
        correct: '',
        span: { start: block.headerStart, end: block.headerEnd },
        reason: 'merge_header',
      });
    }
    anchors.push({
      speaker: first.speaker,
      at: first.at,
      endAt: last.at,
      sourceSpan: { start: first.headerStart, end: last.bodyEnd },
    });
    i = j + 1;
  }

  return {
    edits: edits.sort((a, b) => a.span.start - b.span.start),
    anchors,
    blocksBefore: blocks.length,
    blocksAfter,
    speakers,
  };
}

/** 合并后的块头示例（供 UI 预览/文档用，不用于改写正文）。 */
export function previewMergedHeader(anchor: SpeakerAnchor): string {
  const clock = (value: string): string => (value.includes(' ') ? value.split(' ')[1] : value);
  const start = anchor.at.includes(' ') ? `${anchor.at.split(' ')[0]} ${clock(anchor.at)}` : anchor.at;
  const end = clock(anchor.endAt);
  return `${anchor.speaker} ${start}${end && end !== clock(anchor.at) ? `—${end}` : ''}`;
}
