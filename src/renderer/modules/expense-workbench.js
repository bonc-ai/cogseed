// Management view for the canonical reimbursement agent. It owns setup only;
// reimbursement details and chat attachments stay in the normal conversation.
(function () {
  'use strict';

  let activeAgentId = '';

  function text(key, fallback) {
    const value = typeof t === 'function' ? t(key) : key;
    return value && value !== key ? value : fallback;
  }

  function host() { return document.getElementById('agent-management-surface'); }

  function reset() {
    const target = host();
    if (target) {
      target.hidden = true;
      target.replaceChildren();
    }
    const detail = document.getElementById('agents-detail-content');
    const chat = document.getElementById('agents-chat-col');
    if (detail) detail.style.display = '';
    if (chat) chat.style.display = 'none';
    activeAgentId = '';
  }

  function statusText(status) {
    if (status && status.legacy_local_configuration_detected) return text('expense_agent.management.legacy_local_configuration', 'A previous local reimbursement project was found but is no longer used. Complete the secure Feishu setup below.');
    if (status && status.ready) return text('expense_agent.management.ready', 'Feishu configuration is ready. Start reimbursement in a main chat with this agent.');
    if (status && status.configured) return text('expense_agent.management.invalid', 'The saved Feishu configuration needs attention. Update it below before using reimbursement.');
    return text('expense_agent.management.unconfigured', 'Complete Feishu setup before using reimbursement. You can also start a main chat with this agent and configure it there.');
  }

  function render(agentId, status) {
    const target = host();
    if (!target || activeAgentId !== agentId) return;
    target.replaceChildren();
    const section = document.createElement('section');
    section.className = 'expense-agent-management';
    const heading = document.createElement('h2');
    heading.textContent = text('expense_agent.management.title', 'Reimbursement setup');
    section.appendChild(heading);
    const state = document.createElement('p');
    state.className = `expense-agent-card-status${status && status.ready ? ' is-ready' : status && status.configured ? ' is-error' : ''}`;
    state.textContent = statusText(status);
    section.appendChild(state);
    if (!status || !status.ready) {
      const cardHost = document.createElement('div');
      section.appendChild(cardHost);
      if (typeof window.mountExpenseSetupCard === 'function') window.mountExpenseSetupCard(cardHost, { agent_id: agentId });
    }
    const chatHint = document.createElement('p');
    chatHint.className = 'expense-agent-card-intro';
    chatHint.textContent = text('expense_agent.management.chat_hint', 'After setup, use this agent in the main chat and attach the reimbursement materials there.');
    section.appendChild(chatHint);
    target.appendChild(section);
  }

  async function openExpenseWorkbench(agentId) {
    if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return;
    activeAgentId = agentId;
    const target = host();
    if (!target) return;
    const detail = document.getElementById('agents-detail-content');
    const chat = document.getElementById('agents-chat-col');
    if (detail) detail.style.display = 'none';
    if (chat) chat.style.display = 'none';
    target.hidden = false;
    render(agentId, null);
    try {
      const response = await window.orkas.invoke('expenseAgent.status', { agent_id: agentId });
      if (!response || response.ok !== true) throw new Error('status_failed');
      render(agentId, response.result || response);
    } catch (_) {
      render(agentId, { configured: true, ready: false });
    }
  }

  window.openExpenseWorkbench = openExpenseWorkbench;
  window.closeExpenseWorkbench = reset;
  window.addEventListener('i18n-change', () => {
    if (activeAgentId) void openExpenseWorkbench(activeAgentId);
  });
}());
