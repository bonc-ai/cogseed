/**
 * .docx generator **with the real Word picture wrapper** (`<w:drawing>` +
 * `<wp:extent>` + `<a:blip>`), for tests that need mammoth to inline an image
 * and for the "Word 原始显示尺寸" path (`extract-docx.applyDocxImageSizes`).
 *
 * 与 `make-minimal-docx.ts` 的分工：那份是手写 STORED zip、只出文字；这份用 adm-zip
 * 连带 `word/media/*`、`word/_rels/document.xml.rels`、`[Content_Types].xml` 一起打包，
 * 因为 mammoth 要能顺着关系找到图片字节才会输出 `<img>`。
 */

import AdmZip from 'adm-zip';
import { Buffer } from 'node:buffer';

/** 1×1 透明 PNG（够 mammoth 认出类型并内联成 data URI）。 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** 真机样本 `软件行业的三块地基，正在被AI改写.docx` 里每张图的 EMU（= 554×369 px）。 */
export const SAMPLE_IMAGE_EMU = { cx: 5_273_040, cy: 3_517_900 };

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export interface DocxImageSpec {
  /** Word 里的显示宽高，EMU（`wp:extent` 的原样单位）。 */
  cx: number;
  cy: number;
  /** 图片替代文字（写进 `wp:docPr descr`，mammoth 会当 `alt`）。 */
  descr?: string;
}

function documentXml(paragraphs: string[], images: DocxImageSpec[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const drawings = images
    .map((img, i) => {
      const rId = `rId${i + 1}`;
      return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
  <wp:extent cx="${img.cx}" cy="${img.cy}"/>
  <wp:docPr id="${i + 1}" name="Picture ${i + 1}" descr="${escapeXml(img.descr ?? `image${i + 1}`)}"/>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic>
      <pic:nvPicPr><pic:cNvPr id="${i + 1}" name="image${i + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
    </pic:pic>
  </a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r></w:p>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>${body}${drawings}</w:body>
</w:document>`;
}

function documentRels(count: number): string {
  const rels = Array.from({ length: count }, (_v, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function makeDocxWithImages(opts: { paragraphs?: string[]; images: DocxImageSpec[] }): Buffer {
  const paragraphs = opts.paragraphs ?? [];
  const images = opts.images;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(PACKAGE_RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml(paragraphs, images), 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(documentRels(images.length), 'utf8'));
  const png = Buffer.from(TINY_PNG_BASE64, 'base64');
  images.forEach((_img, i) => zip.addFile(`word/media/image${i + 1}.png`, png));
  return zip.toBuffer();
}

/** 只有图形/图表（`wp:extent` 但**没有** `a:blip`）的 docx：mammoth 不输出 `<img>`。 */
export function makeDocxWithChartOnly(): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body><w:p><w:r><w:drawing><wp:inline>
    <wp:extent cx="5273040" cy="3517900"/>
    <wp:docPr id="1" name="Chart 1"/>
  </wp:inline></w:drawing></w:r></w:p></w:body>
</w:document>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(PACKAGE_RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}
