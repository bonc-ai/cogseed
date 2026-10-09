import { describe, expect, it } from 'vitest';

/**
 * Mirrors `_resetSideColumnForConversation` in conversation.js.
 *
 * The side column is per-conversation: the aside thread is anchored to a
 * message in it, and the browser pane shows a file it produced. Carrying either
 * across a switch would show the previous conversation's content under the new
 * one's header.
 *
 * The reset is keyed on cid rather than firing unconditionally because
 * `onEnterConversationView` also runs when re-entering the same conversation,
 * and collapsing a panel the user just opened would be hostile.
 */
function makeResetter() {
  let sideColumnCid: string | null = null;
  const closed: string[] = [];
  const reset = (currentCid: string) => {
    const cid = typeof currentCid === 'string' ? currentCid : '';
    if (sideColumnCid === cid) return;
    sideColumnCid = cid;
    closed.push('browser', 'aside', 'host');
  };
  return { reset, closed, peek: () => sideColumnCid };
}

describe('side column — conversation switch', () => {
  it('closes everything when the conversation changes', () => {
    const { reset, closed } = makeResetter();
    reset('conv-a');
    closed.length = 0;

    reset('conv-b');

    expect(closed).toEqual(['browser', 'aside', 'host']);
  });

  it('leaves an open panel alone when re-entering the same conversation', () => {
    const { reset, closed } = makeResetter();
    reset('conv-a');
    closed.length = 0;

    reset('conv-a');
    reset('conv-a');

    expect(closed).toEqual([]);
  });

  it('closes when leaving a conversation for no conversation', () => {
    const { reset, closed } = makeResetter();
    reset('conv-a');
    closed.length = 0;

    reset('');

    expect(closed).toEqual(['browser', 'aside', 'host']);
  });

  it('treats a missing cid as empty rather than a distinct conversation', () => {
    const { reset, closed } = makeResetter();
    reset('');
    closed.length = 0;

    reset(undefined as unknown as string);

    expect(closed).toEqual([]);
  });

  it('closes again on a later switch back', () => {
    const { reset, closed } = makeResetter();
    reset('conv-a');
    reset('conv-b');
    closed.length = 0;

    reset('conv-a');

    expect(closed).toEqual(['browser', 'aside', 'host']);
  });

  it('closes the browser before the host', () => {
    // The host's close hook clears panes too; running the pane cleanups first
    // keeps each pane's own release path exercised.
    const { reset, closed } = makeResetter();
    reset('conv-a');
    closed.length = 0;
    reset('conv-b');
    expect(closed.indexOf('browser')).toBeLessThan(closed.indexOf('host'));
  });
});
