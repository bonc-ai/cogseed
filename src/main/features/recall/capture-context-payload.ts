/** Complete summaries carry every source segment; oversized later stages keep
 * every literal summary/approved passage with its original coordinates. Nothing
 * is silently sliced to satisfy the prompt budget. */
import type { CaptureContextSummary } from './capture-context-summary';

export function captureSourcePassages<T extends { id: string; text: string }>(
  messages: readonly T[], summary: Pick<CaptureContextSummary, 'topics'> | undefined,
  approvedEvidence: readonly { messageId: string; quote: string }[],
): Array<T & { excerpt: true; sourceSpans: Array<{ start: number; end: number }> }> {
  const evidence = [...(summary?.topics.flatMap(topic => topic.evidence) || []), ...approvedEvidence];
  return messages.flatMap(message => {
    const ranges = evidence.filter(item => item.messageId === message.id).map(item => {
      const located = 'start' in item && typeof item.start === 'number'
        && message.text.slice(item.start, item.start + item.quote.length) === item.quote
        ? item.start : message.text.indexOf(item.quote);
      if (located < 0) throw Object.assign(new Error('capture evidence missing from original source'), { code: 'capture_source_unavailable' });
      return { start: Math.max(0, located - 400), end: Math.min(message.text.length, located + item.quote.length + 400) };
    }).sort((a, b) => a.start - b.start);
    const spans: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const previous = spans.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else spans.push({ ...range });
    }
    return spans.length ? [{ ...message, excerpt: true as const, sourceSpans: spans,
      text: spans.map(span => message.text.slice(span.start, span.end))
        .join('\n\n[...other source passages omitted; use the complete context summary...]\n\n') }] : [];
  });
}
