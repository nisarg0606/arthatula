import React from "react";
import { Composition, registerRoot, staticFile } from "remotion";
import { Promo, duration } from "./Promo.jsx";

/* Picks up a voice-over prepared by voice.mjs, if there is one. */
async function calculateMetadata({ props }) {
  const voice = await fetch(staticFile("voice/manifest.json")).then((r) => (r.ok ? r.json() : {}), () => ({}));
  return { durationInFrames: duration(voice), props: { ...props, voice } };
}

const SIZES = [["Promo-16x9", 1920, 1080], ["Promo-1x1", 1080, 1080], ["Promo-9x16", 1080, 1920]];

registerRoot(() => (
  <>
    {SIZES.map(([id, width, height]) => (
      <Composition key={id} id={id} component={Promo} durationInFrames={duration()} calculateMetadata={calculateMetadata} fps={30} width={width} height={height} />
    ))}
  </>
));
