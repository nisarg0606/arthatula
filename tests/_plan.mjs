/* Pins the client plan to what the suites were written against (Oct
   2026 – Oct 2027, baseline 2026-10-26); otherwise it follows today. */
import { blankState, planMonthKeys, setPlanMonths } from "../js/core/plan.js";

setPlanMonths(planMonthKeys("2026-10"));

export function blank() {
  const s = blankState();
  s.baselineDate = "2026-10-26";
  return s;
}
