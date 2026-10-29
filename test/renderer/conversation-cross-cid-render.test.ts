import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

describe('conversation live render is scoped to the visible conversation', () => {
  it('uses a view predicate, not the controller-captured identity, to gate stream rendering', () => {
    expect(source).toContain('isViewActive: (id) => id === currentCid');
    expect(source).toContain('config.isViewActive(id)');
    // Regression: this was always true because getCurrentId() returns the
    // controller's captured cid, allowing a background stream to render into
    // whichever conversation is currently visible.
    expect(source).not.toContain('if (id === config.getCurrentId())');
  });

  it('keeps the shared chat-history placeholder writer scoped', () => {
    expect(source).toContain("if (typeof currentCid !== 'undefined' && cid !== currentCid) return null;");
  });
});
