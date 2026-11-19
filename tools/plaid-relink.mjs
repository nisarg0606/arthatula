#!/usr/bin/env node
/*
 * Arthatula — reconnect a bank in place (Plaid Link update mode).
 *
 * When a bank's Plaid connection breaks (the sync reports an error
 * such as ITEM_LOGIN_REQUIRED, or the bank asks you to sign in again),
 * DON'T link the bank again from scratch: a new link is a new Plaid
 * Item, and Plaid gives every account and transaction a new id, which
 * is how accounts ended up twice in the app. Run this instead. It
 * opens Plaid Link in *update mode* on the connection you already
 * have, you sign in to the bank, and the same Item, the same
 * access token and the same account ids keep working. Nothing needs
 * exchanging afterwards and the sync engine needs no change.
 *
 * Run it on the computer that runs the sync (it needs the Plaid keys
 * and the bank's access token, which never leave that computer):
 *
 *   PLAID_CLIENT_ID=… PLAID_SECRET=… PLAID_ENV=production \
 *   node tools/plaid-relink.mjs --access-token-file ~/path/to/that-bank.token
 *
 * or PLAID_ACCESS_TOKEN=access-production-… instead of the file. Then
 * open the address it prints (http://localhost:8765 by default) in a
 * browser on the same computer and follow Plaid's screens. Banks that
 * sign in through their own site (OAuth: Chase, Wells Fargo, Capital
 * One, American Express …) open in a pop-up, so allow pop-ups for
 * localhost. If your Plaid setup uses a registered OAuth redirect URI,
 * pass it with --redirect-uri and serve this page there.
 *
 * Options:
 *   --access-token-file <path>  file holding the Item's access token
 *   --port <n>                  local port (default 8765)
 *   --redirect-uri <url>        optional OAuth redirect URI (must be
 *                               registered in the Plaid dashboard)
 *   --new-accounts              also let you pick accounts the bank
 *                               added since the first link
 *
 * The secret and the access token are never printed or logged. The
 * page is served on 127.0.0.1 only and the script exits after Link
 * finishes or is closed.
 */
import fs from "node:fs";
import http from "node:http";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || "";
}
function fail(msg) {
  console.error("plaid-relink: " + msg);
  process.exit(1);
}

const ENV = (process.env.PLAID_ENV || "production").toLowerCase();
if (!/^(sandbox|production)$/.test(ENV)) fail("PLAID_ENV must be sandbox or production.");
const CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const SECRET = process.env.PLAID_SECRET || "";
if (!CLIENT_ID || !SECRET) fail("set PLAID_CLIENT_ID and PLAID_SECRET (the same keys the sync uses).");
const tokenFile = arg("--access-token-file");
let ACCESS_TOKEN = process.env.PLAID_ACCESS_TOKEN || "";
if (tokenFile) {
  try { ACCESS_TOKEN = fs.readFileSync(tokenFile, "utf8").trim(); } catch (e) { fail("can't read " + tokenFile + "."); }
}
if (!/^access-(sandbox|production)-/.test(ACCESS_TOKEN)) fail("give the bank's access token (--access-token-file or PLAID_ACCESS_TOKEN); it starts with access-" + ENV + "-.");
const PORT = parseInt(arg("--port") || "8765", 10);
const REDIRECT_URI = arg("--redirect-uri");
const NEW_ACCOUNTS = process.argv.includes("--new-accounts");

/* /link/token/create with access_token = update mode: no products,
   the Item stays the same. */
function linkTokenRequest() {
  const body = {
    client_id: CLIENT_ID,
    secret: SECRET,
    client_name: "Arthatula",
    country_codes: ["US"],
    language: "en",
    user: { client_user_id: "arthatula-owner" },
    access_token: ACCESS_TOKEN
  };
  if (REDIRECT_URI) body.redirect_uri = REDIRECT_URI;
  if (NEW_ACCOUNTS) body.update = { account_selection_enabled: true };
  return body;
}

async function createLinkToken() {
  const res = await fetch("https://" + ENV + ".plaid.com/link/token/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(linkTokenRequest()),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.link_token) fail("Plaid refused the link token: " + (data.error_code || res.status) + " " + (data.error_message || ""));
  return data.link_token;
}

function page(linkToken) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reconnect bank</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Reconnect your bank</h1>
<p id="msg">Opening Plaid…</p>
<button id="go" style="padding:.5rem 1rem">Open Plaid again</button>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const say = (t) => { document.getElementById("msg").textContent = t; };
const done = (body) => fetch("/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const opts = {
  token: ${JSON.stringify(linkToken)},
  onSuccess: (_publicToken, meta) => {
    say("Reconnected. You can close this tab; the next sync works as before.");
    done({ ok: true, institution: meta && meta.institution ? meta.institution.name : "" });
  },
  onExit: (err, meta) => {
    say(err ? "Plaid stopped: " + (err.display_message || err.error_message || err.error_code) : "Closed without reconnecting.");
    done({ ok: false, error: err ? err.error_code : "closed", status: meta ? meta.status : "" });
  }
};
if (/[?&]oauth_state_id=/.test(location.search)) opts.receivedRedirectUri = location.href;
const handler = Plaid.create(opts);
document.getElementById("go").onclick = () => handler.open();
handler.open();
</script>`;
}

const linkToken = await createLinkToken();
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/done") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => {
      let r = {};
      try { r = JSON.parse(raw); } catch (e) { r = {}; }
      res.end("ok");
      if (r.ok) console.log("Reconnected" + (r.institution ? " " + r.institution : "") + ". Same connection, same account ids.");
      else console.log("Not reconnected (" + (r.error || "closed") + "). Run this again to retry.");
      server.close();
      setTimeout(() => process.exit(r.ok ? 0 : 2), 200);
    });
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page(linkToken));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("Open http://localhost:" + PORT + " in a browser on this computer to reconnect the bank.");
});
