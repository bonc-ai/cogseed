// Host-owned reimbursement cards. Configuration is deliberately rendered
// outside the generic chat form protocol so the app secret never becomes a
// chat message, model input, log field, or syncable conversation record.
(function () {
  'use strict';

  function text(key, fallback, vars) {
    let value = typeof t === 'function' ? t(key) : key;
    if (!value || value === key) value = fallback;
    for (const [name, replacement] of Object.entries(vars || {})) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  }

  function addField(form, options) {
    const row = document.createElement('label');
    row.className = 'expense-agent-card-field';
    const label = document.createElement('span');
    label.className = 'expense-agent-card-label';
    label.textContent = options.label;
    row.appendChild(label);

    let control;
    if (options.type === 'textarea') {
      control = document.createElement('textarea');
      control.rows = options.rows || 4;
    } else if (options.type === 'select') {
      control = document.createElement('select');
      for (const option of options.options || []) {
        const choice = document.createElement('option');
        choice.value = option.value;
        choice.textContent = option.label;
        control.appendChild(choice);
      }
    } else {
      control = document.createElement('input');
      control.type = options.type || 'text';
      if (options.autocomplete) control.autocomplete = options.autocomplete;
    }
    control.name = options.name;
    control.className = 'expense-agent-card-control';
    if (options.placeholder) control.placeholder = options.placeholder;
    if (options.required) control.required = true;
    if (options.type === 'password') {
      control.spellcheck = false;
      control.autocapitalize = 'off';
    }
    row.appendChild(control);
    if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'expense-agent-card-hint';
      hint.textContent = options.hint;
      row.appendChild(hint);
    }
    form.appendChild(row);
    return control;
  }

  function responseError(response) {
    const message = response && typeof response.error === 'string' ? response.error : '';
    if (message && message.length <= 160 && !/[\r\n\u0000]/.test(message)) return message;
    return text('expense_agent.card.operation_failed', 'The request could not be completed.');
  }

  async function invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      throw new Error('ipc_unavailable');
    }
    const response = await window.cogseed.invoke(channel, payload);
    if (!response || response.ok !== true) throw new Error(responseError(response));
    return response;
  }

  function statusLine(status, fallback) {
    const line = document.createElement('p');
    line.className = 'expense-agent-card-status';
    if (fallback) line.textContent = fallback;
    if (status && status.state === 'ready') {
      line.classList.add('is-ready');
      line.textContent = text('expense_agent.card.setup_ready', 'Feishu configuration is verified and ready.');
    } else if (status && status.state === 'invalid') {
      line.classList.add('is-error');
      line.textContent = text('expense_agent.card.setup_invalid', 'The configuration was saved but could not be verified. Check the Feishu values and try again.');
    }
    return line;
  }

  function mountSetup(container, payload) {
    if (!container || !payload || !validId(payload.agent_id)) return;
    const card = document.createElement('section');
    card.className = 'expense-agent-card expense-agent-setup-card';
    card.setAttribute('aria-label', text('expense_agent.card.setup_aria', 'Configure reimbursement agent'));

    const heading = document.createElement('h3');
    heading.textContent = text('expense_agent.card.setup_title', 'Connect Feishu reimbursement');
    card.appendChild(heading);
    const intro = document.createElement('p');
    intro.className = 'expense-agent-card-intro';
    intro.textContent = text('expense_agent.card.setup_intro', 'Credentials are sent directly to the app and stored only in encrypted local configuration.');
    card.appendChild(intro);

    const form = document.createElement('form');
    form.className = 'expense-agent-card-form';
    form.noValidate = true;
    const apiBase = addField(form, {
      name: 'api_base_url', type: 'url', required: true,
      label: text('expense_agent.card.api_base_url', 'Feishu API base URL'),
      placeholder: 'https://open.feishu.cn', autocomplete: 'url',
    });
    const appId = addField(form, {
      name: 'app_id', required: true,
      label: text('expense_agent.card.app_id', 'App ID'), autocomplete: 'off',
    });
    const secret = addField(form, {
      name: 'app_secret', type: 'password', required: true,
      label: text('expense_agent.card.app_secret', 'App secret'),
      hint: text('expense_agent.card.app_secret_hint', 'This value is never added to the conversation.'),
      autocomplete: 'new-password',
    });
    const approvalCode = addField(form, {
      name: 'approval_code', required: true,
      label: text('expense_agent.card.approval_code', 'Approval definition code'), autocomplete: 'off',
    });
    addField(form, {
      name: 'applicant_open_id', required: true,
      label: text('expense_agent.card.applicant_open_id', 'Applicant open ID'), autocomplete: 'off',
    });
    addField(form, {
      name: 'approval_node_label',
      label: text('expense_agent.card.approval_node_label', 'Approval node label (optional)'), autocomplete: 'off',
    });
    addField(form, {
      name: 'approval_form_template', type: 'textarea', rows: 6, required: true,
      label: text('expense_agent.card.approval_form_template', 'Approval form template (JSON)'),
      hint: text('expense_agent.card.template_hint', 'Use the approved Feishu form JSON and the supported {{title}}, {{amount}}, {{currency}}, {{merchant}}, {{expense_date}}, {{description}}, and {{materials}} placeholders.'),
    });
    const receiverType = addField(form, {
      name: 'notification_receiver_type', type: 'select',
      label: text('expense_agent.card.receiver_type', 'Notification target type'),
      options: [
        { value: 'open_id', label: text('expense_agent.card.receiver_open_id', 'User open ID') },
        { value: 'chat_id', label: text('expense_agent.card.receiver_chat_id', 'Chat ID') },
      ],
    });
    const receiverId = addField(form, {
      name: 'notification_receiver_id', required: true,
      label: text('expense_agent.card.receiver_id', 'Notification target ID'), autocomplete: 'off',
    });
    const actions = document.createElement('div');
    actions.className = 'expense-agent-card-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary';
    submit.textContent = text('expense_agent.card.save_setup', 'Verify and save configuration');
    actions.appendChild(submit);
    form.appendChild(actions);
    card.appendChild(form);
    const status = statusLine(null, '');
    status.hidden = true;
    card.appendChild(status);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.hidden = false;
      status.className = 'expense-agent-card-status';
      status.textContent = text('expense_agent.card.verifying', 'Verifying Feishu configuration...');
      let appSecret = secret.value;
      try {
        const response = await invoke('expenseAgent.saveConfiguration', {
          agent_id: payload.agent_id,
          api_base_url: apiBase.value,
          app_id: appId.value,
          app_secret: appSecret,
          approval_code: form.elements.approval_code.value,
          applicant_open_id: form.elements.applicant_open_id.value,
          approval_node_label: form.elements.approval_node_label.value,
          approval_form_template: form.elements.approval_form_template.value,
          notification_receiver_type: receiverType.value,
          notification_receiver_id: receiverId.value,
        });
        const nextStatus = response.result || response;
        const next = statusLine(nextStatus);
        status.className = next.className;
        status.textContent = next.textContent;
        if (nextStatus && nextStatus.ready === true) {
          form.querySelectorAll('input, textarea, select, button').forEach((control) => { control.disabled = true; });
        }
      } catch (_) {
        status.className = 'expense-agent-card-status is-error';
        status.textContent = text('expense_agent.card.setup_request_failed', 'Configuration could not be saved or verified. Review the fields and try again.');
      } finally {
        secret.value = '';
        appSecret = '';
        if (!status.classList.contains('is-ready')) submit.disabled = false;
      }
    });
    container.appendChild(card);
  }

  function mountSubmit(container, payload, cid) {
    if (!container || !payload || !validId(payload.agent_id) || !validId(payload.case_id) || !validId(cid)) return;
    const card = document.createElement('section');
    card.className = 'expense-agent-card expense-agent-submit-card';
    card.setAttribute('aria-label', text('expense_agent.card.submit_aria', 'Submit reimbursement for approval'));
    const heading = document.createElement('h3');
    heading.textContent = text('expense_agent.card.submit_title', 'Submit reimbursement for approval');
    card.appendChild(heading);
    const intro = document.createElement('p');
    intro.className = 'expense-agent-card-intro';
    intro.textContent = text('expense_agent.card.submit_intro', 'The app will show a final confirmation before creating the Feishu approval request.');
    card.appendChild(intro);
    const actions = document.createElement('div');
    actions.className = 'expense-agent-card-actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary';
    submit.textContent = text('expense_agent.card.submit', 'Submit to Feishu');
    actions.appendChild(submit);
    card.appendChild(actions);
    const status = statusLine(null, '');
    status.hidden = true;
    card.appendChild(status);
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      status.hidden = false;
      status.className = 'expense-agent-card-status';
      status.textContent = text('expense_agent.card.submitting', 'Waiting for your confirmation...');
      try {
        const response = await invoke('expenseAgent.confirmAndSubmit', {
          agent_id: payload.agent_id,
          cid,
          case_id: payload.case_id,
        });
        const result = response.result || response;
        if (result && result.status === 'submitted') {
          status.className = 'expense-agent-card-status is-ready';
          status.textContent = text('expense_agent.card.submitted', 'The Feishu approval was created and sent to the designated human approvers.');
          return;
        }
        throw new Error('unexpected_submission_status');
      } catch (_) {
        status.className = 'expense-agent-card-status is-error';
        status.textContent = text('expense_agent.card.submit_failed', 'No duplicate submission was attempted. Check the case status in the reimbursement agent.');
        submit.disabled = false;
      }
    });
    container.appendChild(card);
  }

  window.mountExpenseSetupCard = mountSetup;
  window.mountExpenseSubmitCard = mountSubmit;
}());
