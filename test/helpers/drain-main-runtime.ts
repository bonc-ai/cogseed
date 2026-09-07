/**
 * Release process-wide main-process caches before deleting a per-test
 * workspace. Windows does not allow unlinking SQLite databases while a
 * connection is still open, and search can retain delayed flush timers.
 */
export async function drainMainRuntimeForTest(...userIds: string[]): Promise<void> {
  const kbIndexer = await import('../../src/main/features/kb_indexer');
  const projectLibraryIndexer = await import('../../src/main/features/project_library_indexer');
  await Promise.all(userIds.flatMap((userId) => [
    typeof kbIndexer.drain === 'function' ? kbIndexer.drain(userId) : Promise.resolve(),
    typeof projectLibraryIndexer.drain === 'function'
      ? projectLibraryIndexer.drain(userId)
      : Promise.resolve(),
  ]));

  const searchIndexer = await import('../../src/main/features/search/indexer');
  await searchIndexer.flushAll();

  const kbVector = await import('../../src/main/features/kb_vector');
  kbVector.closeAllKb();

  const kbEmbed = await import('../../src/main/features/kb_embed');
  if (typeof kbEmbed.closeEmbedder === 'function') kbEmbed.closeEmbedder();
}
