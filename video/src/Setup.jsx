import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { fontFamily, TEAL, DEEP, INK, MUTED, PHONE, shot, useIn, useLayout, Background, Caption, Shot, Layer, Logo, Pills } from "./Promo.jsx";

/* "How to set it up": the GUIDE's section 1 as a ~70 s walkthrough, 16:9
   only (it goes in the README). The Cloudflare screens are drawn as simple
   mock-ups, not real screenshots, so a changed Cloudflare UI dates the
   look, not the steps. The app's own setup screen is a real screenshot. */

const ORANGE = "#f38020";
const ease = (f, a, b, from = 0, to = 1) => interpolate(f, [a, b], [from, to], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/* A browser window with an address bar, in the scene's main box. */
function Browser({ url, children }) {
  const L = useLayout(), p = useIn(0, 20);
  return (
    <div style={{ position: "absolute", left: L.box.x, top: L.box.y, width: L.box.w, height: L.box.h, borderRadius: 28, overflow: "hidden", background: "#fff",
      boxShadow: "0 40px 90px -30px rgba(15,118,110,.45), 0 0 0 1px rgba(15,118,110,.12)", opacity: p, transform: `scale(${0.94 + 0.06 * p})` }}>
      <div style={{ height: 74, display: "flex", alignItems: "center", gap: 14, padding: "0 28px", background: "#f1f5f4", borderBottom: "1px solid #e2e8e7" }}>
        {["#f87171", "#fbbf24", "#34d399"].map((c) => <div key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />)}
        <div style={{ marginLeft: 20, flex: 1, padding: "10px 22px", borderRadius: 12, background: "#fff", fontSize: 26, color: MUTED, fontFamily: "ui-monospace, Menlo, monospace" }}>🔒 {url}</div>
      </div>
      <div style={{ position: "relative", height: L.box.h - 74, padding: "50px 70px" }}>{children}</div>
    </div>
  );
}

/* A mouse pointer gliding to (x, y) in the browser's content area, clicking at frame `at`. */
function Pointer({ from, to, at }) {
  const f = useCurrentFrame(), t = ease(f, at - 30, at - 4);
  const x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t;
  const ring = ease(f, at, at + 18), press = f >= at && f < at + 6 ? 0.85 : 1;
  return (
    <>
      <div style={{ position: "absolute", left: x, top: y, width: 80, height: 80, marginLeft: -40, marginTop: -40, borderRadius: "50%", border: `5px solid ${TEAL}`,
        opacity: ring > 0 && ring < 1 ? 1 - ring : 0, transform: `scale(${0.4 + ring * 1.2})` }} />
      <svg width="44" height="44" viewBox="0 0 24 24" style={{ position: "absolute", left: x - 6, top: y - 4, transform: `scale(${press})`, filter: "drop-shadow(0 4px 6px rgba(0,0,0,.3))" }}>
        <path d="M4 2l16 11-7 1.5L9.5 21z" fill="#111827" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </>
  );
}

const Button = ({ children, color = ORANGE, style }) => (
  <div style={{ display: "inline-block", padding: "22px 40px", borderRadius: 16, background: color, color: "#fff", fontSize: 36, fontWeight: 800, ...style }}>{children}</div>
);

/* A yellow note along the bottom of the window: the one thing not to miss in this step. */
function Note({ children, delay = 40 }) {
  const L = useLayout(), p = useIn(delay);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: L.box.y + L.box.h - 96, textAlign: "center", opacity: p, transform: `translateY(${(1 - p) * 20}px)` }}>
      <span style={{ display: "inline-block", padding: "14px 30px", borderRadius: 16, background: "#fef3c7", color: "#78350f", fontSize: 32, fontWeight: 700,
        boxShadow: "0 0 0 2px #fcd34d" }}>{children}</span>
    </div>
  );
}

const Step = ({ n, title, note, noteDelay, children }) => (
  <AbsoluteFill>{children}<Caption kicker={"Step " + n + " of 6"} title={title} />{note && <Note delay={noteDelay}>{note}</Note>}</AbsoluteFill>
);

function Intro() {
  const a = useIn(0, 14), b = useIn(14), c = useIn(34);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ transform: `scale(${a})` }}><Logo size={180} /></div>
      <div style={{ marginTop: 44, fontSize: 104, fontWeight: 800, color: INK, lineHeight: 1.05, letterSpacing: -3, opacity: b }}>
        Set up Arthatula<br /><span style={{ color: DEEP }}>in about 5 minutes</span>
      </div>
      <div style={{ marginTop: 40, fontSize: 40, color: MUTED, fontWeight: 600, opacity: c, lineHeight: 1.4 }}>
        You need a free Cloudflare account and a free GitHub account.<br />No credit card, no coding.
      </div>
    </AbsoluteFill>
  );
}

function DeployButton() {
  return (
    <Step n={1} title="Click “Deploy to Cloudflare”" note="Use this button, not GitHub's Fork: only button copies update themselves." noteDelay={70}>
      <Browser url="github.com/nisarg0606/arthatula">
        <div style={{ textAlign: "center" }}>
          <Img src={staticFile("logo.png")} style={{ width: 120, height: 120, borderRadius: 26 }} />
          <div style={{ fontSize: 72, fontWeight: 800, color: INK, marginTop: 16 }}>Arthatula</div>
          <div style={{ fontSize: 34, color: MUTED, marginTop: 8 }}>Your money, on your own server.</div>
          <Button style={{ marginTop: 50 }}>☁️ Deploy to Cloudflare</Button>
        </div>
        <Pointer from={[1250, 600]} to={[790, 430]} at={60} />
      </Browser>
    </Step>
  );
}

function Check({ done, children, size = 38 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: size, fontWeight: 700, color: INK, padding: "18px 0" }}>
      <div style={{ width: 52, height: 52, borderRadius: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, color: "#fff",
        background: done ? TEAL : "#e2e8e7", transform: `scale(${done ? 1 : 0.9})` }}>{done ? "✓" : ""}</div>
      {children}
    </div>
  );
}

function SignIn() {
  const f = useCurrentFrame();
  return (
    <Step n={2} title="Sign in to Cloudflare, then connect GitHub" note="Cloudflare copies the app into your GitHub account. That copy is yours." noteDelay={90}>
      <Browser url="deploy.workers.cloudflare.com">
        <div style={{ maxWidth: 1000, margin: "30px auto 0" }}>
          <Check done={f > 30}>Sign in to Cloudflare <span style={{ color: MUTED, fontWeight: 500 }}>(or create a free account)</span></Check>
          <div style={{ height: 1, background: "#e2e8e7", margin: "10px 0" }} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Check done={f > 84}>Connect your GitHub account</Check>
            {f <= 84 && <Button color="#111827" style={{ fontSize: 30, padding: "16px 30px" }}>Connect GitHub</Button>}
          </div>
        </div>
        <Pointer from={[300, 520]} to={[1140, 235]} at={78} />
      </Browser>
    </Step>
  );
}

const SECRET = "purple-otter-wears-a-tiny-hat";
function Secret() {
  const f = useCurrentFrame(), n = Math.max(0, Math.min(SECRET.length, Math.floor((f - 25) / 2.2)));
  const caret = Math.floor(f / 15) % 2 === 0 && n < SECRET.length;
  return (
    <Step n={3} title="Make up a SETUP_SECRET and write it down" note="✍️ Keep it safe: you need it in step 5, and to reset a forgotten access code." noteDelay={95}>
      <Browser url="deploy.workers.cloudflare.com">
        <div style={{ maxWidth: 1100, margin: "40px auto 0" }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: INK, fontFamily: "ui-monospace, Menlo, monospace" }}>SETUP_SECRET</div>
          <div style={{ fontSize: 28, color: MUTED, margin: "8px 0 20px" }}>Any long phrase you make up. Don't reuse a real password.</div>
          <div style={{ padding: "26px 30px", borderRadius: 16, border: `3px solid ${TEAL}`, fontSize: 44, color: INK, fontFamily: "ui-monospace, Menlo, monospace", minHeight: 60 }}>
            {SECRET.slice(0, n)}<span style={{ opacity: caret ? 1 : 0, color: TEAL }}>|</span>
          </div>
        </div>
      </Browser>
    </Step>
  );
}

function Deploy() {
  const f = useCurrentFrame();
  const steps = [[60, "Copying the app into your GitHub"], [95, "Creating your database"], [130, "Building your app"]];
  const live = f > 160;
  return (
    <Step n={4} title="Leave everything else as it is. Press Deploy" note="⏱ Takes a minute or two. Write down your app's address." noteDelay={165}>
      <Browser url="deploy.workers.cloudflare.com">
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <Button style={{ opacity: f < 50 ? 1 : 0.4 }}>Deploy</Button>
          <div style={{ marginTop: 24 }}>
            {steps.map(([at, label]) => f > 45 && <Check key={label} done={f > at} size={34}>{label}</Check>)}
          </div>
          <div style={{ marginTop: 20, padding: "22px 30px", borderRadius: 16, background: "#ecfdf5", boxShadow: "0 0 0 2px #6ee7b7", fontSize: 36, fontWeight: 700, color: "#065f46",
            opacity: ease(f, 160, 175), fontFamily: "ui-monospace, Menlo, monospace" }}>{live ? "✓ Live at https://arthatula.your-name.workers.dev" : ""}</div>
        </div>
        <Pointer from={[900, 520]} to={[235, 95]} at={45} />
      </Browser>
    </Step>
  );
}

function AccessCode() {
  const f = useCurrentFrame();
  return (
    <Step n={5} title="Open your app and choose your access code" note="🔑 Your access code is the app's password. Keep it in a password manager." noteDelay={70}>
      <Shot src={shot("setup")} from={[0.5, 0.45, 1]} to={[0.5, 0.52, 1.3]}>
        <Layer src={shot("setup-filled")} style={{ opacity: ease(f, 80, 100) }} />
      </Shot>
    </Step>
  );
}

function Phone() {
  const L = useLayout(), p = useIn(6), ph = L.box.h + 40, pw = ph / PHONE;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: L.box.x + 80, top: L.box.y - 20, width: pw, height: ph, borderRadius: pw * 0.13, border: "10px solid #111827", overflow: "hidden", background: "#fff",
        boxShadow: "0 40px 80px -30px rgba(15,23,42,.5)", opacity: p, transform: `translateY(${(1 - p) * 120}px)` }}>
        <Img src={shot("phone-home")} style={{ width: "100%" }} />
      </div>
      <div style={{ position: "absolute", left: L.box.x + 80 + pw + 90, right: L.box.x, top: L.box.y + 120, display: "grid", gap: 30 }}>
        {[["🍎 iPhone (Safari)", "Share → Add to Home Screen"], ["🤖 Android (Chrome)", "⋮ → Install app"], ["🔐 Each device", "Sign in once with your access code"]].map(([h, s], i) => {
          const q = useIn(20 + i * 12); // fixed count, so hook order is stable
          return (
            <div key={h} style={{ padding: "28px 36px", borderRadius: 28, background: "rgba(255,255,255,.85)", boxShadow: "0 24px 60px -30px rgba(15,118,110,.45), 0 0 0 1px rgba(15,118,110,.12)",
              opacity: q, transform: `translateX(${(1 - q) * 60}px)` }}>
              <div style={{ fontSize: 42, fontWeight: 800, color: INK }}>{h}</div>
              <div style={{ fontSize: 34, color: MUTED, marginTop: 6 }}>{s}</div>
            </div>
          );
        })}
      </div>
      <Caption kicker="Step 6 of 6" title="Put it on your phone's Home Screen" />
    </AbsoluteFill>
  );
}

function Outro() {
  const a = useIn(0, 14), b = useIn(12), c = useIn(26);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ transform: `scale(${a})` }}><Logo size={160} /></div>
      <div style={{ marginTop: 40, fontSize: 96, fontWeight: 800, color: INK, letterSpacing: -2.5, opacity: b }}>You're all set 🎉</div>
      <div style={{ marginTop: 30, fontSize: 40, color: MUTED, fontWeight: 600, opacity: c }}>Next: try it with sample data, then add your own accounts.</div>
      <div style={{ marginTop: 44, fontSize: 40, fontWeight: 600, color: INK, padding: "18px 34px", borderRadius: 20, background: "#fff", boxShadow: "0 0 0 2px rgba(15,118,110,.25)", opacity: c }}>
        Stuck? Read the guide: <span style={{ fontFamily: "ui-monospace, Menlo, monospace", color: DEEP }}>docs/GUIDE.md</span>
      </div>
    </AbsoluteFill>
  );
}

const SCENES = [
  [130, <Intro />],
  [190, <DeployButton />],
  [210, <SignIn />],
  [230, <Secret />],
  [260, <Deploy />],
  [230, <AccessCode />],
  [200, <Phone />],
  [230, <Pills kicker="Updates" title="Your copy keeps itself up to date" items={[
    ["🔄", "New versions arrive on their own", "Once a day; nothing to click"],
    ["🔒", "Your data is never touched", "It stays in your own Cloudflare database"],
    ["🛑", "Don't fork the repo by hand", "Forks don't update. Use the Deploy button"]]} />],
  [170, <Outro />],
];
const T = 15;
export const setupDuration = SCENES.reduce((a, [d]) => a + d, 0) - T * (SCENES.length - 1);

export function Setup() {
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <Background />
      <TransitionSeries>
        {SCENES.flatMap(([d, el], i) => [
          i > 0 && <TransitionSeries.Transition key={"t" + i} presentation={fade()} timing={linearTiming({ durationInFrames: T })} />,
          <TransitionSeries.Sequence key={i} durationInFrames={d}>{el}</TransitionSeries.Sequence>,
        ].filter(Boolean))}
      </TransitionSeries>
    </AbsoluteFill>
  );
}
