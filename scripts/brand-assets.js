// node scripts/brand-assets.js: exports the Telegram bot / Mini App pictures from the brand originals
// (originals are read, never modified).
//   autostack-avatar-512.png  512×512, background #0A0A0B, white icon centred with padding (bot picture, Mini App icon)
//   autostack-app-640x360.png 640×360, background #0A0A0B, white full logo centred (BotFather /newapp photo)
import { writeFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const BRAND = "demo-miniapp/public/brand";
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
