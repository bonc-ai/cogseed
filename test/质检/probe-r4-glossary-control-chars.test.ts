/**
 * 词表控制字符回归：RTL override（U+202E）、NUL（\x00）与零宽类字符在
 * 写入（bounded）与读入（normalizeStoredEntry）两侧统一剥除；存量坏字符
 * 读入时收敛（只读兼容，不改写盘上字节）；替换链消费的 correct 为净文本，
 * 清理版文本不携带控制/不可见字符（视觉欺骗向量不复存在）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { upsertEntry, loadGlossary, listEntries } from '../../src/main/features/transcript_glossary';
import { userTranscriptGlossaryFile } from '../../src/main/paths';
import { scanText, applyCorrections } from '../../src/main/features/transcript_auto_correct';

let tmpDir: string;
let uid = '';
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-glos-ctl-'));
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  uid = `u_gctl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('回归 r4 › 词表词条控制字符：写入/读入/替换链统一剥除', () => {
  it('对照组：正常词条读写与替换链干净', () => {
    const res = upsertEntry(uid, { wrong: 'coxy', correct: 'Cogseed' });
    expect(res.entry?.correct).toBe('Cogseed');
    const entries = listEntries(uid, { status: 'active' });
    const scan = scanText('coxy 是演示词', entries);
    expect(scan.candidates.length).toBeGreaterThan(0);
    const applied = applyCorrections('coxy 是演示词', scan.candidates, { acceptRiskLevels: ['low', 'medium', 'high'] });
    expect(applied.text).toBe('Cogseed 是演示词');
  });

  it('RTL override 与 NUL 词条：写入即剥除，落盘重读不回流', () => {
    const rtl = upsertEntry(uid, { wrong: 'speakerx', correct: 'SpeakerX\u202Eelpmas 演示角色' });
    expect(rtl.entry).toBeTruthy();
    expect(rtl.entry?.correct).not.toContain('\u202E');
    expect(rtl.entry?.correct).toBe('SpeakerXelpmas 演示角色');
    const nul = upsertEntry(uid, { wrong: 'nulprobe', correct: 'A\x00B' });
    expect(nul.entry).toBeTruthy();
    expect(nul.entry?.correct).toBe('AB');

    // 落盘后重读同样干净：坏字符既不在内存对象，也不再从盘上回流。
    const reloaded = loadGlossary(uid).entries;
    expect(reloaded.some((e) => e.correct.includes('\u202E'))).toBe(false);
    expect(reloaded.some((e) => e.correct.includes('\x00'))).toBe(false);
  });

  it('存量词条带控制字符：读入收敛（只读兼容），替换链输出净文本', () => {
    // 先写一条干净词条，再在盘上手工混入 RTL override（模拟存量脏数据）。
    upsertEntry(uid, { wrong: 'speakerx', correct: 'SpeakerX 演示角色' });
    const file = userTranscriptGlossaryFile(uid);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<{ correct: string }> };
    doc.entries[0].correct = 'SpeakerX\u202E 演示角色';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');

    const entries = listEntries(uid, { status: 'active' });
    expect(entries.some((e) => e.correct.includes('\u202E'))).toBe(false);
    const scan = scanText('speakerx 为演示发言', entries);
    expect(scan.candidates.length).toBeGreaterThan(0);
    const applied = applyCorrections('speakerx 为演示发言', scan.candidates, { acceptRiskLevels: ['low', 'medium', 'high'] });
    // 清理版文本（另存进 KB 的会议纪要）不再携带 RTL override。
    expect(applied.text).not.toContain('\u202E');
    expect(applied.text).toBe('SpeakerX 演示角色 为演示发言');
  });
});
