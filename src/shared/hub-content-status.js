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
  const api = { hubContentStatus, isHubContentDisabled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HubContentStatus = api;
})(globalThis);
