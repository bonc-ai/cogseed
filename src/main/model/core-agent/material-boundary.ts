/**
 * Material-set boundary model (知识库问答 ① Phase 3).
 *
 * Defines what counts as "material" for a conversation and resolves the
 * current material set from live app state:
 *
 *   MaterialSet = Library (global + optional space slice)
 *               + conversation attachments (when a cid is known)
 *               + space artifacts (when a spaceId is known)
 *               + history scope (project vs none)
 *
 * Every non-Library entry carries an `inScope` flag computed against the
 * path sandbox: an entry whose resolved absolute path escapes its allowed
 * root is reported but marked out-of-scope, so downstream retrieval/reads
 * can reject it — "out of scope == not in the material set".
 *
 * The boundary is resolved on demand (per call), so attachment uploads /
 * deletions and artifact writes are reflected immediately without any
 * index to maintain. Read-only; never writes user data.
 */

import * as path from 'node:path';
import { createLogger } from '../../logger';
import * as chatAttachments from '../../features/chat_attachments';
import * as spaceArtifacts from '../../features/spaces_artifacts';
import { spaceContentDir } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import { maskId } from '../../util/log-redact';

const log = createLogger('material-boundary');

export type MaterialHistoryScope = 'project' | 'none';

export interface MaterialLibrarySlice {
  global: boolean;
  space: boolean;
}

export interface MaterialAttachment {
  name: string;
  kind: string;
  bytes: number;
  mtime: number;
  /** True when the resolved path stays inside the conversation's attachment root. */
  inScope: boolean;
}

export interface MaterialArtifact {
  name: string;
  type: string;
  ext: string;
  sourceSessionId: string;
  /** True when the artifact path stays inside the space content root. */
  inScope: boolean;
}

export interface MaterialSet {
  library: MaterialLibrarySlice;
  attachments: MaterialAttachment[];
  artifacts: MaterialArtifact[];
  history: MaterialHistoryScope;
}

export interface MaterialSetOptions {
  userId: string;
  spaceId?: string;
  /** Conversation id — resolves this conversation's attachments into scope. */
  cid?: string;
  projectId?: string;
}

/**
 * Resolve the current material set for a conversation. Attachment upload /
 * delete and artifact writes take effect on the next call (no persisted
 * boundary state).
 */
export async function resolveMaterialSet(opts: MaterialSetOptions): Promise<MaterialSet> {
  const { userId, spaceId, cid, projectId } = opts;

  const attachments: MaterialAttachment[] = [];
  if (cid) {
    const cidRoot = path.resolve(chatAttachments.attachmentDirForCid(userId, cid));
    for (const a of chatAttachments.listAttachments(userId, cid)) {
      const abs = path.resolve(cidRoot, a.name);
      attachments.push({
        name: a.name,
        kind: a.kind,
        bytes: a.bytes,
        mtime: a.mtime,
        inScope: isPathAllowed(abs, [cidRoot]),
      });
    }
  }

  const artifacts: MaterialArtifact[] = [];
  if (spaceId) {
    const spaceRoot = path.resolve(spaceContentDir(userId, spaceId));
    let entries: spaceArtifacts.SpaceArtifactEntry[] = [];
    try {
      entries = await spaceArtifacts.listSpaceArtifacts(userId, spaceId);
    } catch (err) {
      log.warn('material_boundary: listSpaceArtifacts failed', {
        user_id: maskId(userId),
        space_id: maskId(spaceId),
        error: (err as Error).message,
      });
    }
    for (const e of entries) {
      artifacts.push({
        name: e.name,
        type: e.type,
        ext: e.ext,
        sourceSessionId: e.sourceSessionId,
        inScope: e.path ? isPathAllowed(path.resolve(e.path), [spaceRoot]) : false,
      });
    }
  }

  return {
    library: { global: true, space: !!spaceId },
    attachments,
    artifacts,
    history: projectId ? 'project' : 'none',
  };
}
