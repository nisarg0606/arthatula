/* Page controls for long lists: "51–100 of 1,500" and ‹ 1 … 4 5 6 … 30 ›.
   Lists render one page at a time; a page change calls onGo(page) and
   brings the list's top back into view. */
export const PAGE_SIZE = 50;

export function pageCount(total, size) { return Math.max(1, Math.ceil(total / (size || PAGE_SIZE))); }

/* Clamp a remembered page to the list's current length. */
export function clampPage(page, total, size) { return Math.min(Math.max(1, page || 1), pageCount(total, size)); }

/* The page numbers to show: first, last, and the current one ±1, with
   0 standing for a gap ("…"). */
export function pageNumbers(page, pages) {
  var out = [];
  for (var n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) out.push(n);
    else if (out[out.length - 1] !== 0) out.push(0);
  }
  return out;
}

export function rangeLabel(page, total, size) {
  size = size || PAGE_SIZE;
  if (!total) return "0 items";
  var from = (page - 1) * size + 1, to = Math.min(total, page * size);
  return from.toLocaleString("en-US") + "–" + to.toLocaleString("en-US") + " of " + total.toLocaleString("en-US");
}

/* Returns the controls, or null when everything fits on one page.
   `top` is the element to scroll back to after a page change. */
export function pager(page, total, onGo, top, size) {
  var pages = pageCount(total, size);
  if (pages <= 1) return null;
  var nav = document.createElement("nav");
  nav.className = "pager";
  nav.setAttribute("aria-label", "Pages");
  function go(n) {
    onGo(n);
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }
  function btn(label, n, aria, current) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "pager-btn" + (current ? " current" : "");
    b.textContent = label;
    if (aria) b.setAttribute("aria-label", aria);
    if (current) b.setAttribute("aria-current", "page");
    if (n < 1 || n > pages || current) b.disabled = true;
    else b.addEventListener("click", function () { go(n); });
    return b;
  }
  nav.appendChild(btn("‹", page - 1, "Previous page"));
  pageNumbers(page, pages).forEach(function (n) {
    if (n === 0) {
      var gap = document.createElement("span");
      gap.className = "pager-gap"; gap.textContent = "…"; gap.setAttribute("aria-hidden", "true");
      nav.appendChild(gap);
    } else nav.appendChild(btn(String(n), n, "Page " + n, n === page));
  });
  nav.appendChild(btn("›", page + 1, "Next page"));
  var label = document.createElement("span");
  label.className = "pager-label";
  label.textContent = rangeLabel(page, total, size);
  nav.appendChild(label);
  return nav;
}
