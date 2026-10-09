/**
 * Anchor resolution feature (知识库问答 ② P1) — IPC-facing entry for
 * `cogseed.anchor.resolve`.
 *
 * Lives in the features layer (not cogseed_backend) because it calls the
 * in-process model layer (`model/core-agent/anchor-resolver`), which the
 * cogseed runtime backend must not import (separation boundary).
 *
 * Validates the payload here (bounded strings, integer chunk), then delegates
 * to the resolver. Read-only.
 */

import { createLogger } from '../logger';
import { resolveAnchor } from '../model/core-agent/anchor-resolver';

const log = createLogger('anchor');

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s.length === 0 || s.length > max) return undefined;
  return s;
}

export async function anchorResolveIpc(userId: string, payload: unknown): Promise<unknown> {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const view = raw.view === 'document' ? 'document' : 'anchor';
  const scopeRaw = boundedString(raw.scope, 'scope', 32) ?? '';
  const scope = scopeRaw === 'space' ? 'space'
    : scopeRaw === 'conversation' ? 'conversation' : 'global';
  const source = raw.source === 'attachment' ? 'attachment' : 'library';

  const pathValue = boundedString(raw.path, 'path', 500);
  if (!pathValue) {
    log.warn('anchor.resolve: missing path', { user_id: String(userId).slice(0, 8) });
    return { resolved: false, reason: 'bad_input' };
  }

  // chunkIdx 只在调用方**真的给了数字**时才算"引用定位"。此前缺省补 0，
  // 于是"打开整篇"的调用（文件列表/发现页/来源跳转）都会被定位到第 0 个 chunk
  // ——正文前几行平白多出一道高亮，还多出"返回引用位置"按钮（真机反馈）。
  const chunkNum = Number(raw.chunkIdx);
  const hasChunk = Number.isFinite(chunkNum) && chunkNum >= 0;
  const quote = typeof raw.quote === 'string' && raw.quote.trim()
    ? boundedString(raw.quote, 'quote', 2000)
    : undefined;
  // 片段视图必须有定位依据（chunk 或 quote）；整篇视图可以什么都不给 = 打开整篇
  if (view === 'anchor' && !hasChunk && !quote) {
    return { resolved: false, reason: 'bad_input' };
  }

  try {
    return await resolveAnchor({
      userId,
      source,
      scope,
      path: pathValue,
      ...(hasChunk ? { chunkIdx: Math.floor(chunkNum) } : {}),
      view,
      ...(quote ? { quote } : {}),
      ...(typeof raw.cid === 'string' && raw.cid.trim() ? { cid: boundedString(raw.cid, 'cid', 200)! } : {}),
      ...(typeof raw.spaceId === 'string' && raw.spaceId.trim() ? { spaceId: boundedString(raw.spaceId, 'spaceId', 200)! } : {}),
    });
  } catch (err) {
    log.warn('anchor.resolve failed', {
      user_id: String(userId).slice(0, 8),
      error: (err as Error).message,
    });
    return { resolved: false, reason: 'no_text' };
  }
}
