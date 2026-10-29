// 真机修复总结 F-02b：网关启停失败要给**可执行**原因。
//
// 真机现象：外接 WorkBuddy 启动失败时，Run Center「外接通道」只显示一句
// 「切换失败，请重试」——用户无法判断是 CLI 没装、桥没起还是内置脚本缺失，
// 只能靠翻日志。主进程回的是稳定错误码，这里把它映射成用户能照做的说法，
// 并把码附在未知错误后面便于排查。
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/modules/run-center-settings.js'), 'utf8');

function locale(lang: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8')) as Record<string, string>;
}

/** 从真实模块里抽出 gatewayErrorText，注入该语言的词典（缺键回落英文文案）。 */
function gatewayErrorText(lang: string): (error: unknown) => string {
  const fn = /function gatewayErrorText\(error\) \{[\s\S]*?\n  \}/.exec(source)?.[0];
  if (!fn) throw new Error('gatewayErrorText not found in run-center-settings.js');
  const dict = locale(lang);
  return vm.runInNewContext(`(${fn})`, { text: (key: string, fallback: string) => dict[key] || fallback }) as (error: unknown) => string;
}

const MAPPED = {
  p3394_cli_not_found: 'run_center.agent_gateway_error_cli_not_found',
  p3394_gateway_registration_timeout: 'run_center.agent_gateway_error_registration_timeout',
  p3394_bridge_unavailable: 'run_center.agent_gateway_error_bridge_unavailable',
  p3394_gateway_script_missing: 'run_center.agent_gateway_error_script_missing',
} as const;

describe('run-center gateway start failure text (F-02b)', () => {
  it('turns each stable failure code into its own actionable message', () => {
    for (const lang of ['en', 'zh']) {
      const translate = gatewayErrorText(lang);
      const dict = locale(lang);
      const generic = dict['run_center.agent_gateway_failed'];
      for (const [code, key] of Object.entries(MAPPED)) {
        const shown = translate(`${code}: workbuddy`);
        expect(shown, `${lang}/${code}`).toBe(dict[key]);
        // 不能退化成「切换失败」那一句——那正是真机上用户看到的信息。
        expect(shown, `${lang}/${code}`).not.toBe(generic);
      }
      // 四个原因互不相同：用户据此能区分 CLI 未装 / 未上线 / 桥未就绪 / 脚本缺失。
      const distinct = new Set(Object.keys(MAPPED).map((code) => translate(`${code}: workbuddy`)));
      expect(distinct.size).toBe(4);
    }
  });

  it('keeps the code visible for an unmapped failure', () => {
    const translate = gatewayErrorText('en');
    const generic = locale('en')['run_center.agent_gateway_failed'];
    expect(translate('p3394_some_future_failure: detail'))
      .toBe(`${generic} (p3394_some_future_failure)`);
  });

  it('does not decorate non-protocol errors', () => {
    const translate = gatewayErrorText('en');
    const generic = locale('en')['run_center.agent_gateway_failed'];
    expect(translate('gateway_action_failed')).toBe(generic);
    expect(translate(new Error('ipc exploded'))).toBe(generic);
    expect(translate(undefined)).toBe(generic);
  });

  it('ships every mapped key in the shipped locales', () => {
    for (const lang of ['en', 'zh']) {
      const dict = locale(lang);
      for (const key of Object.values(MAPPED)) {
        expect(typeof dict[key], `${lang}:${key}`).toBe('string');
        expect(dict[key].length, `${lang}:${key}`).toBeGreaterThan(8);
      }
    }
  });
});
