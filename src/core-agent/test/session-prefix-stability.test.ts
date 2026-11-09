import { describe, expect, it } from 'vitest';
import {
  Session,
  FOREGROUND_MAX_TOKENS,
  FOREGROUND_MAX_TURNS,
  esticogseedTextTokens,
} from '../src/agent/session.js';
import type { Message } from '../src/shared/types.js';

const text = (value: string): Message['content'] => [{ type: 'text', text: value }];
const host = (value: string): Message => ({ role: 'user', content: text(value) });
const scopeKey = 'provider:model:system:tools:visible-scope';
const opts = { scopeKey, maxMessageTokens: 40_000 };
const json = (value: unknown) => JSON.stringify(value);
function begin(session: Session, request = 'first user request') {
  session.beginUserTurn(text(request));
  session.addAssistantMessage([{ type: 'tool_use', id: request, name: 'read_file', input: { path: 'fixture.txt' } }]);
  session.addToolResult(request, `tool evidence for ${request}`);
}
function finish(session: Session, request?: Message[], afterComplete = false): Message[] {
  const messages = request ?? session.getForegroundMessagesForModel({ ...opts, turnContext: 'ephemeral first turn' });
  const answer: Message = { role: 'assistant', content: text('final answer') };
  session.addAssistantMessage(answer.content);
  if (afterComplete) session.completeActiveTurn();
  const terminal = [...messages, answer];
  expect(session.recordForegroundTurn({ ...opts, messages: terminal })).toBe(true);
  if (!afterComplete) session.completeActiveTurn();
  return terminal;
}

class EditableSession extends Session {
  replace(messages: Message[]) { this.replaceMessagesPreservingContext(messages); }
}

describe('bounded memory-only foreground transport', () => {
  it('keeps two completed request/response prefixes including tool process, ephemeral text and host snapshots', () => {
    const session = new Session();
    begin(session);
    const request = [...session.getForegroundMessagesForModel({ ...opts, turnContext: 'ephemeral first turn' }), host('snapshot one')];
    const first = finish(session, request);
    session.addHistoryResource({ kind: 'final_output', path: 'first-output.md' });
    begin(session, 'second request');
    const secondRequest = session.getForegroundMessagesForModel({ ...opts, turnContext: 'ephemeral second turn' });
    expect(secondRequest.slice(0, first.length)).toStrictEqual(first);
    expect(json(secondRequest)).toContain('tool evidence for first user request');
    expect(json(secondRequest).match(/ephemeral first turn/g)).toHaveLength(1);
    const second = finish(session, [...secondRequest, ...session.getExecutionContextForModel(), host('snapshot two')], true);
    session.addHistoryResource({ kind: 'final_output', path: 'second-output.md' });
    session.beginUserTurn(text('third request'));
    const third = session.getForegroundMessagesForModel(opts);
    expect(third.slice(0, second.length)).toStrictEqual(second);
    const latest = json(session.getExecutionContextForModel());
    expect(latest).toContain('second-output.md');
    expect(latest).toMatch(/supersed/i);
    expect(latest).toContain('not a user request');
    const canonical = json([session.getMessagesForModel(), session.getMessagesForSummary(), session.getSerializedContextState(), session.getMessages()]);
    expect(canonical).not.toContain('ephemeral first turn');
    expect(canonical).not.toContain('snapshot one');
    expect(json(session.getMessagesForSummary())).not.toContain('tool evidence for first user request');
  });

  it('keeps live resources behind stable history and exposes the newest resources past the display bound', () => {
    const session = new Session();
    begin(session);
    session.addAssistantMessage(text('answer'));
    session.completeActiveTurn();
    const before = session.getMessagesForModel();
    for (let i = 0; i < 25; i++) session.addHistoryResource({ kind: 'final_output', path: `output-${i}.md` });
    session.addHistoryResource({ kind: 'attachment', path: 'attachment.txt' });
    const after = session.getMessagesForModel();
    expect(after.slice(0, before.length)).toStrictEqual(before);
    expect(json(after.at(-1))).toContain('output-24.md');
    expect(json(after.at(-1))).toContain('attachment.txt');
    session.addHistoryResource({ kind: 'final_output', path: 'output-0.md', note: 'latest revision' });
    expect(json(session.getExecutionContextForModel())).toContain('latest revision');
    expect(json(session.getSerializedContextState())).toContain('output-1.md');
  });

  it.each(['new-system', 'new-tools', 'new-provider', 'hidden-scope', 'disabled-plan'])('discards previous foreground on scope change: %s', (scopeKey) => {
    const session = new Session();
    begin(session);
    finish(session);
    session.beginUserTurn(text('next'));
    expect(json(session.getForegroundMessagesForModel({ ...opts, scopeKey }))).not.toContain('ephemeral first turn');
    // Changing back must not resurrect restricted material.
    expect(json(session.getForegroundMessagesForModel(opts))).not.toContain('ephemeral first turn');
  });

  it.each(['archive', 'checkpoint', 'replace', 'mutate', 'restore', 'clear', 'compact', 'reset'])('invalidates retained bytes after %s', (edit) => {
    const session = new EditableSession();
    begin(session);
    finish(session);
    session.beginUserTurn(text('next'));
    if (edit === 'archive') session.applyHistorySummary('canonical summary', [1]);
    if (edit === 'checkpoint') session.applyActiveCheckpointSummary('checkpoint', session.length - 1);
    if (edit === 'replace') session.replace(session.getMessages());
    if (edit === 'mutate') session.getMessages()[0].content = text('rewritten user request');
    if (edit === 'restore') session.restoreContextState(session.getSerializedContextState());
    if (edit === 'clear') session.clear();
    if (edit === 'compact') session.compact('legacy compacted');
    if (edit === 'reset') session.resetForeground();
    const view = json(session.getForegroundMessagesForModel(opts));
    expect(view).not.toContain('ephemeral first turn');
    if (edit === 'archive') expect(view).toContain('canonical summary');
  });

  it('reloads canonical state without ephemeral request bytes and still keeps live resources', () => {
    const original = new Session();
    begin(original);
    finish(original);
    original.addHistoryResource({ kind: 'final_output', path: 'latest.md' });
    const loaded = new Session();
    for (const message of original.getMessages()) loaded.addMessage(message.role, message.content, message.turnId);
    loaded.restoreContextState(original.getSerializedContextState());
    loaded.beginUserTurn(text('resume'));
    expect(json(loaded.getForegroundMessagesForModel(opts))).not.toContain('ephemeral first turn');
    expect(json(loaded.getExecutionContextForModel())).toContain('latest.md');
  });

  it('clears previous host authority even when current plan and work ledger are absent', () => {
    const session = new Session();
    begin(session);
    finish(session, [...session.getForegroundMessagesForModel(opts), host('old host plan and runtime')]);
    session.beginUserTurn(text('new unrelated user instruction'));
    session.getForegroundMessagesForModel(opts);
    expect(json(session.getExecutionContextForModel())).toMatch(/supersed/i);
    expect(json(session.getExecutionContextForModel())).toMatch(/no current execution plan/i);
  });

  it('resets the optional prefix at headroom pressure while preserving canonical context and latest resources', () => {
    const session = new Session();
    begin(session);
    finish(session, [...session.getForegroundMessagesForModel(opts), host('optional snapshot '.repeat(300))]);
    session.addHistoryResource({ kind: 'final_output', path: 'latest.md' });
    session.beginUserTurn(text('next request'));
    const view = session.getForegroundMessagesForModel({ ...opts, maxMessageTokens: 300 });
    expect(json(view)).not.toContain('optional snapshot');
    expect(json(view)).toContain('next request');
    expect(json(session.getExecutionContextForModel())).toContain('latest.md');
    expect(json(session.getForegroundMessagesForModel(opts))).not.toContain('optional snapshot');
  });

  it('rejects oversized and image-bearing retained transcripts without losing current canonical messages', () => {
    const session = new Session();
    begin(session);
    const base = session.getForegroundMessagesForModel(opts);
    const answer: Message = { role: 'assistant', content: text('answer') };
    session.addAssistantMessage(answer.content);
    const oversized = [...base, host('x'.repeat(FOREGROUND_MAX_TOKENS * 5)), answer];
    expect(session.recordForegroundTurn({ ...opts, messages: oversized })).toBe(false);
    const image: Message = { role: 'user', content: [{ type: 'image', data: 'opaque image', mediaType: 'image/png' }] };
    const fresh = session.getForegroundMessagesForModel(opts);
    expect(session.recordForegroundTurn({ ...opts, messages: [...fresh, image, answer] })).toBe(false);
    expect(json(session.getMessagesForModel())).toContain('answer');
  });

  it('bounds consecutive retained turns even when individual turns are tiny', () => {
    const session = new Session();
    let rejected = false;
    for (let i = 0; i <= FOREGROUND_MAX_TURNS; i++) {
      session.beginUserTurn(text(`request ${i}`));
      const request = session.getForegroundMessagesForModel(opts);
      const answer: Message = { role: 'assistant', content: text(`answer ${i}`) };
      session.addAssistantMessage(answer.content);
      const accepted = session.recordForegroundTurn({ ...opts, messages: [...request, answer] });
      if (i < FOREGROUND_MAX_TURNS) expect(accepted).toBe(true);
      else rejected = !accepted;
      session.completeActiveTurn();
    }
    expect(rejected).toBe(true);
  });

  it('takes defensive snapshots and returns defensive projections', () => {
    const session = new Session();
    begin(session);
    const first = finish(session);
    first[1].content = text('caller mutation');
    session.beginUserTurn(text('next'));
    const foreground = session.getForegroundMessagesForModel(opts);
    expect(json(foreground)).not.toContain('caller mutation');
    foreground[1].content = text('returned view mutation');
    expect(json(session.getForegroundMessagesForModel(opts))).not.toContain('returned view mutation');
    expect(esticogseedTextTokens(json(foreground))).toBeLessThan(FOREGROUND_MAX_TOKENS);
  });

  it('rejects a missing or mismatched final assistant instead of retaining an incomplete request', () => {
    const session = new Session();
    begin(session);
    const request = session.getForegroundMessagesForModel(opts);
    expect(session.recordForegroundTurn({ ...opts, messages: request })).toBe(false);
    session.addAssistantMessage(text('real final'));
    const fresh = session.getForegroundMessagesForModel(opts);
    expect(session.recordForegroundTurn({ ...opts, messages: [...fresh, { role: 'assistant', content: text('wrong final') }] })).toBe(false);
  });

  it('does not resurrect a request invalidated by a canonical edit while the provider was answering', () => {
    const session = new Session();
    begin(session);
    const request = session.getForegroundMessagesForModel({ ...opts, turnContext: 'pre-checkpoint host state' });
    session.applyActiveCheckpointSummary('canonical checkpoint', session.length - 1);
    const answer: Message = { role: 'assistant', content: text('answer') };
    session.addAssistantMessage(answer.content);
    expect(session.recordForegroundTurn({ ...opts, messages: [...request, answer] })).toBe(false);
  });
});
