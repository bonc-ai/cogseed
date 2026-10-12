/**
 * 贡献流程的检查组件版本快照。
 *
 * ## 为什么不直接用 `guardrailStatus()`
 *
 * `security/guardrail-status.ts` 已经把扫描器可用性、两个 pin 完整性、`skill-sentry`
 * 引擎与规则包版本、声明引擎版本组合好了，本模块**复用它**而不是再读一遍文件。
 *
 * 但它缺一样东西：**本体版本**。`declarationEngineVersion` 读的是
 * `skill-declaration-core/VERSION`（实测 `1.3.0`），那是**引擎**版本；引擎加载的
 * 本体是 `cogseed.security.skill@1.1.1`，两者不是一回事。跨端已确认口径：报告与上行
 * 都不得以其一冒充另一。所以这里补一个本体版本读取，并**只在贡献流程里用**——
 * 不去改 `guardrailStatus` 的既有形状，那是设置页的契约。
 *
 * ## 为什么本体版本从目录名读
 *
 * `ontologies/cogseed.security.skill/<version>/` 的目录名**就是**版本号，且
 * `version-policy.yaml` 的 `current` 与之一致。读目录名不需要解析 YAML，而解析
 * YAML 恰恰依赖 PyYAML——那正是 `rulesDegraded` 的成因来源。用不依赖解析器的方式
 * 读版本，避免「因为解析器坏了所以读不出版本，于是报不出降级」这种自指失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { packagedGuardrailDir } from '../../paths';
import { guardrailStatus, type GuardrailStatus } from '../security/guardrail-status';

const log = createLogger('contribution/components');

const ENGINE_DIR_NAME = 'skill-declaration-core';
const ONTOLOGY_ID = 'cogseed.security.skill';

/** 一个检查组件的可报告状态。`version` 读不到时为 `null`，**不得用别的版本号顶替**。 */
export interface ComponentSnapshot {
  name: 'ruleset' | 'skill-sentry' | 'declaration-core';
  version: string | null;
  /** 该组件是否处于可用且完整的状态。 */
  ready: boolean;
  /** 不可用/不完整的机器原因，供 UI 选文案。 */
  reason?: string;
}
export interface ContributionComponents {
  ruleset: ComponentSnapshot;
  sentry: ComponentSnapshot;
  declaration: ComponentSnapshot;
  /**
   * 声明引擎加载的**本体**版本（如 `1.1.1`）。
   *
   * 与 `declaration.version`（引擎 `1.3.0`）是两个独立版本号。跨端契约里
   * `components[].version` 填的是**引擎**版本；本体版本单独呈现，不挤进同一字段。
   */
  ontologyVersion: string | null;
  /** 底层快照，供诊断。 */
  guardrail: GuardrailStatus;
}

/**
 * 读出随仓本体的版本。
 *
 * 只认**恰好一个**版本目录：出现多个意味着随仓状态不确定（升级到一半、或两份快照
 * 并存），此时报 `null` 而不是挑一个——挑错会让报告显示一个引擎并未加载的版本。
 */
export function readOntologyVersion(): string | null {
  try {
    const root = path.join(packagedGuardrailDir(), ENGINE_DIR_NAME, 'ontologies', ONTOLOGY_ID);
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    if (dirs.length !== 1) {
      log.warn('ontology version ambiguous', { count: dirs.length });
      return null;
    }
    return dirs[0];
  } catch {
    return null;
  }
}

/**
 * 贡献流程开始前的组件快照。
 *
 * `ready` 的判据比设置页严：设置页只需展示状态，贡献流程要据此决定能不能往外发东西。
 * 因此 pin 不是 `verified` 一律判不可用——`tampered` / `unpinned` / `unreadable` 三种
 * 都意味着"这棵树不是发布时那棵"，由它产出的结论不能拿来担保一份要进公开目录的内容。
 */
export function contributionComponents(): ContributionComponents {
  const g = guardrailStatus();

  const sentryReady = g.scanner === 'present' && g.scannerIntegrity === 'verified';
  const declarationReady = g.declarationIntegrity === 'verified' && !!g.declarationEngineVersion;
  const ontologyVersion = readOntologyVersion();

  return {
    // 规则包随 skill-sentry 一起分发，完整性与可用性判据同源。
    ruleset: {
      name: 'ruleset',
      version: g.sentryRulesetVersion || null,
      ready: sentryReady,
      ...(sentryReady ? {} : { reason: g.scanner !== 'present' ? g.scanner : g.scannerIntegrity }),
    },
    sentry: {
      name: 'skill-sentry',
      version: g.sentryEngineVersion || null,
      ready: sentryReady,
      ...(sentryReady ? {} : { reason: g.scanner !== 'present' ? g.scanner : g.scannerIntegrity }),
    },
    declaration: {
      name: 'declaration-core',
      version: g.declarationEngineVersion || null,
      ready: declarationReady,
      ...(declarationReady ? {} : { reason: g.declarationIntegrity }),
    },
    ontologyVersion,
    guardrail: g,
  };
}

/**
 * 三组件是否都处于可报告且可信的状态。
 *
 * 贡献流程的前置：任一组件不 ready 就不该开始检查——开始了也只能得到一个
 * 不能采信的结论，而贡献者会把它读成"检查过了"。
 */
export function componentsReady(c: ContributionComponents): { ready: boolean; blocking: string[] } {
  const blocking: string[] = [];
  if (!c.sentry.ready) blocking.push(`skill-sentry:${c.sentry.reason || 'not_ready'}`);
  if (!c.declaration.ready) blocking.push(`declaration-core:${c.declaration.reason || 'not_ready'}`);
  if (!c.ontologyVersion) blocking.push('ontology:unreadable');
  return { ready: blocking.length === 0, blocking };
}
