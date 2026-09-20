/* 独立交互原型：仅使用内存中的模拟数据，不调用 CogSeed IPC 或 Hub 接口。 */
(function () {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const assetIcon = (name) => '<span class="icon i-' + name + '" aria-hidden="true"></span>';
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const iconAssets = { plug: "./prototype-assets/plug.svg", "book-open": "./prototype-assets/book-open.svg", "file-check": "./prototype-assets/file-check.svg" };
  function skillInitial(name) {
    const label = name.replace(/^\[[^\]]+\]\s*/, "").trim();
    const match = label.match(/\p{Script=Han}/u) || label.match(/[A-Za-z]/u);
    return match ? match[0].toLocaleUpperCase() : "技";
  }
  function skillAvatar(skill) {
    const tones = ["tone-green", "tone-blue", "tone-peach", "tone-lilac"];
    const tone = tones[Array.from(skill.id).reduce((sum, char) => sum + char.codePointAt(0), 0) % tones.length];
    const asset = iconAssets[skill.icon];
    return '<span class="skill-avatar ' + tone + (asset ? ' has-icon' : '') + '" aria-hidden="true">' +
      (asset ? '<img class="skill-avatar-image" src="' + asset + '" alt="">' : '') +
      '<span class="skill-avatar-fallback">' + escapeHtml(skillInitial(skill.name)) + '</span></span>';
  }

  const skills = [
    { id: "imagegen", name: "[Codex] imagegen", source: "custom", category: "通用", version: "", hasManifest: false, description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-background cutouts." },
    { id: "openai-docs", name: "[Codex] openai-docs", source: "custom", category: "通用", version: "1.1.0", description: "Use for Codex models, pricing, scheduled tasks, skills, settings, setup, troubleshooting and customization." },
    { id: "plugin-creator", name: "[Codex] plugin-creator", source: "custom", icon: "plug", category: "通用", version: "1.0.0", description: "Create and scaffold plugin directories for Codex with a required plugin manifest and optional structure." },
    { id: "review-agent", name: "[Codex] review-agent", source: "custom", category: "通用", version: "1.0.0", description: "Perform a read-only, defect-first review of a specified code change and return actionable findings." },
    { id: "skill-creator", name: "[Codex] skill-creator", source: "custom", category: "通用", version: "1.2.0", description: "Create or update a Codex skill with scoped instructions and supporting resources." },
    { id: "skill-installer", name: "[Codex] skill-installer", source: "custom", category: "通用", version: "1.0.0", description: "Install Codex skills from a curated list or a GitHub repository path." },
    { id: "academic-writing", name: "academic-writing", source: "platform", icon: "book-open", category: "通用", version: "1.0.0", description: "用主张、证据和推理组织论文，并核验引文与结论。" },
    { id: "acceptance-evaluation", name: "acceptance-evaluation", source: "platform", icon: "file-check", category: "数据", version: "1.0.0", description: "为确定性功能和 Agent 设计验收场景、评测集与人工 Gate。" },
    { id: "acceptance-evidence", name: "acceptance-evidence", source: "platform", category: "数据", version: "1.0.0", description: "将功能、非功能、安全和运维要求转成可重复采集的验收证据。" },
    { id: "ai-risk", name: "AI产品风险排除", source: "platform", category: "通用", version: "1.0.0", description: "按最大不确定性选择用户研究、原型、评测或技术验证。" }
  ];
  let contributions = [
    { id: "sub_01J8Z3K4M5N6", contentId: null, localId: "plugin-creator", name: "[Codex] plugin-creator", version: "1.0.0", status: "pending", publishedVersion: null, submitted: "今天 09:42", rejection: "", withdrawal: null },
    { id: "8a4f01c29d7e", contentId: "8a4f01c29d7e", localId: "skill-creator", name: "[Codex] skill-creator", version: "1.2.0", status: "accepted", publishedVersion: "1.2.0", submitted: "9月18日", rejection: "", withdrawal: null },
    { id: "sub_01J8Y6H2R3Q4", contentId: null, localId: "review-agent", name: "[Codex] review-agent", version: "1.0.0", status: "rejected", publishedVersion: null, submitted: "9月17日", rejection: "说明中包含本机绝对路径，请修改后重新提交。", withdrawal: null },
    { id: "5d27bc0e61a9", contentId: "5d27bc0e61a9", localId: "openai-docs", name: "[Codex] openai-docs", version: "1.1.0", status: "accepted", publishedVersion: "1.1.0", submitted: "9月15日", rejection: "", withdrawal: { status: "pending", reason: "计划停止维护此内容。", requested: "今天 08:10" } }
  ];
  const state = {
    view: "skills", category: "全部", search: "", skillId: "imagegen", scenario: "", stage: "",
    loggedIn: true, pendingRoute: null, tour: "skills", draft: null,
    check: "idle", selectedFile: 0, sourceType: "", historyFilter: "all",
    historySearch: "", selectedHistory: contributions[0].id, newVersionOf: null
  };
  let checkTimer = 0;
  let submitTimer = 0;
  let toastTimer = 0;
  let menuAnchor = null;
  let dialogReturnFocus = null;

  function skillById(id) { return skills.find((skill) => skill.id === id) || skills[0]; }
  function historyById(id) { return contributions.find((item) => item.id === id) || null; }
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3400);
  }
  function route(view, options) {
    const opts = options || {};
    if (typeof opts.loggedIn === "boolean") state.loggedIn = opts.loggedIn;
    if ((view === "contribute" || view === "contributions") && !state.loggedIn) {
      if (state.view !== "skills") route("skills", { loggedIn: false });
      showLoginRequired(view, opts);
      return;
    }
    if (state.view === "contribute") {
      clearTimeout(checkTimer);
      clearTimeout(submitTimer);
      submitTimer = 0;
    }
    if (opts.skillId) state.skillId = opts.skillId;
    state.view = view;
    state.scenario = opts.scenario || "";
    state.stage = opts.stage || "";
    state.newVersionOf = opts.newVersionOf || null;
    if (opts.historyId) state.selectedHistory = opts.historyId;
    state.tour = opts.tour || tourForCurrentView();
    const url = new URL(location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("modal");
    if (view === "contribute") {
      url.searchParams.set("skill", state.skillId);
      if (state.scenario) url.searchParams.set("scenario", state.scenario);
      else url.searchParams.delete("scenario");
      if (state.stage) url.searchParams.set("stage", state.stage);
      else url.searchParams.delete("stage");
      if (state.newVersionOf) url.searchParams.set("content", state.newVersionOf);
      else url.searchParams.delete("content");
    } else {
      url.searchParams.delete("skill");
      url.searchParams.delete("scenario");
      url.searchParams.delete("stage");
      url.searchParams.delete("content");
    }
    url.searchParams.delete("next");
    if (state.loggedIn) url.searchParams.delete("auth");
    else url.searchParams.set("auth", "guest");
    history.pushState(null, "", url);
    renderView();
  }
  function tourForCurrentView() {
    if (state.view === "skills") return state.loggedIn ? "skills" : "guest";
    if (state.view === "contributions") return "history";
    if (state.scenario === "blocked") return "blocked";
    if (state.scenario === "unavailable") return "unavailable";
    if (state.stage === "complete") return "complete";
    if (state.stage === "preview") return "preview";
    if (state.stage === "sending") return "sending";
    if (state.newVersionOf) return "version";
    return "check";
  }
  function restoreRoute() {
    const params = new URLSearchParams(location.search);
    const requestedView = params.get("view");
    state.view = ["skills", "contribute", "contributions"].includes(requestedView) ? requestedView : "skills";
    state.skillId = params.get("skill") || "imagegen";
    state.scenario = params.get("scenario") || "";
    state.stage = params.get("stage") || "";
    state.newVersionOf = params.get("content") || null;
    state.loggedIn = params.get("auth") !== "guest" && requestedView !== "login";
    const gatedView = requestedView === "login" || (!state.loggedIn && params.get("modal") === "login")
      ? (params.get("next") === "contributions" ? "contributions" : "contribute")
      : (!state.loggedIn && (state.view === "contribute" || state.view === "contributions") ? state.view : null);
    if (gatedView) state.view = "skills";
    state.tour = tourForCurrentView();
    renderView();
    if (gatedView) showLoginRequired(gatedView, { skillId: state.skillId, scenario: state.scenario, stage: state.stage, newVersionOf: state.newVersionOf });
  }
  function renderView() {
    ["skills", "contribute", "contributions"].forEach((view) => {
      $("#view-" + view).hidden = state.view !== view;
    });
    closeMenu();
    renderAccount();
    renderTour();
    if (state.view === "skills") renderSkills();
    if (state.view === "contribute") renderContribution();
    if (state.view === "contributions") renderContributions();
    $(".workspace").scrollTo(0, 0);
  }
  function renderAccount() {
    $("#account-avatar").textContent = state.loggedIn ? "F" : "?";
    $("#account-name").textContent = state.loggedIn ? "fzy" : "未登录";
    $("#account-subtitle").textContent = state.loggedIn ? "个人工作空间" : "点击登录";
  }
  function renderTour() {
    $$("[data-tour]").forEach((button) => {
      const active = button.dataset.tour === state.tour;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  }
  function showLoginRequired(view, options) {
    const opts = options || {};
    const skillId = opts.skillId || state.skillId;
    state.pendingRoute = { view, options: { ...opts, skillId } };
    state.tour = "login";
    renderTour();
    const target = view === "contributions" ? "我的贡献"
      : view === "contribute" ? "贡献「" + skillById(skillId).name + "」" : "个人工作空间";
    const detail = view === "contribute" ? "登录前不会检查或上传该 Skill。"
      : view === "contributions" ? "登录前不会展示任何账号的贡献记录。" : "登录前不会执行需要账号的操作。";
    openDialog("此功能需要登录",
      '<p>请前往 Web 登录。完成后将返回客户端，继续刚才的操作。</p>' +
      '<div class="login-target"><span>登录后继续</span><strong>' + escapeHtml(target) + '</strong></div>' +
      '<p>' + detail + '</p>',
      [{ label: "稍后再说", variant: "secondary" },
        { label: "前往 Web 登录", variant: "primary", keepOpen: true, run: showWebLoginHandoff }]);
  }
  function showWebLoginHandoff() {
    openDialog("Web 登录 · 原型模拟",
      '<p>正式客户端会向 Hub 获取授权地址并在系统浏览器中打开 Web 登录。这里仅模拟浏览器返回，不连接真实账号。</p>' +
      '<p>完成登录后，客户端将继续打开刚才选择的功能。</p>',
      [{ label: "取消登录", variant: "secondary" },
        { label: "模拟 Web 登录完成", variant: "primary", run: () => {
          const pending = state.pendingRoute;
          state.pendingRoute = null;
          if (pending) route(pending.view, { ...pending.options, loggedIn: true });
        } }]);
  }
  function renderSkills() {
    $$(".segmented button").forEach((button) => button.classList.toggle("selected", button.dataset.category === state.category));
    $("#skills-search").value = state.search;
    const query = state.search.trim().toLocaleLowerCase();
    const match = (skill) => (state.category === "全部" || skill.category === state.category) &&
      (!query || (skill.name + " " + skill.description).toLocaleLowerCase().includes(query));
    const custom = skills.filter((skill) => skill.source === "custom" && match(skill));
    const platform = skills.filter((skill) => skill.source === "platform" && match(skill));
    const groups = $("#skills-groups");
    groups.innerHTML = [
      renderSkillGroup("自定义 · " + custom.length, custom),
      renderSkillGroup(state.search || state.category !== "全部" ? "平台 · " + platform.length : "平台 · 58", platform),
      (!state.search && state.category === "全部") ? '<div class="group-heading">外部包 · 1 来自已安装的外部代码包</div><div class="group-heading">全局文件夹 · 17 来自本机共享的技能文件夹</div>' : ""
    ].join("");
    if (!custom.length && !platform.length) groups.innerHTML = '<div class="empty-state">' + assetIcon("search") + '<strong>没有匹配的技能</strong><p>修改关键词或分类后再查找。</p></div>';
    $$(".skill-avatar-image").forEach((icon) => {
      const showFallback = () => {
        icon.hidden = true;
        icon.closest(".skill-avatar").classList.remove("has-icon");
      };
      icon.addEventListener("error", showFallback);
      if (icon.complete && !icon.naturalWidth) showFallback();
    });
    $$(".skill-card").forEach((card) => {
      card.addEventListener("click", (event) => {
        const skill = skillById(card.dataset.skill);
        if (event.target.closest(".card-more")) {
          event.stopPropagation();
          openMenu(card.querySelector(".card-more"), skill);
        } else if (event.target.closest(".use-button")) {
          event.stopPropagation();
          showToast("已在任务输入框选中「" + skill.name + "」");
        } else if (event.target.closest(".contribute-button")) {
          event.stopPropagation();
          route("contribute", { skillId: skill.id });
        } else {
          showToast("已打开「" + skill.name + "」的技能详情");
        }
      });
      card.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === card) {
          event.preventDefault();
          showToast("已打开「" + skillById(card.dataset.skill).name + "」的技能详情");
        }
      });
    });
  }
  function renderSkillGroup(title, list) {
    if (!list.length) return "";
    return '<section class="skill-section"><div class="group-heading">' + escapeHtml(title) +
      '</div><div class="skill-grid">' + list.map((skill) =>
        '<article class="skill-card" data-skill="' + escapeHtml(skill.id) + '" tabindex="0">' +
        '<div class="skill-card-head">' + skillAvatar(skill) + '<strong class="skill-card-title">' + escapeHtml(skill.name) + '</strong></div>' +
        '<button type="button" class="icon-button card-more" aria-label="' + escapeHtml(skill.name) + '更多操作" aria-haspopup="menu">' + assetIcon("ellipsis") + '</button>' +
        '<p class="skill-card-desc">' + escapeHtml(skill.description) + '</p>' +
        '<div class="skill-card-divider"></div><div class="skill-card-foot"><span class="category-chip">' +
        escapeHtml(skill.category) + '</span><div class="skill-card-actions">' +
        (skill.source === "custom" ? '<button type="button" class="button button-secondary contribute-button" aria-label="贡献 ' + escapeHtml(skill.name) + ' 到 Hub">贡献</button>' : '') +
        '<button type="button" class="button button-primary use-button">使用</button></div></div></article>'
      ).join("") + '</div></section>';
  }
  function openMenu(anchor, skill) {
    const menu = $("#card-menu");
    if (menuAnchor === anchor && !menu.hidden) { closeMenu(); return; }
    closeMenu();
    menuAnchor = anchor;
    anchor.closest(".skill-card").classList.add("menu-open");
    menu.innerHTML = (skill.source === "custom" ? '<button type="button" data-menu="edit">' + assetIcon("pencil") + '编辑</button>' : "") +
      '<button type="button" data-menu="disable">' + assetIcon("circle-x") + '停用</button>' +
      (skill.source === "custom" ? '<div class="menu-divider"></div><button type="button" class="menu-danger" data-menu="delete">' + assetIcon("trash") + '卸载</button>' : "");
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 164;
    menu.style.left = Math.min(window.innerWidth - menuWidth - 9, Math.max(9, rect.right - menuWidth)) + "px";
    menu.style.top = (rect.bottom + 6 + menu.offsetHeight < window.innerHeight ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6) + "px";
    menu.querySelectorAll("[data-menu]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.menu;
      closeMenu();
      if (action === "disable") showToast("已选择停用「" + skill.name + "」");
      else if (action === "edit") showToast("已打开「" + skill.name + "」编辑页");
      else showToast("已选择卸载「" + skill.name + "」");
    }));
    menu.querySelector("button").focus();
  }
  function closeMenu() {
    const menu = $("#card-menu");
    menu.hidden = true;
    $$(".skill-card.menu-open").forEach((card) => card.classList.remove("menu-open"));
    menuAnchor = null;
  }

  function previewFiles(skill, draft) {
    const declaration = [
      "# 本次提交副本的安全声明示意",
      "skill:",
      "  id: " + skill.id,
      "  version: " + JSON.stringify(draft.version),
      "permissions:",
      "  required: " + draft.permission,
      "network:",
      "  access: " + draft.network,
      "runtime_boundary:",
      "  purpose: " + JSON.stringify(draft.boundary)
    ].join("\n");
    return [
      { name: "SKILL.md", size: "3.2 KB", content: "---\nname: " + JSON.stringify(draft.name) + "\ndescription: " + JSON.stringify(draft.description) + "\nversion: " + JSON.stringify(draft.version) + "\n---\n\n# " + draft.name + "\n\n" + draft.description + "\n\n## 使用方式\n\n根据当前任务说明选择所需步骤，并在执行前核对输入与输出范围。" },
      { name: "references/guide.md", size: "1.8 KB", content: "# 使用指南\n\n本文件说明技能的适用场景、输入和交付结果。\n\n提交前请检查引用材料的来源与再分发权限。" },
      { name: "references/security-manifest.yaml", size: "由本次声明生成", content: declaration },
      { name: "scripts/prepare.cjs", size: "1.1 KB", content: "// Skill support script\n// Input is limited to the current task's approved files.\n\nfunction prepare(input) {\n  return { ready: Boolean(input), checkedAt: new Date().toISOString() };\n}\n\nmodule.exports = { prepare };" },
      { name: "_meta.json", size: "428 B", content: '{\n  "category": "' + skill.category + '",\n  "version": "' + draft.version + '",\n  "routing": {\n    "applicable_domain": ["general"]\n  }\n}' }
    ];
  }
  function initialDraft(skill, sourceContribution) {
    return {
      name: skill.name || "",
      description: skill.description || "",
      version: sourceContribution ? nextVersion(sourceContribution.publishedVersion) : skill.version || "",
      permission: skill.hasManifest === false ? "" : "selected-files",
      network: skill.hasManifest === false ? "" : "none",
      boundary: skill.hasManifest === false ? "" : "仅处理当前任务中用户选择的文件"
    };
  }
  function draftComplete(draft) {
    return Boolean(draft.name.trim() && draft.description.trim() && parseSemver(draft.version.trim()) &&
      draft.permission && draft.network && draft.boundary.trim());
  }
  function parseSemver(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4] || "" } : null;
  }
  function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) return NaN;
    for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
    if (!left.pre && right.pre) return 1;
    if (left.pre && !right.pre) return -1;
    return left.pre.localeCompare(right.pre, undefined, { numeric: true });
  }
  function showCompletion() {
    clearTimeout(checkTimer);
    state.check = "needs-input";
    $("#completion-panel").hidden = false;
    $("#check-panel").hidden = true;
    $("#preview-wrap").hidden = true;
    $("#draft-name").value = state.draft.name;
    $("#draft-version").value = state.draft.version;
    $("#draft-description").value = state.draft.description;
    $("#draft-permission").value = state.draft.permission;
    $("#draft-network").value = state.draft.network;
    $("#draft-boundary").value = state.draft.boundary;
    $("#completion-alert").hidden = true;
    $("#completion-status").textContent = draftComplete(state.draft) ? "可修改" : "待补齐";
    $$("#view-contribute .flow-step").forEach((step) => step.classList.remove("done", "current"));
    $("#step-complete").classList.add("current");
    state.tour = "complete";
    renderTour();
  }
  function saveCompletion() {
    const draft = {
      name: $("#draft-name").value.trim(),
      description: $("#draft-description").value.trim(),
      version: $("#draft-version").value.trim(),
      permission: $("#draft-permission").value,
      network: $("#draft-network").value,
      boundary: $("#draft-boundary").value.trim()
    };
    const error = $("#completion-alert");
    if (!draft.name || !draft.description || !draft.version || !draft.permission || !draft.network || !draft.boundary) {
      error.textContent = "请补齐名称、说明、版本和安全声明的全部字段。";
      error.hidden = false;
      return;
    }
    if (!draftComplete(draft)) {
      error.textContent = "版本号需采用标准 SemVer，例如 1.0.0。";
      error.hidden = false;
      return;
    }
    const sourceContribution = state.newVersionOf ? historyById(state.newVersionOf) : null;
    if (sourceContribution && compareSemver(draft.version, sourceContribution.publishedVersion) <= 0) {
      error.textContent = "新版本必须高于当前已发布的 v" + sourceContribution.publishedVersion + "。";
      error.hidden = false;
      return;
    }
    state.draft = draft;
    state.previewFiles = previewFiles(skillById(state.skillId), draft);
    state.selectedFile = 0;
    $("#meta-name").textContent = draft.name;
    $("#meta-version").textContent = draft.version;
    $("#meta-desc").textContent = draft.description;
    if (sourceContribution) $("#contrib-subtitle").textContent = "关联原内容 " + sourceContribution.contentId + "，本次版本 " + draft.version;
    renderFileList();
    $("#completion-panel").hidden = true;
    $("#check-panel").hidden = false;
    state.scenario = "";
    state.stage = "check";
    state.tour = "check";
    renderTour();
    startCheck();
  }
  function renderContribution() {
    clearTimeout(checkTimer);
    const skill = skillById(state.skillId);
    const sourceContribution = state.newVersionOf ? historyById(state.newVersionOf) : null;
    state.draft = initialDraft(skill, sourceContribution);
    const version = state.draft.version;
    $("#contrib-heading").textContent = (sourceContribution ? "提交新版本" : "贡献技能") + " · " + skill.name;
    $("#contrib-subtitle").textContent = sourceContribution
      ? "关联原内容 " + sourceContribution.contentId + "，本次版本 " + version
      : "先核对提交资料，再检查本次副本和预览全部内容。";
    $("#meta-name").textContent = state.draft.name;
    $("#meta-version").textContent = state.draft.version;
    $("#meta-desc").textContent = state.draft.description;
    state.previewFiles = previewFiles(skill, state.draft);
    state.selectedFile = 0;
    state.sourceType = "";
    $("#source-type").value = "";
    $("#source-type").disabled = false;
    $("#source-note").value = "";
    $("#accept-terms").checked = false;
    $("#accept-maintenance").checked = false;
    $("#source-hint").textContent = "请如实说明技能的来源。";
    if (sourceContribution) {
      $("#source-type").value = "original";
      $("#source-hint").textContent = "已按上一版预填；你可以修改来源声明。";
    }
    $("#submit-contribution").disabled = true;
    $("#submit-contribution").innerHTML = assetIcon("upload") + "提交审核";
    $("#cancel-submit").hidden = true;
    renderFileList();
    $("#completion-panel").hidden = true;
    $("#check-panel").hidden = false;
    if (state.stage === "complete" || !draftComplete(state.draft)) showCompletion();
    else if (state.stage === "preview" || state.stage === "sending") {
      startCheck(true);
      if (state.stage === "sending") showSendingStage();
    } else startCheck();
  }
  function nextVersion(current) {
    const parts = String(current || "1.0.0").split(".").map(Number);
    return (parts[0] || 1) + "." + ((parts[1] || 0) + 1) + ".0";
  }
  function renderFileList() {
    $("#file-count").textContent = state.previewFiles.length + " 个文件";
    $("#preview-files").innerHTML = state.previewFiles.map((file, index) =>
      '<button type="button" class="file-row' + (index === state.selectedFile ? ' selected' : '') +
      '" data-file="' + index + '">' + assetIcon("file-text") + '<span class="file-name">' + escapeHtml(file.name) +
      '</span><span class="file-size">' + escapeHtml(file.size) + '</span></button>'
    ).join("");
    $$("#preview-files button").forEach((button) => button.addEventListener("click", () => {
      state.selectedFile = Number(button.dataset.file);
      renderFileList();
    }));
    const selected = state.previewFiles[state.selectedFile];
    $("#file-title").textContent = selected.name;
    $("#file-size").textContent = selected.size + " · 只读";
    $("#file-content").textContent = selected.content;
  }
  function startCheck(instant) {
    clearTimeout(checkTimer);
    state.check = "running";
    $("#preview-wrap").hidden = true;
    $("#check-status").className = "status-pill status-running";
    $("#check-status").textContent = "检查中";
    $("#check-message").textContent = "正在检查技能文件与内容";
    $("#check-progress").style.width = "18%";
    $("#check-footnote").textContent = "检查完成前，文件不会离开本机。";
    $("#recheck-button").hidden = true;
    $("#cancel-check-button").hidden = false;
    $("#check-list").innerHTML = [
      checkRow("包结构与入口", "正在检查", "running"),
      checkRow("文件大小与数量", "等待检查", "running"),
      checkRow("路径与链接安全", "等待检查", "running"),
      checkRow("禁止内容与结构质量", "等待检查", "running"),
      checkRow("安全扫描规则包 v1.0.0", "等待加载", "running"),
      checkRow("深扫引擎 skill-sentry 2.1.0", "等待深扫", "running"),
      checkRow("声明完整性校验 declaration-core 1.3.0", "等待预检", "running")
    ].join("");
    $$("#view-contribute .flow-step").forEach((step) => step.classList.remove("done", "current"));
    $("#step-complete").classList.add("done");
    $("#step-check").classList.add("current");
    state.tour = tourForCurrentView();
    renderTour();
    if (instant) finishCheck();
    else checkTimer = setTimeout(finishCheck, 850);
  }
  function checkRow(label, result, tone) {
    return '<div class="check-item ' + tone + '">' + assetIcon(tone === "running" ? "loader" : tone === "blocked" || tone === "unknown" ? "circle-x" : "check") +
      '<strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(result) + '</span></div>';
  }
  function finishCheck() {
    const blocked = state.scenario === "blocked";
    const unavailable = state.scenario === "unavailable";
    state.check = blocked ? "blocked" : unavailable ? "unknown" : "passed";
    $("#check-progress").style.width = "100%";
    $("#check-status").className = "status-pill " + (blocked ? "status-rejected" : unavailable ? "status-running" : "status-success");
    $("#check-status").innerHTML = assetIcon(blocked || unavailable ? "circle-x" : "check") + (blocked ? "发现阻断项" : unavailable ? "检查未完成" : "检查通过");
    $("#check-message").textContent = blocked ? "社区档深扫发现阻断项，需修正后重检。" : unavailable ? "声明预检不可用；这不是技能危险结论，提交已暂停。" : "7 项检查已完成，可以核对将发出的文件。";
    $("#check-list").innerHTML = [
      checkRow("包结构与入口", "通过", ""),
      checkRow("文件大小与数量", state.previewFiles.length + " 个文件 · 未超限", ""),
      checkRow("路径与链接安全", blocked ? "references/guide.md · 本机绝对路径" : "通过", blocked ? "blocked" : ""),
      checkRow("禁止内容与结构质量", "EXTREME 0 项", ""),
      checkRow("安全扫描规则包 v1.0.0", "已加载", ""),
      checkRow("深扫引擎 skill-sentry 2.1.0", blocked ? "社区档 CAUTION · 阻断" : "社区档通过", blocked ? "blocked" : ""),
      checkRow("声明完整性校验 declaration-core 1.3.0", unavailable ? "不可用 · 未能预检" : "声明完整且一致", unavailable ? "unknown" : "")
    ].join("");
    $("#check-footnote").textContent = blocked ? "请修正 references/guide.md 后重新检查；本次没有发出文件。" : unavailable ? "请恢复校验能力后重试；未检查完成时不能提交。" : "本地检查通过，提交前仍请逐个查看文件内容。";
    $("#recheck-button").hidden = false;
    $("#cancel-check-button").hidden = true;
    $("#preview-wrap").hidden = blocked || unavailable;
    if (!blocked && !unavailable) {
      $("#step-check").classList.remove("current");
      $("#step-check").classList.add("done");
      $("#step-preview").classList.add("current");
      state.tour = state.newVersionOf ? "version" : "preview";
      renderTour();
    }
    updateSubmit();
  }
  function cancelCheck() {
    clearTimeout(checkTimer);
    state.check = "cancelled";
    $("#check-progress").style.width = "0";
    $("#check-status").className = "status-pill status-neutral";
    $("#check-status").textContent = "已取消";
    $("#check-message").textContent = "本地检查已取消。";
    $("#check-list").innerHTML = "";
    $("#check-footnote").textContent = "没有文件离开本机；你可以重新检查。";
    $("#cancel-check-button").hidden = true;
    $("#recheck-button").hidden = false;
    $("#preview-wrap").hidden = true;
  }
  function updateSubmit() {
    const ready = state.check === "passed" && draftComplete(state.draft) && Boolean($("#source-type").value) &&
      $("#accept-terms").checked && $("#accept-maintenance").checked;
    $("#submit-contribution").disabled = !ready;
  }
  function showSendingStage() {
    $("#source-type").value = "original";
    $("#accept-terms").checked = true;
    $("#accept-maintenance").checked = true;
    $("#submit-contribution").disabled = true;
    $("#submit-contribution").innerHTML = assetIcon("loader") + "正在提交";
    $("#cancel-submit").hidden = false;
    $("#step-preview").classList.remove("current");
    $("#step-preview").classList.add("done");
    $("#step-send").classList.add("current");
    state.tour = "sending";
    renderTour();
  }
  function submitContribution() {
    if ($("#submit-contribution").disabled) return;
    const skill = skillById(state.skillId);
    const existing = contributions.find((item) => item.localId === skill.id && item.status === "pending");
    if (existing) {
      openDialog("替换待审核提交？",
        "<p>「" + escapeHtml(skill.name) + "」已有一条待审核提交。新提交将替换原提交，Hub 不会保留两条待审核记录。</p>",
        [{ label: "保留原提交", variant: "secondary" }, { label: "替换并提交", variant: "primary", run: () => performSubmit(skill, existing) }]);
      return;
    }
    performSubmit(skill, null);
  }
  function performSubmit(skill, existing) {
    const button = $("#submit-contribution");
    button.disabled = true;
    button.innerHTML = assetIcon("loader") + "正在提交";
    $("#step-preview").classList.remove("current");
    $("#step-preview").classList.add("done");
    $("#step-send").classList.add("current");
    $("#cancel-submit").hidden = false;
    submitTimer = setTimeout(() => {
      submitTimer = 0;
      $("#cancel-submit").hidden = true;
      if (existing) contributions = contributions.filter((item) => item !== existing);
      const old = state.newVersionOf ? historyById(state.newVersionOf) : null;
      const item = {
        id: old ? old.id : "sub_" + Math.random().toString(36).slice(2, 14).toUpperCase(),
        contentId: old ? old.contentId : null,
        localId: skill.id,
        name: state.draft.name,
        version: state.draft.version,
        status: "pending",
        publishedVersion: old ? old.publishedVersion : null,
        submitted: "刚刚",
        rejection: "",
        withdrawal: old ? old.withdrawal : null
      };
      if (old) contributions = contributions.filter((entry) => entry !== old);
      contributions.unshift(item);
      state.selectedHistory = item.id;
      route("contributions", { historyId: item.id });
      showToast("已提交审核，可在「我的贡献」查看进度。");
    }, 680);
  }
  function cancelSubmit() {
    clearTimeout(submitTimer);
    submitTimer = 0;
    $("#cancel-submit").hidden = true;
    $("#step-send").classList.remove("current");
    $("#step-preview").classList.remove("done");
    $("#step-preview").classList.add("current");
    $("#submit-contribution").innerHTML = assetIcon("upload") + "提交审核";
    updateSubmit();
    showToast("已取消提交，预览内容仍在本机。");
  }

  function statusOf(item) {
    if (item.status === "pending") return { text: "待审核", tone: "pending" };
    if (item.status === "rejected") return { text: "已退回", tone: "rejected" };
    if (item.status === "withdrawn") return { text: "已撤回", tone: "withdrawn" };
    if (item.status === "accepted" && item.publishedVersion) return { text: "已接受", tone: "success" };
    return { text: "已接受 · 待发布", tone: "review" };
  }
  function renderContributions() {
    $("#history-search").value = state.historySearch;
    $$(".history-filters button").forEach((button) => button.classList.toggle("selected", button.dataset.filter === state.historyFilter));
    $("#history-total").textContent = contributions.length;
    $("#history-pending").textContent = contributions.filter((item) => item.status === "pending").length;
    $("#history-published").textContent = contributions.filter((item) => Boolean(item.publishedVersion)).length;
    const query = state.historySearch.trim().toLocaleLowerCase();
    const matching = contributions.filter((item) => {
      if (query && !(item.name + " " + item.id).toLocaleLowerCase().includes(query)) return false;
      if (state.historyFilter === "pending") return item.status === "pending";
      if (state.historyFilter === "rejected") return item.status === "rejected";
      if (state.historyFilter === "published") return Boolean(item.publishedVersion);
      if (state.historyFilter === "withdrawal") return Boolean(item.withdrawal);
      return true;
    });
    if (!matching.some((item) => item.id === state.selectedHistory)) state.selectedHistory = matching[0] ? matching[0].id : null;
    $("#history-rows").innerHTML = matching.map((item) => {
      const status = statusOf(item);
      const withdrawal = item.withdrawal ? (item.withdrawal.status === "pending" ? " · 撤回待处置" : " · 已撤回") : "";
      return '<button type="button" class="history-row' + (item.id === state.selectedHistory ? ' selected' : '') +
        '" data-history="' + escapeHtml(item.id) + '"><span class="history-name"><strong>' + escapeHtml(item.name) +
        '</strong><small>' + escapeHtml(item.contentId || item.id) + withdrawal + '</small></span>' +
        '<span class="history-cell"><span class="status-pill status-' + status.tone + '">' + status.text + '</span><small>' +
        escapeHtml(item.submitted) + '</small></span><span class="history-cell">' +
        escapeHtml(item.publishedVersion ? "v" + item.publishedVersion : "—") + '</span></button>';
    }).join("");
    $("#history-empty").hidden = matching.length !== 0;
    $$("#history-rows [data-history]").forEach((button) => button.addEventListener("click", () => {
      state.selectedHistory = button.dataset.history;
      renderContributions();
    }));
    renderHistoryDetail(historyById(state.selectedHistory));
  }
  function renderHistoryDetail(item) {
    const panel = $("#history-detail");
    if (!item) {
      panel.innerHTML = '<div class="empty-state">' + assetIcon("list") + '<strong>选择一项贡献</strong><p>查看状态和可用操作。</p></div>';
      return;
    }
    const status = statusOf(item);
    let message = "";
    let actions = "";
    if (item.status === "pending") {
      message = "运营正在审核此提交。审核前你可以撤回提交。";
      actions = '<button type="button" class="button button-secondary" data-detail-action="withdraw-submission">撤回提交</button>';
    } else if (item.status === "rejected") {
      message = item.rejection || "提交被退回，请修改后重新提交。";
      actions = '<button type="button" class="button button-primary" data-detail-action="resubmit">修改后重新提交</button>';
    } else if (item.status === "withdrawn") {
      message = "这条待审核提交已由你撤回。";
      actions = '<button type="button" class="button button-secondary" data-detail-action="resubmit">重新发起贡献</button>';
    } else {
      message = item.publishedVersion ? "当前发布版本 v" + item.publishedVersion + "。新版本需重新审核和发布。" : "审核已接受，发布角色尚未发布。";
      if (item.publishedVersion) {
        actions = '<button type="button" class="button button-primary" data-detail-action="new-version">提交新版本</button>' +
          (item.withdrawal && item.withdrawal.status === "pending" ? "" : '<button type="button" class="button button-secondary" data-detail-action="request-withdrawal">申请撤回内容</button>');
      }
    }
    panel.innerHTML = '<h2>' + escapeHtml(item.name) + '</h2><span class="detail-id">' + escapeHtml(item.contentId || item.id) +
      '</span><span class="status-pill status-' + status.tone + '">' + status.text + '</span>' +
      '<div class="detail-block"><span class="label">最近提交</span><strong>v' + escapeHtml(item.version) +
      ' · ' + escapeHtml(item.submitted) + '</strong><p>' + escapeHtml(message) + '</p></div>' +
      (item.publishedVersion ? '<div class="detail-block"><span class="label">当前发布版本</span><strong>v' +
        escapeHtml(item.publishedVersion) + '</strong><p>审核接受与内容发布分别记录。</p></div>' : "") +
      (item.withdrawal ? '<div class="detail-block"><span class="label">撤回申请</span><strong>' +
        (item.withdrawal.status === "pending" ? "待治理角色处置" : "已撤回") + '</strong><p>' +
        escapeHtml(item.withdrawal.reason) + '</p></div>' : "") +
      '<div class="detail-actions">' + actions + '</div>';
    panel.querySelectorAll("[data-detail-action]").forEach((button) => button.addEventListener("click", () => detailAction(item, button.dataset.detailAction)));
  }
  function detailAction(item, action) {
    if (action === "resubmit") {
      route("contribute", { skillId: item.localId });
    } else if (action === "new-version") {
      route("contribute", { skillId: item.localId, newVersionOf: item.id });
    } else if (action === "withdraw-submission") {
      openDialog("撤回这条待审核提交？",
        "<p>撤回后这条提交将停止审核。你可以修改本机技能后重新发起贡献。</p>",
        [{ label: "继续等待审核", variant: "secondary" }, { label: "撤回提交", variant: "danger", run: () => {
          item.status = "withdrawn"; item.submitted = "刚刚"; renderContributions(); showToast("待审核提交已撤回。");
        } }]);
    } else if (action === "request-withdrawal") {
      const body = '<p>撤回会影响此内容的全部已发布版本。申请须由内容治理角色处置后才生效；已安装副本不会被删除。</p>' +
        '<label class="reason-field"><span>撤回原因</span><textarea id="withdrawal-reason" rows="3" placeholder="说明申请撤回的原因"></textarea></label>' +
        '<p id="reason-error" style="color:var(--cs-critical)" hidden>请填写撤回原因。</p>';
      openDialog("申请撤回已发布内容？", body,
        [{ label: "保留内容", variant: "secondary" }, { label: "提交撤回申请", variant: "primary", keepOpen: true, run: () => {
          const reason = $("#withdrawal-reason").value.trim();
          if (!reason) { $("#reason-error").hidden = false; $("#withdrawal-reason").focus(); return; }
          item.withdrawal = { status: "pending", reason, requested: "刚刚" };
          $("#app-dialog").close(); renderContributions(); showToast("撤回申请已提交，等待治理角色处置。");
        } }]);
    }
  }
  function openDialog(title, body, buttons) {
    const dialog = $("#app-dialog");
    if (!dialog.open) dialogReturnFocus = document.activeElement;
    $("#dialog-title").textContent = title;
    $("#dialog-body").innerHTML = body;
    $("#dialog-actions").innerHTML = "";
    buttons.forEach((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-" + choice.variant;
      button.textContent = choice.label;
      button.addEventListener("click", () => {
        if (choice.run) choice.run();
        if (!choice.keepOpen) dialog.close();
      });
      $("#dialog-actions").appendChild(button);
    });
    if (!dialog.open) dialog.showModal();
    ($("#dialog-actions .button-primary") || $("#dialog-actions button")).focus();
  }
  function showTerms() {
    openDialog("CogSeed 社区贡献条款 · v1.0",
      '<div class="terms-summary"><p>提交前请阅读条款全文。系统会记录你接受的条款版本与时间。</p>' +
      '<h3>提交与审核</h3><p>你保留技能的知识产权，并允许 Hub 为社区目录存储、展示、检查和分发经发布的内容。每次提交都需经过运营审核；审核接受后仍需显式发布。</p>' +
      '<h3>来源与维护</h3><p>你需要如实声明原创、派生或第三方来源，并确认愿意维护后续版本。这项维护承诺不构成强制义务。</p>' +
      '<h3>撤回与数据</h3><p>审核前可自行撤回提交；已发布内容须申请撤回，由治理角色处置。提交仅包含预览中展示的文件和元信息。</p>' +
      '<p><a href="./terms-v1.0.html" target="_blank" rel="noopener" class="inline-link">在新窗口查看条款全文</a></p></div>',
      [{ label: "返回提交预览", variant: "secondary" }]);
  }
  function navigateTour(stage) {
    const demoSkill = "plugin-creator";
    if (stage === "skills") route("skills", { loggedIn: true, tour: stage });
    else if (stage === "guest") route("skills", { loggedIn: false, tour: stage });
    else if (stage === "login") {
      route("skills", { loggedIn: false, tour: stage });
      showLoginRequired("contribute", { skillId: "imagegen" });
    } else if (stage === "complete") route("contribute", { skillId: "imagegen", loggedIn: true, stage: "complete", tour: stage });
    else if (stage === "check") route("contribute", { skillId: demoSkill, loggedIn: true, stage: "check", tour: stage });
    else if (stage === "blocked") route("contribute", { skillId: demoSkill, loggedIn: true, scenario: "blocked", tour: stage });
    else if (stage === "unavailable") route("contribute", { skillId: demoSkill, loggedIn: true, scenario: "unavailable", tour: stage });
    else if (stage === "preview") route("contribute", { skillId: demoSkill, loggedIn: true, stage: "preview", tour: stage });
    else if (stage === "sending") route("contribute", { skillId: demoSkill, loggedIn: true, stage: "sending", tour: stage });
    else if (stage === "history") {
      state.historyFilter = "all";
      route("contributions", { loggedIn: true, tour: stage });
    }
    else if (stage === "version") route("contribute", { skillId: "skill-creator", newVersionOf: "8a4f01c29d7e", loggedIn: true, stage: "preview", tour: stage });
    else if (stage === "withdraw") {
      state.historyFilter = "all";
      route("contributions", { historyId: "8a4f01c29d7e", loggedIn: true, tour: stage });
      const item = historyById("8a4f01c29d7e");
      if (item) detailAction(item, "request-withdrawal");
    }
  }
  function wire() {
    $$("[data-tour]").forEach((button) => button.addEventListener("click", () => navigateTour(button.dataset.tour)));
    $("#side-skills").addEventListener("click", () => route("skills"));
    $("#account-button").addEventListener("click", () => {
      if (!state.loggedIn) {
        showLoginRequired("skills");
        return;
      }
      openDialog("切换到未登录预览？", "<p>仅改变原型内的模拟登录状态；你可以验证贡献入口仍然可见。</p>",
        [{ label: "保持登录", variant: "secondary" }, { label: "模拟退出登录", variant: "primary", run: () => route("skills", { loggedIn: false, tour: "guest" }) }]);
    });
    $("#back-to-skills").addEventListener("click", () => route("skills"));
    $("#history-back").addEventListener("click", () => route("skills"));
    $("#my-contributions-button").addEventListener("click", () => route("contributions"));
    $("#create-button").addEventListener("click", () => showToast("已打开新建技能入口"));
    $("#more-button").addEventListener("click", () => showToast("已打开更多技能资源"));
    $("#security-button").addEventListener("click", () => showToast("正在重新检查已安装的技能"));
    $$(".segmented button").forEach((button) => button.addEventListener("click", () => { state.category = button.dataset.category; renderSkills(); }));
    $("#skills-search").addEventListener("input", (event) => { state.search = event.target.value; renderSkills(); $("#skills-search").focus(); });
    $("#complete-submit").addEventListener("click", saveCompletion);
    $("#edit-draft").addEventListener("click", showCompletion);
    $("#recheck-button").addEventListener("click", () => { state.scenario = ""; state.stage = "check"; startCheck(); });
    $("#cancel-check-button").addEventListener("click", cancelCheck);
    $("#cancel-submit").addEventListener("click", cancelSubmit);
    $("#source-type").addEventListener("change", (event) => {
      state.sourceType = event.target.value;
      $("#source-hint").textContent = event.target.value === "third-party"
        ? "请在下方补充材料名称和授权来源。"
        : event.target.value === "hub"
          ? "派生副本的上游内容 ID 与版本会随提交保留。"
          : "请如实说明技能的来源。";
      updateSubmit();
    });
    $("#accept-terms").addEventListener("change", updateSubmit);
    $("#accept-maintenance").addEventListener("change", updateSubmit);
    $("#read-terms").addEventListener("click", showTerms);
    $("#submit-contribution").addEventListener("click", submitContribution);
    $$(".history-filters button").forEach((button) => button.addEventListener("click", () => { state.historyFilter = button.dataset.filter; renderContributions(); }));
    $("#history-search").addEventListener("input", (event) => { state.historySearch = event.target.value; renderContributions(); $("#history-search").focus(); });
    $("#refresh-history").addEventListener("click", () => {
      const now = new Date();
      $("#sync-time").textContent = "最近同步 " + now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      showToast("贡献状态已更新。");
    });
    $("#dialog-close").addEventListener("click", () => $("#app-dialog").close());
    $("#app-dialog").addEventListener("close", () => {
      if (!state.loggedIn && state.pendingRoute) {
        state.pendingRoute = null;
        state.tour = tourForCurrentView();
        renderTour();
      }
      if (dialogReturnFocus && dialogReturnFocus.isConnected) dialogReturnFocus.focus();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#card-menu") && !event.target.closest(".card-more")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#card-menu").hidden) {
        const anchor = menuAnchor;
        event.preventDefault(); closeMenu(); if (anchor) anchor.focus();
      }
    });
    $(".workspace").addEventListener("scroll", closeMenu, { passive: true });
    window.addEventListener("popstate", restoreRoute);
    restoreRoute();
  }
  document.addEventListener("DOMContentLoaded", wire);
})();
