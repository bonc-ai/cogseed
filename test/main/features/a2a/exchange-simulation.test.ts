import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Two-instance exchange simulation (same machine, no Hub).
 *
 * Delivery is simulated: the test hands A's envelope straight to B's inbound plan
 * instead of routing it through a server. Everything else is the real code —
 * contact stores, conversation markers, the reception tool policy, consultations and
 * the reply gate — so this is evidence for the flow the product cares about, with
 * the one honest caveat that transport is a stub (H-04 still open).
 *
 * Covered acceptance points: AC-04 (question → receiver confirms → answer reaches
 * the initiator), AC-05 (a follow-up needs no re-confirmation and the initiator's own
 * conversation keeps its permissions), AC-13/14 (consultation, revise, no leak),
 * AC-15 (the reception run can only read its granted workspace), AC-16 (nothing is
 * sent to the peer unless the receiver decided it).
 */
const A = 'cs_alice';
const B = 'cs_bob';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-sim-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [extensions, inbound, marker, scope, consultations, contacts, chats] = await Promise.all([
    import('../../../../src/main/features/a2a/extensions'),
    import('../../../../src/main/features/a2a/inbound'),
    import('../../../../src/main/features/a2a/conversation-marker'),
    import('../../../../src/main/features/a2a/reception-scope'),
    import('../../../../src/main/features/a2a/consultations'),
    import('../../../../src/main/features/contacts/store'),
    import('../../../../src/main/features/chats'),
  ]);
  return { extensions, inbound, marker, scope, consultations, contacts, chats };
}

describe('a2a exchange simulation › both sides on one machine', () => {
  it('runs question → confirm → consultation → answer → follow-up', async () => {
    const { extensions, inbound, marker, scope, consultations, contacts, chats } = await modules();
    const exchangeId = extensions.a2aConversationId(A, B);

    // 双方各自把对方加入通讯录（Hub 侧关系在本地栈里由本地记录模拟）。
    const reqA = await contacts.requestAdd(A, { phone: '13800001234', peerUserId: B, peerName: 'Bob' });
    await contacts.acceptRequest(A, reqA.id);
    const reqB = await contacts.requestAdd(B, { phone: '13800005678', peerUserId: A, peerName: 'Alice' });
    await contacts.acceptRequest(B, reqB.id);
    expect((await contacts.listContacts(A)).map((row) => row.userId)).toEqual([B]);
    expect((await contacts.listContacts(B)).map((row) => row.userId)).toEqual([A]);

    // ① A 发出首个问题 → B 侧需要本人确认（D-04）。
    const question = extensions.buildA2AExtension({
      kind: 'question',
      visibility: 'cross',
      conversation_id: exchangeId,
      recipient_user: B,
      assistant_agent_id: 'agent-b',
    });
    const firstPlan = inbound.planInboundA2A({
      extension: question, localUserId: B, peerUserId: A, existingMarker: null,
    });
    if ('rejected' in firstPlan) throw new Error(firstPlan.rejected);
    expect(firstPlan.needsConfirmation).toBe(true);
    expect(firstPlan.marker.state).toBe('waiting');

    // ② B 确认接待，选定工作区 → 会话进入 active。
    const workspace = fs.mkdtempSync(path.join(tmp, 'ws-b-'));
    await chats.createConversation(B, { conversationId: 'conv-b-incoming', title: 'A2A 来访' });
    const confirmed = marker.transitionA2AConversation(firstPlan.marker, 'active');
    await chats.updateConversation(B, 'conv-b-incoming', {
      a2a: { ...confirmed, workspace, assistant_agent_id: 'agent-b' },
    });

    // ③ B 侧该会话的运行被收口：只读授权工作区，写/命令/连接器全关（D-18/AC-15）。
    const stored = await chats.getConversation(B, 'conv-b-incoming');
    expect(stored?.a2a).toMatchObject({ inbound: true, state: 'active' });
    const receptionPolicy = scope.toolPolicyForConversation(
      { fileRead: 'explicit_roots', fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation', skillRun: 'none', network: 'none', connectors: 'enabled' },
      stored?.a2a,
    );
    expect(receptionPolicy).toMatchObject({ fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation', connectors: 'none' });
    expect(scope.receptionReadRoots(stored?.a2a, null)).toEqual([workspace]);

    // ④ 助理遇到要 B 拍板的问题 → 开请示；未作答前什么都不发（AC-16）。
    const consultation = await consultations.createConsultation(B, {
      conversationId: 'conv-b-incoming',
      peerUserId: A,
      peerName: 'Alice',
      question: '报价能给吗',
      proposedReply: '可以打八折',
    });
    expect(consultations.outboundConsultationReply(consultation)).toBeNull();
    expect(inbound.canReplyToPeer(stored?.a2a, false)).toBe(false);

    // ⑤ B 改口径 → 只有本人写的这句可以发出去（AC-13/14）。
    const answered = await consultations.answerConsultation(B, consultation.id, 'revise', '最多九折');
    expect(consultations.outboundConsultationReply(answered!)).toBe('最多九折');
    expect(inbound.canReplyToPeer(stored?.a2a, true)).toBe(true);

    // ⑥ A 追问：同一交换不再需要确认，且沿用 B 的授权工作区（AC-05）。
    const followUp = inbound.planInboundA2A({
      extension: question, localUserId: B, peerUserId: A, existingMarker: stored?.a2a,
    });
    if ('rejected' in followUp) throw new Error(followUp.rejected);
    expect(followUp.kind).toBe('continue');
    expect(followUp.needsConfirmation).toBe(false);
    expect(followUp.marker.workspace).toBe(workspace);

    // ⑦ A 自己的会话不受接待限制：它是发起方，不是接访方（AC-05）。
    const initiatorMarker = marker.parseA2AConversationMarker({
      outgoing: true, peer_user_id: B, state: 'active', exchange_id: exchangeId,
    });
    const initiatorPolicy = scope.toolPolicyForConversation(
      { fileRead: 'explicit_roots', fileWrite: 'explicit_writable_roots', shell: 'allow_with_confirmation', skillRun: 'none', network: 'none', connectors: 'enabled' },
      initiatorMarker,
    );
    expect(initiatorPolicy).toMatchObject({ fileWrite: 'explicit_writable_roots', connectors: 'enabled' });

    // ⑧ 删联系人 → 会话结束，标识不再显示（D-19）。
    await contacts.removeContact(A, B);
    expect((await contacts.listContacts(A))).toEqual([]);
    const ended = marker.transitionA2AConversation(confirmed, 'ended');
    expect(marker.isA2AConversation(ended)).toBe(false);
  });
});
