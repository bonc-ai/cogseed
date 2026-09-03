// ─── 知识库生态 · 发现面板（S4）— classic script (window.renderKbDiscover) ───
// 计划书 v1.3 §四.8/9：知识库市场（精选/分类/推荐）+ MCP 市场 + Skills 市场。
// 状态：**待开发** —— 不展示内置示例市场数据，进入发现页显示占位提示。
(function () {
  function renderKbDiscover() {
    const host = document.getElementById('kb-discover');
    if (!host) return;
    host.innerHTML = `
      <div class="kb-eco-coming">
        <div class="kb-eco-coming-ico">🧭</div>
        <div class="kb-eco-coming-title">发现 · 待开发</div>
        <div class="kb-eco-coming-sub">知识库市场 / MCP 市场 / Skills 市场正在规划中，
          上线后将在「发现」中聚合可订阅的知识库与工具。当前可先在「知识库」中使用
          个人库 / 共享库的问答、解析与脑图功能。</div>
      </div>`;
  }

  window.renderKbDiscover = renderKbDiscover;
})();
