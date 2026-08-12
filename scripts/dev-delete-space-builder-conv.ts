/* eslint-disable no-console */
/**
 * 删除僵尸 space_builder 会话（等价 IPC conversations.delete 逻辑）：
 *   1. recycle_bin.createAppRecycleBatchForConversation —— jsonl 进回收站（可恢复）
 *   2. chats.deleteConversation —— 索引写 tombstone + 清理会话文件
 * 必须在 App 停止后运行，避免与运行中实例的内存缓存互踩。
 * 用法：npx tsx scripts/dev-delete-space-builder-conv.ts <uid> <cid>
 */
async function main() {
  const [uid, cid] = process.argv.slice(2);
  if (!uid || !cid) {
    console.error('usage: npx tsx scripts/dev-delete-space-builder-conv.ts <uid> <cid>');
    process.exit(2);
  }
  // 先初始化数据根（设置 ORKAS_WORKSPACE_ROOT），再加载依赖 paths 的模块。
  // require（非 import）避免静态提升导致顺序颠倒。
  const { initializeInstallDataRoot } = require('../src/main/install-data-root.cjs');
  const variant = process.env.ORKAS_RUNTIME_VARIANT || 'mate';
  process.env.ORKAS_RUNTIME_VARIANT = variant;
  initializeInstallDataRoot(variant, { allowWorkspaceOverride: false });

  const { createAppRecycleBatchForConversation } = require('../src/main/features/recycle_bin');
  const { deleteConversation } = require('../src/main/features/chats');

  const batch = await createAppRecycleBatchForConversation(uid, cid);
  console.log(`recycle batch: ${batch ? batch.batch_id : 'null (nothing backed up)'}`);
  const deleted = await deleteConversation(uid, cid);
  console.log(`deleteConversation: ${deleted}`);
  process.exit(deleted ? 0 : 1);
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
