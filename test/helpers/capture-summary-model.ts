/** Valid model fixture for exercising the real summary coverage/parser pipeline. */
export function captureSummaryModelResponse(input: { message: string }) {
  const request = JSON.parse(input.message);
  if (request.stage === 'chunk') {
    const segment = request.segments.find((entry: { text: string }) => entry.text.length);
    return { text: JSON.stringify({
      coveredIds: request.segments.map((entry: { id: string }) => entry.id),
      topics: segment ? [{ title: 'Reusable source discussion', content: segment.text.slice(0, 1_000),
        conditions: [], unresolved: [], attribution: segment.role === 'user' ? 'user_requirement' : 'assistant_proposal',
        evidence: [{ messageId: segment.messageId, quote: segment.text.slice(0, 1_000) }],
      }] : [],
    }), meta: { aborted: false } };
  }
  if (request.stage === 'merge') {
    const topics = request.inputs.flatMap((entry: { topics: unknown[] }) => entry.topics);
    return { text: JSON.stringify({
      coveredIds: request.inputs.map((entry: { id: string }) => entry.id),
      topics: topics.length ? [{ ...topics[0], id: undefined,
        inputIds: topics.map((topic: { id: string }) => topic.id),
      }] : [],
    }), meta: { aborted: false } };
  }
  throw new Error(`Unexpected summary stage: ${request.stage}`);
}

/** Preserve the selected real requirements/corrections through every merge. */
export function captureSummaryModelResponseWithEvidence(input: { message: string }, quotes: readonly string[]) {
  const request = JSON.parse(input.message);
  if (request.stage === 'chunk') {
    const topics = request.segments.flatMap((segment: { messageId: string; role: string; text: string }) =>
      quotes.filter(quote => segment.text.includes(quote)).map(quote => ({
        title: 'Source requirement or correction', content: quote,
        conditions: [], unresolved: [], attribution: segment.role === 'user' ? 'user_requirement' : 'assistant_proposal',
        evidence: [{ messageId: segment.messageId, quote }],
      })));
    if (!topics.length) {
      const segment = request.segments.find((segment: { text: string }) => segment.text.length);
      if (segment) topics.push({ title: 'Background source discussion', content: segment.text.slice(0, 100),
        conditions: [], unresolved: [], attribution: 'source_observation',
        evidence: [{ messageId: segment.messageId, quote: segment.text.slice(0, 100) }],
      });
    }
    return { text: JSON.stringify({
      coveredIds: request.segments.map((segment: { id: string }) => segment.id),
      topics,
    }), meta: { aborted: false } };
  }
  if (request.stage === 'merge') {
    return { text: JSON.stringify({
      coveredIds: request.inputs.map((entry: { id: string }) => entry.id),
      topics: request.inputs.flatMap((entry: { topics: Array<{ id: string }> }) =>
        entry.topics.map(topic => ({ ...topic, id: undefined, inputIds: [topic.id] }))),
    }), meta: { aborted: false } };
  }
  throw new Error(`Unexpected summary stage: ${request.stage}`);
}
