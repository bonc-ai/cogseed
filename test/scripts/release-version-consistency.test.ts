import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const releaseVersion = '1.0.2';
const releaseDate = '2026-09-10';

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
}

function collectCogSeedVersions(value: unknown, versions = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/cogseed@([^|?"\s]+)/gi)) versions.add(match[1]);
    return versions;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCogSeedVersions(item, versions);
    return versions;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectCogSeedVersions(item, versions);
  }
  return versions;
}

describe('release version consistency', () => {
  it('keeps package, publiccode, SBOM, and changelog on 0.9.0', () => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const sbom = readJson('sbom.cdx.json');
    const publiccode = YAML.parse(readFileSync(resolve(repoRoot, 'publiccode.yml'), 'utf8'));
    const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8');

    expect(packageJson.version).toBe(releaseVersion);
    expect(packageLock.version).toBe(releaseVersion);
    expect(packageLock.packages[''].version).toBe(releaseVersion);
    expect(publiccode.softwareVersion).toBe(releaseVersion);
    expect(publiccode.releaseDate).toBe(releaseDate);
    expect(sbom.metadata.component.version).toBe(releaseVersion);
    expect(collectCogSeedVersions(sbom)).toEqual(new Set([releaseVersion]));
    expect(changelog).toContain(`## [${releaseVersion}] - ${releaseDate}`);
  });
});
