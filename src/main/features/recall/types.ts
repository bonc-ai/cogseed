export const RECALL_SCHEMA_VERSION = 1;

export interface RecallJsonRecord {
  schemaVersion: number;
  ownerId: string;
  id: string;
  [key: string]: unknown;
}

export interface RecallMigrationMarker extends RecallJsonRecord {
  id: 'recall-migrations';
  applied: Record<string, string>;
}

export type RecallJsonRecordUpdater = (
  current: RecallJsonRecord | undefined,
) => RecallJsonRecord | Promise<RecallJsonRecord>;

export type {
  CognitionSourceInput,
  CognitionSourceKind,
  CognitionSourceRef,
  CognitionSourceScope,
  CognitionSourceSubtype,
  CognitionSourceType,
  LegacyCognitionSourceKind,
} from './source-service';
