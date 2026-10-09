import { describe, it, expect } from 'vitest';
import { docxBufferToHtml, docxBufferToMarkdown, stripInlineImageData } from '../../../src/main/util/extract-docx';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';

describe('extract-docx › stripInlineImageData', () => {
  it('剥掉 markdown 内联图片的 base64，只留短占位', () => {
    const b64 = 'A'.repeat(5000);
    const md = `正文开头\n\n![IMG_256](data:image/jpeg;base64,${b64})\n\n正文结尾`;
    const out = stripInlineImageData(md);
    expect(out).toContain('正文开头');
    expect(out).toContain('正文结尾');
    expect(out).not.toContain(b64);
    expect(out).not.toContain('base64');
    expect(out).toContain('（图）');
    // 体积必须塌下来（真机案例：一张 140KB 截图 → 19 万字符 → 470 个乱码 chunk）
    expect(out.length).toBeLessThan(50);
  });

  it('剥掉 HTML <img> 形式的 base64（表格内/某些 mammoth 版本）', () => {
    const out = stripInlineImageData('<p>前</p><img src="data:image/png;base64,BBBBBBBBBBBB"/><p>后</p>');
    expect(out).toBe('<p>前</p>（图）<p>后</p>');
  });

  it('多张图片全部剥掉，正文一字不动', () => {
    const md = ['甲', `![a](data:image/png;base64,${'x'.repeat(300)})`, '乙', `![b](data:image/jpeg;base64,${'y'.repeat(300)})`, '丙'].join('\n');
    expect(stripInlineImageData(md)).toBe(['甲', '（图）', '乙', '（图）', '丙'].join('\n'));
  });

  it('普通 markdown（含远程图片链接）不受影响', () => {
    const md = '看这里 ![图](https://example.com/a.png) 和 [链接](https://example.com)';
    expect(stripInlineImageData(md)).toBe(md);
  });

  it('空值/undefined 返回空串，不抛', () => {
    expect(stripInlineImageData('')).toBe('');
    expect(stripInlineImageData(undefined as never)).toBe('');
  });
});

describe('extract-docx › docxBufferToMarkdown', () => {
  it('extracts plain paragraphs', async () => {
    const docx = makeMinimalDocx({ paragraphs: ['First paragraph.', 'Second paragraph.'] });
    const md = await docxBufferToMarkdown(docx);
    // mammoth markdown-escapes literal periods to "\." — match either form.
    expect(md).toMatch(/First paragraph\\?\./);
    expect(md).toMatch(/Second paragraph\\?\./);
  });

  it('emits a markdown heading for Heading1 paragraphs', async () => {
    const docx = makeMinimalDocx({ heading: 'Title Here', paragraphs: ['Body line.'] });
    const md = await docxBufferToMarkdown(docx);
    expect(md).toMatch(/^#\s+Title Here/m);
    expect(md).toMatch(/Body line\\?\./);
  });

  it('rejects empty buffer', async () => {
    await expect(docxBufferToMarkdown(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});

describe('extract-docx › docxBufferToHtml', () => {
  it('extracts preview HTML for paragraphs', async () => {
    const docx = makeMinimalDocx({ heading: 'Preview Title', paragraphs: ['Preview body.'] });
    const html = await docxBufferToHtml(docx);

    expect(html).toContain('Preview Title');
    expect(html).toMatch(/Preview body\\?\./);
  });

  it('rejects empty buffer', async () => {
    await expect(docxBufferToHtml(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});
