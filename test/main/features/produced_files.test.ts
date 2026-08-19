import { describe, expect, it } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { selectVisibleProducedFiles, validateProducedFiles } from '../../../src/main/features/produced_files';

describe('produced file presentation', () => {
  it('keeps an ordinary ambiguous deliverable when there is no export signal', () => {
    expect(selectVisibleProducedFiles(['/workspace/report.md'])).toEqual(['/workspace/report.md']);
    expect(selectVisibleProducedFiles(['/workspace/tool.py'])).toEqual(['/workspace/tool.py']);
  });

  it('shows document exports instead of their source and rendering assets', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/report.md',
      '/workspace/assets/chart.png',
      '/workspace/report.docx',
      '/workspace/report.pdf',
    ])).toEqual([
      '/workspace/report.docx',
      '/workspace/report.pdf',
    ]);
  });

  it('shows a rendered video and subtitle instead of composition assets', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/composition.html',
      '/workspace/frame.png',
      '/workspace/final.mp4',
      '/workspace/final.srt',
    ])).toEqual([
      '/workspace/final.mp4',
      '/workspace/final.srt',
    ]);
  });

  it('shows final images instead of generated metadata', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/metadata.json',
      '/workspace/cover.png',
      '/workspace/cover.webp',
    ])).toEqual([
      '/workspace/cover.png',
      '/workspace/cover.webp',
    ]);
  });

  it('removes obvious process paths and technical files', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/tmp/render.json',
      '/workspace/preview-slide.png',
      '/workspace/run.log',
      '/workspace/result.csv',
    ])).toEqual(['/workspace/result.csv']);
  });

  it('does not treat a process-like workspace ancestor as a file role', () => {
    expect(selectVisibleProducedFiles([
      '/Users/test/work/project/result.json',
      'C:\\Users\\example\\temp\\project\\report.md',
    ])).toEqual([
    '/Users/test/work/project/result.json',
      'C:\\Users\\example\\temp\\project\\report.md',
    ]);
  });

  it('deduplicates exact paths while preserving the original order', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/a.json',
      '/workspace/a.json',
      '/workspace/b.json',
    ])).toEqual(['/workspace/a.json', '/workspace/b.json']);
  });

  it('lets an explicit current-turn declaration override every heuristic', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/source.md',
      '/workspace/manifest.json',
      '/workspace/export.pdf',
    ], [
      '/workspace/manifest.json',
      '/workspace/source.md',
      '/workspace/not-produced.zip',
    ])).toEqual([
      '/workspace/manifest.json',
      '/workspace/source.md',
    ]);
  });

  it('distinguishes no declaration from an explicit empty declaration', () => {
    const paths = [
      '/workspace/script.md',
      '/workspace/shotlist.json',
    ];

    expect(selectVisibleProducedFiles(paths)).toEqual(paths);
    expect(selectVisibleProducedFiles(paths, [])).toEqual([]);
  });
});

describe('produced file validation', () => {
  it('distinguishes usable, empty, missing, and fallback-only outputs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-produced-'));
    const ready = path.join(dir, 'report.pdf');
    const empty = path.join(dir, 'empty.txt');
    const fallbackOnly = path.join(dir, 'archive.zip');
    fs.writeFileSync(ready, 'pdf');
    fs.writeFileSync(empty, '');
    fs.writeFileSync(fallbackOnly, 'zip');

    const results = validateProducedFiles([
      ready,
      empty,
      path.join(dir, 'missing.docx'),
      fallbackOnly,
    ], [{
      type: 'event',
      event: { stream: 'tool', data: { name: 'html_to_pdf', phase: 'end', output_path: ready } },
    }]);

    expect(results.map((item) => ({
      name: path.basename(item.path),
      status: item.status,
      preview: item.preview,
      failure: item.failure_code,
    }))).toEqual([
      { name: 'report.pdf', status: 'ready', preview: 'available', failure: undefined },
      { name: 'empty.txt', status: 'invalid', preview: 'failed', failure: 'empty' },
      { name: 'missing.docx', status: 'invalid', preview: 'failed', failure: 'missing' },
      { name: 'archive.zip', status: 'ready', preview: 'fallback_only', failure: undefined },
    ]);
    expect(results[0]).toMatchObject({ exists: true, non_empty: true, bytes: 3 });
    expect(results[0].evidence.producer_tool).toBe('html_to_pdf');
    expect(results[1].fallbacks).toEqual(['open', 'reveal']);
    expect(results[2].fallbacks).toEqual([]);
    expect(results[3].fallbacks).toEqual(['open', 'reveal']);
  });
});
