// Real renderer/preload/registered IPC/facade/Commander bus. Only model transport
// is replayed from an explicitly supplied native-model acceptance report.
// No driver-authored messages, projections, injection or adoption receipts.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Module } = require('node:module');
const repo = path.resolve(__dirname, '../../..');
const sourceReport = process.env.COGSEED_COGNITION_BUS_REPLAY_REPORT;
if (!sourceReport) throw new Error('explicit recorded acceptance report required');
const recorded = JSON.parse(fs.readFileSync(sourceReport, 'utf8'));
if (recorded.environment !== 'native-model-tools-production-renderer-isolated-domain' || recorded.syntheticSeed !== true
  || !fs.realpathSync(recorded.dataRoot).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('invalid isolated native report');
const answer = recorded.modelRuns.find(row => row.stage === 'ordinary-answer');
const checker = recorded.modelRuns.find(row => row.stage.startsWith('output-check-'));
if (!answer?.response?.text || !checker?.response?.text) throw new Error('recording lacks actual ordinary answer/checker');
const originalCheckInput = JSON.parse(checker.request.message);
const uid = 'cognition-edit-live-user', cid = 'cognition-bus-replayed-next-turn';
const taskText = answer.request.message;
const assetId = originalCheckInput.assets[0].assetId;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-bus-replay-'));
// Preserve the complete canonical body/version/decision/source chain. Never
// read the normal account root or write into the original native checkpoint.
fs.cpSync(path.join(recorded.dataRoot, uid), path.join(temporary, uid), { recursive: true });
process.env.COGSEED_WORKSPACE_ROOT = temporary;
process.env.CORE_AGENT_AUTH_DIR = path.join(temporary, 'unused-auth');
delete process.env.COGSEED_KSTAR_HOST_ROUTING;
delete process.env.COGSEED_P3394_WAKE_GATE;
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
require('tsx/esm/api').register();
const load = file => require(path.join(repo, 'src/main', file));
const outcome = { coverage: 'production-renderer-preload-registered-ipc-facade-commander-bus-persistence-receipts-timeline; model-transport-replay',
  sourceReport, sourceDataRoot: recorded.dataRoot, dataRoot: temporary, reportFile: path.join(temporary, 'result.json'),
  modelCalls: 0, modelReplays: [], checkerReplays: [], streamRequests: [], backgroundStreamRequests: [], ipc: [], passed: [], failed: [],
  boundaries: ['Routing verdict is a controlled test input, not a new model-quality observation.',
    'The model client transport is replayed; native runner construction, provider execution and execution lifecycle are not exercised again.',
    'All bus-produced rows retain production labels inside this synthetic isolated store; these are integration evidence, not a new effectiveness proof.'] };
const persist = () => fs.writeFileSync(outcome.reportFile, JSON.stringify(outcome, null, 2));
const check = (name, ok, details) => { (ok ? outcome.passed : outcome.failed).push(ok ? name : { name, details }); persist(); };
const denied = [];
const denyNetwork = () => { denied.push('blocked'); throw new Error('Network forbidden during recorded bus replay'); };
globalThis.fetch = async () => denyNetwork();
for (const protocol of ['node:http', 'node:https']) { const client = require(protocol); client.request = denyNetwork; client.get = denyNetwork; }
function substitute(file, exports) {
  const resolved = require.resolve(path.join(repo, 'src/main', file));
  const entry = new Module(resolved, module); entry.filename = resolved; entry.loaded = true; entry.exports = exports;
  require.cache[resolved] = entry;
}
// The checker itself, exact-version/source checks, parser and ledger stay real.
substitute('features/recall/capture-model-routing.ts', { runRecallCaptureModel: async (_uid, input) => {
  if (outcome.checkerReplays.length) throw new Error('unexpected extra auxiliary model request');
  const actual = JSON.parse(input.message);
  if (actual.task !== originalCheckInput.task || actual.output !== originalCheckInput.output
    || JSON.stringify(actual.assets) !== JSON.stringify(originalCheckInput.assets)) {
    outcome.unexpectedCheckerInput = actual; persist(); throw new Error('checker replay input changed');
  }
  if (input.shouldContinue && !await input.shouldContinue()) throw new Error('checker snapshot no longer current');
  outcome.checkerReplays.push({ sessionId: input.sessionId, input: actual, rawResponse: checker.response.text }); persist();
  return { result: { text: checker.response.text, meta: checker.response.meta || {} }, chosen: checker.response.chosen };
} });
substitute('model/client.ts', {
  async *streamChatWithModel(opts) {
    if (outcome.modelReplays.length || opts.cid !== cid || opts.sourceMessageText !== taskText) throw new Error('unexpected model replay request');
    outcome.modelReplays.push({ sessionId: opts.sessionId, cid: opts.cid, turnId: opts.turnId,
      sourceMessageId: opts.sourceMessageId, sourceMessageFromUser: opts.sourceMessageFromUser,
      sourceMessageText: opts.sourceMessageText, systemPrompt: opts.systemPrompt,
      suppliedAbilityAssets: opts.suppliedAbilityAssets, rawResponse: answer.response.text }); persist();
    yield { type: 'final', text: answer.response.text };
    yield { type: 'done' };
  },
  chatWithModel: async () => { throw new Error('unexpected non-streaming model request'); },
  abortActiveSession: async () => {}, abortActiveSessionsForConversation: () => 0, hasActiveSession: () => false,
});
const bus = load('features/group_chat/bus.ts');
// Only the routing model's boolean verdict is controlled. Real host routing
// still creates the task/requirement and resolves automatic projections.
bus._setHostRoutingJudgeForTest(async () => ({ isTask: true, continuation: false }));
const allowed = new Set(['user.init', 'prefs.getOnboarding', 'prefs.getTourCompleted', 'config.getLanguage', 'config.getUiLanguage', 'log.record',
  'agents.list', 'spaces.list', 'conversations.titles', 'recall.timeline.forAsset', 'recall.assets.adoptionReceipts', 'recall.assets.list']);
let window, finishBoot;
const bootReady = new Promise(resolve => { finishBoot = resolve; });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'cogseed.invoke' ? async (event, request) => {
  if (request?.channel === 'log.record' && request.payload?.module === 'boot' && /^boot total/.test(request.payload.message)) finishBoot();
  if (!allowed.has(request?.channel)) return { ok: false, error: 'Unrelated boot channel unavailable in isolated bus fixture' };
  const result = await listener(event, request);
  outcome.ipc.push({ channel: request.channel, ok: result.ok });
  return result;
} : listener);
const originalOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => originalOn(channel, channel === 'cogseed.streamStart' ? (event, envelope) => {
  (envelope?.channel === 'conversations.sendStream' ? outcome.streamRequests : outcome.backgroundStreamRequests).push(envelope); persist();
  return listener(event, envelope);
} : listener);
load('ipc/index.ts').register();
ipcMain.handle = originalHandle; ipcMain.on = originalOn;
originalHandle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
originalHandle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
const tables = JSON.parse(fs.readFileSync(path.join(repo, 'src/renderer/locales/zh.json'), 'utf8'));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables: { zh: tables } }; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => window.webContents.executeJavaScript(code);
app.whenReady().then(async () => {
  try {
    load('i18n.ts').setCurrentLang('zh'); load('i18n.ts').setCurrentUiLang('zh');
    load('features/users.ts').activateUser(uid);
    load('features/onboarding_state.ts').setOnboardingCompleted(true);
    const chats = load('features/chats.ts');
    await chats.createConversation(uid, { conversationId: cid, kind: 'normal', title: '数据库索引技术说明：正常 bus 回放' });
    await chats.updateConversation(uid, cid, { title_manually_set: true });
    const before = await load('features/recall/asset-service.ts').readAbilityAsset(uid, assetId);
    check('checkpoint preserves the actually saved v3 body and all conditions', before.version === '3'
      && before.statement === originalCheckInput.assets[0].content
      && JSON.stringify(before.applicableWhen) === JSON.stringify(originalCheckInput.assets[0].applicableWhen)
      && JSON.stringify(before.forbiddenWhen) === JSON.stringify(originalCheckInput.assets[0].forbiddenWhen));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true,
      backgroundThrottling: false, preload: path.join(repo, 'src/main/preload.js') } });
    await window.loadFile(path.join(repo, 'src/renderer/index.html'));
    await Promise.race([bootReady, delay(15000).then(() => { throw new Error('renderer boot timed out'); })]);
    outcome.events = await js(`(async () => { const events=[]; const stream=window.cogseed.stream('conversations.sendStream',
      { cid:${JSON.stringify(cid)},content:${JSON.stringify(taskText)},submit_request_id:'req-cognition-bus-replay' }, event=>events.push(event));
      await stream.promise; return events; })()`);
    const { conversationMessageReadFile } = load('util/project-layout.ts');
    const messages = await load('storage.ts').readJsonl(conversationMessageReadFile(uid, cid), 1000);
    const user = messages.find(row => row.from === 'user' && row.text === taskText);
    const reply = messages.find(row => row.from === 'commander' && row.text === answer.response.text && row.turn_end === true);
    outcome.messages = messages;
    const call = outcome.modelReplays[0];
    check('actual production stream IPC accepted exactly one ordinary unpinned submission', outcome.streamRequests.length === 1
      && outcome.streamRequests[0].channel === 'conversations.sendStream'
      && !outcome.streamRequests[0].payload.references && !outcome.streamRequests[0].payload.use_selections);
    check('bus-owned visible user message is the exact model source', !!user && call?.sourceMessageId === user.id
      && call.sourceMessageFromUser === true && call.sourceMessageText === user.text);
    check('production bus persisted the unchanged recorded final answer', !!reply && reply.turn_id === call?.turnId);
    const citation = reply?.recall_citations?.find(row => row.asset_id === assetId);
    const automatic = (await load('features/recall/context-projection.ts').listContextProjections(uid))
      .find(row => row.taskRunId === call?.turnId && row.assetMatches?.some(match => match.assetId === assetId && match.matchMethod === 'standing_preference'));
    outcome.automaticProjection = automatic;
    check('automatic current qualification injects complete saved v3 without a pin', citation?.version === '3'
      && !!automatic && automatic.assetVersions[assetId] === '3' && call.systemPrompt.includes(before.statement)
      && before.applicableWhen.every(text => call.systemPrompt.includes(text)) && before.forbiddenWhen.every(text => call.systemPrompt.includes(text)));
    const requirementStore = load('features/kstar/requirement-store.ts');
    const taskState = await requirementStore.readConversationTaskState(uid, cid);
    const requirement = taskState?.currentRequirementId && await requirementStore.readKstarRequirement(uid, taskState.currentRequirementId);
    outcome.requirement = requirement;
    check('real host routing created a governed task from the actual user row', requirement?.goalText === taskText
      && !!requirement.projectionId && !!taskState.currentTaskId);
    if (!reply || !call) throw new Error('missing official bus reply or model request');
    const usage = (await load('features/recall/usage-service.ts').listRecallUsage(uid, assetId)).filter(row => row.taskRunId === call.turnId);
    const injections = await load('features/recall/injection-receipt.ts').listInjectionReceipts(uid, call.turnId);
    const adoption = await load('features/recall/asset-usage-receipt.ts').listAssetUsageReceipts(uid, call.turnId);
    outcome.receipts = { usage, injections, adoption };
    check('bus writes actual injected exposure, not a fabricated agent_read', usage.length === 1 && usage[0].outcome === 'injected'
      && usage[0].assetVersion === '3' && usage[0].messageId === reply.id);
    check('bus injection receipt binds the same turn, official reply and exact version', injections.some(row => row.assetId === assetId
      && row.assetVersion === '3' && row.messageId === reply.id && row.status === 'injected' && row.channel === 'projection'));
    check('real output checker sees the task once and persists independently checked adoption', outcome.checkerReplays.length === 1
      && outcome.checkerReplays[0].input.task === taskText && adoption.some(row => row.assetId === assetId && row.assetVersion === '3'
      && row.messageId === reply.id && row.status === 'applied' && row.observationMethod === 'model_assisted' && !!row.outputCheckReceiptId));
    outcome.readback = await js(`(async () => ({ timeline:await cogseed.invoke('recall.timeline.forAsset',{assetId:${JSON.stringify(assetId)}}),
      adoption:await cogseed.invoke('recall.assets.adoptionReceipts',{assetId:${JSON.stringify(assetId)}}) }))()`);
    check('renderer reads new bus usage through registered timeline IPC', outcome.readback.timeline.ok === true
      && outcome.readback.timeline.items.some(row => row.kind === 'usage_recorded' && row.refs?.taskRunId === call.turnId));
    check('renderer reads exact new adoption through registered receipt IPC', outcome.readback.adoption.ok === true
      && outcome.readback.adoption.receipts.some(row => row.taskRunId === call.turnId && row.assetVersion === '3'
        && row.evidence.some(ref => ref.kind === 'message' && ref.id === reply.id) && row.status === 'applied'));
    check('normal bus completes without leaving queued actors', bus.isQuiescent(uid, cid));
    check('no external model or network request was made', denied.length === 0);
  } catch (error) {
    outcome.failed.push({ name: error.message, stack: error.stack });
  } finally {
    outcome.deniedNetworkAttempts = denied.length;
    bus._setHostRoutingJudgeForTest(null);
    await bus.dropConv(uid, cid).catch(() => {});
    persist(); window?.destroy();
    process.stdout.write('@@COGNITION_BUS_REPLAY@@' + JSON.stringify(outcome) + '\n');
    app.exit(outcome.failed.length ? 1 : 0);
  }
});
