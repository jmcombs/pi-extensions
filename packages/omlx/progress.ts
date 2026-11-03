/**
 * Load-progress ratio for the `/omlx` progress view.
 *
 * omlx does not report byte-level load progress. The admin dashboard estimates
 * from elapsed time once it has two observations (`admin/routes.py`). This is
 * that estimate: elapsed over `max(3, 1 + size_GiB * seconds_per_gb)`, capped
 * at 0.99 so the bar never shows complete before the model is loaded.
 *
 * `now` and `row.loading_started_at` must share a clock. The status field is
 * the server's `time.monotonic()` value, not unix time, so callers pass a
 * `now` in that same clock.
 */

import type { OmlxModelStatus, OmlxStatusRow } from "./client.js";

const RATIO_CAP = 0.99;
const ESTIMATE_FLOOR_SECONDS = 3;
const GIB = 1024 ** 3;

/**
 * Estimated fraction of the load that has elapsed.
 *
 * Returns `undefined` when omlx has fewer than two load-time observations, or
 * when the estimate or the start timestamp is missing. A missing size counts
 * as 0, matching the dashboard's `estimated_size` default.
 */
export function loadRatio(
  row: OmlxStatusRow,
  status: OmlxModelStatus,
  now: number,
): number | undefined {
  if (status.load_time_observations < 2) return undefined;
  const secondsPerGb = status.load_seconds_per_gb_estimate;
  if (secondsPerGb === null || !Number.isFinite(secondsPerGb) || secondsPerGb <= 0) {
    return undefined;
  }
  if (row.loading_started_at === null || !Number.isFinite(row.loading_started_at)) {
    return undefined;
  }
  if (!Number.isFinite(now)) return undefined;
  const sizeBytes = row.estimated_size ?? 0;
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  const elapsed = Math.max(0, now - row.loading_started_at);
  const estimatedSeconds = Math.max(ESTIMATE_FLOOR_SECONDS, 1 + (sizeBytes / GIB) * secondsPerGb);
  if (!Number.isFinite(estimatedSeconds) || estimatedSeconds <= 0) return undefined;
  return Math.min(RATIO_CAP, elapsed / estimatedSeconds);
}
