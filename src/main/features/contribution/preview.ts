/**
 * 提交预览清单与摘要 —— 「预览即发出」的唯一真相源。
 *
 * ## 不变量
 *
 * `C-FR-004a`：实际发出的文件清单 MUST 与预览逐项一致；预览外的任何本机数据
 * （安装清单、用户设置、任务正文、设备信息、其他 Skill、账号凭据）MUST NOT 发出。
 *
 * 实现上这条靠**同一份清单既用于展示也用于打包**来保证，而不是靠两处各自遍历目录
 * 然后期望它们一致。两处遍历就是两个真相，差异会在"预览显示 12 个文件、实际发出
 * 13 个"这种地方出现，而这恰恰是隐私承诺最不能出错的地方。
 *
 * ## 为什么摘要在这里算
 *
 * `C-FR-012a`：提交前 MUST 重新校验包摘要，与预览时不一致则要求重新检查与预览。
 * 摘要必须覆盖**清单本身**而不只是各文件内容——否则增删一个空文件不会改变摘要，
 * 而清单变了。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { ContributionStaging } from './staging';

/** 预览中的一个文件条目。`sha256` 是该文件内容的摘要。 */
export interface PreviewFile {
  /** 包内相对路径，正斜杠分隔（跨平台稳定）。 */
  path: string;
  size: number;
  sha256: string;
}
export interface PreviewManifest {
  files: PreviewFile[];
  /** 全部文件的总字节数。 */
  totalBytes: number;
  /**
   * 覆盖「清单 + 内容」的摘要。
   *
   * 对 `path\0size\0sha256\n` 逐行拼接后取 SHA-256：文件内容变、大小变、路径变、
   * 增删文件，四种改动都会改变它。只哈希内容会漏掉后两种。
   */
  digest: string;
}

/** 与 `staging.ts` 的复制过滤保持一致：本机安装态不属于"将要发出的内容"。 */
const _EXCLUDED = new Set(['_install.json', '_cache.json', '_resource_manifest.json']);

function _walk(root: string, rel: string, out: PreviewFile[]): void {
  const abs = path.join(root, rel);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (_EXCLUDED.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      _walk(root, childRel, out);
      continue;
    }
    // 只收普通文件。符号链接不跟随——跟随会让清单指向副本之外的内容，
    // 那正是「预览外的数据随提交发出」的一条路径。
    if (!e.isFile()) continue;
    const full = path.join(root, childRel);
    let buf: Buffer;
    try { buf = fs.readFileSync(full); } catch { continue; }
    out.push({
      path: childRel,
      size: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
  }
}

/**
 * 为提交副本生成预览清单。
 *
 * 路径按字典序排序：同一份内容在任何机器上必须产出同一个 `digest`，而目录遍历
 * 顺序依赖文件系统。不排序会让「提交前重新校验摘要」在换机或重装后误报不一致。
 */
export function buildPreview(staging: ContributionStaging): PreviewManifest {
  const files: PreviewFile[] = [];
  _walk(staging.dir, '', files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const h = createHash('sha256');
  let totalBytes = 0;
  for (const f of files) {
    h.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
    totalBytes += f.size;
  }
  return { files, totalBytes, digest: h.digest('hex') };
}

/**
 * 判断副本自上次预览以来是否变化。
 *
 * `C-FR-004c` / `C-FR-012a` 的判据：变了就必须重跑全套检查并重新确认预览，
 * 不能沿用旧结论。
 */
export function previewChanged(previous: PreviewManifest, current: PreviewManifest): boolean {
  return previous.digest !== current.digest;
}

/** 迭代一 §6.3 的包上限，贡献侧沿用同一组值。 */
export const PACKAGE_LIMITS = {
  /** 解包后总字节上限。 */
  maxUnpackedBytes: 10 * 1024 * 1024,
  /** 文件数上限。 */
  maxFiles: 200,
} as const;

export type LimitViolation =
  | { kind: 'too_many_files'; actual: number; limit: number }
  | { kind: 'unpacked_too_large'; actual: number; limit: number };

/**
 * 对预览清单核对上限。
 *
 * 压缩后 ≤ 8 MiB 那一条在打包时才能判（这里还没压），所以不在本函数内——
 * 把一个判不了的条件写进来只会让调用方以为已经判过了。
 */
export function checkLimits(preview: PreviewManifest): LimitViolation[] {
  const out: LimitViolation[] = [];
  if (preview.files.length > PACKAGE_LIMITS.maxFiles) {
    out.push({ kind: 'too_many_files', actual: preview.files.length, limit: PACKAGE_LIMITS.maxFiles });
  }
  if (preview.totalBytes > PACKAGE_LIMITS.maxUnpackedBytes) {
    out.push({ kind: 'unpacked_too_large', actual: preview.totalBytes, limit: PACKAGE_LIMITS.maxUnpackedBytes });
  }
  return out;
}
