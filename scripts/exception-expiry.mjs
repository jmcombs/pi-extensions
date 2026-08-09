/**
 * exception-expiry.mjs — One review date, shared by every deliberate exception.
 *
 * This repo currently grants one exception for an upstream constraint outside
 * our control:
 *
 *   1. .github/dependabot.yml — ignores @types/node majors, holding the types
 *      at the v22 line that pi's engines (>=22.19.0) actually target.
 *
 * (The previous brace-expansion audit allowlist was removed when
 * pi-coding-agent >=0.84.0 refreshed its shrinkwrap pins.)
 *
 * The Dependabot ignore has no natural expiry signal — it simply persists.
 * A shared review date means a scheduled conversation re-examines it rather
 * than it quietly becoming permanent.
 *
 * When this date passes, the gate fails. That is the point: decide again,
 * then move the date forward or remove the exception.
 */

export const EXCEPTIONS_EXPIRE = "2026-11-01";

/** @param {string} isoDate YYYY-MM-DD @returns {boolean} */
export function isExpired(isoDate) {
  return isoDate <= new Date().toISOString().slice(0, 10);
}
