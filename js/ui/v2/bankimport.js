/* Getting bank rows in without Plaid: a statement CSV (read and mapped
   here, see ../../core/csvimport.js) or SimpleFIN Bridge (US banks; the
   server holds the connection, see functions/api/v2/simplefin.js). */
import { parseCsv, detect, toTransactions, ROLE_NAMES } from "../../core/csvimport.js";
import { api, h, clear, money, dayLabel, loadBasics, accountSelect, field, openDialog } from "./kit.js";

const ROLE_LABELS = {
  date: "Date", description: "Description", amount: "Amount (one column)", debit: "Money out / Debit",
  credit: "Money in / Credit", type: "Dr / Cr column", balance: "Balance"
};
const PREVIEW = 5;

function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

export function openCsvImport(done) {
  let cells = null, mapping = null, parsed = { rows: [], skipped: 0 };
  const file = h("input", { attrs: { type: "file", accept: ".csv,.txt,text/csv", id: "v2CsvFile" } });
  const acct = accountSelect("", { noneLabel: "+ New account" });
  const newName = h("input", { attrs: { type: "text", maxlength: "100", placeholder: "e.g. HDFC Savings" } });
  const newType = h("select", { attrs: { "aria-label": "New account type" } },
    h("option", { value: "depository", text: "Bank account" }), h("option", { value: "credit", text: "Credit card" }));
  const newWrap = h("div", { class: "v2-form-row" }, field("New account name", newName), field("Type", newType));
  acct.addEventListener("change", function () { newWrap.hidden = !!acct.value; });
  const mapEl = h("div", { class: "v2-form" });
  const previewEl = h("div", { class: "v2-import-preview", attrs: { "aria-live": "polite" } });

  function recompute() {
    parsed = toTransactions(cells, mapping);
    clear(previewEl);
    if (!parsed.rows.length) {
      previewEl.appendChild(h("p", { class: "auth-error", text: "No transactions found with these columns. Check the Date and Amount columns above." }));
      return;
    }
    const dates = parsed.rows.map(function (r) { return r.date; }).sort();
    previewEl.appendChild(h("p", { class: "hint", text: plural(parsed.rows.length, "transaction", "transactions") + ", " + dayLabel(dates[0]) + " – " + dayLabel(dates[dates.length - 1]) +
      (parsed.skipped ? " · " + plural(parsed.skipped, "line", "lines") + " that aren't transactions will be left out" : "") }));
    parsed.rows.slice(0, PREVIEW).forEach(function (r) {
      previewEl.appendChild(h("div", { class: "v2-import-row" },
        h("span", { class: "v2-import-date", text: dayLabel(r.date) }),
        h("span", { class: "v2-import-desc", text: r.description }),
        h("span", { class: r.amountCents > 0 ? "v2-amt in" : "v2-amt", text: money(r.amountCents, { signed: true }) })));
    });
  }

  function columnSelect(role) {
    const sel = h("select", { attrs: { "aria-label": ROLE_LABELS[role] + " column" } }, h("option", { value: "-1", text: "—" }),
      mapping.headers.map(function (name, i) { return h("option", { value: String(i), text: name || "Column " + (i + 1) }); }));
    sel.value = String(mapping.columns[role]);
    sel.addEventListener("change", function () { mapping.columns[role] = Number(sel.value); drawMapping(); recompute(); });
    return field(ROLE_LABELS[role], sel);
  }

  function drawMapping() {
    clear(mapEl);
    const c = mapping.columns;
    mapEl.appendChild(h("p", { class: "hint", text: mapping.ok ? "We matched these columns. Fix any that look wrong." : "We couldn't tell which column is which. Pick them below." }));
    mapEl.appendChild(h("div", { class: "v2-form-row" }, ROLE_NAMES.map(columnSelect)));
    const order = h("select", { attrs: { "aria-label": "Date format" } },
      h("option", { value: "dmy", text: "Day first (31/01/2026)" }), h("option", { value: "mdy", text: "Month first (01/31/2026)" }));
    order.value = mapping.dateOrder || "dmy";
    if (!mapping.dateOrder) mapping.dateOrder = "dmy";
    order.addEventListener("change", function () { mapping.dateOrder = order.value; recompute(); });
    mapEl.appendChild(field("Dates are written", order, "Only matters for dates like 03/04/2026."));
    if (c.amount !== -1 && c.type === -1) {
      const flip = h("input", { attrs: { type: "checkbox", id: "v2CsvFlip" } });
      flip.checked = !!mapping.flip;
      flip.addEventListener("change", function () { mapping.flip = flip.checked; recompute(); });
      mapEl.appendChild(h("label", { class: "switch-label v2-check" }, flip, h("span", { text: "Spending shows as a positive number in this file (common for credit cards)" })));
    }
  }

  file.addEventListener("change", function () {
    const f = file.files && file.files[0];
    if (!f) return;
    f.text().then(function (text) {
      cells = parseCsv(text);
      mapping = detect(cells);
      drawMapping();
      recompute();
    });
  });

  const body = h("div", { class: "v2-form" },
    h("p", { class: "hint", text: "Download a statement from your bank's website or app as CSV (sometimes called “Excel” or “spreadsheet”), then pick it here. Rows already in Arthatula are skipped, so overlapping statements are fine." }),
    field("Statement file (.csv)", file), previewEl,
    field("Add to account", acct), newWrap, mapEl);
  newWrap.hidden = !!acct.value;

  openDialog("Import from your bank (CSV)", body, [{
    label: "Import", primary: true, onClick: function (close) {
      if (!cells) throw new Error("Pick a CSV file first.");
      if (!parsed.rows.length) throw new Error("No transactions to import: check the columns.");
      if (!acct.value && !newName.value.trim()) throw new Error("Name the new account (or pick one).");
      const req = { rows: parsed.rows };
      if (acct.value) req.accountId = acct.value; else req.newAccount = { name: newName.value.trim(), type: newType.value };
      return api("POST", "import", req).then(function (r) {
        close();
        return loadBasics(true).then(function () {
          if (done) done();
          summary("Import finished", r, parsed.skipped);
        });
      });
    }
  }]);
}

function summary(title, r, skipped) {
  const lines = [
    plural(r.added, "transaction added", "transactions added") + ".",
    r.duplicates ? plural(r.duplicates, "was", "were") + " already here and skipped." : null,
    r.categorized ? plural(r.categorized, "was", "were") + " filed by your rules." : null,
    r.toReview ? plural(r.toReview, "is", "are") + " on To review for you (the AI checks them first when you have a key)." : null,
    skipped ? plural(skipped, "line", "lines") + " in the file weren't transactions." : null,
    r.balanceUpdated ? "The account balance was updated from the statement." : null
  ].concat(r.errors || []).filter(Boolean);
  openDialog(title, h("div", { class: "v2-form", attrs: { id: "v2ImportSummary" } }, lines.map(function (t) { return h("p", { text: t }); })),
    [{ label: "Done", primary: true, onClick: function (close) { close(); } }]);
}

function since(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return "just now";
  if (mins < 120) return mins + " minutes ago";
  return Math.round(mins / 60) + " hours ago";
}

export function openSimplefin(done) {
  const finish = function (r) {
    return loadBasics(true).then(function () { if (done) done(); summary("Bank sync finished", r, 0); });
  };
  api("GET", "simplefin").then(function (st) {
    if (st.connected) {
      openDialog("Bank sync (SimpleFIN)", h("div", { class: "v2-form" },
        h("p", { text: "Connected. Last synced " + since(st.lastSyncAt) + ". Arthatula pulls new transactions when you open it (at most every few hours); SimpleFIN itself refreshes about once a day." }),
        st.lastError ? h("p", { class: "auth-error", text: st.lastError }) : null), [
        { label: "Sync now", primary: true, onClick: function (close) { return api("POST", "simplefin", { action: "sync" }).then(function (r) { close(); return finish(r); }); } },
        { label: "Disconnect", danger: true, onClick: function (close) {
          if (!window.confirm("Disconnect SimpleFIN? Transactions already imported stay.")) return;
          return api("DELETE", "simplefin").then(close);
        } }
      ]);
      return;
    }
    const token = h("textarea", { attrs: { rows: "3", placeholder: "Paste the setup token here", "aria-label": "SimpleFIN setup token", autocomplete: "off", spellcheck: "false" } });
    openDialog("Connect your bank (SimpleFIN)", h("div", { class: "v2-form" },
      h("p", { text: "SimpleFIN Bridge links US banks and credit cards for about $15 a year, with no computer left running. It doesn't cover banks outside the US and Canada: use CSV import for those." }),
      h("ol", { class: "v2-steps" },
        h("li", null, "Open ", h("a", { text: "SimpleFIN Bridge", attrs: { href: "https://beta-bridge.simplefin.org/", target: "_blank", rel: "noopener" } }), ", make an account and link your bank."),
        h("li", { text: "Choose “New connection” / “Create setup token” and copy the token." }),
        h("li", { text: "Paste it below. It works once: Arthatula swaps it for a private connection that stays on your server." })),
      field("Setup token", token)), [{
      label: "Connect", primary: true, onClick: function (close) {
        if (!token.value.trim()) throw new Error("Paste the setup token first.");
        return api("POST", "simplefin", { setupToken: token.value.trim() }).then(function (r) { close(); return finish(r); });
      }
    }]);
  }, function (e) { window.alert("Couldn't check bank sync: " + e.message); });
}

/* On app open: pull SimpleFIN when it's connected and the last pull is a
   few hours old (the server decides). Resolves true when rows came in. */
export function autoSync() {
  return api("POST", "simplefin", { action: "sync", auto: true })
    .then(function (r) { return !r.skipped && r.added > 0; }, function () { return false; });
}
