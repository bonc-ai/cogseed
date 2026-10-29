import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CONTENT_ROUTE_TABLE,
  HOME_DEFINITIONS,
  POOL_BY_HOME,
  UNCLASSIFIED,
} from '../../../../src/main/features/cognition_kernel/routing';

describe('cognition_kernel/routing — 归属契约（不含判定规则）', () => {
  it('每个家都有定义、判据与边界样例；标的唯一', () => {
    const homes = HOME_DEFINITIONS.map((entry) => entry.home);
    expect(new Set(homes).size).toBe(homes.length);
    for (const entry of HOME_DEFINITIONS) {
      expect(entry.label).toBeTruthy();
      expect(entry.definition.length).toBeGreaterThan(8);
      expect(entry.examples.length).toBeGreaterThan(0);
    }
    expect(homes).toHaveLength(7);
    expect(UNCLASSIFIED).toBe('unclassified');
  });

  it('每个家都映射到一个候选池，两池互斥的口径成立', () => {
    for (const entry of HOME_DEFINITIONS) {
      expect(['ontology', 'recall', 'experience', 'task_local']).toContain(POOL_BY_HOME[entry.home]);
    }
    expect(POOL_BY_HOME.cognition).toBe('recall');
    expect(POOL_BY_HOME.personal_fact).toBe('ontology');
    expect(POOL_BY_HOME.rule).toBe('recall');
    expect(POOL_BY_HOME.template).toBe('recall');
    expect(POOL_BY_HOME.method).toBe('recall');
  });

  it('路由表与家的定义一一对应（防两处漂移）', () => {
    expect(CONTENT_ROUTE_TABLE.map((row) => row.home).sort()).toEqual(
      HOME_DEFINITIONS.map((entry) => entry.home).sort(),
    );
    for (const row of CONTENT_ROUTE_TABLE) {
      expect(row.pool).toBe(POOL_BY_HOME[row.home]);
      expect(row.label).toBe(HOME_DEFINITIONS.find((entry) => entry.home === row.home)?.label);
    }
  });

  it('契约里不再有写死的判定规则（旧版遗留物必须消失）', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../src/main/features/cognition_kernel/routing.ts'),
      'utf8',
    );
    expect(source).not.toContain('HOME_BY_SUGGESTED_TYPE');
    expect(source).not.toContain('routeContentForm');
    expect(source).not.toContain('hasSteps');
  });
});
