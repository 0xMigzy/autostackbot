// node scripts/brand-assets.js: exports pictures from the brand originals (originals are read, never modified).
//   autostack-avatar-512.png  512×512, background #0A0A0B, white icon centred with padding (bot picture, Mini App icon)
//   autostack-app-640x360.png 640×360, background #0A0A0B, white full logo centred (BotFather /newapp photo)
//   sized/*.png               logo and icon at the exact sizes the demo app shows them, at 1×, 2× and 3×,
//                             downscaled in steps (sharp at small sizes) with the originals' faint background removed
import { mkdirSync, writeFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const BRAND = "demo-miniapp/public/brand";
const SIZED = `${BRAND}/sized`;
const DENSITIES = [1, 2, 3];
const BACKGROUND = "#0A0A0B";

async function exportCentred(source, width, height, maxW, maxH, out) {
  const image = await loadImage(`${BRAND}/${source}`);
  const scale = Math.min(maxW / image.width, maxH / image.height);
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
  writeFileSync(`${BRAND}/${out}`, canvas.toBuffer("image/png"));
  console.log(`Wrote ${BRAND}/${out} (${width}×${height})`);
}

await exportCentred("autostack-icon-white.png", 512, 512, 300, 300, "autostack-avatar-512.png");
await exportCentred("autostack-logo-white.png", 640, 360, 420, 230, "autostack-app-640x360.png");

/** High-quality downscale: halve in steps, then draw at the exact size; drop alpha ≤ 4 (the originals' faint box). */
function downscale(image, w, h) {
  let src = image;
  while (src.width / 2 >= w && src.height / 2 >= h) {
    const step = createCanvas(Math.round(src.width / 2), Math.round(src.height / 2));
    const sctx = step.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(src, 0, 0, step.width, step.height);
    src = step;
  }
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] <= 4) pixels.data[i] = 0;
  ctx.putImageData(pixels, 0, 0);
  return out;
}

/** Writes <name>@1x/@2x/@3x.png at the given 1× size (one side given, the other from the aspect ratio). */
async function exportSized(source, name, { width, height }) {
  const image = await loadImage(`${BRAND}/${source}`);
  const ratio = image.width / image.height;
  const w1 = width ?? height * ratio;
  const h1 = height ?? width / ratio;
  mkdirSync(SIZED, { recursive: true });
  for (const d of DENSITIES) {
    const out = downscale(image, Math.round(w1 * d), Math.round(h1 * d));
    writeFileSync(`${SIZED}/${name}@${d}x.png`, out.toBuffer("image/png"));
  }
  console.log(`Wrote ${SIZED}/${name}@{1,2,3}x.png (1×: ${Math.round(w1)}×${Math.round(h1)})`);
}

for (const tone of ["white", "dark"]) {
  await exportSized(`autostack-logo-${tone}.png`, `logo-${tone}-header`, { height: 32 }); // Home header, h-8
  await exportSized(`autostack-logo-${tone}.png`, `logo-${tone}-splash`, { width: 160 }); // splash, w-40
  await exportSized(`autostack-icon-${tone}.png`, `icon-${tone}-24`, { height: 24 }); // header icon, size-6
}
