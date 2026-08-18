import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(__dirname, '../../..');
const EXPENSE_FEATURE_ROOT = 'src/main/features/expense_workbench';
const EXPENSE_RENDERER_ROOTS = [
  'src/renderer/modules/expense-workbench.js',
] as const;
const COGNITION_MAIN_ROOTS = [
  'src/main/features/cognition',
  'src/main/features/cognition-memory-transaction.ts',
  'src/main/ipc/cognition.ts',
] as const;
const COGNITION_RENDERER_ROOTS = [
  'src/renderer/modules/cognition/cognition.js',
  'src/renderer/modules/cognition/pages.js',
] as const;

function repoPath(file: string): string {
  return path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
}

function codeFilesUnder(relativePath: string): string[] {
  const absolute = path.join(SOURCE_ROOT, relativePath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`boundary root must not be a symlink: ${relativePath}`);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) throw new Error(`boundary root is not a file or directory: ${relativePath}`);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(absolute, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`boundary source must not be a symlink: ${repoPath(child)}`);
    if (entry.isDirectory()) return codeFilesUnder(repoPath(child));
    return entry.isFile() && /\.(?:c|m)?[jt]s$/u.test(entry.name) ? [child] : [];
  }).sort();
}

function sourceFile(file: string, source = fs.readFileSync(file, 'utf8')): ts.SourceFile {
  const kind = /\.(?:c|m)?js$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function moduleSpecifiers(file: string, source?: string): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression
        && ts.isStringLiteralLike(node.moduleReference.expression)) {
      result.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])) {
      const directLoader = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      const requireResolve = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require'
        && node.expression.name.text === 'resolve';
      if (directLoader || requireResolve) result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(file, source));
  return result;
}

function localTarget(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return repoPath(path.resolve(path.dirname(importer), specifier))
    .replace(/\.(?:c|m)?[jt]s$/u, '');
}

function dependencyViolations(
  files: readonly string[],
  allowedExternal: ReadonlySet<string>,
  allowedLocal: (target: string) => boolean,
): string[] {
  return files.flatMap((file) => moduleSpecifiers(file).flatMap((specifier) => {
    const target = localTarget(file, specifier);
    const allowed = target === null ? allowedExternal.has(specifier) : allowedLocal(target);
    return allowed ? [] : [`${repoPath(file)} -> ${specifier}`];
  }));
}

function propertyName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function isWindowOrkas(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  return ts.isIdentifier(node.expression)
    && node.expression.text === 'window'
    && propertyName(node) === 'cogseed';
}

function rendererViolations(file: string, module: 'expense' | 'cognition'): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (module === 'expense' && isWindowOrkas(node)) {
      const parent = node.parent;
      const entersExpenseApi = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node
        && propertyName(parent) === 'expenseWorkbench';
      // The workbench also talks through the shared invoke channel, exactly
      // like the other renderer modules (agents, contexts, ...); the legacy
      // expenseWorkbench-only rule predates that pattern.
      const entersSharedInvoke = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node
        && propertyName(parent) === 'invoke';
      if (!entersExpenseApi && !entersSharedInvoke) violations.push(`${repoPath(file)}: window.cogseed outside expenseWorkbench`);
    }
    if (module === 'expense' && ts.isIdentifier(node)
        && new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']).has(node.text)) {
      violations.push(`${repoPath(file)}: forbidden renderer network primitive ${node.text}`);
    }
    if (module === 'cognition'
        && ((ts.isIdentifier(node) && node.text === 'expenseWorkbench')
          || ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
            && propertyName(node) === 'expenseWorkbench'))) {
      violations.push(`${repoPath(file)}: cognition renderer accesses expenseWorkbench`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(file));
  return [...new Set(violations)];
}

describe('cognition and expense static module boundary', () => {
  it('parses static, exported, dynamic, CommonJS, and TypeScript module loading', () => {
    const fixture = [
      "import value from './static';",
      "export { value } from './exported';",
      "import alias = require('./equals');",
      "void import('./dynamic');",
      "require('./commonjs');",
      "require.resolve('./resolved');",
    ].join('\n');
    expect(moduleSpecifiers('fixture.ts', fixture)).toEqual([
      './static',
      './exported',
      './equals',
      './dynamic',
      './commonjs',
      './resolved',
    ]);
  });

  it('keeps expense features on their narrow domain and infrastructure dependencies', () => {
    const files = codeFilesUnder(EXPENSE_FEATURE_ROOT);
    const allowedExternal = new Set([
      'node:crypto',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'zod',
      'async-mutex',
    ]);
    const exactLocal = new Set([
      'src/main/features/agent-dispatch-policy',
      'src/main/features/agents',
      'src/main/features/chat_attachments',
      'src/main/features/users',
      'src/main/i18n',
      'src/main/logger',
      'src/main/paths',
      'src/main/storage',
      'src/main/util/local-secret-store',
      'src/main/util/managed-stdio-process',
      'src/main/util/private-directory',
      'src/main/util/trusted-tar',
    ]);
    const violations = dependencyViolations(files, allowedExternal, (target) => (
      target === EXPENSE_FEATURE_ROOT
      || target.startsWith(`${EXPENSE_FEATURE_ROOT}/`)
      || exactLocal.has(target)
    ));
    expect(violations).toEqual([]);
  });

  it('keeps expense IPC limited to validation, security, and expense features', () => {
    const files = codeFilesUnder('src/main/ipc/expense_workbench.ts');
    const allowedExternal = new Set(['electron', 'node:crypto']);
    const exactLocal = new Set([
      'src/main/features/users',
      'src/main/i18n',
      'src/main/ipc/security',
      'src/main/logger',
    ]);
    const violations = dependencyViolations(files, allowedExternal, (target) => (
      target === EXPENSE_FEATURE_ROOT
      || target.startsWith(`${EXPENSE_FEATURE_ROOT}/`)
      || exactLocal.has(target)
    ));
    expect(violations).toEqual([]);
  });

  it('keeps reimbursement infrastructure independent from feature and model code', () => {
    const files = [
      ...codeFilesUnder('src/main/util/managed-stdio-process.ts'),
      ...codeFilesUnder('src/main/util/private-directory.ts'),
      ...codeFilesUnder('src/main/util/process-tree.ts'),
    ];
    const allowedExternal = new Set(['node:child_process', 'node:fs', 'node:path']);
    const violations = dependencyViolations(files, allowedExternal, (target) => (
      target === 'src/main/util/process-tree'
    ));
    expect(violations).toEqual([]);
  });

  it('rejects expense dependencies from cognition main-process code', () => {
    const violations = COGNITION_MAIN_ROOTS.flatMap(codeFilesUnder).flatMap((file) => (
      moduleSpecifiers(file).flatMap((specifier) => {
        const target = localTarget(file, specifier);
        const referencesExpense = (target !== null && (
          target === EXPENSE_FEATURE_ROOT
          || target.startsWith(`${EXPENSE_FEATURE_ROOT}/`)
          || target === 'src/main/ipc/expense_workbench'
        )) || specifier.includes('expense_workbench');
        return referencesExpense ? [`${repoPath(file)} -> ${specifier}`] : [];
      })
    ));
    expect(violations).toEqual([]);
  });

  it('keeps renderer code on each module-specific preload surface and off direct networking', () => {
    const expenseViolations = EXPENSE_RENDERER_ROOTS.flatMap(codeFilesUnder)
      .flatMap((file) => rendererViolations(file, 'expense'));
    const cognitionViolations = COGNITION_RENDERER_ROOTS.flatMap(codeFilesUnder)
      .flatMap((file) => rendererViolations(file, 'cognition'));
    expect([...expenseViolations, ...cognitionViolations]).toEqual([]);
  });
});
