import { describe, expect, it } from 'vitest';
import contract from '../../fixtures/expense-workbench/legacy-contract.json';
import {
  EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS,
  isExpenseWorkbenchExplicitExternalOperation,
  isExpenseWorkbenchExternalOperation,
  isExpenseWorkbenchExternalSideEffectOperation,
  isExpenseWorkbenchOperation,
} from '../../../src/main/features/expense_workbench/contracts';

const OPERATION_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

describe('expense workbench migration contract', () => {
  it('keeps the seven existing workbench sections', () => {
    expect(contract.sections).toEqual([
      'assistant',
      'applications',
      'precheck',
      'overview',
      'reviews',
      'connections',
      'audit',
    ]);
  });

  it('assigns every legacy action to a namespaced expenseWorkbench operation', () => {
    expect(contract.operations.length).toBeGreaterThan(20);
    for (const action of contract.operations) {
      expect(action.legacy).toMatch(/^(GET|POST|PUT|DELETE) \/.+/);
      expect(action.kind).toMatch(/^(read|write)$/);
      expect(action.operation).toMatch(OPERATION_PATTERN);
      expect(action.operation).not.toMatch(/^(new|answer|status|report|evidence)$/);
    }
  });

  it('does not reintroduce the removed legacy session command names', () => {
    const serialized = JSON.stringify(contract.operations).toLowerCase();
    for (const command of contract.forbidden_legacy_commands) {
      expect(serialized).not.toContain(`"operation":"${command}"`);
    }
  });

  it('has no duplicate migrated operations', () => {
    const operations = contract.operations.map(({ operation }) => operation);
    expect(new Set(operations).size).toBe(operations.length);
  });

  it('classifies every OA/Feishu call outside the generic operation tiers', () => {
    expect(EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS).toEqual([
      'applications.submitStatus',
      'applications.refreshStatus',
      'settings.preflight',
      'settings.test',
      'applications.recoverSubmission',
      'applications.retryFeishu',
    ]);
    for (const operation of EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS) {
      expect(isExpenseWorkbenchOperation(operation), operation).toBe(true);
      expect(isExpenseWorkbenchExternalOperation(operation), operation).toBe(true);
    }
  });

  it('requires extra confirmation for recovery/retry and fails closed without a safe UI', () => {
    expect(isExpenseWorkbenchExternalSideEffectOperation('applications.recoverSubmission')).toBe(true);
    expect(isExpenseWorkbenchExternalSideEffectOperation('applications.retryFeishu')).toBe(true);
    expect(isExpenseWorkbenchExternalSideEffectOperation('applications.submitStatus')).toBe(false);
    expect(isExpenseWorkbenchExplicitExternalOperation('applications.refreshStatus')).toBe(false);
    expect(isExpenseWorkbenchExplicitExternalOperation('settings.test')).toBe(false);
  });
});
