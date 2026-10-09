import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileViewer = require('../../src/renderer/modules/chat-file-viewer.js');

/**
 * The chip badge and the open action must agree with what the side pane can
 * actually render. They both ask the viewer's classifier, so this locks that
 * contract: a file marked "previewable" must open in the side pane, and an
 * unmarked one must fall back to the fullscreen viewer.
 */
describe('produced chip — side-pane routing', () => {
  const { _kindOf, isSidePreviewableKind } = fileViewer as {
    _kindOf: (name: string) => string;
    isSidePreviewableKind: (kind: string) => boolean;
  };

  const previewable = (name: string) => isSidePreviewableKind(_kindOf(name));

  it('marks rendered outputs as previewable', () => {
    for (const name of ['report.html', 'page.htm', 'slides.pdf', 'chart.png',
      'photo.jpg', 'icon.svg', 'anim.gif', 'shot.webp']) {
      expect(previewable(name), name).toBe(true);
    }
  });

  it('leaves editor and binary outputs to the fullscreen viewer', () => {
    for (const name of ['notes.md', 'data.csv', 'log.txt', 'code.ts',
      'sheet.xlsx', 'doc.docx', 'deck.pptx', 'bundle.zip', 'clip.mp4', 'song.mp3']) {
      expect(previewable(name), name).toBe(false);
    }
  });

  it('ignores extension case', () => {
    expect(previewable('REPORT.HTML')).toBe(true);
    expect(previewable('Slides.PDF')).toBe(true);
  });

  it('treats an extensionless file as not previewable', () => {
    // Guessing here would open a blank frame for e.g. a Makefile.
    expect(previewable('Makefile')).toBe(false);
    expect(previewable('')).toBe(false);
  });

  it('classifies by the final extension of a multi-dot name', () => {
    expect(previewable('report.final.v2.html')).toBe(true);
    expect(previewable('archive.html.zip')).toBe(false);
  });
});

/**
 * Mirrors `_openProducedFile`'s decision. Kept as a table so the fallback rule
 * is asserted directly: the side pane declining is what routes a file to the
 * fullscreen viewer.
 */
describe('produced chip — open dispatch', () => {
  function dispatch(name: string) {
    const calls: string[] = [];
    const sideAccepts = fileViewer.isSidePreviewableKind(fileViewer._kindOf(name));
    const openSideBrowser = () => { calls.push('side'); return sideAccepts; };
    const openChatFileViewer = () => { calls.push('fullscreen'); };
    if (openSideBrowser()) return calls;
    openChatFileViewer();
    return calls;
  }

  it('sends a rendered page to the side pane only', () => {
    expect(dispatch('report.html')).toEqual(['side']);
  });

  it('falls back to fullscreen when the side pane declines', () => {
    expect(dispatch('notes.md')).toEqual(['side', 'fullscreen']);
    expect(dispatch('bundle.zip')).toEqual(['side', 'fullscreen']);
  });
});
