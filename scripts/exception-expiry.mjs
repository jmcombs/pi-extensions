/**
 * exception-expiry.mjs — Review dates for every deliberate exception.
 *
 * Dependabot ignores (and any future audit allowlist entries) have no natural
 * end. Without an expiry they suppress updates forever. Each exception class
 * carries a date; past that date the gate fails so the decision is made again.
 *
 * Two clocks on purpose:
 *
 *   1. EXCEPTIONS_EXPIRE — longer-lived policy (e.g. @types/node majors held
 *      at the v22 line that pi's engines (>=22.19.0) actually target).
 *   2. SHORT_EXCEPTIONS_EXPIRE — short holds (e.g. dev-only transitive
 *      security noise we refuse to force-bump while upstream is silent).
 *
 * YAML `# expires:` comments must match one of these constants exactly
 * (enforced by check-dependabot-ignores.mjs). When a date passes: remove the
 * exception, or move the matching constant forward and update the comments.
 */

/** Longer-lived policy exceptions. */
export const EXCEPTIONS_EXPIRE = "2026-11-01";

/** Short holds (≈30 days from 2026-08-09). */
export const SHORT_EXCEPTIONS_EXPIRE = "2026-09-08";

/** Every date check-dependabot-ignores.mjs will accept on an ignore entry. */
export const VALID_EXCEPTION_EXPIRIES = Object.freeze([EXCEPTIONS_EXPIRE, SHORT_EXCEPTIONS_EXPIRE]);

/** @param {string} isoDate YYYY-MM-DD @returns {boolean} */
export function isExpired(isoDate) {
  return isoDate <= new Date().toISOString().slice(0, 10);
}

/** @param {string} isoDate YYYY-MM-DD @returns {boolean} */
export function isKnownExpiry(isoDate) {
  return VALID_EXCEPTION_EXPIRIES.includes(isoDate);
}
