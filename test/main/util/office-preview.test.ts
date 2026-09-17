import { describe, expect, it } from 'vitest';

import { officeBufferToPreviewHtml, officeEmptyBodyHtml, officeFragmentHasText, wrapOfficePreviewHtml } from '../../../src/main/util/office-preview';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

describe('office-preview', () => {
  it('renders blank Word documents without placeholder text', async () => {
    const docx = makeMinimalDocx({ paragraphs: [] });
    const preview = await officeBufferToPreviewHtml('word', 'blank.docx', docx);

    expect(preview.kind).toBe('word');
    expect(preview.html).toContain('office-preview office-word');
    expect(preview.html).not.toContain('(no previewable content)');
  });

  it('renders blank spreadsheets without placeholder text', async () => {
    const xlsx = makeMinimalXlsx({ rows: [] });
    const preview = await officeBufferToPreviewHtml('spreadsheet', 'blank.xlsx', xlsx);

    expect(preview.kind).toBe('spreadsheet');
    expect(preview.html).toContain('office-preview office-spreadsheet');
    expect(preview.html).not.toContain('(empty sheet)');
  });

  it('renders blank slides without placeholder text', async () => {
    const pptx = makeMinimalPptx({ slides: [[]] });
    const preview = await officeBufferToPreviewHtml('presentation', 'blank.pptx', pptx);

    expect(preview.kind).toBe('presentation');
    expect(preview.html).toContain('office-preview office-presentation');
    expect(preview.html).not.toContain('(no text)');
  });

  it('renders a presentation with no slides as a blank page', async () => {
    const pptx = makeMinimalPptx({ slides: [] });
    const preview = await officeBufferToPreviewHtml('presentation', 'empty.pptx', pptx);

    expect(preview.kind).toBe('presentation');
    expect(preview.html).toContain('class="office-slide office-slide-blank"');
    expect(preview.html).not.toContain('(no previewable content)');
  });
});

describe('office 预览排版护栏（真机反馈：docx 内图片溢出正文栏）', () => {
  it('正文图片/视频/矢量图受正文栏约束，不再按固有像素溢出', () => {
    const html = wrapOfficePreviewHtml('word', 't', '<p>x</p><img src="data:image/jpeg;base64,AA">');
    // mammoth 内联的 base64 图不带宽高属性：必须由外壳 CSS 兜住（1080px 图塞进 692px 正文栏 → 曾溢出）
    expect(html).toMatch(/\.office-word img,[\s\S]{0,80}\.office-word video \{[\s\S]{0,120}max-width: 100%;/);
    expect(html).toContain('height: auto;');
  });

  it('长串与宽表格同样有换行/限宽护栏', () => {
    const html = wrapOfficePreviewHtml('word', 't', '<p>https://example.com/very/long</p>');
    expect(html).toMatch(/\.office-word a \{[\s\S]{0,120}overflow-wrap: anywhere;/);
    expect(html).toMatch(/\.office-word table \{[\s\S]{0,160}max-width: 100%;/);
  });
});

describe('office 预览提不出正文时的说明（知识库整页查看器用）', () => {
  it('识别"正文全在嵌入对象里"与"扫描件/图片"两种原因，文案不同', () => {
    // 真机案例：一份报告.docx 的 word/document.xml 里只有一个 OLE 包
    const withEmbedded = Buffer.from('PK\u0003\u0004...word/embeddings/oleObject1.bin...', 'latin1');
    const embeddedNote = officeEmptyBodyHtml('word', withEmbedded);
    expect(embeddedNote).toContain('嵌入对象');
    expect(embeddedNote).toContain('在系统中打开');

    const scanned = officeEmptyBodyHtml('word', Buffer.from('PK\u0003\u0004word/document.xml', 'latin1'));
    expect(scanned).toContain('没有可直接提取的文字');
    expect(scanned).not.toContain('全在嵌入对象里');

    // 表格 / 演示文稿只说类型，不误报嵌入对象
    const sheet = officeEmptyBodyHtml('spreadsheet', withEmbedded);
    expect(sheet).toContain('表格');
    expect(sheet).not.toContain('嵌入对象里（Word');
  });

  it('officeFragmentHasText 只认真正有文字的片段', () => {
    expect(officeFragmentHasText('')).toBe(false);
    expect(officeFragmentHasText('<p></p>')).toBe(false);
    expect(officeFragmentHasText('<p>&nbsp;</p>')).toBe(false);
    expect(officeFragmentHasText('<p>正文</p>')).toBe(true);
  });
});
