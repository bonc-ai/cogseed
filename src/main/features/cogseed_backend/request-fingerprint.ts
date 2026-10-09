// SPDX-FileCopyrightText: 2025 AI Agent Board Contributors
// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';

/** Canonical JSON ordering adapted from AI Agent Board's orchestration snapshots. */
export function canonicalCogSeedRequestJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
        .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonicalize((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

export function cogSeedRequestFingerprint(kind: 'create' | 'retry' | 'resume', value: unknown): string {
  return createHash('sha256')
    .update(canonicalCogSeedRequestJson({ kind, request: value }))
    .digest('hex');
}
