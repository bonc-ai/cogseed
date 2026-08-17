import { createLogger } from '../../logger';
import type { ConnectorInstance } from '../connectors';
import {
  cognitionArtifactSourceId,
  cognitionConnectorSourceId,
  cognitionContextFileSourceId,
  removeCognitionSourceRef,
} from './source-catalog';
import type { CognitionSourceInput } from './source-service';

const log = createLogger('recall.source-removal');

export interface CognitionSourceRemovalBatchResult {
  removedSourceIds: string[];
  failedSourceIds: string[];
}

async function recordRemovedSources(
  userId: string,
  sources: CognitionSourceInput[],
): Promise<CognitionSourceRemovalBatchResult> {
  const removedSourceIds: string[] = [];
  const failedSourceIds: string[] = [];
  for (const source of sources) {
    try {
      const result = await removeCognitionSourceRef(userId, source, false);
      removedSourceIds.push(result.control.sourceId);
    } catch (error) {
      failedSourceIds.push(source.id);
      log.warn('failed to record removed cognition source', {
        kind: source.kind,
        source_id: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removedSourceIds, failedSourceIds };
}

export function recordRemovedContextFiles(
  userId: string,
  relativePaths: readonly string[],
): Promise<CognitionSourceRemovalBatchResult> {
  return recordRemovedSources(userId, [...new Set(relativePaths)].map((relativePath) => ({
    kind: 'artifact_file',
    subtype: 'context_file',
    scope: 'personal',
    id: cognitionContextFileSourceId(relativePath),
    title: relativePath,
  })));
}

export function recordRemovedConnector(
  userId: string,
  instance: Pick<ConnectorInstance, 'id' | 'display_name' | 'tools_cached_at'>,
): Promise<CognitionSourceRemovalBatchResult> {
  return recordRemovedSources(userId, [{
    kind: 'authorized_external_system',
    subtype: 'connector_record',
    scope: 'external',
    id: cognitionConnectorSourceId(instance.id),
    title: instance.display_name || instance.id,
    sourceVersion: String(instance.tools_cached_at || 0),
  }]);
}

export function recordRemovedArtifacts(
  userId: string,
  conversationId: string,
  artifactIds: readonly string[],
): Promise<CognitionSourceRemovalBatchResult> {
  return recordRemovedSources(userId, [...new Set(artifactIds)].map((artifactId) => ({
    kind: 'artifact_file',
    subtype: 'artifact',
    scope: 'conversation',
    id: cognitionArtifactSourceId(conversationId, artifactId),
  })));
}
