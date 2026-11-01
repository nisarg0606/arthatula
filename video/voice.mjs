/*
 * Gets a voice-over recording ready for the video: levels it to about
 * -16 LUFS (what social feeds expect), trims silence around per-scene
 * takes, and writes public/voice/manifest.json with each file's length so
 * scenes can stretch to fit.
 *   node voice.mjs [folder]   (default ~/Downloads/arthatula-promo/voice)
 * Takes 01.m4a … 14.m4a (one per scene) or a single voiceover.m4a; .wav,
 * .mp3, .aac and .caf work too.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = path.resolve(process.argv[2] || path.join(os.homedir(), "Downloads/arthatula-promo/voice"));
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "public/voice");
const run = (tool, args) => execFileSync("npx", ["remotion", tool, ...args], { encoding: "utf8" });

/* Remotion's ffmpeg has silencedetect but not silenceremove: find the
   quiet stretch at each end, then cut it (keeping 0.1 s). */
function trim(file) {
  const log = spawnSync("npx", ["remotion", "ffmpeg", "-hide_banner", "-i", file, "-af", "silencedetect=n=-45dB:d=0.2", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]), ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const from = starts[0] < 0.05 && ends.length ? Math.max(0, ends[0] - 0.1) : 0;
  const to = starts.length > ends.length ? starts[starts.length - 1] + 0.1 : null; // still silent at the end
  return "atrim=start=" + from.toFixed(3) + (to ? ":end=" + to.toFixed(3) : "") + ",asetpts=PTS-STARTPTS,";
}

const files = fs.readdirSync(src).filter((f) => /^(\d\d|voiceover)\.(m4a|wav|mp3|aac|caf)$/i.test(f)).sort();
if (!files.length) throw new Error("No 01.m4a … or voiceover.m4a in " + src);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const manifest = {};
for (const f of files) {
  const name = f.replace(/\.\w+$/, ""), dest = path.join(out, name + ".wav");
  run("ffmpeg", ["-v", "error", "-y", "-i", path.join(src, f), "-ac", "2", "-ar", "48000",
    "-af", (name === "voiceover" ? "" : trim(path.join(src, f))) + "loudnorm=I=-16:TP=-1.5:LRA=11", dest]);
  manifest[name] = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dest]).trim());
  console.log(name, manifest[name].toFixed(2) + " s");
}
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Ready in public/voice. Now: npm run render");
