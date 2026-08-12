import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildCapabilityPack,
  type MinimumCapabilityPack,
} from '../../../../src/main/features/p3394/capability-pack';
import {
  exportCapabilityPack,
  renderContextPackMarkdown,
} from '../../../../src/main/features/p3394/capability-pack-export';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

const FROZEN_AT = '2026-08-11T02:00:00.000Z';
const EXPIRES_AT = '2026-08-11T03:00:00.000Z';
const DURING = '2026-08-11T02:30:00.000Z';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pack-export-')); prev = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev; fs.rmSync(tmpDir, { recursive: true, force: true }); });

function asset(overrides: Partial<RecallAbilityAssetRecord> & { id: string }): RecallAbilityAssetRecord {
  return {
    schemaVersion: 1, ownerId: 'u', candidateId: `cand-${overrides.id}`,
    type: 'rule', title: `标题 ${overrides.id}`, statement: `判断 ${overrides.id}`,
    evidenceRefs: [{ kind: 'execution', id: `exec-${overrides.id}` }],
    scope: 'delivery', status: 'active', maturity: 'seed', version: '1',
    createdAt: FROZEN_AT, updatedAt: FROZEN_AT, ...overrides,
  } as RecallAbilityAssetRecord;
}

function samplePack(): MinimumCapabilityPack {
  return buildCapabilityPack({
    packId: 'pack-export-1',
    purpose: '交给外部执行端做一次接口评审',
    targetAgent: 'workbuddy',
    frozenAt: FROZEN_AT,
    expiresAt: EXPIRES_AT,
    assets: [
      asset({ id: 'aa-1', title: '先定错误码', statement: '写接口先定好错误码再动手。', applicableWhen: ['设计接口时'] }),
      asset({ id: 'aa-gone', status: 'revoked' }),
    ],
  });
}

describe('人读版 context-pack', () => {
  it('列出带入的判断、版本与适用条件', () => {
    const md = renderContextPackMarkdown(samplePack());
    expect(md).toContain('先定错误码');
    expect(md).toContain('写接口先定好错误码再动手。');
    expect(md).toContain('第 1 版');
    expect(md).toContain('适用：设计接口时');
  });

  it('未带入的条目必须带原因，不能只列 id', () => {
    // 最小投影如果不解释自己扣了什么，对用户就是黑箱。
    const md = renderContextPackMarkdown(samplePack());
    expect(md).toContain('## 未带入（1 条）');
    expect(md).toContain('已撤销');
  });

  it('要求接收方回传内容校验值', () => {
    const pack = samplePack();
    const md = renderContextPackMarkdown(pack);
    expect(md).toContain(pack.contentHash);
    expect(md).toContain('回传内容校验值');
  });

  it('不把内部枚举名漏给读者', () => {
    const md = renderContextPackMarkdown(samplePack());
    // 排除原因要翻译成人话，statementHash 这类校验数据留在 manifest 里。
    expect(md).not.toContain('status_not_active');
    expect(md).not.toMatch(/statementHash/);
  });

  it('零条也说清楚，不留空标题', () => {
    const empty = buildCapabilityPack({
      packId: 'pack-empty', purpose: '空包', targetAgent: 'workbuddy',
      frozenAt: FROZEN_AT, expiresAt: EXPIRES_AT, assets: [],
    });
    const md = renderContextPackMarkdown(empty);
    expect(md).toContain('这次没有带入任何判断');
    expect(md).toContain('没有被排除的条目');
  });
});

describe('导出落盘', () => {
  it('产出 manifest 与 context-pack 两份文件', async () => {
    const pack = samplePack();
    const out = await exportCapabilityPack(pack, tmpDir, DURING);

    expect(fs.existsSync(out.manifestPath)).toBe(true);
    expect(fs.existsSync(out.contextPackPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(out.manifestPath, 'utf8'));
    // manifest 是机器读的那份：校验值与版本必须原样在里面。
    expect(manifest.contentHash).toBe(pack.contentHash);
    expect(manifest.assets[0].version).toBe('1');
    expect(manifest.assets[0].statementHash).toBeTruthy();
  });

  it('拒绝导出已过期的包', async () => {
    // 对方拿到一份过期包之后没有任何办法发现这件事。
    await expect(exportCapabilityPack(samplePack(), tmpDir, '2026-08-11T04:00:00.000Z'))
      .rejects.toThrow('expired');
  });

  it('拒绝导出被篡改的包', async () => {
    const pack = samplePack();
    const tampered: MinimumCapabilityPack = {
      ...pack,
      assets: [{ ...pack.assets[0], statement: '偷偷换掉的判断' }],
    };
    await expect(exportCapabilityPack(tampered, tmpDir, DURING)).rejects.toThrow('mismatch');
  });

  it('导出不产生复用回执——交付了不等于被用了', async () => {
    // 接入方案 4.1：文件复制不构成跨 Agent 传递证明。
    // 在这里记一笔会让履历页的「实际带入几次」凭空变大。
    await exportCapabilityPack(samplePack(), tmpDir, DURING);
    const execDir = path.join(tmpDir, 'u', 'local', 'kstar', 'executions');
    const receipts = fs.existsSync(execDir)
      ? fs.readdirSync(execDir).filter((d) => fs.existsSync(path.join(execDir, d, 'context-reuse-receipt.json')))
      : [];
    expect(receipts).toEqual([]);
  });
});
