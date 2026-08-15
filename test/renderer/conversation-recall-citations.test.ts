import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

describe('conversation Recall citations', () => {
  it('keeps recall_citations in the persisted message record but renders no UI footer', () => {
    // Backend contract stays: the message passthrough keeps the field for
    // proofs/usage; the footer UI and feedback controls are intentionally
    // removed (visibility is backend-only per product decision).
    expect(source).toContain('recall_citations');
    expect(source).not.toContain('_renderRecallCitationsHtml');
    expect(source).not.toContain('_hydrateRecallCitations');
    expect(source).not.toContain('chat-recall-citations');
    expect(source).not.toContain('data-recall-feedback');
  });
});
