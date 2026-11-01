import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", { weights: ["400", "600", "800"], subsets: ["latin"] });
const TEAL = "#14b8a6", DEEP = "#0f766e", INK = "#0b1f1e", MUTED = "#4b5f5d";
const shot = (n) => staticFile("shots/" + n + ".png");
const DESK = 860 / 1280, PHONE = 1328 / 780; // screenshot height / width

/* Where things go for each output size (16:9, 1:1, 9:16). */
function useLayout() {
  const { width: W, height: H } = useVideoConfig();
  const kind = W > H ? "wide" : W === H ? "square" : "tall";
  return {
    W, H, kind,
    capTop: { wide: 56, square: 56, tall: 190 }[kind],
    title: { wide: 68, square: 60, tall: 78 }[kind],
    box: { wide: { x: 180, y: 250, w: 1560, h: 780 }, square: { x: 60, y: 280, w: 960, h: 740 }, tall: { x: 50, y: 560, w: 980, h: 1140 } }[kind],
  };
}

const useIn = (delay = 0, damping = 18) => {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping } });
};

function Background() {
  const f = useCurrentFrame();
  const blob = (color, x, y, r) => (
    <div style={{ position: "absolute", left: x, top: y, width: r, height: r, borderRadius: "50%", background: color, filter: "blur(120px)", opacity: 0.55 }} />
  );
  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #e7f8f5 0%, #f7fbfa 50%, #eeeafc 100%)", overflow: "hidden" }}>
      {blob("#99f6e4", -200 + 80 * Math.sin(f / 90), -200 + 60 * Math.cos(f / 70), 900)}
      {blob("#c7d2fe", "60%", "55%", 900)}
    </AbsoluteFill>
  );
}

function Caption({ kicker, title }) {
  const L = useLayout(), p = useIn(4);
  return (
    <div style={{ position: "absolute", top: L.capTop, left: 60, right: 60, textAlign: "center", opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
      <div style={{ color: DEEP, fontWeight: 800, fontSize: L.title * 0.46, letterSpacing: 3, textTransform: "uppercase", marginBottom: 10 }}>{kicker}</div>
      <div style={{ color: INK, fontWeight: 800, fontSize: L.title, lineHeight: 1.1, letterSpacing: -1.5 }}>{title}</div>
    </div>
  );
}

/* A screenshot in a rounded window that eases from one framing to another.
   from/to = [focusX, focusY, zoom] with focus as a fraction of the image;
   zoom 1 = image as wide as the box. Children are laid over the image in
   image percentages, so they move with it. */
function Shot({ src, ratio = DESK, from = [0.5, 0, 1], to = from, children }) {
  const L = useLayout(), f = useCurrentFrame(), { durationInFrames } = useVideoConfig();
  const t = interpolate(f, [0, durationInFrames], [0, 1], { easing: Easing.inOut(Easing.cubic), extrapolateRight: "clamp" });
  const [fx, fy, z] = from.map((v, i) => v + (to[i] - v) * t);
  const { w, h } = L.box, s = Math.max(z, h / (w * ratio));
  const iw = w * s, ih = iw * ratio;
  const left = Math.min(0, Math.max(w - iw, w / 2 - fx * iw)), top = Math.min(0, Math.max(h - ih, h / 2 - fy * ih));
  const p = useIn(0, 20);
  return (
    <div style={{ position: "absolute", left: L.box.x, top: L.box.y, width: w, height: h, borderRadius: 28, overflow: "hidden", background: "#fff",
      boxShadow: "0 40px 90px -30px rgba(15,118,110,.45), 0 0 0 1px rgba(15,118,110,.12)", opacity: p, transform: `scale(${0.94 + 0.06 * p})` }}>
      <div style={{ position: "absolute", left, top, width: iw, height: ih }}>
        <Img src={src} style={{ width: "100%", height: "100%" }} />
        {children}
      </div>
    </div>
  );
}

const Tour = ({ kicker, title, ...shotProps }) => (
  <AbsoluteFill><Shot {...shotProps} /><Caption kicker={kicker} title={title} /></AbsoluteFill>
);

const Layer = ({ src, style }) => <Img src={src} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", ...style }} />;

function Eye() {
  const f = useCurrentFrame();
  const swap = interpolate(f, [42, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ring = interpolate(f, [24, 46], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Tour kicker="Privacy in one tap" title="The eye button hides every amount" src={shot("home")} from={[0.75, 0.18, 1.25]} to={[0.75, 0.18, 1.4]}>
      <Layer src={shot("home-hidden")} style={{ opacity: swap }} />
      <div style={{ position: "absolute", left: "88.4%", top: "4.2%", width: 70, height: 70, marginLeft: -35, marginTop: -35, borderRadius: "50%",
        border: `5px solid ${TEAL}`, opacity: ring > 0 ? 1 - ring : 0, transform: `scale(${0.6 + ring * 1.4})` }} />
    </Tour>
  );
}

function Dark() {
  const f = useCurrentFrame();
  const x = interpolate(f, [20, 70], [100, 0], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Tour kicker="Easy on the eyes" title="Dark mode, of course" src={shot("home")} from={[0.5, 0.3, 1.1]} to={[0.5, 0.3, 1.15]}>
      <Layer src={shot("home-dark")} style={{ clipPath: `inset(0 0 0 ${x}%)` }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, left: x + "%", width: 6, marginLeft: -3, background: TEAL, opacity: x > 0 && x < 100 ? 1 : 0 }} />
    </Tour>
  );
}

function Phones() {
  const L = useLayout(), gap = { wide: 60, square: 0, tall: -110 }[L.kind]; // tall: phones overlap so they stay big
  const pw = Math.min(L.box.h / PHONE, (L.box.w - 2 * gap) / 3), ph = pw * PHONE;
  const ins = [useIn(6), useIn(14), useIn(22)];
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: L.box.x, top: L.box.y, width: L.box.w, height: L.box.h, display: "flex", justifyContent: "center", alignItems: "center", gap: Math.max(gap, 0) }}>
        {["phone-home", "phone-hidden", "phone-budget"].map((n, i) => (
          <div key={n} style={{ width: pw, height: ph, flexShrink: 0, marginLeft: i && gap < 0 ? gap : 0, borderRadius: pw * 0.13, border: "10px solid #111827", overflow: "hidden", background: "#fff",
            boxShadow: "0 40px 80px -30px rgba(15,23,42,.5)", zIndex: i === 1 ? 1 : 0, opacity: ins[i], transform: `translateY(${(1 - ins[i]) * 120 + (i === 1 ? -20 : 20)}px)` }}>
            <Img src={shot(n)} style={{ width: "100%" }} />
          </div>
        ))}
      </div>
      <Caption kicker="Add it to your home screen" title="Made for your phone, too" />
    </AbsoluteFill>
  );
}

function Logo({ size }) {
  return <Img src={staticFile("logo.png")} style={{ width: size, height: size, borderRadius: size * 0.22, boxShadow: "0 30px 60px -25px rgba(15,118,110,.6)" }} />;
}

function Hook() {
  const L = useLayout(), a = useIn(0, 14), b = useIn(14), c = useIn(30);
  const big = L.kind === "wide" ? 120 : 104;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ transform: `scale(${a})` }}><Logo size={L.kind === "tall" ? 260 : 200} /></div>
      <div style={{ marginTop: 50, fontSize: big, fontWeight: 800, color: INK, lineHeight: 1.05, letterSpacing: -3, opacity: b, transform: `translateY(${(1 - b) * 40}px)` }}>
        Your money,<br /><span style={{ color: DEEP }}>on your own server.</span>
      </div>
      <div style={{ marginTop: 36, fontSize: 40, color: MUTED, fontWeight: 600, opacity: c }}>Arthatula · an open-source money app</div>
    </AbsoluteFill>
  );
}

function Pills({ kicker, title, items, cols = 1 }) {
  const L = useLayout(), ins = items.map((_, i) => useIn(12 + i * 8)); // fixed count per scene, so hook order is stable
  const grid = L.kind === "wide" ? cols : 1;
  return (
    <AbsoluteFill>
      <Caption kicker={kicker} title={title} />
      <div style={{ position: "absolute", left: L.box.x, top: L.kind === "tall" ? 440 : L.box.y, width: L.box.w, bottom: L.H - L.box.y - L.box.h, display: "grid", gridTemplateColumns: `repeat(${grid}, 1fr)`, gap: 28, alignContent: "center" }}>
        {items.map(([icon, head, sub], i) => (
          <div key={head} style={{ display: "flex", alignItems: "center", gap: 28, padding: "30px 36px", borderRadius: 28, background: "rgba(255,255,255,.85)",
            boxShadow: "0 24px 60px -30px rgba(15,118,110,.45), 0 0 0 1px rgba(15,118,110,.12)", opacity: ins[i], transform: `translateY(${(1 - ins[i]) * 50}px)` }}>
            <div style={{ fontSize: 64, width: 84, textAlign: "center", flexShrink: 0 }}>{icon}</div>
            <div>
              <div style={{ fontSize: 44, fontWeight: 800, color: INK, letterSpacing: -0.5 }}>{head}</div>
              {sub && <div style={{ fontSize: 32, color: MUTED, marginTop: 6, lineHeight: 1.25 }}>{sub}</div>}
            </div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Cta() {
  const L = useLayout(), f = useCurrentFrame(), a = useIn(0, 14), b = useIn(12), c = useIn(26);
  const pulse = 1 + 0.04 * Math.max(0, Math.sin((f - 40) / 6));
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ transform: `scale(${a})` }}><Logo size={180} /></div>
      <div style={{ marginTop: 44, fontSize: L.kind === "wide" ? 92 : 80, fontWeight: 800, color: INK, lineHeight: 1.05, letterSpacing: -2.5, opacity: b }}>
        Deploy your own copy<br /><span style={{ color: DEEP }}>in 5 minutes.</span>
      </div>
      <div style={{ marginTop: 44, fontSize: L.kind === "wide" ? 48 : 42, fontWeight: 600, color: INK, padding: "18px 34px", borderRadius: 20, background: "#fff",
        boxShadow: "0 0 0 2px rgba(15,118,110,.25)", opacity: c, fontFamily: "ui-monospace, Menlo, monospace" }}>github.com/nisarg0606/arthatula</div>
      <div style={{ marginTop: 36, fontSize: 44, fontWeight: 800, color: "#fff", padding: "20px 44px", borderRadius: 999, background: `linear-gradient(135deg, ${TEAL}, ${DEEP})`,
        boxShadow: "0 24px 50px -20px rgba(15,118,110,.8)", opacity: c, transform: `scale(${pulse})` }}>⭐ Star it on GitHub</div>
      <div style={{ marginTop: 32, fontSize: 32, color: MUTED, fontWeight: 600, opacity: c }}>Free · MIT licensed · runs on Cloudflare</div>
    </AbsoluteFill>
  );
}

const SCENES = [
  [105, <Hook />],
  [130, <Pills kicker="Private & free" title="Runs in your own Cloudflare account" items={[
    ["☁️", "Your account, your data", "Nothing goes to a company server"],
    ["💸", "No subscription", "Cloudflare's free plan is enough"],
    ["🔓", "Open source, MIT", "Read every line, change anything"]]} />],
  [110, <Tour kicker="Dashboard" title="Heads up on big expenses and what's next" src={shot("home")} from={[0.5, 0.35, 1.05]} to={[0.5, 0.55, 1.3]} />],
  [110, <Eye />],
  [110, <Tour kicker="Investments" title="Your portfolio vs the S&P 500" src={shot("investments")} from={[0.5, 0.45, 1.05]} to={[0.5, 0.58, 1.25]} />],
  [95, <Tour kicker="Holdings" title="Shares, price and gain vs cost" src={shot("holdings")} from={[0.5, 0.56, 1.05]} to={[0.5, 0.64, 1.12]} />],
  [95, <Tour kicker="Budget" title="3-month averages keep it honest" src={shot("budget")} from={[0.4, 0.55, 1.1]} to={[0.3, 0.75, 1.45]} />],
  [85, <Tour kicker="Cash flow" title="See where every month goes" src={shot("cashflow")} from={[0.5, 0.35, 1.05]} to={[0.5, 0.5, 1.2]} />],
  [95, <Tour kicker="Transactions" title="Every category gets an emoji" src={shot("transactions")} from={[0.4, 0.5, 1.1]} to={[0.3, 0.65, 1.5]} />],
  [95, <Tour kicker="Customize" title="Make the dashboard yours" src={shot("customize")} from={[0.5, 0.45, 1.05]} to={[0.5, 0.5, 1.3]} />],
  [110, <Dark />],
  [120, <Phones />],
  [175, <Pills kicker="AI where it helps" title="Bring your own AI key" cols={2} items={[
    ["✨", "Auto-categorizing", "New charges sorted for you"],
    ["💬", "“Can I afford it?”", "Answers from your real plan"],
    ["📈", "Market today", "An evening recap after the close"],
    ["🤖", "MCP for AI agents", "“Log $12 lunch” and it's saved"]]} />],
  [150, <Cta />],
];
const T = 15, LEAD = 8, TAIL = 10;
const num = (i) => String(i + 1).padStart(2, "0");

/* Scene lengths in frames. voice = public/voice/manifest.json (seconds per
   file, from voice.mjs). A per-scene line that runs long stretches its
   scene, with a short pause after it and before the next transition; a
   single continuous take only ever stretches the last scene. */
export function lengths(voice = {}) {
  const d = SCENES.map(([base], i) => {
    const v = voice[num(i)];
    return v ? Math.max(base, LEAD + Math.ceil(v * 30) + TAIL + (i < SCENES.length - 1 ? T : 0)) : base;
  });
  const total = d.reduce((a, b) => a + b, 0) - T * (d.length - 1);
  if (voice.voiceover) d[d.length - 1] += Math.max(0, Math.ceil(voice.voiceover * 30) + TAIL - total);
  return d;
}
export const duration = (voice) => lengths(voice).reduce((a, b) => a + b, 0) - T * (SCENES.length - 1);

export function Promo({ voice = {} }) {
  const d = lengths(voice);
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <Background />
      {voice.voiceover && <Audio src={staticFile("voice/voiceover.wav")} />}
      <TransitionSeries>
        {SCENES.flatMap(([, el], i) => [
          /* Screen to screen slides, so two captions never fade over each other. */
          i > 0 && <TransitionSeries.Transition key={"t" + i} presentation={i >= 3 && i <= 11 ? slide({ direction: "from-right" }) : fade()} timing={linearTiming({ durationInFrames: T })} />,
          <TransitionSeries.Sequence key={i} durationInFrames={d[i]}>
            {el}
            {voice[num(i)] && <Sequence from={LEAD} layout="none"><Audio src={staticFile("voice/" + num(i) + ".wav")} /></Sequence>}
          </TransitionSeries.Sequence>,
        ].filter(Boolean))}
      </TransitionSeries>
    </AbsoluteFill>
  );
}
