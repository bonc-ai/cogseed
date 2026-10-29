import { describe, it, expect } from 'vitest';
import { buildFormalAssetPayload, instantiateAssetTemplate } from '../../../../src/main/features/recall/formal-assets/payload';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
const record = (type: string, statement: string, extra = {}) => ({ type, statement, ...extra } as RecallAbilityAssetRecord);
describe('正式资产分类型能力', () => {
 it('保留模板正文并识别唯一必填槽位，单次替换不递归执行输入', () => {
  const template = record('template', '# {{活动}}\n责任人：{{负责人}}\n再写一次{{活动}}');
  expect(buildFormalAssetPayload(template)).toMatchObject({ kind: 'template', slots: [{ name: '活动', required: true }, { name: '负责人', required: true }] });
  expect(instantiateAssetTemplate(template, { 活动: '虚构活动', 负责人: '{{保留原文}}' })).toBe('# 虚构活动\n责任人：{{保留原文}}\n再写一次虚构活动');
 });
 it.each([{}, { 活动: 'x', 负责人: '' }, { 活动: 'x', 负责人: 'y', unknown: 'z' }, ['x']])('缺失、空白、未知槽位或非对象拒绝', values => {
  expect(() => instantiateAssetTemplate(record('template', '{{活动}} {{负责人}}'), values)).toThrow();
 });
 it('继承原型不能冒充已填写值', () => {
  expect(() => instantiateAssetTemplate(record('template', '{{constructor}}'), {})).toThrow();
  expect(instantiateAssetTemplate(record('template', '{{constructor}}'), { constructor: '测试值' })).toBe('测试值');
 });
 it('没有槽位的旧模板仍能读取和实例化', () => {
  expect(instantiateAssetTemplate(record('template', '1. 准备\n2. 验收'), {})).toBe('1. 准备\n2. 验收');
 });
 it('规则边界缺失不冒充无限制；方法只抽取明确步骤', () => {
  expect(buildFormalAssetPayload(record('rule', '先核查再下结论'))).toMatchObject({ kind: 'rule', boundaryRecorded: false });
  expect(buildFormalAssetPayload(record('rule', '先核查', { applicableWhen: ['评审'], forbiddenWhen: ['缺证据'] }))).toMatchObject({ applicableWhen: ['评审'], forbiddenWhen: ['缺证据'], boundaryRecorded: true });
  expect(buildFormalAssetPayload(record('skill_method', '# 方法\n1. 读取输入\n2. 校验输出'))).toMatchObject({ kind: 'skill_method', steps: ['读取输入', '校验输出'] });
 });
});
