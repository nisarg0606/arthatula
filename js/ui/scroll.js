/* Keep the reader's place while part of the page is rebuilt.

   Lists here are rebuilt by clearing them and adding the rows back. For
   that moment the page is shorter, the browser clamps the scroll
   position, and after the rebuild the reader is left higher up the page
   (often at the top). keepScroll() holds the page at its current height
   while fn() runs, so there is nothing to clamp to, then puts the scroll
   position back. Nested calls are fine. */
export function keepScroll(fn) {
  var root = document.documentElement;
  var y = window.scrollY;
  var prev = root.style.minHeight;
  root.style.minHeight = root.scrollHeight + "px";
  try {
    return fn();
  } finally {
    root.style.minHeight = prev;
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  }
}
