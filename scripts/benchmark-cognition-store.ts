/** Isolated synthetic benchmark. Never reads or changes the live account. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cognition-benchmark-'));
  const previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  try {
    const bridge = await import('../src/main/features/cognition_bridge');
    const results = [];
    for (const count of [100, 1000, 10000]) {
      const uid = `benchmark-${count}`;
      const records: Record<string, Record<string, unknown>> = {};
      for (let n = 0; n < count; n++) {
        const id = `aa-benchmark-${n}`;
        records[id] = { schemaVersion: 2, ownerId: uid, id, type: 'template', title: `测试模板${n}`, statement: '虚构正文'.repeat(100),
          scope: 'global', status: 'active', version: '1', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' };
      }
      const start = performance.now();
      await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': records, candidates: {} }, po: { schemaVersion: 2, ownerId: uid, groups: [], trash: [] }, pendingProjection: true, migratedAt: new Date().toISOString() });
      await bridge.recoverCognitionProjection(uid, true);
      const fullRecoveryMs = performance.now() - start;
      const dir = path.join(root, uid, 'cloud/recall/records/ability-assets');
      const times = new Map(fs.readdirSync(dir).map(name => [name, fs.statSync(path.join(dir, name), { bigint: true }).mtimeNs]));
      const samples = [];
      for (let n = 0; n < 3; n++) {
        const started = performance.now();
        await bridge.withCognitionTransition(uid, () => bridge.persistCognitionSource(uid, 'ability-assets', 'aa-benchmark-0', { ...records['aa-benchmark-0'], status: n % 2 ? 'active' : 'paused' }, async () => { throw new Error('unified write fell back'); }));
        samples.push(Math.round(performance.now() - started));
      }
      const rewritten = fs.readdirSync(dir).filter(name => times.get(name) !== fs.statSync(path.join(dir, name), { bigint: true }).mtimeNs).length;
      results.push({ count, fullRecoveryMs: Math.round(fullRecoveryMs), singleEditMs: samples, compatibilityRecordsRewritten: rewritten });
    }
    process.stdout.write(JSON.stringify({ synthetic: true, results }, null, 2) + '\n');
  } finally {
    if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
