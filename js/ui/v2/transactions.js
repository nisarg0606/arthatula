/* Transactions screen: one feed of every money movement, with search,
   filters, a to-review queue (with "Mark all reviewed"), the rows
   Gemini checked for you, and an edit dialog (category, merchant,
   amount, my share, notes, tags, hide, split). */
import { PAGE_SIZE, clampPage, pager } from "../pager.js";
import { keepScroll } from "../scroll.js";
import {
  v2, api, h, clear, money, parseMoney, dayLabel, todayIso, loadBasics, categoryById, accountById, categoryName,
  categorySelect, accountSelect, field, openDialog, section, button, emptyState, errorState, loading
} from "./kit.js";

const state = { q: "", accountId: "", categoryId: "", month: "", review: false, auto: false, page: 1, list: [], total: 0 };
let root = null, listEl = null, countEl = null;

/* Jump here from another screen with a filter already set. */
export function showFiltered(filter) {
  Object.assign(state, { q: "", accountId: "", categoryId: "", month: "", review: false, auto: false, page: 1 }, filter || {});
}

/* Re-read the list in place (after auto-review, from ./index.js). */
export function refresh() { if (listEl && listEl.isConnected) load(); }

function query() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.accountId) p.set("accountId", state.accountId);
  if (state.categoryId) p.set("categoryId", state.categoryId);
  if (state.month) { p.set("from", state.month + "-01"); p.set("to", state.month + "-31"); }
  if (state.review) p.set("review", "1");
  if (state.auto) p.set("auto", "1");
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String((state.page - 1) * PAGE_SIZE));
  return "transactions?" + p.toString();
}

/* Re-reads the list and swaps it in place: the "Loading…" placeholder
   only shows when there is nothing on screen yet, and the scroll
   position stays put (see ../scroll.js). */
function load() {
  if (!listEl.firstChild) loading(listEl);
  return api("GET", query()).then(function (r) {
    state.list = r.transactions; state.total = r.total;
    /* The list got shorter (reviewed, deleted): step back to its last page. */
    const last = clampPage(state.page, r.total);
    if (last !== state.page) { state.page = last; return load(); }
    keepScroll(drawList);
  }).catch(function (e) { errorState(listEl, e); });
}

/* The chip on a row auto-review took off To review. */
function autoLabel(a) {
  if (a.decision === "duplicate") return "✓ Already in daily log";
  return a.by === "gemini" ? "✓ Checked by AI" : "✓ Matched past payments";
}

function amountClass(t) { return t.amountCents > 0 ? "v2-amt in" : "v2-amt"; }

function txRow(t) {
  const cat = t.splits.length ? "Split · " + t.splits.length + " categories" : categoryName(t.categoryId);
  const acct = accountById(t.accountId);
  return h("button", { class: "v2-tx" + (t.needsReview ? " review" : "") + (t.excludeReports ? " excluded" : ""), attrs: { type: "button", "data-tx": t.id }, on: { click: function () { editTx(t); } } },
    h("span", { class: "v2-tx-main" },
      h("span", { class: "v2-tx-merchant", text: t.merchant || t.description || "(no name)" }),
      h("span", { class: "v2-tx-sub" },
        h("span", { class: "v2-chip", text: cat }),
        acct ? h("span", { class: "v2-tx-acct", text: acct.name }) : null,
        t.needsReview ? h("span", { class: "v2-chip warn", text: "To review" }) : null,
        t.autoReview ? h("span", { class: "v2-chip ai", text: autoLabel(t.autoReview), attrs: { title: t.autoReview.reason } }) : null,
        t.excludeReports ? h("span", { class: "v2-chip muted", text: "Not counted" }) : null,
        t.tags.map(function (tag) { return h("span", { class: "v2-tag", text: "#" + tag }); }),
        t.notes ? h("span", { class: "v2-tx-note", text: t.notes }) : null)),
    h("span", { class: "v2-tx-right" },
      h("span", { class: amountClass(t), text: money(t.amountCents, { signed: true }) }),
      t.myShareCents !== null ? h("span", { class: "v2-tx-share", text: "mine " + money(t.myShareCents) }) : null));
}

/* Everything on To review, as it is, in one go. Instant like a single
   "Mark reviewed": the list empties now and the save runs behind it. */
function markAllReviewed() {
  const n = state.total;
  if (!n || !window.confirm("Mark all " + n + " transactions on To review as reviewed? Each keeps the category it has now.")) return;
  state.list = []; state.total = 0;
  keepScroll(drawList);
  return api("PATCH", "transactions", { reviewAll: true })
    .then(load, function (e) { window.alert("Couldn't mark them reviewed: " + e.message); load(); });
}

function drawList() {
  clear(listEl);
  countEl.textContent = state.total === 1 ? "1 transaction" : state.total + " transactions";
  if (state.review && state.total > 0) {
    listEl.appendChild(h("div", { class: "v2-bulk" },
      h("span", { class: "hint", text: state.total === 1 ? "1 transaction waits for you." : state.total + " transactions wait for you." }),
      button("Mark all reviewed", markAllReviewed, "btn-primary", { id: "v2ReviewAll" })));
  }
  if (state.auto && state.total > 0) {
    listEl.appendChild(h("p", { class: "hint v2-bulk", text: "These were taken off To review because they match what you did before. They are counted. Open one and choose \u201cNot right\u201d if it isn\u2019t." }));
  }
  if (!state.list.length) {
    listEl.appendChild(emptyState(state.review ? "Nothing to review — every transaction has a category." : state.auto ? "Nothing here: the AI hasn't taken anything off To review." : "No transactions match."));
    return;
  }
  let day = null, group = null;
  state.list.forEach(function (t) {
    if (t.date !== day) {
      day = t.date;
      group = h("div", { class: "v2-tx-day" }, h("h3", { class: "v2-day-head", text: dayLabel(day) }));
      listEl.appendChild(group);
    }
    group.appendChild(txRow(t));
  });
  const pages = pager(state.page, state.total, function (n) { state.page = n; load(); }, listEl);
  if (pages) listEl.appendChild(pages);
}

/* ---- edit / add dialog ---- */
function splitEditor(t, base) {
  const wrap = h("div", { class: "v2-splits" });
  const rows = [];
  function addRow(catId, cents) {
    const sel = categorySelect(catId, { kinds: ["expense", "income"] });
    const amt = h("input", { attrs: { type: "text", inputmode: "decimal", "aria-label": "Split amount" }, value: cents ? (Math.abs(cents) / 100).toFixed(2) : "" });
    const row = h("div", { class: "v2-split-row" }, sel, amt, button("Remove", function () {
      rows.splice(rows.indexOf(entry), 1); wrap.removeChild(row);
    }, "danger"));
    const entry = { sel: sel, amt: amt };
    rows.push(entry);
    wrap.insertBefore(row, addBtn);
  }
  const addBtn = button("+ Add a part", function () { addRow(null, 0); });
  wrap.appendChild(addBtn);
  (t && t.splits.length ? t.splits : []).forEach(function (s) { addRow(s.categoryId, s.amountCents); });
  return {
    el: wrap,
    value: function () {
      if (!rows.length) return [];
      const sign = base < 0 ? -1 : 1;
      return rows.map(function (r) {
        const c = parseMoney(r.amt.value);
        if (c === null) throw new Error("Each split part needs an amount.");
        return { categoryId: r.sel.value, amountCents: sign * Math.abs(c) };
      });
    }
  };
}

function editTx(t) {
  const isNew = !t;
  const tx = t || { date: todayIso(), merchant: "", amountCents: -0, myShareCents: null, categoryId: null, notes: "", tags: [], hidden: false, splits: [], source: "manual", accountId: null };
  const fromBank = tx.source === "v1bank" || tx.source === "v1actual";
  const merchant = h("input", { attrs: { type: "text", maxlength: "300", disabled: fromBank }, value: tx.merchant });
  const date = h("input", { attrs: { type: "date", disabled: fromBank }, value: tx.date });
  const dir = h("select", { attrs: { "aria-label": "Money in or out", disabled: fromBank } },
    h("option", { value: "out", text: "Money out" }), h("option", { value: "in", text: "Money in" }));
  dir.value = tx.amountCents > 0 ? "in" : "out";
  const amount = h("input", { attrs: { type: "text", inputmode: "decimal", disabled: fromBank, placeholder: "0.00" }, value: tx.amountCents ? (Math.abs(tx.amountCents) / 100).toFixed(2) : "" });
  const share = h("input", { attrs: { type: "text", inputmode: "decimal", placeholder: "All mine", disabled: tx.source === "v1actual" || tx.source === "v1bank" }, value: tx.myShareCents !== null ? (Math.abs(tx.myShareCents) / 100).toFixed(2) : "" });
  const cat = categorySelect(tx.categoryId, { allowNone: true });
  const acct = accountSelect(tx.accountId);
  if (!isNew && tx.source !== "manual") acct.disabled = true;
  const notes = h("textarea", { attrs: { maxlength: "500", rows: "2" }, value: tx.notes });
  const tags = h("input", { attrs: { type: "text", placeholder: "e.g. trip, work" }, value: tx.tags.join(", ") });
  const hidden = h("input", { attrs: { type: "checkbox" } });
  hidden.checked = !!tx.hidden;
  const splitOn = h("input", { attrs: { type: "checkbox" } });
  splitOn.checked = tx.splits.length > 0;
  const splits = splitEditor(tx, tx.amountCents || -1);
  splits.el.hidden = !splitOn.checked;
  splitOn.addEventListener("change", function () { splits.el.hidden = !splitOn.checked; });

  const body = h("div", { class: "v2-form" },
    tx.autoReview ? h("p", { class: "v2-ai-note" },
      h("strong", { text: autoLabel(tx.autoReview).replace(/^✓ /, "") + ": " }),
      h("span", { text: tx.autoReview.reason || "It matches payments you had before." })) : null,
    fromBank ? h("p", { class: "hint", text: tx.source === "v1bank" ? "From your bank: the name, date and amount come from the bank." : "From the Month editor: change the amount there." }) : null,
    field("Merchant", merchant),
    h("div", { class: "v2-form-row" }, field("Date", date), field("Direction", dir), field("Amount ($)", amount)),
    h("div", { class: "v2-form-row" }, field("Category", cat), field("Account", acct)),
    field("My share ($)", share, "For a shared expense: only your part counts in budgets and reports."),
    field("Notes", notes),
    field("Tags (comma-separated)", tags),
    h("label", { class: "switch-label v2-check" }, hidden, h("span", { text: "Hide this transaction everywhere" })),
    h("label", { class: "switch-label v2-check" }, splitOn, h("span", { text: "Split across categories" })),
    splits.el);

  function collect() {
    const p = {};
    const a = parseMoney(amount.value);
    if (!fromBank) {
      if (!merchant.value.trim()) throw new Error("Add a merchant or description.");
      if (a === null || a === 0) throw new Error("Enter an amount.");
      const signed = (dir.value === "in" ? 1 : -1) * Math.abs(a);
      if (isNew || signed !== tx.amountCents) p.amountCents = signed;
      if (isNew || merchant.value.trim() !== tx.merchant) p.merchant = merchant.value.trim();
      if (isNew || date.value !== tx.date) p.date = date.value;
    }
    const base = p.amountCents !== undefined ? p.amountCents : tx.amountCents;
    if (!share.disabled) {
      const sh = share.value.trim() === "" ? null : parseMoney(share.value);
      const signedShare = sh === null ? null : (base < 0 ? -1 : 1) * Math.abs(sh);
      if (signedShare !== tx.myShareCents) p.myShareCents = signedShare;
    }
    if ((cat.value || null) !== tx.categoryId || isNew) p.categoryId = cat.value || null;
    if (notes.value.trim() !== tx.notes) p.notes = notes.value.trim();
    const tagList = tags.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (tagList.join(",") !== tx.tags.join(",")) p.tags = tagList;
    if (hidden.checked !== !!tx.hidden) p.hidden = hidden.checked;
    if (!isNew && (acct.value || null) !== tx.accountId && tx.source === "manual") p.accountId = acct.value || null;
    if (splitOn.checked) p.splits = splits.value();
    else if (tx.splits.length) p.splits = [];
    return p;
  }

  const actions = [{
    label: isNew ? "Add transaction" : "Save", primary: true, onClick: function (close) {
      const p = collect();
      const req = isNew
        ? api("POST", "transactions", { date: p.date, merchant: p.merchant, amountCents: p.amountCents, categoryId: p.categoryId, notes: p.notes, tags: p.tags, accountId: acct.value || null })
          .then(function (r) { return p.splits && p.splits.length || p.myShareCents !== undefined ? api("PATCH", "transactions", { id: r.transaction.id, patch: { splits: p.splits, myShareCents: p.myShareCents } }) : r; })
        : (Object.keys(p).length ? api("PATCH", "transactions", { id: tx.id, patch: p }) : Promise.resolve());
      return req.then(function () { close(); load(); });
    }
  }];
  if (!isNew && tx.needsReview) actions.push({ label: "Mark reviewed", onClick: function (close) {
    /* Instant: the row updates (or leaves the To review filter) now; the
       save runs in the background and the row comes back if it fails. */
    close();
    const row = state.list.find(function (x) { return x.id === tx.id; });
    if (row) row.needsReview = false;
    if (state.review) { state.list = state.list.filter(function (x) { return x.id !== tx.id; }); state.total -= 1; }
    keepScroll(drawList);
    return api("PATCH", "transactions", { id: tx.id, patch: { needsReview: false } })
      .then(load, function (e) { window.alert("Couldn't mark it reviewed: " + e.message); load(); });
  } });
  if (!isNew && tx.autoReview) {
    /* Same instant pattern: the row changes now, the save follows. */
    const verdict = function (backToReview) {
      return function (close) {
        close();
        const row = state.list.find(function (x) { return x.id === tx.id; });
        if (row) { row.autoReview = null; row.needsReview = backToReview; }
        if (state.auto) { state.list = state.list.filter(function (x) { return x.id !== tx.id; }); state.total -= 1; }
        keepScroll(drawList);
        return api("PATCH", "transactions", { id: tx.id, patch: { needsReview: backToReview } })
          .then(load, function (e) { window.alert("Couldn't save that: " + e.message); load(); });
      };
    };
    actions.push({ label: "Looks right", onClick: verdict(false) });
    actions.push({ label: "Not right — I'll review it", onClick: verdict(true) });
  }
  if (!isNew && (tx.source === "manual" || tx.source === "v1exp")) {
    actions.push({ label: "Delete", danger: true, onClick: function (close) {
      if (!window.confirm("Delete this transaction?" + (tx.source === "v1exp" ? " It is also removed from the classic daily log." : ""))) return;
      return api("DELETE", "transactions?id=" + encodeURIComponent(tx.id)).then(function () { close(); load(); });
    } });
  }
  openDialog(isNew ? "Add a transaction" : (tx.merchant || "Transaction"), body, actions);
}

function filters() {
  const search = h("input", { class: "v2-search", attrs: { type: "search", placeholder: "Search merchant, notes, tags", "aria-label": "Search transactions" }, value: state.q });
  let timer = null;
  search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { state.q = search.value.trim(); state.page = 1; load(); }, 250); });
  const acct = accountSelect(state.accountId, { noneLabel: "All accounts", label: "Filter by account" });
  acct.addEventListener("change", function () { state.accountId = acct.value; state.page = 1; load(); });
  const cat = categorySelect(state.categoryId, { allowNone: true, noneLabel: "All categories", label: "Filter by category" });
  cat.addEventListener("change", function () { state.categoryId = cat.value; state.page = 1; load(); });
  const month = h("input", { attrs: { type: "month", "aria-label": "Filter by month" }, value: state.month });
  month.addEventListener("change", function () { state.month = month.value; state.page = 1; load(); });
  const review = h("input", { attrs: { type: "checkbox" } });
  review.checked = state.review;
  const auto = h("input", { attrs: { type: "checkbox" } });
  auto.checked = state.auto;
  /* The two are either/or: ticking one unticks the other. */
  review.addEventListener("change", function () { state.review = review.checked; if (review.checked) { state.auto = false; auto.checked = false; } state.page = 1; load(); });
  auto.addEventListener("change", function () { state.auto = auto.checked; if (auto.checked) { state.review = false; review.checked = false; } state.page = 1; load(); });
  return h("div", { class: "v2-filters" }, search, acct, cat, month,
    h("label", { class: "switch-label v2-check" }, review, h("span", { text: "To review only" })),
    h("label", { class: "switch-label v2-check" }, auto, h("span", { text: "Checked by AI" })));
}

export function render(container) {
  root = container;
  loading(root);
  return loadBasics().then(function () {
    clear(root);
    countEl = h("p", { class: "hint v2-count" });
    listEl = h("div", { class: "v2-tx-list", attrs: { "aria-live": "polite" } });
    root.appendChild(section("Transactions", [button("+ Add transaction", function () { editTx(null); }, "btn-primary", { id: "v2AddTx" })],
      h("div", null, filters(), countEl, listEl)));
    return load();
  }).catch(function (e) { errorState(root, e); });
}

export { editTx };
