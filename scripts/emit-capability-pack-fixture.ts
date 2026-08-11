/** 生成固定测试能力包的 manifest 样例，供评审与执行端联调使用。
 *
 *  样例由 `buildCapabilityPack` 本身产出，不是手写的——手写样例会和实现漂移，
 *  而这份 manifest 的用途正是让执行端照着对字段和 hash。
 *
 *  用法：npx tsx scripts/emit-capability-pack-fixture.ts
 *  输出：docs/p3394/capability-pack/manifest.sample.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildCapabilityPack } from '../src/main/features/p3394/capability-pack';
import type { RecallAbilityAssetRecord } from '../src/main/features/recall/candidate-service';

const FROZEN_AT = '2026-08-11T02:00:00.000Z';
const EXPIRES_AT = '2026-08-11T03:00:00.000Z';

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 1,
    ownerId: 'user-fixture',
    candidateId: `cand-${overrides.id}`,
    type: 'rule',
    title: `Title ${overrides.id}`,
    statement: `Statement for ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery',
    status: 'active',
    maturity: 'seed',
    version: '1',
    createdAt: FROZEN_AT,
    updatedAt: FROZEN_AT,
    ...overrides,
  } as RecallAbilityAssetRecord;
}

const pack = buildCapabilityPack({
  packId: 'pack-fixture-0001',
  purpose: '为客户交付方案做一次评审',
  targetAgent: 'workbuddy',
  frozenAt: FROZEN_AT,
  expiresAt: EXPIRES_AT,
  situation: ['交付评审'],
  assets: [
    asset({
      id: 'aa-0001',
      title: '先对齐验收标准',
      statement: '动手前先把验收标准写成可勾选的清单。',
      applicableWhen: ['交付评审'],
      evidenceRefs: [{ kind: 'execution', id: 'exec-2026-08-04-delivery' }],
    }),
    asset({
      id: 'aa-0002',
      type: 'template',
      title: '风险登记表',
      statement: '每个交付风险要有触发信号与处置人。',
      evidenceRefs: [{ kind: 'episode', id: 'ep-risk-review' }],
    }),
    asset({
      id: 'aa-0003',
      status: 'revoked',
      title: '已撤销的判断',
      statement: '这条不该出现在包里。',
    }),
    asset({
      id: 'aa-0004',
      title: '内部估算口径',
      statement: '对外报价前先过一遍内部估算口径。',
      forbiddenWhen: ['在客户现场不要引用内部估算'],
      evidenceRefs: [{ kind: 'execution', id: 'exec-pricing' }],
    }),
    asset({
      id: 'aa-0005',
      title: '缺证据的判断',
      statement: '没有来源的判断不该进包。',
      evidenceRefs: [],
    }),
  ],
});

const outPath = path.resolve(__dirname, '..', 'docs', 'p3394', 'capability-pack', 'manifest.sample.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');

console.log(`wrote ${path.relative(path.resolve(__dirname, '..'), outPath)}`);
console.log(`  assets: ${pack.assets.length}  excluded: ${pack.excluded.length}`);
console.log(`  contentHash: ${pack.contentHash}`);
