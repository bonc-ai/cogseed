/** Explicit completed formation proof for page tests. Never applied by the renderer loader. */
export function nightlyFormation() {
  return {
    origin: 'capture', suggestedAction: 'create', value: '可用于后续同类任务，减少重复核对。',
    sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-nightly-message' }],
    captureProvenance: { pipeline: 'nightly_conversation', captureId: 'capture-nightly', messageIds: ['message-nightly'],
      extractionCompletedAt: '2026-10-11T08:01:00Z',
      valueJudgment: { eligible: true, reason: '有可重复使用的明确内容', judgedAt: '2026-10-11T08:00:00Z',
        evidence: [{ messageId: 'message-nightly', sourceId: 'source-nightly-message', quote: '这是用户明确给出的可复用原文。' }] } },
  };
}
