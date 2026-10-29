/* Shared by classic Renderer scripts, Main and the Skill runner.
 * FR-004: status/state strings are authoritative; the boolean disabled is not.
 * Hub governance is independent of the user's enabled preference.
 */
(function (root) {
  function hubContentStatus(row) {
    const status = typeof row?.status === 'string' ? row.status.trim() : '';
    const state = typeof row?.state === 'string' ? row.state.trim() : '';
    return (status || state).toLowerCase();
  }
  function isHubContentDisabled(row) {
    return hubContentStatus(row) === 'disabled';
  }
  // 可作为依赖安装的状态。Hub 的内容状态是 `published` / `disabled`；旧市场服务用 `approved`。
  // 两种写法都表示"已发布且可用"，其余（draft、pending、disabled、空）一律不算。
  function isHubContentInstallable(row) {
    const status = hubContentStatus(row);
    return status === 'published' || status === 'approved';
  }
  const api = { hubContentStatus, isHubContentDisabled, isHubContentInstallable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HubContentStatus = api;
})(globalThis);
