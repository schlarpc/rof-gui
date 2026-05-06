/**
 * Render a shareable summary card to a canvas. Returns a Blob.
 *
 * Mirrors the live HeroResult layout — same accent-bar headline, same
 * 4-stat strip, same palette and typography stack — so the export reads
 * as a snapshot of the UI rather than a separate document.
 */

import type { AnalysisResult } from './rof-detector.js';

const COLORS = {
  bg: '#FAFAF7',
  cardBg: '#FFFFFF',
  border: '#E8E8E3',
  text: '#1A1A19',
  textSecondary: '#5C5C58',
  textTertiary: '#98988F',
  accent: '#00879A'
};

const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif";
const FONT_MONO = "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace";

export interface ResultCardOptions {
  headlineRpm?: number;
  ci95?: number;
  filename?: string;
}

export async function renderResultCard(
  canvas: HTMLCanvasElement,
  results: AnalysisResult,
  options: ResultCardOptions = {}
): Promise<Blob | null> {
  if (document.fonts?.ready) await document.fonts.ready;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const W = canvas.width;
  const H = canvas.height;

  // Page bg + inset card
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  const PAD = 48;
  const cardX = PAD;
  const cardY = PAD;
  const cardW = W - PAD * 2;
  const cardH = H - PAD * 2;

  ctx.fillStyle = COLORS.cardBg;
  roundRect(ctx, cardX, cardY, cardW, cardH, 14);
  ctx.fill();
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  roundRect(ctx, cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 14);
  ctx.stroke();

  const summary = results.summary;
  const headline = options.headlineRpm ?? summary.meanBurstRateRpm ?? summary.cyclicRateRpm ?? 0;
  const ci95 = options.ci95 ?? summary.cyclicRateCI95 ?? 0;
  const periodMs = summary.medianIntervalMs ?? 0;
  const jitterMs = summary.intervalStdMs ?? 0;

  // --- Headline ---
  const innerX = cardX + 40;
  const innerRight = cardX + cardW - 40;
  const headlineTop = cardY + 36;
  const headlineSize = 168;
  const headlineBaseline = headlineTop + Math.round(headlineSize * 0.85);

  // Headline number
  const numX = innerX;
  ctx.fillStyle = COLORS.accent;
  ctx.font = `700 ${headlineSize}px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const headlineText = Math.round(headline).toString();
  ctx.fillText(headlineText, numX, headlineBaseline);
  const headlineW = ctx.measureText(headlineText).width;

  // Unit + CI stacked to the right
  const unitX = numX + headlineW + 22;
  ctx.fillStyle = COLORS.textSecondary;
  ctx.font = `600 28px ${FONT_MONO}`;
  ctx.fillText('RPM', unitX, headlineBaseline - headlineSize * 0.4);

  if (ci95 > 0) {
    ctx.fillStyle = COLORS.textTertiary;
    ctx.font = `400 18px ${FONT_SANS}`;
    ctx.fillText(`±${ci95.toFixed(1)} 95% CI`, unitX, headlineBaseline - headlineSize * 0.22);
  }

  // --- Stat strip ---
  // Footer reserves bottom rows for filename + url; strip sits above it.
  const footerTop = cardY + cardH - 78;
  const stripTop = footerTop - 92;
  const stripH = 80;

  // Top divider
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(innerX, stripTop + 0.5);
  ctx.lineTo(innerRight, stripTop + 0.5);
  ctx.stroke();

  const stats: [string, string, string | null][] = [
    ['PERIOD', `${periodMs.toFixed(1)}`, 'ms'],
    ['SHOTS', String(summary.totalShots), null],
    ['JITTER', `${jitterMs.toFixed(1)}`, 'ms'],
    ['BURSTS', String(summary.totalBursts), null]
  ];

  const colW = (innerRight - innerX) / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const [label, value, unit] = stats[i];
    const colX = innerX + i * colW + 22;

    if (i > 0) {
      // Inter-column divider
      const dx = innerX + i * colW + 0.5;
      ctx.strokeStyle = COLORS.border;
      ctx.beginPath();
      ctx.moveTo(dx, stripTop + 16);
      ctx.lineTo(dx, stripTop + stripH - 8);
      ctx.stroke();
    }

    ctx.fillStyle = COLORS.textTertiary;
    ctx.font = `600 12px ${FONT_SANS}`;
    ctx.textAlign = 'left';
    ctx.fillText(label, colX, stripTop + 30);

    ctx.fillStyle = COLORS.text;
    ctx.font = `600 30px ${FONT_MONO}`;
    ctx.fillText(value, colX, stripTop + 66);
    if (unit) {
      const valueW = ctx.measureText(value).width;
      ctx.fillStyle = COLORS.textTertiary;
      ctx.font = `400 14px ${FONT_SANS}`;
      ctx.fillText(unit, colX + valueW + 6, stripTop + 66);
    }
  }

  // --- Footer ---
  ctx.fillStyle = COLORS.textSecondary;
  ctx.font = `400 14px ${FONT_MONO}`;
  if (options.filename) {
    ctx.fillText(options.filename, innerX, footerTop + 22);
  }
  ctx.fillStyle = COLORS.textTertiary;
  ctx.font = `400 12px ${FONT_SANS}`;
  ctx.fillText('schlarpc.github.io/rof-gui', innerX, footerTop + 46);

  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
