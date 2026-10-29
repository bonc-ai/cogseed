import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

import type { ContributionStaging } from './staging';
import type { PreviewManifest } from './preview';
import { DEFAULT_PACKAGE_LIMITS, type PackageStats } from './agent-package-rules';

export interface PackageSnapshot {
  bytes: Buffer;
  digest: string;
  size: number;
  fileList: PreviewManifest['files'];
  /** 压缩后实测数据，供四段上限判定（`checkPackageLimits`）；压缩比取各条目最大值。 */
  stats: PackageStats;
}

/**
 * 压缩后字节上限默认取契约值（8 MiB）；Agent 路径可传入契约覆盖值，不在业务代码里写死。
 */
export function buildPackage(
  staging: Pick<ContributionStaging, 'dir'>,
  preview: PreviewManifest,
  opts: { maxCompressedBytes?: number } = {},
): PackageSnapshot {
  const zip = new AdmZip();
  for (const file of preview.files) {
    const full = path.join(staging.dir, ...file.path.split('/'));
    const bytes = fs.readFileSync(full);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== file.size || digest !== file.sha256) throw new Error('snapshot_drift');
    zip.addFile(file.path, bytes);
  }
  const bytes = zip.toBuffer();
  if (bytes.length > (opts.maxCompressedBytes ?? DEFAULT_PACKAGE_LIMITS.maxCompressedBytes)) throw new Error('package_too_large');
  let maxRatio = 0;
  for (const entry of new AdmZip(bytes).getEntries()) {
    if (entry.isDirectory) continue;
    const { size, compressedSize } = entry.header;
    // 空文件与未压缩条目按 1 计，避免除零
    maxRatio = Math.max(maxRatio, compressedSize > 0 ? size / compressedSize : 1);
  }
  return {
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    fileList: preview.files,
    stats: {
      compressedBytes: bytes.length,
      fileCount: preview.files.length,
      unpackedBytes: preview.totalBytes,
      maxEntryCompressionRatio: maxRatio,
    },
  };
}
