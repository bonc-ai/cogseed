/**
 * Ability-asset display status.
 *
 * The store keeps lifecycle in two independent parts: a candidate status
 * (pending / deferred / rejected / promoted) and, once promoted, an asset
 * status (active / paused / revoked) paired with a maturity ladder
 * (seed → bud → transfer_validated → effectiveness_validated). That split is
 * what the governance chain needs — transfer and effectiveness proofs advance
 * maturity independently of whether the user has paused the asset.
 *
 * This module maps that pair onto one display enum. It is read-only: it does
 * not touch candidate status, asset status, or maturity, and nothing it
 * returns is persisted. Display state is derived on every render so it can
 * never drift from the facts it is derived from.
 *
 * It also does not localize. It returns stable enum values that the caller
 * resolves through i18n, so the mapping is testable without a DOM or a locale
 * bundle.
 */
(function () {
  'use strict';

  var DISPLAY = {
    CANDIDATE: 'candidate',
    CONFIRMED: 'confirmed',
    ACTIVE: 'active',
    PAUSED: 'paused',
    /** Terminal on the candidate side; belongs to candidate history, not the register. */
    REJECTED: 'rejected',
    DEPRECATED: 'deprecated',
    /**
     * Any combination this mapping does not recognize, including a promoted
     * candidate whose asset cannot be resolved. Never inferred from a partial
     * match: showing a real-looking status for a record we cannot read would
     * assert something the data does not support.
     */
    UNKNOWN: 'unknown',
  };

  var VALIDATED = { transfer_validated: 1, effectiveness_validated: 1 };
  var UNVALIDATED = { seed: 1, bud: 1 };

  /**
   * Resolve the maturity ladder for a record already known to be promoted or
   * active. Returns null when maturity is missing or unrecognized — the caller
   * turns that into UNKNOWN rather than picking a rung.
   */
  function maturityStage(maturity) {
    if (VALIDATED[maturity]) return DISPLAY.ACTIVE;
    if (UNVALIDATED[maturity]) return DISPLAY.CONFIRMED;
    return null;
  }

  /**
   * @param {{status?: string, maturity?: string}} record candidate or asset
   * @returns {{key: string, note?: string}} `note` carries detail the enum
   *   itself does not encode; today only `deferred`, which would otherwise be
   *   indistinguishable from an untouched pending candidate.
   */
  function abilityAssetDisplayStatus(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { key: DISPLAY.UNKNOWN };
    }

    var status = typeof record.status === 'string' ? record.status : '';
    var maturity = typeof record.maturity === 'string' ? record.maturity : '';

    // ── Candidate side ──────────────────────────────────────
    if (status === 'pending' || status === 'candidate') return { key: DISPLAY.CANDIDATE };
    if (status === 'deferred') return { key: DISPLAY.CANDIDATE, note: 'deferred' };
    if (status === 'rejected') return { key: DISPLAY.REJECTED };

    // A promoted candidate is displayed through its asset. When the asset is
    // missing or unreadable there is no maturity to read, and the honest
    // answer is that we do not know its state.
    if (status === 'promoted') return { key: maturityStage(maturity) || DISPLAY.UNKNOWN };

    // ── Asset side ──────────────────────────────────────────
    // Checked before `active` so a paused or revoked asset keeps its own
    // identity regardless of how far up the maturity ladder it had climbed.
    if (status === 'paused') return { key: DISPLAY.PAUSED };
    if (status === 'revoked') return { key: DISPLAY.DEPRECATED };
    if (status === 'active') return { key: maturityStage(maturity) || DISPLAY.UNKNOWN };

    return { key: DISPLAY.UNKNOWN };
  }

  /** i18n key for a display status, resolved by the caller. */
  function abilityAssetDisplayStatusI18nKey(key) {
    return 'cognition.display_status_' + key;
  }

  var api = {
    DISPLAY: DISPLAY,
    abilityAssetDisplayStatus: abilityAssetDisplayStatus,
    abilityAssetDisplayStatusI18nKey: abilityAssetDisplayStatusI18nKey,
  };

  if (typeof globalThis === 'object') globalThis.OrkasAbilityAssetStatus = api;
  if (typeof module !== 'undefined' && typeof module.exports === 'object') module.exports = api;
})();
