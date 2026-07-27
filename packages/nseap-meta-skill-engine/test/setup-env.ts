/**
 * Test setup for nseap-meta-skill-engine
 * Minimal environment setup for vitest
 */
import { vi } from 'vitest';

// Suppress expected console warnings during tests
vi.spyOn(console, 'warn').mockImplementation(() => {});
