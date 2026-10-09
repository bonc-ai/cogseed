#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CogSeed review.3 整改包 → 平台 marketplace skill 内容升级导入。
策略：41 个 skill 已存在（id 由 sha256(cogseed:{role}:{name})[:12] 确定性生成），
本次只覆盖内容制品（SKILL.md + references/ + evals/ + agents/ + schemas.json），
保留并合并 _meta.json（契约分级标注不动，version 升为 0.2.0-review.3）。
用法: python3 scripts/dev-import-cogseed-review3.py [--apply]  (默认 dry-run)
"""
import json, os, shutil, sys, hashlib, glob

PKG = '/tmp/cogseed-review3/role_packages'
DEST = os.path.expanduser('~/cogseed-agent/resources/builtin/marketplace/skills')
APPLY = '--apply' in sys.argv

def gen_id(role, name):
    return hashlib.sha256(f'cogseed:{role}:{name}'.encode()).hexdigest()[:12]

# 收集整改包所有 skill（role, name）→ 平台 sid
pkg_skills = []
for role in sorted(os.listdir(PKG)):
    rp = os.path.join(PKG, role)
    if not os.path.isdir(rp) or role.startswith('.'):
        continue
    skills_dir = os.path.join(rp, 'skills')
    if not os.path.isdir(skills_dir):
        continue
    for sk in sorted(os.listdir(skills_dir)):
        if os.path.isdir(os.path.join(skills_dir, sk)):
            pkg_skills.append((role, sk))

# 校验平台 sid 存在性
missing = []
for role, sk in pkg_skills:
    sid = gen_id(role, sk)
    if not os.path.isdir(os.path.join(DEST, sid)):
        missing.append((role, sk, sid))

print(f"整改包 skill 数: {len(pkg_skills)}")
print(f"平台目录缺失: {len(missing)}")
for m in missing:
    print(f"  ⚠️ {m[0]}/{m[1]} → 平台无 sid={m[2]}")

# 逐个预览将复制的内容
print("\n=== 每 skill 将覆盖/新增的文件 ===")
total_files = 0
for role, sk in pkg_skills:
    sid = gen_id(role, sk)
    src = os.path.join(PKG, role, 'skills', sk)
    dst = os.path.join(DEST, sid)
    if not os.path.isdir(dst):
        continue
    # 计算要复制的内容文件（排除 cogseed-skill.yaml —— 平台不认这个扩展文件）
    to_copy = []
    for item in ('SKILL.md', 'schemas.json', 'agents', 'evals', 'references'):
        p = os.path.join(src, item)
        if os.path.isfile(p) or os.path.isdir(p):
            to_copy.append(item)
    n_files = 0
    for item in to_copy:
        p = os.path.join(src, item)
        if os.path.isdir(p):
            n_files += sum(len(fs) for _, _, fs in os.walk(p))
        else:
            n_files += 1
    total_files += n_files
    print(f"  {sk} (sid={sid}): {', '.join(to_copy)} = {n_files} 文件")
print(f"\n总计将复制: {total_files} 文件")

if not APPLY:
    print("\n[dry-run] 未写盘。加 --apply 执行。")
    sys.exit(0)

# ── 执行 ──
copied = 0
for role, sk in pkg_skills:
    sid = gen_id(role, sk)
    src = os.path.join(PKG, role, 'skills', sk)
    dst = os.path.join(DEST, sid)
    if not os.path.isdir(dst):
        continue
    # SKILL.md 覆盖
    shutil.copy2(os.path.join(src, 'SKILL.md'), os.path.join(dst, 'SKILL.md'))
    copied += 1
    # schemas.json
    if os.path.isfile(os.path.join(src, 'schemas.json')):
        shutil.copy2(os.path.join(src, 'schemas.json'), os.path.join(dst, 'schemas.json'))
        copied += 1
    # 目录：agents/ evals/ references/（先删平台旧目录再整体复制，保证与整改包逐字节一致）
    for item in ('agents', 'evals', 'references'):
        sdir = os.path.join(src, item)
        ddir = os.path.join(dst, item)
        if os.path.isdir(sdir):
            if os.path.isdir(ddir):
                shutil.rmtree(ddir)
            shutil.copytree(sdir, ddir)
            copied += sum(len(fs) for _, _, fs in os.walk(sdir))
    # _meta.json：保留 契约分级，version 升 review.3
    meta_path = os.path.join(dst, '_meta.json')
    meta = json.load(open(meta_path, encoding='utf-8')) if os.path.exists(meta_path) else {}
    meta['version'] = '0.2.0-review.3'
    meta['updated_at'] = '2026-08-11T00:00:00'
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    copied += 1

print(f"\n✅ 已复制 {copied} 文件到 {len(pkg_skills)} 个 skill 目录")
