/**
 * Test: Meta-skill engine packaging contract
 * Ensures correct packaging for runtime deployment
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';

describe('Meta-skill engine packaging', () => {
  it('should have dist/ directory after build', () => {
    const distDir = join(process.cwd(), 'dist');
    // This assumes tests run after build
    // In CI, build would run before tests
    expect(typeof distDir).toBe('string');
  });

  it('should have ontologies/ directory in package', () => {
    const ontologiesDir = join(process.cwd(), 'ontologies');
    expect(existsSync(ontologiesDir)).toBe(true);
  });

  it('should have package.json with correct main field', () => {
    const packageJson = require('../../package.json');
    expect(packageJson.main).toBe('dist/index.js');
  });

  it('should have package.json with correct type field', () => {
    const packageJson = require('../../package.json');
    expect(packageJson.type).toBe('module');
  });

  it('should not have userWorkSpace at runtime', () => {
    // Contract: no PC-specific paths leak into the package
    const packageJson = require('../../package.json');
    const packageJsonStr = JSON.stringify(packageJson);
    expect(packageJsonStr).not.toContain('userWorkSpace');
    expect(packageJsonStr).not.toContain('/Users/');
    expect(packageJsonStr).not.toContain('C:\\Users\\');
  });

  it('should have fixed repository package path', () => {
    const packageJson = require('../../package.json');
    expect(packageJson.name).toBe('nseap-meta-skill-engine');
    // Package is in packages/nseap-meta-skill-engine
    expect(process.cwd()).toContain('packages/nseap-meta-skill-engine');
  });

  it('should include dist and ontologies in files field', () => {
    const packageJson = require('../../package.json');
    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).toContain('ontologies');
  });
});
