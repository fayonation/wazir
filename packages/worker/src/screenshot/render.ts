import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";

// Register Menlo (macOS built-in monospace) for crisp terminal rendering.
const MENLO = "/System/Library/Fonts/Menlo.ttc";
const MONACO = "/System/Library/Fonts/Monaco.ttf";
let fontFamily = "monospace";
if (existsSync(MENLO)) {
  GlobalFonts.registerFromPath(MENLO, "Menlo");
  fontFamily = "Menlo";
} else if (existsSync(MONACO)) {
  GlobalFonts.registerFromPath(MONACO, "Monaco");
  fontFamily = "Monaco";
}

const FONT_SIZE = 13;
const LINE_HEIGHT = 19;
const H_PAD = 20;
const V_PAD = 16;
const BG = "#1e1e2e";         // dark background
const FG = "#cdd6f4";         // main text
const TITLE_BG = "#313244";   // top bar
const TITLE_FG = "#a6adc8";   // top bar text
const MAX_WIDTH = 900;

/**
 * Render a tmux pane capture as a dark-themed terminal PNG.
 * Returns a Buffer containing the PNG bytes.
 */
export function renderPanePng(rawText: string, sessionLabel?: string): Buffer {
  // Strip ANSI escape sequences before rendering.
  // eslint-disable-next-line no-control-regex
  const text = rawText.replace(/\x1b\[[\d;]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

  const lines = text.split("\n").map((l) => l.trimEnd());
  // Trim trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) lines.push("(empty pane)");

  // Measure with a throwaway canvas first.
  const probe = createCanvas(1, 1);
  const pctx = probe.getContext("2d");
  pctx.font = `${FONT_SIZE}px "${fontFamily}"`;
  const charWidth = pctx.measureText("M").width;

  const maxLineLen = Math.max(...lines.map((l) => l.length));
  const contentWidth = Math.min(maxLineLen * charWidth + H_PAD * 2, MAX_WIDTH);
  const width = Math.max(contentWidth, 400);
  const titleBarH = 32;
  const height = titleBarH + lines.length * LINE_HEIGHT + V_PAD * 2;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // ── title bar ──────────────────────────────────────────────────
  ctx.fillStyle = TITLE_BG;
  ctx.fillRect(0, 0, width, titleBarH);

  // Traffic-light dots
  const dots: [string, number][] = [["#ff5f57", 16], ["#ffbd2e", 36], ["#28c840", 56]];
  for (const [color, x] of dots) {
    ctx.beginPath();
    ctx.arc(x, titleBarH / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  if (sessionLabel) {
    ctx.fillStyle = TITLE_FG;
    ctx.font = `12px "${fontFamily}"`;
    ctx.textAlign = "center";
    ctx.fillText(sessionLabel, width / 2, titleBarH / 2 + 4);
    ctx.textAlign = "left";
  }

  // ── body ───────────────────────────────────────────────────────
  ctx.fillStyle = BG;
  ctx.fillRect(0, titleBarH, width, height - titleBarH);

  ctx.font = `${FONT_SIZE}px "${fontFamily}"`;
  ctx.fillStyle = FG;

  for (let i = 0; i < lines.length; i++) {
    const y = titleBarH + V_PAD + (i + 1) * LINE_HEIGHT;
    const line = lines[i] ?? "";
    const maxChars = Math.floor((width - H_PAD * 2) / charWidth);
    const display = line.length > maxChars ? line.slice(0, maxChars - 1) + "…" : line;
    ctx.fillText(display, H_PAD, y);
  }

  return canvas.toBuffer("image/png");
}
