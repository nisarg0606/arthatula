/* Bank statement CSV -> transactions. Runs in the browser (preview and
   column mapping before anything is sent); the server checks each row
   again. Pure: no DOM, no fetch.

   detect(table) guesses which column is which from the header names
   (US and Indian bank exports: Date / Txn Date / Value Date, Description
   / Narration / Particulars, Amount, Debit / Withdrawal Amt., Credit /
   Deposit Amt., Dr / Cr, Balance), skipping preamble lines above the
   header. toTransactions(table, mapping) turns rows into
   { date: "YYYY-MM-DD", description, amountCents (negative = money out),
   balanceCents | null }, counting the rows it couldn't read. */

const DELIMS = [",", ";", "\t", "|"];

/* RFC 4180-ish: quoted cells, "" escapes, CRLF or LF; the delimiter is
   whichever of , ; tab | shows up most in the first lines. */
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const sample = src.split(/\r?\n/).slice(0, 20).join("\n");
  let delim = ",", best = 0;
  DELIMS.forEach(function (d) { const n = sample.split(d).length; if (n > best) { best = n; delim = d; } });
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map(function (r) { return r.map(function (x) { return x.trim(); }); })
    .filter(function (r) { return r.some(function (x) { return x !== ""; }); });
}

function norm(h) { return String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

/* Role -> header patterns, best first. Roles are matched in this order
   so "Debit/Credit" is a type column, not a debit one. */
const ROLES = [
  ["date", [/^(transaction|txn|tran|trans) ?date$|^date$/, /^date\b/, /(posting|posted|post|value) (date|dt)$/, /\bdate\b/]],
  ["type", [/^(dr cr|cr dr|debit credit|credit debit|dr or cr|transaction type|type)$/]],
  ["balance", [/balance|\bbal\b/]],
  ["debit", [/^(debit|debits|withdrawal|withdrawals|withdrawl|dr|money out|paid out|outflow)\b/, /withdraw|debit/]],
  ["credit", [/^(credit|credits|deposit|deposits|cr|money in|paid in|inflow)\b/, /deposit|credit/]],
  ["amount", [/^(transaction )?(amount|amt)\b/, /amount/]],
  ["description", [/^description$/, /^(narration|particulars|transaction remarks|remarks|transaction details|payee|merchant|name)\b/, /description|narration|particulars|remarks|memo|details|payee/]]
];
export const ROLE_NAMES = ["date", "description", "amount", "debit", "credit", "type", "balance"];

function guessColumns(header) {
  const names = header.map(norm);
  const cols = {};
  const used = {};
  ROLE_NAMES.forEach(function (r) { cols[r] = -1; });
  ROLES.forEach(function (entry) {
    for (const re of entry[1]) {
      const i = names.findIndex(function (n, j) { return !used[j] && re.test(n); });
      if (i !== -1) { cols[entry[0]] = i; used[i] = true; break; }
    }
  });
  return cols;
}

/* "1,23,456.78", "$12.00", "(12.00)", "-12", "500.00 Dr", "Rs. 40" -> cents, or null. */
export function parseAmount(s) {
  let t = String(s === undefined || s === null ? "" : s).trim();
  if (!t) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  const drcr = t.match(/\s*(dr|cr)\.?$/i);
  if (drcr) { if (/dr/i.test(drcr[1])) sign = -sign; t = t.slice(0, drcr.index); }
  t = t.replace(/rs\.?|inr|usd|[₹$\s,]/gi, "");
  if (/^-/.test(t)) { sign = -sign; t = t.slice(1); }
  else if (/^\+/.test(t)) t = t.slice(1);
  else if (/-$/.test(t)) { sign = -sign; t = t.slice(0, -1); }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  return sign * Math.round(parseFloat(t) * 100);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function iso(y, m, d) {
  if (y < 100) y += 2000;
  const out = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  const dt = new Date(out + "T00:00:00Z");
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === out ? out : null;
}
function monthNum(name) { return MONTHS[String(name).toLowerCase()] || MONTHS[String(name).toLowerCase().slice(0, 3)] || 0; }

/* A statement date -> "YYYY-MM-DD", or null. order ("dmy" or "mdy")
   only matters for all-number dates like 03/04/2026. */
export function parseDate(s, order) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{2,4})\b/);
  if (m) return monthNum(m[2]) ? iso(+m[3], monthNum(m[2]), +m[1]) : null;
  m = t.match(/^([A-Za-z]{3,9})[-/. ](\d{1,2}),?[-/. ](\d{2,4})\b/);
  if (m) return monthNum(m[1]) ? iso(+m[3], monthNum(m[1]), +m[2]) : null;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) return order === "dmy" ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]);
  return null;
}

/* "dmy" / "mdy" when the numbers settle it, null when every date
   could be either (the person picks). */
function dateOrder(values) {
  let dmy = false, mdy = false, numeric = false;
  values.forEach(function (v) {
    const m = String(v || "").trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}\b/);
    if (!m) return;
    numeric = true;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  });
  if (!numeric) return "mdy";
  if (dmy !== mdy) return dmy ? "dmy" : "mdy";
  return null;
}

function isDrCr(v) { return /^(dr|cr|d|c|debit|credit)\.?$/i.test(String(v || "").trim()); }

/* { header, headers, columns: { role: index | -1 }, dateOrder, flip, ok }
   header is the row index of the column names; ok is false when no row
   looks like a header with a date and an amount. */
export function detect(table) {
  for (let i = 0; i < Math.min(table.length, 40); i++) {
    const cols = guessColumns(table[i]);
    if (cols.date === -1 || (cols.amount === -1 && cols.debit === -1 && cols.credit === -1)) continue;
    const body = table.slice(i + 1);
    const amounts = cols.amount === -1 ? [] : body.map(function (r) { return parseAmount(r[cols.amount]); }).filter(function (a) { return a !== null && a !== 0; });
    /* A Type column only gives the direction when it says Dr/Cr and the
       amounts are all unsigned (Chase's "Type" says ACH_DEBIT on rows
       that already carry a minus). */
    if (cols.type !== -1 && (cols.amount === -1 || amounts.some(function (a) { return a < 0; }) ||
        !body.some(function (r) { return isDrCr(r[cols.type]); }))) cols.type = -1;
    const positive = amounts.filter(function (a) { return a > 0; }).length;
    return {
      header: i, headers: table[i], columns: cols,
      dateOrder: dateOrder(body.map(function (r) { return r[cols.date]; })),
      /* A single unsigned-ish amount column that is mostly positive is a
         card export where charges are positive (Amex, Discover). */
      flip: cols.amount !== -1 && cols.type === -1 && amounts.length >= 3 && positive / amounts.length >= 0.75,
      ok: true
    };
  }
  return { header: 0, headers: table[0] || [], columns: guessColumns(table[0] || []), dateOrder: null, flip: false, ok: false };
}

/* mapping: what detect() returned, possibly changed by the person. */
export function toTransactions(table, mapping) {
  const c = mapping.columns;
  const rows = [];
  let skipped = 0;
  table.slice(mapping.header + 1).forEach(function (r) {
    const date = parseDate(r[c.date], mapping.dateOrder || "mdy");
    let amount = null;
    if (c.amount !== -1) {
      amount = parseAmount(r[c.amount]);
      if (amount !== null && c.type !== -1 && isDrCr(r[c.type])) amount = /^(dr|d|debit)/i.test(r[c.type].trim()) ? -Math.abs(amount) : Math.abs(amount);
      else if (amount !== null && mapping.flip) amount = -amount;
    } else {
      const d = c.debit === -1 ? null : parseAmount(r[c.debit]);
      const cr = c.credit === -1 ? null : parseAmount(r[c.credit]);
      if (d !== null || cr !== null) amount = Math.abs(cr || 0) - Math.abs(d || 0);
    }
    if (!date || !amount) { skipped++; return; }
    const desc = c.description === -1 ? "" : String(r[c.description] || "").replace(/\s+/g, " ").trim();
    rows.push({
      date: date, description: desc.slice(0, 300) || "(no description)", amountCents: amount,
      balanceCents: c.balance === -1 ? null : parseAmount(r[c.balance])
    });
  });
  return { rows: rows, skipped: skipped };
}
