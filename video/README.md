# Promo video

A ~46-second promo for Arthatula, made with [Remotion](https://www.remotion.dev)
(React → MP4). It lives here on its own: the app doesn't use it, and the
Worker never serves this folder (`.assetsignore`).

```bash
cd video
npm ci
npm run shots    # fresh sample-data screenshots into public/shots/ (needs: cd ../e2e && npm ci)
npm run render   # out/arthatula-16x9.mp4, -1x1.mp4, -9x16.mp4
npm run studio   # preview and tweak in the browser
```

`npm run shots` runs `tools/readme-screenshots.mjs` with `VIDEO_SHOTS` set: a
throwaway local copy of the app with made-up data, never your own. Re-run it
whenever the UI changes. Scenes, captions and timings are all in
`src/Promo.jsx`. Screenshots and renders stay out of git.

Silent by default (most feeds autoplay muted, so the captions carry it); a
silent AAC track is added so every platform accepts the file.

## Voice-over

Record the lines from the script (one file per scene, `01.m4a` … `14.m4a`,
or one continuous `voiceover.m4a`) into `~/Downloads/arthatula-promo/voice/`,
then:

```bash
npm run voice    # level to about -16 LUFS, trim silence, write public/voice/
npm run render
```

Each per-scene line starts just after its scene's transition. A line that
runs long stretches its scene instead of being sped up. A continuous take
is laid from the first frame and only ever lengthens the last scene.
Recordings and `public/voice/` stay out of git; delete `public/voice/` to
go back to the silent cut.

Remotion has its own license: free for individuals and companies of up to
three people, a paid company license above that. See
https://www.remotion.dev/license.

## Setup walkthrough

A second, ~1-minute video (16:9 only) walks through the GUIDE's "Get your
own copy" steps. It's committed as `docs/setup-video.mp4` and linked from
the README. Scenes are in `src/Setup.jsx`; the Cloudflare screens are drawn
mock-ups, the app's first-run screen is a real screenshot.

```bash
npm run shots:setup    # the app's first-run screen + a phone shot into public/shots/
npm run render:setup   # out/arthatula-setup.mp4
cp out/arthatula-setup.mp4 ../docs/setup-video.mp4
```

Re-render it when the steps in docs/GUIDE.md section 1 change.
