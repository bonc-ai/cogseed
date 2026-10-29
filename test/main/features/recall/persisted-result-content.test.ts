import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { makeMinimalPdf } from '../../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../../fixtures/make-minimal-docx';
import { makeMinimalPptx, makeMinimalXlsx } from '../../../fixtures/make-minimal-office';
import { locatePersistedResultExcerpt, readPersistedResultContent } from '../../../../src/main/features/recall/persisted-result-content';
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: async () => ({ conversation_id: 'conv-a' }) }));
vi.mock('../../../../src/main/features/user_workspace', () => ({ getWorkspacePath: () => process.env.COGSEED_WORKSPACE_ROOT }));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-rich-results-')); vi.stubEnv('COGSEED_WORKSPACE_ROOT', root); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function result(name: string, buf: Buffer) {
  const file = path.join(root, name); await fs.writeFile(file, buf);
  return { file, content: await readPersistedResultContent('user-a', 'conv-a', { id: 'reply-a', text: 'Produced.', produced: [file] }) };
}
describe('bounded persisted rich-document results', () => {
  it('matches literal evidence inside one actual source, never wrapper labels or joined boundaries', async () => {
    const { content } = await result('actual.md', Buffer.from('实际文件正文第一行。\n第二行保留严格换行。'));
    const passage = '实际文件正文第一行。\n第二行';
    expect(locatePersistedResultExcerpt(content, passage)).toMatchObject({ refId: content.refs[1].id });
    expect(locatePersistedResultExcerpt(content, passage.replace(/\n/g, '\\n'))).toBeUndefined();
    expect(locatePersistedResultExcerpt(content, `[Persisted file ${content.refs[1].id}]`)).toBeUndefined();
    const at = content.refs[1].contentRange!.start;
    expect(locatePersistedResultExcerpt(content, content.text.slice(at - 4, at + 5))).toBeUndefined();
  });
  it('reuses real PDF, DOCX, PPTX and XLSX extractors with source-byte and text identities', async () => {
    for (const [name, buf, format] of [
      ['a.pdf', makeMinimalPdf(['Real PDF result']), 'pdf'],
      ['a.docx', makeMinimalDocx({ paragraphs: ['真实文档尾部限制'] }), 'docx'],
      ['a.pptx', makeMinimalPptx({ slides: [['真实幻灯片成果']] }), 'pptx'],
      ['a.xlsx', makeMinimalXlsx({ rows: [['真实工作表成果', '42']] }), 'xlsx'],
    ] as const) {
      const { content } = await result(name, buf);
      expect(content.coverage).toEqual({ complete: true, totalFiles: 1, readableFiles: 1 });
      expect(content.refs[1]).toMatchObject({ status: 'readable', sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), extraction: { format, version: 1, coverage: 'text_only' } });
      const range = content.refs[1].contentRange!;
      expect(content.text.slice(range.start, range.end)).not.toContain('[Persisted file');
    }
  });
  it('separates source-byte limits from extracted-text budgets', async () => {
    const { content } = await result('large-source.pdf', Buffer.concat([makeMinimalPdf(['Short actual result']), Buffer.alloc(100_000, 32)]));
    expect(content.coverage.complete).toBe(true);
    expect(content.text).toContain('Short actual result');
    const tooMuch = await result('large-text.docx', makeMinimalDocx({ paragraphs: ['x'.repeat(97_000)] }));
    expect(tooMuch.content.coverage.complete).toBe(false);
    expect(tooMuch.content.refs[1].status).toBe('unverified');
    expect(tooMuch.content.text).not.toContain('xxxx');
  });
  it('holds empty PDF pages, unrepresented images and missing spreadsheet formula values as unknown coverage', async () => {
    expect((await result('empty.pdf', makeMinimalPdf(['']))).content.coverage.complete).toBe(false);
    const picture = new AdmZip(makeMinimalDocx({ paragraphs: ['文档包含不可核验的图像。'] }));
    picture.addFile('word/media/image.png', Buffer.from('not evaluated'));
    expect((await result('picture.docx', picture.toBuffer())).content.coverage.complete).toBe(false);
    const formula = new AdmZip(makeMinimalXlsx());
    formula.updateFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>'));
    expect((await result('formula.xlsx', formula.toBuffer())).content.coverage.complete).toBe(false);
  });
  it('detects source-byte changes even when the extracted body stays identical', async () => {
    const first = await result('same-body.docx', makeMinimalDocx({ paragraphs: ['相同正文'] }));
    const changed = new AdmZip(await fs.readFile(first.file)); changed.addFile('docProps/version.txt', Buffer.from('different package version'));
    const second = await result('same-body.docx', changed.toBuffer());
    expect(second.content.refs[1].contentHash).toBe(first.content.refs[1].contentHash);
    expect(second.content.refs[1].sourceHash).not.toBe(first.content.refs[1].sourceHash);
  });
  it('does not read a produced path outside the current conversation roots', async () => {
    const content = await readPersistedResultContent('user-a', 'conv-a', { id: 'reply-a', text: 'Produced.', produced: [path.join(root, '..', 'not-authorized.docx')] });
    expect(content.coverage).toEqual({ complete: false, totalFiles: 1, readableFiles: 0 });
  });
});
