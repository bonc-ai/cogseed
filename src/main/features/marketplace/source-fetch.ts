/**
 * Immutable Source Fetch —— A-02 取字节的**唯一**调用点。
 *
 * 需求：FR-008 / FR-009 / FR-010 / FR-011 / FR-012
 * 继承：spike 的 `marketplace_source_fetch.ts`（**继承设计，重写实现**，
 *       理由见 specs/010 `research.md` 资产处置表：原验证物整包读入内存、
 *       不接临时区、错误归一化写在 catch 里，三项都违反本轮需求）。
 *
 * ⚠️ **FR-009 由结构保证**：本函数**不接受 URL 参数**。目标地址一律由
 * `apiBase()` 拼出，调用方无从传入对象存储直连地址——不是靠约定，是靠签名。
 */

import * as fs from 'node:fs';

import { createLogger } from '../../logger';
import { fetchAndReadWithRetry } from '../../util/retry';
import { requireCogSeedApiBase } from '../api_base';
import { withCommonHeaders } from '../api_common';
import { getLanguage } from '../config';
import {
  MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS,
  MarketplaceBundleSizeError,
  streamMarketplaceBundleToFile,
} from '../marketplace_bundle';
import {
  digestMismatch,
  normalizeMarketplaceError,
  sizeMismatch,
  unexpectedContentType,
} from './errors';

const log = createLogger('marketplace/source-fetch');

/** A-02 的路径。**全仓只有本模块可以取它的字节**（FR-008，T017 的扫描判据）。 */
const SOURCE_PATH = '/marketplace/skills/bundle';

/** F4 收口后 A-02 只回不可变字节，Content-Type 必须是这个（FR-010）。 */
const REQUIRED_CONTENT_TYPE = 'application/octet-stream';

export interface ImmutableArtifactRef {
  /** 完整性校验依据（`data-model.md` §1），**不是树哈希**。 */
  sha256: string;
  size_bytes: number;
}

export interface FetchImmutableSourceRequest {
  contentId: string;
  version: string;
  artifact: ImmutableArtifactRef;
  /** 临时区内的落点。字节**流式**写到这里，不经内存累积（FR-012）。 */
  destPath: string;
  assertContinue?: () => void;
  timeoutMs?: number;
}

export interface FetchImmutableSourceResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

function mimeOf(headerValue: string | null): string {
  return (headerValue || '').split(';')[0].trim().toLowerCase();
}

/**
 * 按 `{content_id, version}` 从 **Hub 源站**取不可变字节，流式落到临时区，
 * 再以 `artifact.sha256` + `size_bytes` 校验。
 *
 * 校验不过：**不返回字节、不留盘**（FR-011）。
 */
export async function fetchImmutableSource(
  req: FetchImmutableSourceRequest,
): Promise<FetchImmutableSourceResult> {
  // FR-008：请求体**必含** content_id 与 version。版本缺席即拒，不退化为「取最新」。
  if (!req.contentId) throw normalizeMarketplaceError(new Error('content_id required'), 'CONTENT_NOT_FOUND');
  if (!req.version) throw normalizeMarketplaceError(new Error('version required'), 'CONTENT_NOT_FOUND');

  const label = `marketplace:source-fetch:${req.contentId}`;
  const timeoutMs = req.timeoutMs ?? MARKETPLACE_BUNDLE_DOWNLOAD_TIMEOUT_MS;

  let written: { bytesWritten: number; sha256: string };
  try {
    const { body } = await fetchAndReadWithRetry(
      label,
      `${requireCogSeedApiBase()}${SOURCE_PATH}`,
      {
        method: 'POST',
        headers: withCommonHeaders({
          'Content-Type': 'application/json',
          'Accept-Language': getLanguage(),
        }),
        body: JSON.stringify({ content_id: req.contentId, version: req.version }),
      },
      async (res, signal) => {
        if (!res.ok) {
          throw new Error(`${label} http ${res.status}`);
        }
        // FR-010：源站回 JSON 元信息（或任何非字节类型）时拒绝，
        // 绝不把它当字节落盘——这正是「能装上但内容错」的静默失败来源。
        const mime = mimeOf(res.headers.get('content-type'));
        if (mime !== REQUIRED_CONTENT_TYPE) throw unexpectedContentType(mime);

        return streamMarketplaceBundleToFile(res, req.destPath, {
          signal,
          assertContinue: req.assertContinue,
        });
      },
      {
        timeoutMs,
        timeoutMessage: `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
        isRetriable: (err) => {
          // 体积超限与内容类型不符都是确定性失败，重试只会重复同一结果。
          if (err instanceof MarketplaceBundleSizeError) return false;
          if (err && typeof err === 'object' && (err as { code?: string }).code === 'UNEXPECTED_CONTENT_TYPE') return false;
          if (req.assertContinue) {
            try { req.assertContinue(); } catch { return false; }
          }
          return true;
        },
      },
    );
    written = body;
  } catch (err) {
    await fs.promises.rm(req.destPath, { force: true }).catch(() => {});
    throw normalizeMarketplaceError(err, 'CATALOG_UNAVAILABLE');
  }

  // FR-011：任一校验不过都不得返回字节，且临时区不留残片。
  if (written.sha256 !== req.artifact.sha256) {
    await fs.promises.rm(req.destPath, { force: true }).catch(() => {});
    throw digestMismatch(req.artifact.sha256, written.sha256);
  }
  if (written.bytesWritten !== req.artifact.size_bytes) {
    await fs.promises.rm(req.destPath, { force: true }).catch(() => {});
    throw sizeMismatch(req.artifact.size_bytes, written.bytesWritten);
  }

  log.info('immutable source fetched', {
    content_id: req.contentId, version: req.version, size_bytes: written.bytesWritten,
  });
  return { path: req.destPath, sha256: written.sha256, sizeBytes: written.bytesWritten };
}
