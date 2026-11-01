import { test } from "node:test";
import assert from "node:assert/strict";
import { pageNumbers, rangeLabel, clampPage, pageCount } from "../js/ui/pager.js";

test("page numbers: first, last, current ±1, gaps as 0", () => {
  assert.deepEqual(pageNumbers(5, 30), [1, 0, 4, 5, 6, 0, 30]);
  assert.deepEqual(pageNumbers(1, 30), [1, 2, 0, 30]);
  assert.deepEqual(pageNumbers(30, 30), [1, 0, 29, 30]);
  assert.deepEqual(pageNumbers(2, 4), [1, 2, 3, 4]);
});

test("range label and clamping", () => {
  assert.equal(rangeLabel(1, 1500), "1–50 of 1,500");
  assert.equal(rangeLabel(30, 1490), "1,451–1,490 of 1,490");
  assert.equal(pageCount(0), 1);
  assert.equal(clampPage(9, 120), 3);
  assert.equal(clampPage(0, 120), 1);
  assert.equal(clampPage(undefined, 10), 1);
});
