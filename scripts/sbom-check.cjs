#!/usr/bin/env node
/**
 * SBOM freshness gate for the CogSeed repository.
 *
 * Regenerates the CycloneDX BOM with @cyclonedx/cyclonedx-npm (pinned) into a
 * temp file and compares it semantically against the committed
 * `sbom.cdx.json`, ignoring volatile fields (`metadata.timestamp`,
 * `serialNumber`) that change on every run.
 *
 * Usage:
 *   node scripts/sbom-check.cjs
 *
 * Exits non-zero when:
 *   - the committed sbom.cdx.json is missing or not valid CycloneDX, or
 *   - the regenerated BOM differs in its component set or dependency graph.
 *
 * Requires network access to fetch the pinned generator. Run locally with
 * `npm run sbom:check`, and in CI as the P7 release gate. To update the
 * committed BOM after dependency changes, run `npm run sbom:generate`.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const COMMITTED = path.join(REPO, 'sbom.cdx.json');
const GENERATOR = '@cyclonedx/cyclonedx-npm@6.0.1';

function fail(msg) {
  console.error(`[sbom-check] ${msg}`);
  process.exit(1);
}

function canonicalComponent(comp) {
  const group = comp.group || '';
  const name = comp.name || '';
  const version = comp.version || '';
  const licenses = (comp.licenses || [])
    .map((l) => l.license?.id || l.license?.name || l.expression || '')
    .sort()
    .join('|');
  return `${group}/${name}@${version} [${licenses}]`;
}

function semanticSnapshot(bom) {
  const components = (bom.components || []).map(canonicalComponent).sort();
  const dependencies = (bom.dependencies || [])
    .map((d) => {
      const ref = d.ref || '';
      const deps = (d.dependencies || []).map((x) => x.ref).sort();
      return `${ref} -> ${deps.join(',')}`;
    })
    .sort();
  return { components, dependencies };
}

function regenerate() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-check-'));
  const outFile = path.join(tmpDir, 'sbom.cdx.json');
  const res = spawnSync(
    'npx',
    ['--yes', GENERATOR, '--output-file', outFile],
    { cwd: REPO, encoding: 'utf8', timeout: 10 * 60 * 1000 },
  );
  if (res.status !== 0) {
    fail(`generator failed (${res.status}): ${(res.stderr || res.stdout || '').slice(0, 800)}`);
  }
  if (!fs.existsSync(outFile)) fail('generator produced no output file');
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

/**
 * npm's dependency tree (which cyclonedx-npm renders) skips packages that do
 * not apply to the current platform: optional dependencies with `os`/`cpu`
 * constraints, and alternate versions resolved for other platforms. The
 * committed BOM may therefore legitimately differ from one regenerated on
 * another OS. Such packages are reported as warnings; anything else is a
 * hard stale error.
 */
let _lockCache = null;
function lockfile() {
  if (_lockCache === null) {
    try {
      _lockCache = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
    } catch {
      _lockCache = {};
    }
  }
  return _lockCache;
}

/**
 * True when the raw npm package name (e.g. "sqlite-vec-darwin-x64",
 * "@types/node") is a dev dependency or a platform-scoped optional dependency
 * (os/cpu constraints). Differences for such packages are expected across OSes
 * and install profiles, and are reported as warnings rather than hard errors.
 */
function isSoftPackage(pkgName) {
  const lock = lockfile();
  const key = `node_modules/${pkgName}`;
  for (const [k, p] of Object.entries(lock.packages || {})) {
    if (k === key || k.startsWith(`${key}/`) || k.endsWith(`/node_modules/${pkgName}`)) {
      if (p.optional === true || p.os || p.cpu || p.dev === true) return true;
    }
  }
  return false;
}

function canonicalToName(canonical) {
  // canonical: "<group>/<name>@<version> [licenses]"; group may be empty -> "/name@…"
  const at = canonical.lastIndexOf('@');
  if (at <= 0) return null;
  return canonical.slice(0, at).replace(/^\//, '');
}

function platformScopedInLockfile(canonical) {
  const name = canonicalToName(canonical);
  return name ? isSoftPackage(name) : false;
}

function refToName(ref) {
  // ref formats seen in CycloneDX from cyclonedx-npm:
  //   "pkg:npm/<name>@<version>"                     (component bom-ref)
  //   "<root>|pkg:npm/<name>@<version>"              (dependency edge bom-ref)
  //   "<root>@<version>"                             (root component ref)
  // Strip the "<root>|" prefix if present, then parse the purl/bare name.
  let tail = ref.includes('|') ? ref.slice(ref.lastIndexOf('|') + 1) : ref;
  let name = tail;
  const purlPrefix = 'pkg:npm/';
  if (tail.startsWith(purlPrefix)) {
    const rest = tail.slice(purlPrefix.length);
    const at = rest.lastIndexOf('@');
    name = at > 0 ? rest.slice(0, at) : rest;
  } else {
    const at = tail.lastIndexOf('@');
    if (at > 0) name = tail.slice(0, at);
  }
  return name;
}

function isSoftRef(ref) {
  return isSoftPackage(refToName(ref));
}

/** Dependency graph with dev/platform-scoped refs filtered out, so the hard
 *  comparison is stable across OSes and install profiles. */
function filteredDependencies(bom) {
  return (bom.dependencies || [])
    .map((d) => {
      const ref = d.ref || '';
      if (isSoftRef(ref)) return null;
      const kept = (d.dependencies || []).map((x) => x.ref).filter((x) => !isSoftRef(x)).sort();
      return `${ref} -> ${kept.join(',')}`;
    })
    .filter(Boolean)
    .sort();
}

function main() {
  if (!fs.existsSync(COMMITTED)) fail('sbom.cdx.json missing — run npm run sbom:generate');
  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(COMMITTED, 'utf8'));
  } catch (err) {
    fail(`sbom.cdx.json is not valid JSON: ${err.message}`);
  }
  if (committed.bomFormat !== 'CycloneDX') fail('sbom.cdx.json is not a CycloneDX BOM');

  const fresh = regenerate();
  const a = semanticSnapshot(committed);
  const b = semanticSnapshot(fresh);

  const onlyCommitted = a.components.filter((c) => !b.components.includes(c));
  const onlyFresh = b.components.filter((c) => !a.components.includes(c));
  const depDiff =
    JSON.stringify(filteredDependencies(committed)) !== JSON.stringify(filteredDependencies(fresh));

  if (onlyCommitted.length || onlyFresh.length || depDiff) {
    const hard = [];
    const soft = [];
    for (const c of onlyCommitted) {
      (platformScopedInLockfile(c) ? soft : hard).push(`only in committed: ${c}`);
    }
    for (const c of onlyFresh) {
      (platformScopedInLockfile(c) ? soft : hard).push(`only in fresh: ${c}`);
    }
    if (depDiff) hard.push('dependency graph differs');
    if (soft.length) {
      console.warn(`[sbom-check] ${soft.length} platform-scoped package difference(s) (optional/os/cpu/dev entries; expected across OSes):`);
      for (const s of soft.slice(0, 30)) console.warn(`  ${s}`);
    }
    if (hard.length) {
      console.error(`[sbom-check] BOM is stale: committed ${a.components.length} components, fresh ${b.components.length}`);
      for (const h of hard.slice(0, 50)) console.error(`  ${h}`);
      console.error('  run `npm run sbom:generate` and commit the result');
      process.exit(1);
    }
  }
  console.log(`[sbom-check] OK: ${a.components.length} components in sync (CycloneDX ${committed.specVersion})`);
}

main();
