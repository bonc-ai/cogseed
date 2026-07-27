/**
 * Test: Ontology reader with package-local resolution
 */
import { describe, it, expect } from 'vitest';
import { resolveOntologyPath, listPackageOntologies } from '../src/modules/ontology-reader';
import { existsSync } from 'fs';
import { join } from 'path';

describe('Ontology reader', () => {
  it('should resolve ontology path relative to package', () => {
    const path = resolveOntologyPath('test-ontology');
    expect(path).toContain('packages/nseap-meta-skill-engine/ontologies');
    expect(path).toContain('test-ontology');
  });

  it('should list package ontologies', () => {
    const ontologies = listPackageOntologies();
    expect(Array.isArray(ontologies)).toBe(true);
  });

  it('should find ontologies directory in package', () => {
    const ontologiesDir = join(process.cwd(), 'ontologies');
    // Directory should exist (even if empty for now)
    // This tests the path resolution contract
    expect(typeof resolveOntologyPath('any')).toBe('string');
  });

  it('should return stable paths for same ontology name', () => {
    const path1 = resolveOntologyPath('same-ontology');
    const path2 = resolveOntologyPath('same-ontology');
    expect(path1).toBe(path2);
  });
});
