import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPackage } from '../../../../src/main/features/contribution/package';
import { buildPreview } from '../../../../src/main/features/contribution/preview';

let dir = '';
const staging = () => ({ dir, sourceSkillId: 'demo', token: 'token' });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-package-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel: string, body: string | Buffer): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('confirmed contribution package', () => {
  it('contains exactly the previewed paths and bytes, including ordinary icon files', () => {
    write('SKILL.md', '# demo');
    write('assets/icon.png', Buffer.from([0, 1, 2, 3]));
    const preview = buildPreview(staging());
    const packed = buildPackage(staging(), preview);
    const zip = new AdmZip(packed.bytes);
    expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual(preview.files.map((file) => file.path).sort());
    expect(zip.readFile('SKILL.md')?.toString()).toBe('# demo');
    expect(zip.readFile('assets/icon.png')).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(packed.fileList).toEqual(preview.files);
    expect(packed.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when bytes drift after preview', () => {
    write('SKILL.md', '# before');
    const preview = buildPreview(staging());
    write('SKILL.md', '# after');
    expect(() => buildPackage(staging(), preview)).toThrow('snapshot_drift');
  });
});
