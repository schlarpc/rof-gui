/**
 * Debug a single vector file: dump envelope autocorrelation, coarse peaks,
 * interval histogram. Used for algorithm tuning.
 *
 * Usage: tsx test/debug-file.ts <filename-substring>
 */

import { basename } from 'node:path';

import * as signal from '../src/signal-processing.js';
import * as autotune from '../src/auto-tune.js';
import { findVector, decodeFlac, SAMPLE_RATE } from './_shared.js';

function envelope(audio: Float32Array, sampleRate: number, windowMs: number): Float32Array {
  const windowSamples = Math.max(Math.floor(windowMs * sampleRate / 1000), 1);
  const abs = signal.abs(audio);
  if (windowSamples === 1) return abs;
  const window = signal.divide(signal.ones(windowSamples), windowSamples);
  return signal.convolve(abs, window, 'same');
}

const filterArg = process.argv[2];
if (!filterArg) {
  console.error('Usage: tsx test/debug-file.ts <filename-substring>');
  process.exit(1);
}

const found = findVector(filterArg);
if (!found) {
  console.error(`No vector matching "${filterArg}"`);
  process.exit(1);
}

console.log(`File: ${basename(found.path)}\n`);

const audio = decodeFlac(found.path);
const duration = audio.length / SAMPLE_RATE;
console.log(`Duration: ${duration.toFixed(2)}s   samples: ${audio.length}\n`);

for (const winMs of [2, 5, 10, 20]) {
  console.log(`=== Envelope window=${winMs}ms ===`);
  const env = envelope(audio, SAMPLE_RATE, winMs);

  const coarse = autotune.coarsePeaks(env, SAMPLE_RATE);
  console.log(`Coarse peaks: ${coarse.length}`);

  const intervalEst = autotune.estimatePeriodFromIntervals(coarse, SAMPLE_RATE);
  if (intervalEst) {
    console.log(`Interval estimate: T=${(intervalEst.period * 1000).toFixed(2)}ms = ${(60 / intervalEst.period).toFixed(0)} RPM (conf=${intervalEst.confidence.toFixed(2)})`);
  } else {
    console.log('Interval estimate: failed');
  }

  const acfEst = autotune.estimatePeriodFromAutocorrelation(audio, SAMPLE_RATE);
  if (acfEst) {
    console.log(`ACF estimate:      T=${(acfEst.period * 1000).toFixed(2)}ms = ${(60 / acfEst.period).toFixed(0)} RPM (conf=${acfEst.confidence.toFixed(2)})`);
  }

  // Show ACF curve top-5 peaks
  const downsampleFactor = Math.max(1, Math.floor(SAMPLE_RATE / 8000));
  const dsRate = SAMPLE_RATE / downsampleFactor;
  const dsLen = Math.floor(env.length / downsampleFactor);
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) {
    let m = 0;
    for (let j = 0; j < downsampleFactor; j++) {
      const v = env[i * downsampleFactor + j];
      if (v > m) m = v;
    }
    ds[i] = m;
  }
  const dsMean = signal.mean(ds);
  for (let i = 0; i < ds.length; i++) ds[i] -= dsMean;
  const maxLag = Math.floor(0.250 * dsRate);
  const acf = signal.autocorrelate(ds, maxLag);

  // Find local maxima in plausible range
  interface ACFPeak { lag: number; periodMs: number; value: number; rpm: number; }
  const localMaxes: ACFPeak[] = [];
  const minLagSamples = Math.floor(0.015 * dsRate);
  for (let lag = Math.max(2, minLagSamples); lag < acf.length - 1; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] > acf[lag + 1]) {
      localMaxes.push({ lag, periodMs: lag / dsRate * 1000, value: acf[lag], rpm: 60 / (lag / dsRate) });
    }
  }
  localMaxes.sort((a, b) => b.value - a.value);
  console.log('Top ACF local maxima:');
  for (const lm of localMaxes.slice(0, 6)) {
    console.log(`  T=${lm.periodMs.toFixed(2).padStart(7)}ms   ${lm.rpm.toFixed(0).padStart(5)} RPM   acf=${lm.value.toFixed(4)}`);
  }

  // Show interval histogram top bins
  if (coarse.length >= 4) {
    const intervals = new Float32Array(coarse.length - 1);
    for (let i = 0; i < intervals.length; i++) intervals[i] = (coarse[i + 1] - coarse[i]) / SAMPLE_RATE;
    const plausible = Array.from(intervals).filter(v => v >= 0.020 && v <= 0.200);
    if (plausible.length >= 3) {
      const { counts, lo, binWidth } = signal.histogram(plausible, { binWidth: 0.001, minValue: 0.020, maxValue: 0.200 });
      const binsRanked = Array.from(counts).map((c, i) => ({ count: c, ms: (lo + (i + 0.5) * binWidth) * 1000 })).sort((a, b) => b.count - a.count);
      console.log('Top interval bins (plausible 20-200ms):');
      for (const b of binsRanked.slice(0, 5)) {
        if (b.count === 0) break;
        console.log(`  T=${b.ms.toFixed(2).padStart(7)}ms   ${(60000 / b.ms).toFixed(0).padStart(5)} RPM   count=${b.count}`);
      }
    }
  }

  console.log('');
}
