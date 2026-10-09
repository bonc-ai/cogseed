// Lock in the kind-classifier behaviour of chat-file-viewer.js. The viewer
// dispatches by `_kindOf(name)` — every misclassification surfaces as
// "I clicked a .md but it tried to load in an iframe" or vice versa, which
// is hard to spot in code review. This is the multi-branch decision
// function category from PC/CLAUDE.md §9.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const viewer = require('../../src/renderer/modules/chat-file-viewer.js');
const { _kindOf, _extOf, _chatMediaLocalUrl, _viewerAbsPathFromChatMediaLocalUrl, _viewerCanAddToLibrary, _viewerVideoPlaybackOptions, _viewerVideoSeekTarget } = viewer as {
  _kindOf: (name: string) => string;
  _extOf: (name: string) => string;
  _chatMediaLocalUrl: (abs: string) => string;
  _viewerAbsPathFromChatMediaLocalUrl: (src: string) => string;
  _viewerCanAddToLibrary: (name: string, options?: { projectScoped?: boolean }) => boolean;
  _viewerVideoPlaybackOptions: (opts?: { autoplay?: boolean; startTime?: number; duration?: number; ended?: boolean }) => { autoplay: boolean; startTime: number };
  _viewerVideoSeekTarget: (startTime: number, duration?: number) => number;
};

describe('chat-file-viewer › _kindOf', () => {
  // Set A — known kinds. One representative per ext set; the lists in the
  // module are the contract, so coverage of one ext per kind is enough
  // (the Set membership check makes per-ext coverage redundant).
  it.each([
    ['photo.png', 'image'],
    ['art.jpg', 'image'],
    ['art.jpeg', 'image'],
    ['art.webp', 'image'],
    ['art.gif', 'image'],
    ['contact-sheet.svg', 'image'],
    ['report.pdf', 'pdf'],
    ['doc.docx', 'office'],
    ['macro.docm', 'office'],
    ['workbook.xlsx', 'office'],
    ['sheet.xlsm', 'office'],
    ['slides.pptx', 'office'],
    ['deck.pptm', 'office'],
    ['page.html', 'html'],
    ['old.htm', 'html'],
    ['note.md', 'markdown'],
    ['old.markdown', 'markdown'],
    ['plain.txt', 'text'],
    ['data.json', 'text'],
    ['table.csv', 'text'],
    ['script.py', 'text'],
    ['app.ts', 'text'],
    ['style.css', 'text'],
    ['log.log', 'text'],
    ['video.mp4', 'video'],
    ['voice.mp3', 'audio'],
  ])('classifies "%s" as %s', (name, kind) => {
    expect(_kindOf(name)).toBe(kind);
  });

  // Set B — unsupported / look-alike shapes. These specifically check
  // that the classifier doesn't promote "looks like text" → text or
  // "html-ish" → html when the actual ext doesn't match.
  it.each([
    ['archive.zip', 'unsupported'],
    ['legacy.doc', 'unsupported'],
    ['legacy.xls', 'unsupported'],
    ['legacy.ppt', 'unsupported'],
    ['binary.exe', 'unsupported'],
    ['photo.heic', 'unsupported'], // image-ish but not in the allow-list
    ['no-extension', 'unsupported'],
    ['', 'unsupported'],
    ['file.', 'unsupported'],
    ['file.UPPER', 'unsupported'],
  ])('refuses "%s" → fallback dialog', (name, kind) => {
    expect(_kindOf(name)).toBe(kind);
  });

  it('is case-insensitive on the extension portion', () => {
    expect(_kindOf('REPORT.PDF')).toBe('pdf');
    expect(_kindOf('REPORT.XLSX')).toBe('office');
    expect(_kindOf('Note.MD')).toBe('markdown');
    expect(_kindOf('Page.Html')).toBe('html');
    expect(_kindOf('Voice.MP3')).toBe('audio');
    expect(_kindOf('CONTACT-SHEET.SVG')).toBe('image');
  });

  it('handles paths with directories — only the basename ext matters', () => {
    expect(_kindOf('/Users/test/Documents/note.md')).toBe('markdown');
    expect(_kindOf('C:\\\\work\\\\report.pdf')).toBe('pdf');
  });
});

describe('chat-file-viewer › _extOf', () => {
  it('returns lowercased trailing extension', () => {
    expect(_extOf('note.MD')).toBe('.md');
    expect(_extOf('report.pdf')).toBe('.pdf');
  });
  it('returns "" for names with no dot', () => {
    expect(_extOf('README')).toBe('');
  });
  it('uses the LAST dot, not the first', () => {
    expect(_extOf('a.b.tar.gz')).toBe('.gz');
  });
});

describe('chat-file-viewer › _chatMediaLocalUrl', () => {
  // The URL has to round-trip cleanly through new URL() + the main-side
  // `_pathnameToAbsPath`, so it must encode reserved filename characters and
  // non-ASCII text while preserving `/` separators.
  it('builds chat-media://local/ + path for a unix abs path', () => {
    expect(_chatMediaLocalUrl('/Users/test/file.pdf')).toBe('chat-media://local/Users/test/file.pdf');
  });
  it('URL-encodes spaces in the path', () => {
    expect(_chatMediaLocalUrl('/Users/test/has space.pdf')).toBe('chat-media://local/Users/test/has%20space.pdf');
  });
  it('URL-encodes fragment/query delimiters and literal percent signs in filenames', () => {
    expect(_chatMediaLocalUrl('/Users/user/hero #1?.png')).toBe('chat-media://local/Users/user/hero%20%231%3F.png');
    expect(_chatMediaLocalUrl('/Users/user/100%/图.png')).toBe('chat-media://local/Users/user/100%25/%E5%9B%BE.png');
  });
  it('preserves "/" separators (doesn\'t use encodeURIComponent)', () => {
    const url = _chatMediaLocalUrl('/a/b/c/d.pdf');
    expect(url).not.toContain('%2F');
    expect(url).toContain('/a/b/c/d.pdf');
  });
  it('converts Windows-style "\\\\" to "/" so URL parsing stays well-formed', () => {
    expect(_chatMediaLocalUrl('C:\\Users\\test\\file.pdf')).toBe('chat-media://local/C:/Users/test/file.pdf');
  });
});

describe('chat-file-viewer › _viewerAbsPathFromChatMediaLocalUrl', () => {
  it('decodes local chat-media video URLs for file-backed preview actions', () => {
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://local/Users/test/has%20space.mp4')).toBe('/Users/test/has space.mp4');
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://local/C:/Users/test/clip.mp4')).toBe('C:/Users/test/clip.mp4');
  });

  it('refuses non-local media URLs', () => {
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://cid/main/clip.mp4')).toBe('');
    expect(_viewerAbsPathFromChatMediaLocalUrl('https://example.test/clip.mp4')).toBe('');
  });
});

describe('chat-file-viewer › _viewerCanAddToLibrary', () => {
  it('offers Add to Library only for Library-supported file extensions', () => {
    expect(_viewerCanAddToLibrary('/tmp/report.pdf')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/scores.xlsx')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/slides.pptx')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/note.md')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/page.html')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/photo.png')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/movie.mp4')).toBe(false);
    expect(_viewerCanAddToLibrary('/tmp/movie.mp4', { projectScoped: true })).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/voice.mp3', { projectScoped: true })).toBe(false);
    expect(_viewerCanAddToLibrary('/tmp/archive.zip')).toBe(false);
    expect(_viewerCanAddToLibrary('/tmp/no-extension')).toBe(false);
  });
});

describe('chat-file-viewer › _viewerVideoPlaybackOptions', () => {
  it('keeps explicit autoplay and a positive start time', () => {
    expect(_viewerVideoPlaybackOptions({ autoplay: true, startTime: 12.5 })).toEqual({ autoplay: true, startTime: 12.5 });
  });

  it('normalizes missing or invalid playback options', () => {
    expect(_viewerVideoPlaybackOptions()).toEqual({ autoplay: false, startTime: 0 });
    expect(_viewerVideoPlaybackOptions({ autoplay: false, startTime: -1 })).toEqual({ autoplay: false, startTime: 0 });
  });

  it('replays from the beginning when the source video has ended', () => {
    expect(_viewerVideoPlaybackOptions({ autoplay: true, startTime: 9.5, duration: 10, ended: true })).toEqual({ autoplay: true, startTime: 0 });
  });

  it('replays from the beginning when the source position is at the end', () => {
    expect(_viewerVideoPlaybackOptions({ autoplay: true, startTime: 9.9, duration: 10 })).toEqual({ autoplay: true, startTime: 0 });
  });

  it('keeps mid-video resume positions', () => {
    expect(_viewerVideoPlaybackOptions({ autoplay: true, startTime: 5, duration: 10 })).toEqual({ autoplay: true, startTime: 5 });
  });
});

describe('chat-file-viewer › _viewerVideoSeekTarget', () => {
  it('seeks to the beginning when metadata reveals an end position', () => {
    expect(_viewerVideoSeekTarget(9.9, 10)).toBe(0);
  });

  it('keeps a safe in-range mid-video seek target', () => {
    expect(_viewerVideoSeekTarget(4.25, 10)).toBe(4.25);
  });
});

// The extracted preview builder is shared by the fullscreen viewer and the side
// browser pane. Both surfaces must produce byte-identical frames — a drift in
// the sandbox flags would silently weaken one of them.
describe('chat-file-viewer › shared preview builder', () => {
  // `escapeHtml` is a renderer global the module relies on; provide the real
  // escaping so the XSS assertion below is meaningful.
  (globalThis as any).escapeHtml = (s: unknown) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const { buildFilePreviewHtml, isSidePreviewableKind, PREVIEW_HTML_SANDBOX } = viewer as {
    buildFilePreviewHtml: (kind: string, url: string, name?: string) => string;
    isSidePreviewableKind: (kind: string) => boolean;
    PREVIEW_HTML_SANDBOX: string;
  };

  it('sandboxes local HTML with allow-scripts only', () => {
    // Widening this set is a security regression: allow-same-origin would hand
    // the page cookie / localStorage / sibling-fetch reach, and
    // allow-top-navigation would let it hijack the app frame.
    expect(PREVIEW_HTML_SANDBOX).toBe('allow-scripts');
    const html = buildFilePreviewHtml('html', 'chat-media://local/tmp/a.html', 'a.html');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-popups');
    expect(html).not.toContain('allow-top-navigation');
  });

  it('keeps the PDFium toolbar hints on the pdf frame', () => {
    const html = buildFilePreviewHtml('pdf', 'chat-media://local/tmp/r.pdf', 'r.pdf');
    expect(html).toContain('#toolbar=1&navpanes=0');
  });

  it('escapes the display name into the frame title', () => {
    const html = buildFilePreviewHtml('html', 'chat-media://local/x', '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('returns nothing for kinds it does not own', () => {
    // markdown / text go to editor components, office is server-rendered.
    for (const kind of ['markdown', 'text', 'office', 'video', 'audio', 'unsupported']) {
      expect(buildFilePreviewHtml(kind, 'chat-media://local/x', 'x'), kind).toBe('');
    }
  });

  it('declares exactly the kinds the side pane can render', () => {
    for (const kind of ['html', 'pdf', 'image']) {
      expect(isSidePreviewableKind(kind), kind).toBe(true);
    }
    for (const kind of ['markdown', 'text', 'office', 'video', 'audio', 'unsupported']) {
      expect(isSidePreviewableKind(kind), kind).toBe(false);
    }
  });

  it('classifies real filenames into side-previewable kinds', () => {
    // Guards the chip badge: it must agree with what the pane can actually show.
    expect(isSidePreviewableKind(_kindOf('report.html'))).toBe(true);
    expect(isSidePreviewableKind(_kindOf('slides.pdf'))).toBe(true);
    expect(isSidePreviewableKind(_kindOf('chart.png'))).toBe(true);
    expect(isSidePreviewableKind(_kindOf('bundle.zip'))).toBe(false);
    expect(isSidePreviewableKind(_kindOf('notes.md'))).toBe(false);
  });
});
