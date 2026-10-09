import { describe, expect, it } from 'vitest';

import {
  applyDocxImageSizes,
  docxBufferToHtml,
  docxImageDisplaySizes,
} from '../../../src/main/util/extract-docx';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import {
  SAMPLE_IMAGE_EMU,
  makeDocxWithChartOnly,
  makeDocxWithImages,
} from '../../fixtures/make-docx-with-images';

/**
 * 真机背景（2026-09-18，`软件行业的三块地基，正在被AI改写.docx`）：6 张插图固有
 * 1080×720，Word 里的显示区域是 554×369（`wp:extent` 5273040×3517900 EMU）。
 * mammoth 只输出 `<img src="data:…">`，不带任何宽高 → 曾按固有像素渲染溢出正文栏，
 * 被外壳 CSS 限宽后又变成"撑满正文栏"，都不是 Word 的排版。
 */
describe('extract-docx › Word 原始图片尺寸', () => {
  it('从 wp:extent 读出 EMU 并换算成 CSS px（96dpi）', () => {
    const docx = makeDocxWithImages({
      paragraphs: ['正文一。'],
      images: [SAMPLE_IMAGE_EMU, SAMPLE_IMAGE_EMU],
    });

    expect(docxImageDisplaySizes(docx)).toEqual([
      { width: 554, height: 369 },
      { width: 554, height: 369 },
    ]);
  });

  it('图表/形状（有 wp:extent、无 a:blip）不算图片，避免张数错位', () => {
    expect(docxImageDisplaySizes(makeDocxWithChartOnly())).toEqual([]);
    expect(docxImageDisplaySizes(Buffer.from('not a zip'))).toEqual([]);
  });

  it('docxBufferToHtml 把宽高写回 mammoth 的 <img>（属性，不改内容）', async () => {
    const docx = makeDocxWithImages({
      paragraphs: ['配图说明。'],
      images: [SAMPLE_IMAGE_EMU],
    });
    const html = await docxBufferToHtml(docx);

    expect(html).toMatch(/<img\b[^>]*alt="image1"[^>]*src="data:image\/png;base64,[^"]*"[^>]*\bwidth="554" height="369" \/>/);
  });

  it('没有图的 docx 一字不改（不凭空造属性）', async () => {
    const html = await docxBufferToHtml(makeMinimalDocx({ heading: 'T', paragraphs: ['P'] }));

    expect(html).not.toContain('<img');
    expect(html).not.toContain('width=');
  });

  it('张数对不上就整批不注入——错配尺寸比不限尺寸更糟', () => {
    const html = '<p>x</p><img src="data:image/png;base64,AA" /><img src="data:image/png;base64,BB" />';

    expect(applyDocxImageSizes(html, [{ width: 554, height: 369 }])).toBe(html);
    expect(applyDocxImageSizes(html, [])).toBe(html);
  });

  it('已自带宽高/内联样式的 <img> 不覆盖', () => {
    const html = '<img src="a" width="100" />';

    expect(applyDocxImageSizes(html, [{ width: 554, height: 369 }])).toBe(html);
  });

  it('两种书写形式（自闭合/不成对）都能补上属性', () => {
    expect(applyDocxImageSizes('<img src="a" />', [{ width: 554, height: 369 }]))
      .toBe('<img src="a" width="554" height="369" />');
    expect(applyDocxImageSizes('<img src="a">', [{ width: 554, height: 369 }]))
      .toBe('<img src="a" width="554" height="369">');
  });
});
