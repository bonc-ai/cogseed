#!/usr/bin/env node

/**
 * Pre-commit hook: 检查即将提交的代码中是否包含敏感信息
 *
 * 检测内容:
 * - 手机号(中国大陆 11 位)
 * - 身份证号(18 位)
 * - 邮箱地址(非公司域名、非通用域名)
 * - API Key / Token 常见模式
 * - 内网 IP 地址
 * - 常见密码字段(明文)
 */

const { execSync } = require('child_process');
const fs = require('fs');

// 敏感信息正则模式
const PATTERNS = [
  {
    name: '手机号',
    regex: /1[3-9]\d{9}/g,
    // 排除常见的测试/示例号码
    exclude: /1[38]0\d{8}|13800138000/
  },
  {
    name: '身份证号',
    regex: /\b\d{17}[\dXx]\b/g
  },
  {
    name: '疑似 API Key',
    regex: /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)[\s:=]["']?([a-zA-Z0-9_\-]{20,})/gi
  },
  {
    name: '疑似密码明文',
    regex: /(?:password|passwd|pwd)[\s:=]["']?([^\s"',;]{6,})/gi,
    // 排除变量名、占位符
    exclude: /password|passwd|pwd|123456|your[-_]password|placeholder/i
  },
  {
    name: '内网 IP',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g
  },
  {
    name: '个人邮箱',
    regex: /\b[a-zA-Z0-9._%+-]+@(?!example\.com|test\.com|localhost|bonc\.com\.cn)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g
  }
];

// 获取即将提交的文件列表
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    console.error('❌ 无法获取暂存文件列表:', err.message);
    process.exit(1);
  }
}

// 获取文件的暂存内容
function getStagedContent(file) {
  try {
    return execSync(`git show :${file}`, { encoding: 'utf-8' });
  } catch (err) {
    // 文件可能是二进制或被删除,跳过
    return null;
  }
}

// 检查单个文件
function checkFile(file, content) {
  const findings = [];
  const lines = content.split('\n');

  PATTERNS.forEach(({ name, regex, exclude }) => {
    lines.forEach((line, index) => {
      const matches = line.matchAll(regex);
      for (const match of matches) {
        // 如果有排除规则,检查是否匹配
        if (exclude && exclude.test(match[0])) {
          continue;
        }
        findings.push({
          file,
          line: index + 1,
          type: name,
          snippet: line.trim().substring(0, 80)
        });
      }
    });
  });

  return findings;
}

// 主流程
function main() {
  console.log('🔍 正在检查敏感信息...\n');

  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    console.log('✅ 没有文件需要检查');
    process.exit(0);
  }

  const allFindings = [];

  stagedFiles.forEach(file => {
    // 跳过二进制文件、依赖目录、构建产物、依赖锁文件
    if (
      file.match(/\.(png|jpg|jpeg|gif|ico|pdf|dmg|zip|tar|gz)$/i) ||
      file.startsWith('node_modules/') ||
      file.startsWith('dist/') ||
      file.startsWith('.git/') ||
      file === 'package-lock.json' ||
      file === 'pnpm-lock.yaml' ||
      file === 'yarn.lock'
    ) {
      return;
    }

    const content = getStagedContent(file);
    if (!content) return;

    const findings = checkFile(file, content);
    allFindings.push(...findings);
  });

  if (allFindings.length > 0) {
    console.error('❌ 发现疑似敏感信息:\n');
    allFindings.forEach(({ file, line, type, snippet }) => {
      console.error(`  ${file}:${line}`);
      console.error(`    类型: ${type}`);
      console.error(`    内容: ${snippet}`);
      console.error('');
    });
    console.error('⚠️  请移除敏感信息后重新提交');
    console.error('💡 如果这是误报,可以用 git commit --no-verify 跳过检查(不推荐)\n');
    process.exit(1);
  }

  console.log('✅ 未发现敏感信息,可以安全提交\n');
  process.exit(0);
}

main();
