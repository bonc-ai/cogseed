/**
 * A2A compose guards — what must not be sent from the composer (FR-19/FR-20).
 *
 * Two mistakes are cheap to make and expensive to explain to the peer, so they are
 * refused before send rather than filtered in transport:
 *
 * - a contact mention with an attachment: the exchange carries text only (D-14), and
 *   silently dropping the attachment would send a message that answers a question the
 *   peer never saw;
 * - a contact mention together with a local CogSeed agent mention: the same message
 *   would be addressed to two different recipients (D-15), and "who answers this" has
 *   no defensible answer.
 *
 * Pure by design: the caller keeps the draft, shows the message, and only stops the
 * send.
 */
(function () {
  'use strict';

  const REASONS = ['attachments', 'mixed_recipients'];

  const FALLBACK = {
    attachments: 'A2A 对话暂不支持附件',
    mixed_recipients: '发给对方的消息不能同时发给本方 Agent',
  };

  /**
   * @param {{ contactMentions?: number, agentMentions?: number, attachments?: number }} input
   * @returns {{ blocked: boolean, reason?: string, message?: string }}
   */
  function checkCompose(input) {
    const value = input || {};
    const contacts = Number(value.contactMentions || 0);
    const agents = Number(value.agentMentions || 0);
    const attachments = Number(value.attachments || 0);

    if (contacts <= 0) return { blocked: false };
    if (attachments > 0) {
      return { blocked: true, reason: 'attachments', message: FALLBACK.attachments };
    }
    if (agents > 0) {
      return { blocked: true, reason: 'mixed_recipients', message: FALLBACK.mixed_recipients };
    }
    return { blocked: false };
  }

  /**
   * How many of the mentioned ids belong to contacts. Mention ids are agent ids and
   * contact account ids in one list, so the caller passes both sets and gets the
   * intersection size — no name matching, no guessing from text.
   */
  function countContactMentions(mentionIds, contactIds) {
    const mentions = Array.isArray(mentionIds) ? mentionIds : [];
    const contacts = new Set((Array.isArray(contactIds) ? contactIds : []).map((id) => String(id)));
    let count = 0;
    for (const id of mentions) {
      if (contacts.has(String(id))) count += 1;
    }
    return count;
  }

  function questionRoute({ contactUserId, threadConversationId, requestId }) {
    const contact = String(contactUserId || '');
    const cid = String(threadConversationId || '');
    if (cid) {
      return {
        contactUserId: contact,
        mode: 'continue',
        conversationId: cid,
        requestId: String(requestId || ''),
      };
    }
    return { contactUserId: contact, mode: 'new', requestId: String(requestId || '') };
  }

  function createQuestionSendState(options = {}) {
    const configuredMax = Number(options.maxPreparedPerComposer);
    const maxPreparedPerComposer = Number.isInteger(configuredMax) && configuredMax > 0
      ? configuredMax
      : 16;
    const configuredGlobalMax = Number(options.maxPreparedRecords);
    const maxPreparedRecords = Number.isInteger(configuredGlobalMax) && configuredGlobalMax > 0
      ? configuredGlobalMax
      : 64;
    const prepared = new Map();
    const sending = new Map();
    let order = 0;

    function keys(identity) {
      const value = identity || {};
      return {
        target: String(value.target || ''),
        cid: String(value.cid || ''),
        contact: String(value.contactUserId || ''),
        text: String(value.text || ''),
      };
    }

    function leaf(root, identity, create) {
      const key = keys(identity);
      let byCid = root.get(key.target);
      if (!byCid && create) { byCid = new Map(); root.set(key.target, byCid); }
      let byContact = byCid && byCid.get(key.cid);
      if (!byContact && create) { byContact = new Map(); byCid.set(key.cid, byContact); }
      let byText = byContact && byContact.get(key.contact);
      if (!byText && create) { byText = new Map(); byContact.set(key.contact, byText); }
      return { key, byCid, byContact, byText };
    }

    function get(root, identity) {
      const path = leaf(root, identity, false);
      return path.byText ? path.byText.get(path.key.text) : undefined;
    }

    function set(root, identity, value) {
      const path = leaf(root, identity, true);
      path.byText.set(path.key.text, value);
      return value;
    }

    function remove(root, identity, expected) {
      const path = leaf(root, identity, false);
      if (!path.byText) return false;
      const current = path.byText.get(path.key.text);
      if (!current || (expected !== undefined && current !== expected)) return false;
      path.byText.delete(path.key.text);
      if (!path.byText.size) path.byContact.delete(path.key.contact);
      if (!path.byContact.size) path.byCid.delete(path.key.cid);
      if (!path.byCid.size) root.delete(path.key.target);
      return true;
    }

    function recordsForComposer(identity) {
      const key = keys(identity);
      const byCid = prepared.get(key.target);
      const byContact = byCid && byCid.get(key.cid);
      const records = [];
      if (!byContact) return records;
      for (const [contact, byText] of byContact.entries()) {
        for (const [text, record] of byText.entries()) {
          records.push({ identity: { ...key, contactUserId: contact, text }, record });
        }
      }
      return records;
    }

    function allPreparedRecords() {
      const records = [];
      for (const [target, byCid] of prepared.entries()) {
        for (const [cid, byContact] of byCid.entries()) {
          for (const [contactUserId, byText] of byContact.entries()) {
            for (const [text, record] of byText.entries()) {
              records.push({ identity: { target, cid, contactUserId, text }, record });
            }
          }
        }
      }
      return records;
    }

    function trimSettled(records, limit) {
      const settled = records.filter((item) => !item.record.preparing && !get(sending, item.identity));
      let excess = settled.length - limit;
      if (excess <= 0) return;
      settled.sort((a, b) => a.record.order - b.record.order);
      for (const item of settled) {
        if (excess <= 0) break;
        if (remove(prepared, item.identity, item.record)) excess -= 1;
      }
    }

    function trimPrepared(identity) {
      trimSettled(recordsForComposer(identity), maxPreparedPerComposer);
      trimSettled(allPreparedRecords(), maxPreparedRecords);
    }

    async function prepare(identity, prepareFn, onRejected) {
      const current = get(prepared, identity);
      if (current) {
        if (current.requestId) {
          current.order = ++order;
          trimPrepared(identity);
          return current;
        }
        if (current.preparing) return current.preparing;
      }
      const record = { requestId: '', preparing: null, order: ++order };
      const preparing = Promise.resolve()
        .then(() => prepareFn())
        .then((response) => {
          if (!response || response.prepared !== true || typeof response.requestId !== 'string') return null;
          const requestId = response.requestId.trim();
          if (!requestId) return null;
          record.requestId = requestId;
          return record;
        })
        .catch(() => {
          if (typeof onRejected === 'function') onRejected();
          return null;
        });
      record.preparing = preparing;
      set(prepared, identity, record);
      trimPrepared(identity);
      const result = await preparing;
      record.preparing = null;
      if (!result) remove(prepared, identity, record);
      trimPrepared(identity);
      return result;
    }

    function clearPrepared(identity, record) {
      return remove(prepared, identity, record);
    }

    function disposeSendContext(owner) {
      if (!owner || owner.disposed) return;
      owner.disposed = true;
      if (typeof owner.dispose !== 'function') return;
      try {
        owner.dispose(owner.value);
      } catch (_) {
        // Completion cleanup must not change the shared send result.
      }
    }

    function runSend(identity, task, context, disposeContext) {
      const nextOwner = arguments.length >= 3
        ? { value: context, dispose: disposeContext, disposed: false }
        : null;
      const current = get(sending, identity);
      if (current) {
        if (nextOwner) {
          if (current.contextLocked) {
            disposeSendContext(nextOwner);
          } else {
            disposeSendContext(current.context);
            current.context = nextOwner;
          }
        }
        return current.promise;
      }
      const entry = {
        promise: null,
        context: nextOwner,
        contextLocked: false,
      };
      const claimLatestContext = () => {
        if (entry.contextLocked) return null;
        entry.contextLocked = true;
        return entry.context ? entry.context.value : undefined;
      };
      let run;
      try {
        run = Promise.resolve(task(claimLatestContext));
      } catch (error) {
        run = Promise.reject(error);
      }
      entry.promise = run.finally(() => {
        remove(sending, identity, entry);
        disposeSendContext(entry.context);
        entry.context = null;
        const preparedRecord = get(prepared, identity);
        if (preparedRecord) preparedRecord.order = ++order;
        trimPrepared(identity);
      });
      set(sending, identity, entry);
      return entry.promise;
    }

    return { prepare, clearPrepared, runSend };
  }

  function createComposerFreshnessState(options = {}) {
    const configuredMax = Number(options.maxRevisionIdentities);
    const maxRevisionIdentities = Number.isInteger(configuredMax) && configuredMax > 0
      ? configuredMax
      : 64;
    const revisions = new Map();
    let generationSequence = 0;
    let accessSequence = 0;
    let surfaceGeneration = 0;

    function revisionBucket(target, create) {
      const key = String(target || '');
      let bucket = revisions.get(key);
      if (!bucket && create) {
        bucket = new Map();
        revisions.set(key, bucket);
      }
      return { key, bucket };
    }

    function getRecord(target, cid) {
      const path = revisionBucket(target, false);
      return path.bucket ? path.bucket.get(String(cid || '')) : undefined;
    }

    function ensureRecord(target, cid) {
      const cidKey = String(cid || '');
      const path = revisionBucket(target, true);
      let record = path.bucket.get(cidKey);
      if (!record) {
        record = {
          generation: ++generationSequence,
          order: ++accessSequence,
          refs: 0,
        };
        path.bucket.set(cidKey, record);
      }
      return record;
    }

    function removeRecord(target, cid, expected) {
      const path = revisionBucket(target, false);
      if (!path.bucket) return false;
      const cidKey = String(cid || '');
      if (path.bucket.get(cidKey) !== expected) return false;
      path.bucket.delete(cidKey);
      if (!path.bucket.size) revisions.delete(path.key);
      return true;
    }

    function trimInactive() {
      const inactive = [];
      for (const [target, bucket] of revisions.entries()) {
        for (const [cid, record] of bucket.entries()) {
          if (record.refs === 0) inactive.push({ target, cid, record });
        }
      }
      let excess = inactive.length - maxRevisionIdentities;
      if (excess <= 0) return;
      inactive.sort((a, b) => a.record.order - b.record.order);
      for (const item of inactive) {
        if (excess <= 0) break;
        if (removeRecord(item.target, item.cid, item.record)) excess -= 1;
      }
    }

    function bumpComposer(target, cid) {
      const record = ensureRecord(target, cid);
      record.generation = ++generationSequence;
      record.order = ++accessSequence;
      trimInactive();
      return record.generation;
    }

    function bumpSurface() {
      surfaceGeneration = ++generationSequence;
      trimInactive();
      return surfaceGeneration;
    }

    function capture(target, cid) {
      const targetKey = String(target || '');
      const cidKey = String(cid || '');
      const record = ensureRecord(targetKey, cidKey);
      record.refs += 1;
      record.order = ++accessSequence;
      trimInactive();
      return {
        target: targetKey,
        cid: cidKey,
        generation: record.generation,
        surfaceGeneration,
        record,
        released: false,
      };
    }

    function matches(token) {
      if (!token || typeof token !== 'object' || token.released) return false;
      return token.surfaceGeneration === surfaceGeneration
        && token.record === getRecord(token.target, token.cid)
        && token.generation === token.record.generation;
    }

    function release(token) {
      if (!token || typeof token !== 'object' || token.released) return false;
      token.released = true;
      if (token.record && token.record.refs > 0) {
        token.record.refs -= 1;
        token.record.order = ++accessSequence;
      }
      trimInactive();
      return true;
    }

    return { bumpComposer, bumpSurface, capture, matches, release };
  }

  /**
   * Resolve the block reason plus its localized message, so the caller does not need
   * to know the key mapping.
   */
  function checkComposeLocalized(input, t) {
    const result = checkCompose(input);
    if (!result.blocked) return result;
    let message = result.message;
    try {
      if (typeof t === 'function') {
        const key = `composer.a2a.blocked_${result.reason}`;
        const translated = t(key);
        if (translated && translated !== key) message = String(translated);
      }
    } catch (_) { /* i18n 未加载时用回退文案 */ }
    return { ...result, message };
  }

  const api = {
    checkCompose,
    checkComposeLocalized,
    countContactMentions,
    questionRoute,
    createQuestionSendState,
    createComposerFreshnessState,
    REASONS,
  };
  if (typeof window !== 'undefined') {
    window.a2aComposeGuards = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
