/** Browsing metadata, independent of storage type and formation admission. */
export type CognitionContentCategory = 'rule' | 'preference' | 'template' | 'method' | 'lesson' | 'unclassified';
/** Preserve historical classification and confirmation identities without migrating records. */
export type StoredCognitionContentCategory = CognitionContentCategory | 'understanding' | 'experience_method' | 'fact';
export function isContentCategory(value: unknown): value is CognitionContentCategory {
  return value === 'rule' || value === 'preference' || value === 'template'
    || value === 'method' || value === 'lesson' || value === 'unclassified';
}
export function requireContentCategory(value: unknown): CognitionContentCategory {
  if (!isContentCategory(value)) throw new Error('invalid cognition content category');
  return value;
}
export function readContentCategory(value: unknown): StoredCognitionContentCategory {
  return value === 'understanding' || value === 'experience_method' || value === 'fact' ? value : requireContentCategory(value);
}
