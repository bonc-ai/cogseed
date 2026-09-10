import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_LINKS_SUPPORTED,
  DIRECTORY_LINK_TYPE,
  FILE_MODE_BITS_SUPPORTED,
  FILE_SYMLINKS_SUPPORTED,
} from './fs-capabilities';

describe('filesystem test capabilities', () => {
  it('reports native symlink support as booleans', () => {
    expect(typeof FILE_SYMLINKS_SUPPORTED).toBe('boolean');
    expect(typeof DIRECTORY_LINKS_SUPPORTED).toBe('boolean');
    expect(typeof FILE_MODE_BITS_SUPPORTED).toBe('boolean');
  });

  it('uses junctions for Windows directory-link fixtures', () => {
    expect(DIRECTORY_LINK_TYPE).toBe(process.platform === 'win32' ? 'junction' : 'dir');
  });
});
