// ─── Command Intent Extraction ─────────────────────────────────────────────
//
// Extracts human-readable intent from raw shell commands. This allows us to
// show users "what" and "why" instead of raw bash/curl/python syntax.
//
// Used by execution_log.ts to populate the `intent` and `why` fields when
// creating ExecutionRecord instances.

import type { RiskLevel } from './execution_log';

export interface CommandIntent {
  intent: string;      // "正在安装依赖包"
  why: string;         // "项目需要 3 个 npm 包才能运行"
  resources: string[]; // ["/path/to/package.json"]
  risk: RiskLevel;     // 'low' | 'medium' | 'high'
}

/**
 * Extract intent from a raw command string.
 */
export function extractIntent(rawCommand: string): CommandIntent {
  const cmd = rawCommand.trim();

  // npm/pnpm install
  if (/npm\s+install|pnpm\s+install|yarn\s+install/.test(cmd)) {
    return {
      intent: '正在安装依赖包',
      why: '项目需要安装 npm 依赖才能运行',
      resources: extractPaths(cmd, ['package.json', 'node_modules']),
      risk: 'low',
    };
  }

  // npm test / pnpm test
  if (/npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test/.test(cmd)) {
    return {
      intent: '正在运行测试',
      why: '验证代码是否正常工作',
      resources: extractPaths(cmd, ['test', 'src']),
      risk: 'low',
    };
  }

  // git commands
  if (/git\s+clone/.test(cmd)) {
    return {
      intent: '正在克隆代码仓库',
      why: '下载远程代码到本地',
      resources: extractPaths(cmd, []),
      risk: 'medium', // Network access
    };
  }

  if (/git\s+push/.test(cmd)) {
    return {
      intent: '正在推送代码到远程仓库',
      why: '将本地提交上传到 Git 服务器',
      resources: extractPaths(cmd, ['.git']),
      risk: 'medium', // Network + credentials
    };
  }

  if (/git\s+pull/.test(cmd)) {
    return {
      intent: '正在拉取远程代码',
      why: '同步最新的远程提交',
      resources: extractPaths(cmd, ['.git']),
      risk: 'low',
    };
  }

  // File operations
  if (/\brm\s+/.test(cmd)) {
    return {
      intent: '正在删除文件',
      why: '清理不需要的文件或目录',
      resources: extractPaths(cmd, []),
      risk: isSensitivePath(cmd) ? 'high' : 'medium',
    };
  }

  if (/\bcp\s+|mv\s+/.test(cmd)) {
    return {
      intent: '正在复制/移动文件',
      why: '重新组织文件位置',
      resources: extractPaths(cmd, []),
      risk: 'low',
    };
  }

  // curl/wget (network)
  if (/curl\s+|wget\s+/.test(cmd)) {
    return {
      intent: '正在下载文件',
      why: '从网络获取所需资源',
      resources: extractPaths(cmd, []),
      risk: 'medium', // Network access
    };
  }

  // python/node scripts
  if (/python[0-9.]*\s+|node\s+/.test(cmd)) {
    return {
      intent: '正在运行脚本',
      why: '执行自定义代码逻辑',
      resources: extractPaths(cmd, []),
      risk: 'medium', // Arbitrary code execution
    };
  }

  // Cargo (Rust)
  if (/cargo\s+build|cargo\s+run/.test(cmd)) {
    return {
      intent: '正在编译 Rust 项目',
      why: '构建可执行文件',
      resources: extractPaths(cmd, ['Cargo.toml', 'target']),
      risk: 'low',
    };
  }

  if (/cargo\s+test/.test(cmd)) {
    return {
      intent: '正在运行 Rust 测试',
      why: '验证代码是否正常工作',
      resources: extractPaths(cmd, ['tests', 'src']),
      risk: 'low',
    };
  }

  // TypeScript compilation
  if (/tsc\s+|npx\s+tsc/.test(cmd)) {
    return {
      intent: '正在编译 TypeScript',
      why: '将 TypeScript 代码转换为 JavaScript',
      resources: extractPaths(cmd, ['tsconfig.json', 'src']),
      risk: 'low',
    };
  }

  // Default fallback
  return {
    intent: '正在执行命令',
    why: '执行自定义操作',
    resources: extractPaths(cmd, []),
    risk: determineRiskLevel(cmd),
  };
}

/**
 * Extract file paths from command string.
 */
function extractPaths(cmd: string, fallbackHints: string[]): string[] {
  const paths: string[] = [];

  // Try to extract absolute paths
  const absolutePattern = /\/[\w\-./]+/g;
  const matches = cmd.match(absolutePattern);
  if (matches) {
    paths.push(...matches);
  }

  // If no paths found, use fallback hints
  if (paths.length === 0 && fallbackHints.length > 0) {
    paths.push(...fallbackHints);
  }

  return [...new Set(paths)]; // Deduplicate
}

/**
 * Check if command involves sensitive paths.
 */
function isSensitivePath(cmd: string): boolean {
  const sensitivePaths = ['/.ssh', '/.aws', '/.config', '/etc/', '/var/', '/usr/'];
  return sensitivePaths.some((p) => cmd.includes(p));
}

/**
 * Determine risk level based on command characteristics.
 */
function determineRiskLevel(cmd: string): RiskLevel {
  // High risk: sudo, rm -rf, sensitive paths, remote execution
  if (/sudo|rm\s+-rf|ssh\s+.*@/.test(cmd) || isSensitivePath(cmd)) {
    return 'high';
  }

  // Medium risk: network operations, arbitrary scripts
  if (/curl|wget|python|node|npm\s+install/.test(cmd)) {
    return 'medium';
  }

  // Low risk: read-only operations, simple file manipulation
  return 'low';
}
