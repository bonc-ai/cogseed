/**
 * 版本迁移和数据清理
 *
 * 在应用启动时检测版本变化，自动清理旧版本的缓存数据，
 * 确保用户能够体验到完整的新版本功能（如 4 步引导）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WS_ROOT, userAgentsDir, SRC_ROOT } from '../paths';
import { createLogger } from '../logger';
import { setAgentEnabled } from './component_enabled';
import { getActiveUserId } from './users';

const log = createLogger('version-migration');

const VERSION_FILE = path.join(WS_ROOT, 'app-version.json');

// 从 package.json 读取当前版本
function getCurrentVersion(): string {
  try {
    const packageJsonPath = path.join(SRC_ROOT, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || '0.0.0';
  } catch (err) {
    log.warn('failed to read package.json version', { error: err instanceof Error ? err.message : String(err) });
    return '0.0.0';
  }
}

const CURRENT_VERSION = getCurrentVersion();

interface VersionInfo {
  version: string;
  installedAt: number;
  lastMigrationAt?: number;
}

interface MigrationResult {
  migrated: boolean;
  clearedOnboarding: boolean;
  clearedAgents: number;
  reason?: string;
}

/**
 * 读取上次安装的版本信息
 */
function readVersionInfo(): VersionInfo | null {
  try {
    if (!fs.existsSync(VERSION_FILE)) return null;
    const content = fs.readFileSync(VERSION_FILE, 'utf8');
    return JSON.parse(content) as VersionInfo;
  } catch (err) {
    log.warn('failed to read version info', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * 写入当前版本信息
 */
function writeVersionInfo(info: VersionInfo): void {
  try {
    fs.writeFileSync(VERSION_FILE, JSON.stringify(info, null, 2), 'utf8');
  } catch (err) {
    log.warn('failed to write version info', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 清理引导完成标记
 */
function clearOnboardingState(): boolean {
  try {
    const onboardingFile = path.join(WS_ROOT, 'onboarding-state.json');
    if (fs.existsSync(onboardingFile)) {
      fs.unlinkSync(onboardingFile);
      log.info('cleared onboarding state');
      return true;
    }
    return false;
  } catch (err) {
    log.warn('failed to clear onboarding state', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * 清理所有用户的 CLI Agent
 */
function clearCliAgents(): number {
  let clearedCount = 0;

  try {
    // 只清理当前活跃用户的 Agent
    const userId = getActiveUserId();
    if (!userId) {
      log.info('no active user, skip clearing CLI agents');
      return 0;
    }

    const agentsDir = userAgentsDir(userId);
    if (!fs.existsSync(agentsDir)) {
      log.info('agents directory does not exist', { userId });
      return 0;
    }

    const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory());

    for (const agentDir of agentDirs) {
      const agentJsonPath = path.join(agentsDir, agentDir.name, 'agent.json');
      if (!fs.existsSync(agentJsonPath)) continue;

      try {
        const agentJson = JSON.parse(fs.readFileSync(agentJsonPath, 'utf8'));
        const runtime = agentJson.runtime;

        // CLI 运行时（cli / p3394-gateway）在本版本不再可用：**停用而不是删除**。
        //
        // 2026-10-13 的事件：迁移用 fs.rmSync 整目录删除，用户界面上的智能体直接
        // 消失、也表现为"本地智能体没有回复"，且**不可恢复**。仓库规则明确要求
        // 「Never delete user data to make progress：sideline 或写 tombstone」。
        // 因此这里改为在 agent.json 上写停用标记（保持 JSON 合法、保留全部配置与
        // 自定义字段），让用户/支持可以据此重建或恢复，而不是丢掉数据。
        if (runtime && (runtime.kind === 'cli' || runtime.kind === 'p3394-gateway')) {
          const disabledAt = new Date().toISOString();
          const tombstoned = {
            ...agentJson,
            disabled_at: disabledAt,
            disabled_reason: 'cli-runtime-retired',
            disabled_runtime_kind: runtime.kind,
            ...(runtime.cli ? { disabled_runtime_cli: runtime.cli } : {}),
          };
          fs.writeFileSync(agentJsonPath, JSON.stringify(tombstoned, null, 2), 'utf8');
          // Also flip the component-level enabled flag: the agent lists derive
          // `enabled` from it (agents.ts reads readDisabledSets), so a tombstoned
          // agent is presented as disabled instead of looking usable and then
          // failing when the user picks it.
          try {
            setAgentEnabled(userId, agentDir.name, false);
          } catch (err) {
            log.warn('failed to disable tombstoned agent in component sets', {
              userId,
              agentId: agentDir.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          clearedCount++;
          log.info('disabled CLI agent (tombstoned, not deleted)', {
            userId,
            agentId: agentDir.name,
            name: agentJson.name,
            cli: runtime.cli,
            disabledAt,
          });
        }
      } catch (err) {
        log.warn('failed to process agent', {
          userId,
          agentId: agentDir.name,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } catch (err) {
    log.warn('failed to clear CLI agents', { error: err instanceof Error ? err.message : String(err) });
  }

  return clearedCount;
}

/**
 * 执行版本迁移
 *
 * 在应用启动时调用，检测版本变化并执行必要的数据清理
 */
export async function runVersionMigration(): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: false,
    clearedOnboarding: false,
    clearedAgents: 0,
  };

  try {
    const lastVersion = readVersionInfo();

    // 首次安装或版本信息丢失
    if (!lastVersion) {
      log.info('first install detected, no migration needed');
      writeVersionInfo({
        version: CURRENT_VERSION,
        installedAt: Date.now(),
      });
      return result;
    }

    // 版本未变化，跳过迁移
    if (lastVersion.version === CURRENT_VERSION) {
      log.info('same version, no migration needed', { version: CURRENT_VERSION });
      return result;
    }

    // 检测到版本变化，执行迁移
    log.info('version change detected, starting migration', {
      from: lastVersion.version,
      to: CURRENT_VERSION,
    });

    result.migrated = true;

    // 清理引导状态，让用户重新体验引导流程
    result.clearedOnboarding = clearOnboardingState();

    // 清理旧的 CLI Agent，让用户在引导中重新连接
    result.clearedAgents = clearCliAgents();

    // 更新版本信息
    writeVersionInfo({
      version: CURRENT_VERSION,
      installedAt: lastVersion.installedAt,
      lastMigrationAt: Date.now(),
    });

    log.info('migration completed', result);

  } catch (err) {
    log.error('migration failed', { error: err instanceof Error ? err.message : String(err) });
    result.reason = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * 强制清理所有数据（用于测试）
 */
export function forceCleanAll(): MigrationResult {
  const result: MigrationResult = {
    migrated: true,
    clearedOnboarding: clearOnboardingState(),
    clearedAgents: clearCliAgents(),
  };

  log.info('force clean completed', result);
  return result;
}
