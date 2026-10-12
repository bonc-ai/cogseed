import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

import type { ContributionStaging } from './staging';
import type { PreviewManifest } from './preview';

export interface PackageSnapshot {
  bytes: Buffer;
  digest: string;
  size: number;
  fileList: PreviewManifest['files'];
}

export function buildPackage(staging: ContributionStaging, preview: PreviewManifest): PackageSnapshot {
  const zip = new AdmZip();
  for (const file of preview.files) {
    const full = path.join(staging.dir, ...file.path.split('/'));
    const bytes = fs.readFileSync(full);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== file.size || digest !== file.sha256) throw new Error('snapshot_drift');
    zip.addFile(file.path, bytes);
  }
  const bytes = zip.toBuffer();
  if (bytes.length > 8 * 1024 * 1024) throw new Error('package_too_large');
  return {
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    fileList: preview.files,
  };
}
