/* Sample data (see functions/api/v2/demo.js): a first-run card on the
   Dashboard while you have no data of your own, and a slim banner on
   every screen while the sample data is loaded. Loading or clearing it
   reloads the page, so every screen (and cache) starts over. */
import { api, h, clear, button } from "./kit.js";

export function check() {
  const box = document.getElementById("demoBox");
  if (!box) return;
  api("GET", "demo").then(function (st) { draw(box, st); }, function () { /* no card, no banner */ });
}

function act(method, body, btn) {
  btn.disabled = true;
  return api(method, "demo", body).then(function () { location.reload(); }, function (e) { btn.disabled = false; window.alert(e.message); });
}

function draw(box, st) {
  clear(box);
  if (st.demo) {
    const b = button("Clear sample data", function () { act("DELETE", undefined, b); }, "demo-clear");
    box.appendChild(h("div", { class: "demo-banner", attrs: { role: "status" } },
      h("span", { text: "You're viewing sample data" }),
      h("span", { class: "demo-classic", text: " (the classic tabs stay empty)" }),
      " · ", b));
  } else if (st.empty && !st.dismissed) {
    const go = button("Explore with sample data", function () { act("POST", {}, go); }, "btn-primary");
    const skip = button("Start fresh", function () { api("POST", "demo", { action: "dismiss" }).then(function () { clear(box); }); });
    box.appendChild(h("section", { class: "card demo-welcome" },
      h("h2", { class: "card-title", text: "Welcome to Arthatula" }),
      h("p", { class: "hint", text: "Want a look around first? Load a few months of made-up accounts, spending, budgets and investments, then clear it with one tap when you're ready to add your own." }),
      h("div", { class: "actions" }, go, skip)));
  }
}
