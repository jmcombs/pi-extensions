/**
 * exception-expiry.mjs — One review date, shared by every deliberate exception.
 *
 * This repo currently grants two exceptions, both for the same underlying
 * reason (upstream constraints outside our control):
 *
 *   1. scripts/check-audit.mjs         — allowlists GHSA-mh99-v99m-4gvg,
 *      unfixable while pi-coding-agent's npm-shrinkwrap.json pins it.
 *   2. .github/dependabot.yml          — ignores @types/node majors, holding
 *      the types at the v22 line that pi's engines (>=22.19.0) actually
 *      target.
 *
 * Neither has a natural expiry signal — an advisory nobody has fixed and a
 * Dependabot rule both simply persist. Sharing one date means a single
 * scheduled conversation re-examines all of them together, rather than each
 * quietly becoming permanent on its own timeline.
 *
 * When this date passes, the gate fails. That is the point: decide again,
 * then move the date forward or remove the exception.
 */

export const EXCEPTIONS_EXPIRE = "2026-11-01";

/** @param {string} isoDate YYYY-MM-DD @returns {boolean} */
export function isExpired(isoDate) {
  return isoDate <= new Date().toISOString().slice(0, 10);
}
