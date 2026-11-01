import React from "react";
import { Composition, registerRoot } from "remotion";
import { Promo, DURATION } from "./Promo.jsx";

const SIZES = [["Promo-16x9", 1920, 1080], ["Promo-1x1", 1080, 1080], ["Promo-9x16", 1080, 1920]];

registerRoot(() => (
  <>
    {SIZES.map(([id, width, height]) => (
      <Composition key={id} id={id} component={Promo} durationInFrames={DURATION} fps={30} width={width} height={height} />
    ))}
  </>
));
