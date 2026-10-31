/*
 * v2 migration status (serves /api/v2/migration).
 *   GET  -> { match, months: [{ month, v1IncomeCents, v2IncomeCents, v1SpendingCents, v2SpendingCents, match }], mirroredAt }
 *        The Phase 0 gate: classic actuals vs the new model, per plan month.
 *   POST -> the same, after re-running the mirror from scratch.
 */
import { handleV2 } from "../_v2http.js";
import { compareTotals, mirrorV1 } from "../_v2mirror.js";

export const onRequestGet = (context) => handleV2(context, async ({ db, s }) =>
  Object.assign(await compareTotals(db), { mirroredAt: await s.getSetting("mirrored_at") }));

export const onRequestPost = (context) => handleV2(context, async ({ db, s }) => {
  await mirrorV1(db, { force: true });
  return Object.assign(await compareTotals(db), { mirroredAt: await s.getSetting("mirrored_at") });
}, { skipMirror: true });
