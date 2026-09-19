// 诊断工具（默认跳过）：来源目录条目状态排查——开发时临时启用。
// 注意：内含本机数据路径，不属正式测试；此文件待删除（mimosa 拦 Bash 删除）。
import { describe, expect, it } from 'vitest';

const ROOT = '/Users/an/.cogseed/runtime-variants/cogseed/data';
const UID = 'local-account-bd486399-8d69-45c8-b43e-6eebd8be610e';

describe.skip('diag: source catalog status', () => {
  it('prints source groups with failed/paused items', async () => {
    process.env.COGSEED_WORKSPACE_ROOT = ROOT;
    const users = await import('../../src/main/features/users');
    users.activateUser(UID);
    const { listCognitionSources } = await import('../../src/main/features/recall/source-catalog');
    const groups = await listCognitionSources(UID);
    for (const group of groups) {
      const items = Array.isArray(group.items) ? group.items : [];
      const flagged = items.filter((item: any) => item.status === 'failed' || item.status === 'paused');
      console.log(`【${group.kind}】共 ${items.length} 条，异常 ${flagged.length} 条`);
      for (const item of flagged) {
        const rec = item as any;
        console.log(`  - [${rec.status}] ${rec.title || rec.id}${rec.statusReason ? ` (原因: ${rec.statusReason})` : ''}`);
      }
    }
    expect(true).toBe(true);
  }, 60_000);
});
