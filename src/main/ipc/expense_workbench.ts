import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';

import {
  callExpenseWorkbench,
  closeExpenseWorkbenchSessions,
  configureExpenseProject,
  getExpenseProjectStatus,
} from '../features/expense_workbench/adapter';
import { confirmAndSubmitExpenseWorkbench } from '../features/expense_workbench/submission';
import { assertCanonicalExpenseWorkbenchAgent } from '../features/expense_workbench/canonical-agent';
import {
  addAndBindExpenseMaterialsFromPaths,
  assertExpenseMaterialTarget,
} from '../features/expense_workbench/material-import';
import {
  isExpenseWorkbenchOperation,
  isExpenseWorkbenchExplicitExternalOperation,
  isExpenseWorkbenchExternalOperation,
  isExpenseWorkbenchExternalSideEffectOperation,
  isExpenseWorkbenchHostConfirmationOperation,
  isExpenseWorkbenchReviewOperation,
  isExpenseWorkbenchUnsupportedOperation,
  type ExpenseWorkbenchExternalOperation,
  type JsonObject,
  type JsonValue,
} from '../features/expense_workbench/contracts';
import { t } from '../i18n';

interface ExpenseContext {
  userId: string;
}

interface InvokePayload {
  agent_id?: JsonValue;
  operation?: JsonValue;
  payload?: JsonValue;
}

interface ConfirmAndSubmitPayload {
  agent_id?: JsonValue;
  application_id?: JsonValue;
  version?: JsonValue;
  payload_hash?: JsonValue;
}

interface ApproveApplicationPayload {
  agent_id?: JsonValue;
  application_id?: JsonValue;
  approval_role?: JsonValue;
  decision?: JsonValue;
  expected_artifact_hash?: JsonValue;
  comment?: JsonValue;
}

interface PickAndAddMaterialsPayload {
  agent_id?: JsonValue;
  application_id?: JsonValue;
}

interface PickAndConfigurePayload {
  agent_id?: JsonValue;
}

interface ExternalOperationNotice {
  targetKey: string;
  targetFallback: string;
  actionKey: string;
  actionFallback: string;
  consequenceKey: string;
  consequenceFallback: string;
}

const EXTERNAL_OPERATION_NOTICES: Record<ExpenseWorkbenchExternalOperation, ExternalOperationNotice> = {
  'applications.submitStatus': {
    targetKey: 'expense_workbench.external.target.feishu_oa', targetFallback: '飞书 / OA',
    actionKey: 'expense_workbench.external.submit_status.action', actionFallback: '查询当前报销申请的外部审批状态',
    consequenceKey: 'expense_workbench.external.submit_status.consequence', consequenceFallback: '查询结果可能更新本地状态，并触发飞书同步或状态通知。',
  },
  'applications.refreshStatus': {
    targetKey: 'expense_workbench.external.target.feishu_oa', targetFallback: '飞书 / OA',
    actionKey: 'expense_workbench.external.refresh_status.action', actionFallback: '刷新当前报销申请的外部审批状态',
    consequenceKey: 'expense_workbench.external.unavailable.consequence', consequenceFallback: '该兼容操作没有独立的安全界面入口。',
  },
  'applications.recoverSubmission': {
    targetKey: 'expense_workbench.external.target.oa', targetFallback: 'OA',
    actionKey: 'expense_workbench.external.recover.action', actionFallback: '查询并恢复一次结果不确定的已有提交意图',
    consequenceKey: 'expense_workbench.external.recover.consequence', consequenceFallback: '不会新建提交，但可能写入恢复结果并触发飞书同步。',
  },
  'applications.retryFeishu': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.retry_feishu.action', actionFallback: '重试发送当前报销申请的失败同步',
    consequenceKey: 'expense_workbench.external.retry_feishu.consequence', consequenceFallback: '会向飞书重新发送数据，但不会重复提交 OA 审批。',
  },
  'applications.retryFeishuNotifications': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.retry_feishu_notifications.action', actionFallback: '重试发送当前报销申请的失败通知',
    consequenceKey: 'expense_workbench.external.retry_feishu_notifications.consequence', consequenceFallback: '会向飞书重新发送通知，但不会重复提交 OA 审批或修改报销草稿。',
  },
  'settings.preflight': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.preflight.action', actionFallback: '检查租户身份、审批模板与连接权限',
    consequenceKey: 'expense_workbench.external.preflight.consequence', consequenceFallback: '会发起外部网络请求，但不会提交报销申请。',
  },
  'settings.test': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.test.action', actionFallback: '测试飞书连接',
    consequenceKey: 'expense_workbench.external.unavailable.consequence', consequenceFallback: '该兼容操作没有独立的安全界面入口。',
  },
};

function localized(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function requireAgentId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('invalid agent_id');
  return value.trim();
}

function requirePayload(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function requireApplicationId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('invalid application_id');
  return value;
}

function requireVersion(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('invalid application version');
  return value;
}

function requirePayloadHash(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('invalid payload hash');
  return value.toLowerCase();
}

function requireApprovalRole(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid approval role');
  }
  return value.trim();
}

function requireApprovalDecision(value: JsonValue | undefined): 'approve' | 'reject' {
  if (value !== 'approve' && value !== 'reject') throw new Error('invalid approval decision');
  return value;
}

function approvalConfirmationOptions(
  applicationId: string,
  approvalRole: string,
  decision: 'approve' | 'reject',
  artifactHash: string,
  secondConfirmation: boolean,
): MessageBoxOptions {
  const action = decision === 'approve'
    ? localized('expense_workbench.approval.approve_action', '批准')
    : localized('expense_workbench.approval.reject_action', '驳回');
  const replacements = { application: applicationId, role: approvalRole, action, hash: maskedPayloadHash(artifactHash) };
  return {
    type: secondConfirmation ? 'warning' : 'info',
    buttons: [
      localized('expense_workbench.approval.cancel', '取消'),
      localized(
        secondConfirmation ? 'expense_workbench.approval.confirm_again' : 'expense_workbench.approval.confirm',
        secondConfirmation ? '再次确认执行' : `确认${action}`,
      ),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: localized('expense_workbench.approval.title', '确认人员审批'),
    message: formatLocalized(
      'expense_workbench.approval.message',
      '将以“{role}”身份{action}申请 {application}？',
      replacements,
    ),
    detail: formatLocalized(
      'expense_workbench.approval.detail',
      '审批对象：{application}\n审批角色：{role}\n动作：{action}\n材料指纹：{hash}\n\n该操作会写入不可变人员审批记录；不代表付款或外部 OA 状态已完成。',
      replacements,
    ),
  };
}

async function requireApprovalConfirmation(
  applicationId: string,
  approvalRole: string,
  decision: 'approve' | 'reject',
  artifactHash: string,
): Promise<void> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') throw new Error('无法显示人员审批确认，操作已取消');
  const first = await dialog.showMessageBox(approvalConfirmationOptions(applicationId, approvalRole, decision, artifactHash, false));
  if (!first || first.response !== 1) throw new Error('用户已取消人员审批');
  const second = await dialog.showMessageBox(approvalConfirmationOptions(applicationId, approvalRole, decision, artifactHash, true));
  if (!second || second.response !== 1) throw new Error('用户已取消人员审批');
}

function formatLocalized(
  key: string,
  fallback: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let value = localized(key, fallback);
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{${name}}`, replacement);
  }
  return value;
}

function maskedPayloadHash(payloadHash: string): string {
  return `${payloadHash.slice(0, 12)}…${payloadHash.slice(-12)}`;
}

function submissionConfirmationOptions(
  applicationId: string,
  version: number,
  payloadHash: string,
): MessageBoxOptions {
  const target = localized('expense_workbench.submit_confirmation.target', 'Feishu / OA');
  const replacements = {
    target,
    application: applicationId,
    version: String(version),
    hash: maskedPayloadHash(payloadHash),
  };
  return {
    type: 'warning',
    buttons: [
      localized('expense_workbench.submit_confirmation.cancel', '取消'),
      localized('expense_workbench.submit_confirmation.confirm', '提交到飞书 / OA'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: localized('expense_workbench.submit_confirmation.title', '确认提交报销申请'),
    message: formatLocalized(
      'expense_workbench.submit_confirmation.message',
      '确认将这份报销申请提交到 {target}？',
      replacements,
    ),
    detail: formatLocalized(
      'expense_workbench.submit_confirmation.detail',
      '外部目标：{target}\n报销申请：{application}\n版本：v{version}\n负载指纹：{hash}\n\n外发影响：报销数据将离开本应用，并在飞书中新建或推进 OA 审批请求。\n人工审批：此操作不等于审批通过或付款，仍需人工审批人在飞书 / OA 中审核。',
      replacements,
    ),
  };
}

async function requireSubmissionConfirmation(
  applicationId: string,
  version: number,
  payloadHash: string,
): Promise<void> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.unavailable',
      '无法显示安全提交确认，本次未提交。',
    ));
  }

  let response: Awaited<ReturnType<typeof dialog.showMessageBox>>;
  try {
    response = await dialog.showMessageBox(submissionConfirmationOptions(applicationId, version, payloadHash));
  } catch (cause) {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.unavailable',
      '无法显示安全提交确认，本次未提交。',
    ), { cause });
  }

  if (!response || response.response !== 1) {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.cancelled',
      '用户已取消提交，未向飞书 / OA 发送数据。',
    ));
  }
}

function requireExternalPayload(
  operation: ExpenseWorkbenchExternalOperation,
  value: JsonValue | undefined,
): JsonObject {
  const payload = requirePayload(value);
  if (operation.startsWith('applications.')) {
    if (Object.keys(payload).some((key) => key !== 'application_id')) {
      throw new Error('external application operation accepts only application_id');
    }
    return { application_id: requireApplicationId(payload.application_id) };
  }
  if (Object.keys(payload).length !== 0) throw new Error('external settings operation payload must be empty');
  return {};
}

function confirmationOptions(
  operation: ExpenseWorkbenchExternalOperation,
  applicationId: string | undefined,
  secondConfirmation: boolean,
): MessageBoxOptions {
  const notice = EXTERNAL_OPERATION_NOTICES[operation];
  const target = localized(notice.targetKey, notice.targetFallback);
  const action = localized(notice.actionKey, notice.actionFallback);
  const consequence = localized(notice.consequenceKey, notice.consequenceFallback);
  const subject = applicationId ? `\n${localized('expense_workbench.external.application', '报销申请')}：${applicationId}` : '';
  return {
    type: secondConfirmation ? 'warning' : 'info',
    buttons: [
      localized('expense_workbench.external.cancel', '取消'),
      secondConfirmation
        ? localized('expense_workbench.external.confirm_again', '再次确认执行')
        : localized('expense_workbench.external.allow', '允许访问'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: secondConfirmation
      ? localized('expense_workbench.external.second_title', '外部操作二次确认')
      : localized('expense_workbench.external.title', '确认访问外部系统'),
    message: secondConfirmation
      ? localized('expense_workbench.external.message_again', '请再次确认：将访问 {target}').replace('{target}', target)
      : localized('expense_workbench.external.message', '将访问 {target}').replace('{target}', target),
    detail: localized('expense_workbench.external.detail', '操作：{action}{subject}\n影响：{consequence}')
      .replace('{action}', action)
      .replace('{subject}', subject)
      .replace('{consequence}', consequence),
  };
}

async function confirmExternalOperation(
  operation: ExpenseWorkbenchExternalOperation,
  payload: JsonObject,
): Promise<boolean> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new Error('无法显示外部访问确认，操作已取消');
  }
  const applicationId = typeof payload.application_id === 'string' ? payload.application_id : undefined;
  const first = await dialog.showMessageBox(confirmationOptions(operation, applicationId, false));
  if (first.response !== 1) return false;
  if (!isExpenseWorkbenchExternalSideEffectOperation(operation)) return true;
  const second = await dialog.showMessageBox(confirmationOptions(operation, applicationId, true));
  return second.response === 1;
}

export const invokeHandlers = {
  'expenseWorkbench.status': async (_payload: Record<string, never>, ctx: ExpenseContext) => {
    return getExpenseProjectStatus(ctx.userId);
  },

  'expenseWorkbench.pickAndConfigure': async (payload: PickAndConfigurePayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: localized('expense_workbench.project.pick_title', '选择报销智能体项目目录'),
      properties: ['openDirectory'],
    };
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { cancelled: true, ...getExpenseProjectStatus(ctx.userId) };
    }
    const status = await configureExpenseProject(ctx.userId, selected.filePaths[0], agentId);
    return { cancelled: false, ...status };
  },

  'expenseWorkbench.invoke': async (payload: InvokePayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    if (typeof payload?.operation !== 'string' || !isExpenseWorkbenchOperation(payload.operation)) {
      throw new Error('invalid expense workbench operation');
    }
    if (isExpenseWorkbenchHostConfirmationOperation(payload.operation)) {
      throw new Error('请使用人工确认后的显式提交入口');
    }
    if (isExpenseWorkbenchReviewOperation(payload.operation)) {
      throw new Error('人工复核决策需要独立的身份与确认入口');
    }
    if (isExpenseWorkbenchUnsupportedOperation(payload.operation)) {
      throw new Error('当前 Mate 工作台不允许修改报销连接配置');
    }
    if (isExpenseWorkbenchExternalOperation(payload.operation)) {
      throw new Error('外部系统操作必须使用显式确认入口');
    }
    if (payload.operation === 'materials.add' || payload.operation === 'materials.addAndBind') {
      throw new Error('报销材料必须通过主进程专用选择入口登记');
    }
    return callExpenseWorkbench(ctx.userId, agentId, payload.operation, requirePayload(payload?.payload));
  },

  'expenseWorkbench.approveApplication': async (payload: ApproveApplicationPayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    const applicationId = requireApplicationId(payload?.application_id);
    const approvalRole = requireApprovalRole(payload?.approval_role);
    const decision = requireApprovalDecision(payload?.decision);
    const expectedArtifactHash = requirePayloadHash(payload?.expected_artifact_hash);
    const comment = payload?.comment === undefined ? '' : payload.comment;
    if (typeof comment !== 'string' || comment.length > 1_000) throw new Error('invalid approval comment');
    await assertCanonicalExpenseWorkbenchAgent(agentId);
    await requireApprovalConfirmation(applicationId, approvalRole, decision, expectedArtifactHash);
    return callExpenseWorkbench(
      ctx.userId,
      agentId,
      'applications.approve',
      {
        application_id: applicationId,
        approval_role: approvalRole,
        decision,
        expected_artifact_hash: expectedArtifactHash,
        comment,
      },
    );
  },

  'expenseWorkbench.invokeExternal': async (payload: InvokePayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    if (typeof payload?.operation !== 'string' || !isExpenseWorkbenchOperation(payload.operation)
      || !isExpenseWorkbenchExternalOperation(payload.operation)) {
      throw new Error('invalid external expense workbench operation');
    }
    if (!isExpenseWorkbenchExplicitExternalOperation(payload.operation)) {
      throw new Error('该外部操作尚无安全界面入口，已拒绝执行');
    }
    const externalPayload = requireExternalPayload(payload.operation, payload.payload);
    if (!await confirmExternalOperation(payload.operation, externalPayload)) {
      throw new Error('用户已取消外系统操作');
    }
    return callExpenseWorkbench(ctx.userId, agentId, payload.operation, externalPayload);
  },

  'expenseWorkbench.pickAndAddMaterials': async (payload: PickAndAddMaterialsPayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    const applicationId = requireApplicationId(payload?.application_id);
    const target = await assertExpenseMaterialTarget(ctx.userId, agentId, applicationId);

    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: localized('expense_workbench.material.pick_title', '选择报销材料'),
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: localized('expense_workbench.material.filter_name', '报销材料'),
        extensions: ['pdf', 'png', 'jpg', 'jpeg', 'heic'],
      }],
    };
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths.length) {
      return { cancelled: true, materials: [], failed: [] };
    }
    const result = await addAndBindExpenseMaterialsFromPaths(
      ctx.userId,
      agentId,
      applicationId,
      selected.filePaths,
      target,
    );
    return { cancelled: false, ...result };
  },

  'expenseWorkbench.confirmAndSubmit': async (payload: ConfirmAndSubmitPayload, ctx: ExpenseContext) => {
    const agentId = requireAgentId(payload?.agent_id);
    const applicationId = requireApplicationId(payload?.application_id);
    const version = requireVersion(payload?.version);
    const payloadHash = requirePayloadHash(payload?.payload_hash);
    await requireSubmissionConfirmation(applicationId, version, payloadHash);
    return confirmAndSubmitExpenseWorkbench(ctx.userId, { agentId, applicationId, version, payloadHash });
  },

  'expenseWorkbench.close': async (_payload: Record<string, never>, ctx: ExpenseContext) => {
    await closeExpenseWorkbenchSessions(ctx.userId);
    return { closed: true };
  },
};
