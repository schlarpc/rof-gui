/**
 * Download helpers for the timeline plot, the result card, and the raw
 * analysis JSON.
 */

import { renderResultCard } from './result-card.js';
import type { AnalysisResult } from './rof-detector.js';

export function downloadJson(results: AnalysisResult): void {
  const data = JSON.stringify(results, null, 2);
  triggerDownload(new Blob([data], { type: 'application/json' }), 'rof_results.json');
}

export async function downloadPlot(): Promise<void> {
  const main = document.querySelector<HTMLCanvasElement>('.timeline-card .main-canvas');
  const strip = document.querySelector<HTMLCanvasElement>('.timeline-card .strip-canvas');
  const axis = document.querySelector<HTMLCanvasElement>('.timeline-card .axis-canvas');
  if (!main) return;
  const w = main.width;
  const h = main.height + (strip?.height ?? 0) + (axis?.height ?? 0);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  let y = 0;
  ctx.drawImage(main, 0, y); y += main.height;
  if (strip) { ctx.drawImage(strip, 0, y); y += strip.height; }
  if (axis) { ctx.drawImage(axis, 0, y); }
  const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/png'));
  if (blob) triggerDownload(blob, 'rof_plot.png');
}

export async function downloadCard(
  results: AnalysisResult,
  headlineRpm: number,
  ci95: number
): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 560;
  const blob = await renderResultCard(canvas, results, {
    headlineRpm,
    ci95,
    filename: results.inputFile
  });
  if (blob) triggerDownload(blob, 'rof_card.png');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
