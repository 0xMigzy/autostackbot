// Shareable progress card renderer: draws a 1080x1080 PNG with the coin logo, a progress
// ring, the buy streak and optional goal details. Only data passed in is drawn
// (never addresses or balances); the coin logo is the only image ever drawn.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const SIZE = 1080;
const BG = "#0A0A0B";
const PANEL = "#161618";
const TEXT = "#FFFFFF";
const SECONDARY = "#8E8E93";
const RING = "#30D158";
const RING_TRACK = "rgba(48, 209, 88, 0.18)";
const FLAME = "#FF9F0A";
const LOGO_FALLBACK = "#232326";
const FONT = "Inter";
const MARGIN = 72;
const LOGO = 96;
const FOOTER = "AutoStack · works with Tangem · not affiliated with Tangem";

// Register bundled Inter weights once, relative to this module so any cwd works.
for (const file of ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf"]) {
  GlobalFonts.registerFromPath(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)), FONT);
}

/** "1 week", "2 weeks". */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Set ctx.font at the largest size <= maxSize (>= minSize) where text fits maxWidth,
 * then ellipsize if it still does not fit. Returns the text to draw.
 */
function fitText(ctx, text, weight, maxSize, maxWidth, minSize = 24) {
  let size = maxSize;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (size > minSize && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  let shown = text;
  while (shown.length > 1 && ctx.measureText(shown).width > maxWidth) {
    text = text.slice(0, -1);
    shown = `${text.trimEnd()}…`;
  }
  return shown;
}

/** Draw text centered on the canvas, shrunk/ellipsized to fit maxWidth. */
function centeredText(ctx, text, y, { weight, size, color, maxWidth = SIZE - MARGIN * 2 }) {
  const shown = fitText(ctx, text, weight, size, maxWidth);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(shown, SIZE / 2, y);
}

/** Rounded rectangle path. */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Teardrop flame path: bottom-centre at (x, y), height h. */
function flamePath(ctx, x, y, h) {
  const w = h * 0.72;
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.04, y - h);
  ctx.bezierCurveTo(x + w * 0.2, y - h * 0.72, x + r, y - h * 0.62, x + r, y - r);
  ctx.arc(x, y - r, r, 0, Math.PI);
  ctx.bezierCurveTo(x - r, y - h * 0.55, x - w * 0.12, y - h * 0.62, x + w * 0.04, y - h);
  ctx.closePath();
}

/** Vector flame (Inter has no emoji): orange teardrop with a panel-coloured inner core. */
function drawFlame(ctx, x, y, h) {
  ctx.fillStyle = FLAME;
  flamePath(ctx, x, y, h);
  ctx.fill();
  ctx.fillStyle = PANEL;
  flamePath(ctx, x, y - h * 0.08, h * 0.45);
  ctx.fill();
}

/** Draw text with a flame in front, the pair centered horizontally. */
function flameLine(ctx, text, y, { weight, size, color }) {
  const flameH = size * 0.95;
  const gap = size * 0.4;
  const flameW = flameH * 0.72;
  const shown = fitText(ctx, text, weight, size, SIZE - MARGIN * 2 - 80 - flameW - gap);
  const fontSize = Number(/(\d+)px/.exec(ctx.font)?.[1]) || size;
  const textW = ctx.measureText(shown).width;
  const left = (SIZE - (flameW + gap + textW)) / 2;
  drawFlame(ctx, left + flameW / 2, y + fontSize * 0.04, flameH * (fontSize / size));
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.fillText(shown, left + flameW + gap, y);
}

/** Load the coin logo; null when missing, unreadable or not a decodable image. */
async function loadLogo(logoPath) {
  if (typeof logoPath !== "string" || !logoPath) return null;
  try {
    const img = await loadImage(await readFile(logoPath));
    return img.width > 0 && img.height > 0 ? img : null;
  } catch {
    return null;
  }
}

/** Coin logo clipped to a circle, or a neutral circle with the symbol's first two letters. */
function drawLogo(ctx, img, symbol, x, y) {
  const r = LOGO / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  ctx.closePath();
  if (img) {
    ctx.clip();
    // Cover-fit: scale the shorter side to the circle and centre-crop the rest.
    const scale = LOGO / Math.min(img.width, img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, x + (LOGO - w) / 2, y + (LOGO - h) / 2, w, h);
  } else {
    ctx.fillStyle = LOGO_FALLBACK;
    ctx.fill();
    const letters = String(symbol ?? "").slice(0, 2).toUpperCase() || "?";
    ctx.font = `700 38px ${FONT}`;
    ctx.fillStyle = TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letters, x + r, y + r + 2);
  }
  ctx.restore();
}

/**
 * Render a share card.
 * @param {{coinSymbol: string, title: string, logoPath?: string|null, percent: number|null,
 *   streak: number, bestStreak: number, periodWord: string, onTrackDate: string|null,
 *   amountsLine: string|null}} card
 * @returns {Promise<Buffer>} PNG bytes, 1080x1080
 */
export async function renderCard(card) {
  const logo = await loadLogo(card.logoPath);
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Brand, top-left.
  ctx.font = `700 36px ${FONT}`;
  ctx.fillStyle = TEXT;
  ctx.textAlign = "left";
  ctx.fillText("AutoStack", MARGIN, 104);

  // Header row: coin logo + goal title.
  const headerY = 150;
  drawLogo(ctx, logo, card.coinSymbol, MARGIN, headerY);
  const titleX = MARGIN + LOGO + 28;
  const title = fitText(ctx, card.title, 700, 60, SIZE - MARGIN - titleX);
  ctx.fillStyle = TEXT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, titleX, headerY + LOGO / 2 + 2);
  ctx.textBaseline = "alphabetic";

  // Panel holding the ring and streak details.
  const panelTop = 290;
  const panelBottom = 950;
  ctx.fillStyle = PANEL;
  roundRect(ctx, MARGIN, panelTop, SIZE - MARGIN * 2, panelBottom - panelTop, 44);
  ctx.fill();

  // Keep the panel content vertically centred: each missing optional line frees ~half a row.
  const shift = ((card.onTrackDate ? 0 : 1) + (card.amountsLine ? 0 : 1)) * 26;

  // Progress ring.
  const cx = SIZE / 2;
  const cy = 520 + shift;
  const r = 165;
  const hasGoal = typeof card.percent === "number" && Number.isFinite(card.percent);
  const pct = hasGoal ? Math.min(100, Math.max(0, card.percent)) : 100;
  ctx.lineWidth = 36;
  ctx.lineCap = "round";
  ctx.strokeStyle = RING_TRACK;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (pct > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = RING;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + (Math.PI * 2 * pct) / 100);
    ctx.stroke();
  }

  // Ring centre: percent with a goal, otherwise the current streak.
  const inner = r * 2 - 100;
  if (hasGoal) {
    centeredText(ctx, `${Math.round(pct)}%`, cy + 34, { weight: 700, size: 104, color: TEXT, maxWidth: inner });
    centeredText(ctx, "of goal", cy + 82, { weight: 400, size: 28, color: SECONDARY, maxWidth: inner });
  } else {
    centeredText(ctx, String(card.streak), cy + 28, { weight: 700, size: 120, color: TEXT, maxWidth: inner });
    const unit = card.streak === 1 ? card.periodWord : `${card.periodWord}s`;
    centeredText(ctx, `${unit} in a row`, cy + 80, { weight: 400, size: 28, color: SECONDARY, maxWidth: inner });
  }

  // Detail lines below the ring.
  let y = 790 + shift;
  // With no goal the streak is already in the ring, so only show the best streak here.
  const streakLine = hasGoal
    ? `${plural(card.streak, card.periodWord)} in a row · best ${card.bestStreak}`
    : `Best streak · ${plural(card.bestStreak, card.periodWord)}`;
  flameLine(ctx, streakLine, y, { weight: 600, size: 40, color: TEXT });
  y += 58;
  if (card.onTrackDate) {
    centeredText(ctx, `On track for ${card.onTrackDate}`, y, { weight: 400, size: 34, color: SECONDARY, maxWidth: SIZE - MARGIN * 2 - 80 });
    y += 52;
  }
  if (card.amountsLine) {
    centeredText(ctx, card.amountsLine, y, { weight: 400, size: 32, color: SECONDARY, maxWidth: SIZE - MARGIN * 2 - 80 });
  }

  // Footer: Tangem appears only here, as text.
  centeredText(ctx, FOOTER, SIZE - 52, { weight: 400, size: 26, color: SECONDARY });

  return canvas.encode("png");
}
