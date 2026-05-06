/**
 * Render a diagnostic plot for a vector to a PNG.
 *
 * Three stacked panels:
 *   1. Envelope (smoothed for display) with detected shot markers — mirrors
 *      the in-browser visualization.
 *   2. Onset signal (envelope first-difference, half-wave rectified) used to
 *      build the matched-filter template, with seed peaks.
 *   3. Matched-filter score with adaptive threshold and chosen peaks.
 *
 * Surfacing the internal signals lets us see WHERE the pipeline decides
 * something is a shot — the browser plot only shows the final markers on
 * the envelope, which can hide the actual cause of a misdetection.
 *
 * Usage: tsx test/render-plot.ts <filename-substring> [output.png]
 */

import { writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RateOfFireDetector } from '../src/rof-detector.js';
import * as autotune from '../src/auto-tune.js';
import * as signal from '../src/signal-processing.js';
import { findVector, decodeFlac, SAMPLE_RATE } from './_shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function boxcarSmooth(data: Float32Array, windowSize: number): Float32Array {
  if (windowSize <= 1) return data;
  const n = data.length;
  const out = new Float32Array(n);
  const half = Math.floor(windowSize / 2);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(half, n); i++) { sum += data[i]; count++; }
  for (let i = 0; i < n; i++) {
    const addIdx = i + half;
    const dropIdx = i - half - 1;
    if (addIdx < n) { sum += data[addIdx]; count++; }
    if (dropIdx >= 0) { sum -= data[dropIdx]; count--; }
    out[i] = sum / count;
  }
  return out;
}

interface DownsampleResult { values: number[]; indices: number[]; }

function downsampleMax(data: Float32Array, maxPoints: number): DownsampleResult {
  const n = data.length;
  if (n <= maxPoints) return { values: Array.from(data), indices: Array.from({ length: n }, (_, i) => i) };
  const step = n / maxPoints;
  const values = new Array<number>(maxPoints);
  const indices = new Array<number>(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.min(n, Math.floor((i + 1) * step));
    let m = -Infinity;
    let argmax = lo;
    for (let j = lo; j < hi; j++) {
      if (data[j] > m) { m = data[j]; argmax = j; }
    }
    values[i] = m;
    indices[i] = argmax;
  }
  return { values, indices };
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

interface Marker {
  time: number;
  value: number;
  color: string;
  edge?: string;
}

interface HLine {
  value: number;
  color: string;
  label?: string;
  dash?: boolean;
}

interface VLine {
  time: number;
  color: string;
  dash?: boolean;
}

interface PanelOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Float32Array;
  duration: number;
  yMin: number;
  yMax: number;
  title: string;
  lineColor?: string;
  fillColor?: string;
  markers?: Marker[];
  hLines?: HLine[];
  vLines?: VLine[];
}

/**
 * Render one panel as SVG. Maps the data array (indexed 0..n-1 over the
 * audio duration) and an array of marker indices into the panel's
 * coordinate box. Returns an SVG fragment.
 */
function renderPanel(opts: PanelOptions): string {
  const {
    x, y, width, height,
    data, duration,
    yMin, yMax,
    title,
    lineColor = '#1F2937',
    fillColor = 'rgba(31, 41, 55, 0.06)',
    markers = [],
    hLines = [],
    vLines = []
  } = opts;
  const padL = 50, padR = 8, padT = 18, padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const bx = x + padL;
  const by = y + padT;

  const tx = (t: number) => bx + (t / duration) * innerW;
  const vy = (v: number) => by + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const target = Math.min(2000, data.length);
  const { values: dsVals, indices: dsIdx } = downsampleMax(data, target);
  const sampleRate = data.length / duration;

  let path = '';
  let fill = `M ${tx(0).toFixed(1)} ${vy(yMin).toFixed(1)} `;
  for (let i = 0; i < dsVals.length; i++) {
    const t = dsIdx[i] / sampleRate;
    const cmd = i === 0 ? 'M' : 'L';
    path += `${cmd} ${tx(t).toFixed(1)} ${vy(dsVals[i]).toFixed(1)} `;
    fill += `L ${tx(t).toFixed(1)} ${vy(dsVals[i]).toFixed(1)} `;
  }
  fill += `L ${tx(duration).toFixed(1)} ${vy(yMin).toFixed(1)} Z`;

  let svg = '';
  svg += `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white" stroke="#D4D4CE" stroke-width="0.5"/>`;
  svg += `<text x="${bx}" y="${by - 4}" font-family="sans-serif" font-size="11" fill="#5C5C58">${escapeXml(title)}</text>`;

  // x-axis grid (every 0.5s)
  for (let t = 0; t <= duration + 1e-6; t += 0.5) {
    const xx = tx(t).toFixed(1);
    svg += `<line x1="${xx}" y1="${by}" x2="${xx}" y2="${by + innerH}" stroke="#EFEFEA" stroke-width="0.5"/>`;
    svg += `<text x="${xx}" y="${by + innerH + 14}" font-family="sans-serif" font-size="9" fill="#5C5C58" text-anchor="middle">${t.toFixed(1)}</text>`;
  }
  svg += `<text x="${bx - 4}" y="${(by + 8).toFixed(1)}" font-family="sans-serif" font-size="9" fill="#5C5C58" text-anchor="end">${yMax.toFixed(3)}</text>`;
  svg += `<text x="${bx - 4}" y="${(by + innerH).toFixed(1)}" font-family="sans-serif" font-size="9" fill="#5C5C58" text-anchor="end">${yMin.toFixed(3)}</text>`;

  svg += `<rect x="${bx}" y="${by}" width="${innerW}" height="${innerH}" fill="none" stroke="#D4D4CE" stroke-width="0.5"/>`;

  for (const hl of hLines) {
    if (hl.value < yMin || hl.value > yMax) continue;
    const yy = vy(hl.value).toFixed(1);
    const dash = hl.dash ? `stroke-dasharray="4 3"` : '';
    svg += `<line x1="${bx}" y1="${yy}" x2="${bx + innerW}" y2="${yy}" stroke="${hl.color}" stroke-width="0.8" ${dash}/>`;
    if (hl.label) {
      svg += `<text x="${bx + innerW - 4}" y="${(parseFloat(yy) - 2)}" font-family="sans-serif" font-size="9" fill="${hl.color}" text-anchor="end">${escapeXml(hl.label)}</text>`;
    }
  }

  for (const vl of vLines) {
    const xx = tx(vl.time).toFixed(1);
    const dash = vl.dash ? `stroke-dasharray="3 3"` : '';
    svg += `<line x1="${xx}" y1="${by}" x2="${xx}" y2="${by + innerH}" stroke="${vl.color}" stroke-width="0.8" ${dash}/>`;
  }

  svg += `<path d="${fill}" fill="${fillColor}" stroke="none"/>`;
  svg += `<path d="${path}" fill="none" stroke="${lineColor}" stroke-width="1"/>`;

  for (const m of markers) {
    const cx = tx(m.time).toFixed(1);
    const cy = vy(m.value).toFixed(1);
    svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="${m.color}" stroke="${m.edge ?? '#005c6c'}" stroke-width="0.8"/>`;
  }

  return svg;
}

interface ScoreInfo {
  onset: Float32Array;
  seedPeaks: number[];
  score: Float32Array | null;
  scorePeaks: number[];
  threshold: number;
  preSamples?: number;
}

/**
 * Re-run the matched-filter pipeline so we can capture intermediate signals
 * (onset, seed peaks, raw score peaks). Mirrors `autotune.detectShots()`
 * but returns more detail.
 */
function probeMatchedFilter(detectionSignal: Float32Array, sampleRate: number, period: number): ScoreInfo {
  const minDistance = Math.max(1, Math.floor(period * 0.7 * sampleRate));
  const onset = autotune.onsetSignal(detectionSignal, sampleRate, 3);
  const med = signal.median(onset);
  const m = signal.mad(onset);
  const seedThreshold = med + 4 * m;
  const { peaks: seedPeaks } = signal.findPeaks(onset, {
    height: seedThreshold, distance: minDistance, prominence: 0
  });
  if (seedPeaks.length < 4) {
    return { onset, seedPeaks, score: null, scorePeaks: [], threshold: 0 };
  }
  const tpl = autotune.buildTemplate(onset, sampleRate, seedPeaks, {
    lengthMs: Math.min(15, Math.max(6, period * 200)), preMs: 2
  });
  if (!tpl) return { onset, seedPeaks, score: null, scorePeaks: [], threshold: 0 };

  const score = autotune.matchedFilter(onset, tpl.template);
  const { peaks: scorePeaks } = signal.findPeaks(score, { height: 0, distance: minDistance, prominence: 0 });
  const scoreMed = signal.median(score);
  const scoreMad = signal.mad(score);
  const threshold = scoreMed + 3 * scoreMad;
  return { onset, seedPeaks, score, scorePeaks, threshold, preSamples: tpl.preSamples };
}

interface BuildSVGArgs {
  result: ReturnType<RateOfFireDetector['runAnalysis']>;
  detector: RateOfFireDetector;
  fileLabel: string;
  onset: Float32Array;
  scoreInfo: ScoreInfo;
  seedPeaks: number[];
}

/** Build a diagnostic SVG. Three stacked panels share a time axis. */
function buildSVG({ result, detector, fileLabel, onset, scoreInfo, seedPeaks }: BuildSVGArgs): string {
  if (!detector.envelope) throw new Error('envelope not computed');
  const sampleRate = detector.sampleRate;
  const duration = detector.envelope.length / sampleRate;
  const W = 1400;
  const H = 800;
  const headerH = 60;
  const panelH = (H - headerH) / 3;

  // Panel 1: envelope + final shot markers
  const smoothSamples = Math.max(1, Math.floor(0.020 * sampleRate));
  const displayEnvelope = boxcarSmooth(detector.envelope, smoothSamples);
  const envMax = signal.max(detector.envelope);
  const peakMarkers: Marker[] = (result.peaks || []).map(idx => ({
    time: idx / sampleRate,
    value: displayEnvelope[idx] ?? 0,
    color: '#00879A'
  }));

  // Burst boundary lines
  const burstLines: VLine[] = [];
  for (const burst of detector.bursts) {
    const t0 = detector.shotTimes[burst[0]];
    const t1 = detector.shotTimes[burst[burst.length - 1]];
    burstLines.push({ time: t0, color: 'rgba(0,135,154,0.4)', dash: true });
    burstLines.push({ time: t1, color: 'rgba(0,135,154,0.4)', dash: true });
  }

  // Panel 2: onset + seed peaks
  const onsetMax = signal.max(onset);
  const seedMarkers: Marker[] = seedPeaks.map(idx => ({
    time: idx / sampleRate,
    value: onset[idx],
    color: '#E07B00',
    edge: '#a55300'
  }));

  // Panel 3: matched filter score + threshold
  const score = scoreInfo.score;
  const scoreMax = score ? signal.max(score) : 0;
  const scoreThr = scoreInfo.threshold;
  const chosenScoreMarkers: Marker[] = score ? scoreInfo.scorePeaks.map(idx => ({
    time: idx / sampleRate,
    value: score[idx] ?? 0,
    color: '#7A2E8E',
    edge: '#4f1e5c'
  })) : [];

  // Header text
  const t = result.tuning;
  const tunedRpm = t?.period ? 60 / t.period : null;
  const headerLines = [
    `${fileLabel}   duration=${duration.toFixed(2)}s   sr=${sampleRate}Hz`,
    `tuning: ${t?.period ? `T=${(t.period * 1000).toFixed(2)}ms (${tunedRpm!.toFixed(1)} RPM)  conf=${t.confidence.toFixed(2)}  src=${t.source ?? ''}` : 'failed'}`,
    `summary: ${result.summary.totalShots} shots in ${result.summary.totalBursts} bursts   cyclic=${result.summary.cyclicRateRpm.toFixed(1)}±${result.summary.cyclicRateCI95.toFixed(1)} RPM   mfScoreThr=${scoreThr?.toFixed(3) ?? 'n/a'}`
  ];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="white"/>`;

  for (let i = 0; i < headerLines.length; i++) {
    svg += `<text x="12" y="${16 + i * 14}" font-family="monospace" font-size="11" fill="#1F2937">${escapeXml(headerLines[i])}</text>`;
  }

  svg += renderPanel({
    x: 0, y: headerH, width: W, height: panelH,
    data: displayEnvelope, duration,
    yMin: 0, yMax: envMax * 1.05,
    title: 'Envelope (display, 20ms smooth) + final shot markers',
    lineColor: '#1F2937', fillColor: 'rgba(31, 41, 55, 0.06)',
    markers: peakMarkers,
    vLines: burstLines
  });

  svg += renderPanel({
    x: 0, y: headerH + panelH, width: W, height: panelH,
    data: onset, duration,
    yMin: 0, yMax: onsetMax * 1.05,
    title: 'Onset signal (rises in shotness, 3ms lag, half-wave) + seed peaks',
    lineColor: '#5C5C58', fillColor: 'rgba(92, 92, 88, 0.05)',
    markers: seedMarkers
  });

  if (score) {
    svg += renderPanel({
      x: 0, y: headerH + panelH * 2, width: W, height: panelH,
      data: score, duration,
      yMin: 0, yMax: Math.max(scoreMax * 1.05, scoreThr * 1.5),
      title: 'Matched filter score + adaptive threshold + chosen peaks',
      lineColor: '#7A2E8E', fillColor: 'rgba(122, 46, 142, 0.06)',
      markers: chosenScoreMarkers,
      hLines: [{ value: scoreThr, color: '#C03030', label: `thr=${scoreThr.toFixed(3)}`, dash: true }]
    });
  } else {
    svg += `<text x="12" y="${headerH + panelH * 2 + 30}" font-family="sans-serif" font-size="12" fill="#C03030">No matched filter score (fallback path).</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function main(): void {
  const filterArg = process.argv[2];
  if (!filterArg) {
    console.error('Usage: tsx test/render-plot.ts <filename-substring> [output.png]');
    process.exit(1);
  }
  const found = findVector(filterArg);
  if (!found) {
    console.error(`No vector matching "${filterArg}"`);
    process.exit(1);
  }
  const fileName = found.name;
  const audio = decodeFlac(found.path);

  const detector = new RateOfFireDetector({ autoTune: true });
  detector.setAudio(audio, SAMPLE_RATE);
  const result = detector.runAnalysis();

  const period = detector.tuning?.period;
  const detectionSignal = detector.shotness ?? detector.envelope;
  if (!detectionSignal) throw new Error('detection signal not computed');
  const probe = period
    ? probeMatchedFilter(detectionSignal, SAMPLE_RATE, period)
    : { onset: new Float32Array(detector.envelope!.length), seedPeaks: [], score: null, scorePeaks: [], threshold: 0 };

  const svg = buildSVG({
    result,
    detector,
    fileLabel: fileName,
    onset: probe.onset,
    scoreInfo: probe,
    seedPeaks: probe.seedPeaks
  });

  const outBase = process.argv[3] || join(resolve(__dirname, '..'), `plot_${basename(fileName, '.flac')}.png`);
  const svgPath = outBase.replace(/\.png$/i, '.svg');
  writeFileSync(svgPath, svg);
  const conv = spawnSync('magick', ['-density', '150', '-background', 'white', svgPath, '-resize', '1400x800', outBase], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (conv.status !== 0) {
    console.error(`magick conversion failed for ${svgPath}`);
    process.exit(1);
  }
  console.log(`Wrote ${outBase}`);
  console.log(`  shots=${result.summary.totalShots}  bursts=${result.summary.totalBursts}  cyclic=${result.summary.cyclicRateRpm.toFixed(1)} RPM`);
}

main();
