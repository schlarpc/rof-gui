/**
 * Probe the matched-filter pipeline.
 *
 * Usage: tsx test/debug-mf.ts <filename-substring>
 */

import * as signal from '../src/signal-processing.js';
import * as autotune from '../src/auto-tune.js';
import { findVector, decodeFlac, SAMPLE_RATE } from './_shared.js';

function envelope(audio: Float32Array, sampleRate: number, windowMs = 2): Float32Array {
  const ws = Math.floor(windowMs * sampleRate / 1000);
  const abs = signal.abs(audio);
  if (ws <= 1) return abs;
  const w = signal.divide(signal.ones(ws), ws);
  return signal.convolve(abs, w, 'same');
}

const filterArg = process.argv[2];
if (!filterArg) {
  console.error('Usage: tsx test/debug-mf.ts <filename-substring>');
  process.exit(1);
}

const found = findVector(filterArg);
if (!found) {
  console.error(`No vector matching "${filterArg}"`);
  process.exit(1);
}

console.log(`File: ${found.name}\n`);
const audio = decodeFlac(found.path);
const env = envelope(audio, SAMPLE_RATE, 2);

const tuning = autotune.estimatePeriod(audio, env, SAMPLE_RATE);
if (!tuning) {
  console.error('Period estimation failed');
  process.exit(1);
}
console.log(`Period: ${(tuning.period * 1000).toFixed(2)}ms (${(60 / tuning.period).toFixed(0)} RPM)`);

const result = autotune.detectShots(env, SAMPLE_RATE, tuning.period);
console.log(`\nDetected peaks: ${result.peaks.length}`);
console.log(`Score threshold: ${result.threshold.toFixed(4)}`);

if (result.score) {
  const score = result.score;
  console.log(`Score stats: min=${signal.min(score).toFixed(4)} max=${signal.max(score).toFixed(4)} mean=${signal.mean(score).toFixed(4)} median=${signal.median(score).toFixed(4)} mad=${signal.mad(score).toFixed(4)}`);

  const sorted = Array.from(score).sort((a, b) => b - a);
  console.log(`Top score values: ${sorted.slice(0, 10).map(v => v.toFixed(3)).join(', ')}`);

  const seedThr = signal.median(env) + 3 * signal.mad(env);
  const { peaks } = signal.findPeaks(env, { height: seedThr, distance: Math.floor(tuning.period * 0.7 * SAMPLE_RATE) });
  console.log(`\nSeed peaks: ${peaks.length}`);
  if (peaks.length > 0) {
    const strongest = peaks.reduce((best, idx) => env[idx] > env[best] ? idx : best, peaks[0]);
    console.log(`Strongest seed peak at sample ${strongest} (t=${(strongest / SAMPLE_RATE).toFixed(3)}s, env=${env[strongest].toFixed(4)})`);
    const scoreAt = score[strongest];
    console.log(`Score at that location: ${scoreAt !== undefined ? scoreAt.toFixed(4) : 'undefined'}`);

    const span = Math.floor(0.01 * SAMPLE_RATE);
    let maxNearby = 0;
    for (let i = Math.max(0, strongest - span); i < Math.min(score.length, strongest + span); i++) {
      if (score[i] > maxNearby) maxNearby = score[i];
    }
    console.log(`Max score within ±10ms of peak: ${maxNearby.toFixed(4)}`);
  }
}

if (result.template) {
  console.log(`\nTemplate length: ${result.template.length}`);
  console.log(`Template values: ${Array.from(result.template).slice(0, 8).map(v => v.toFixed(3)).join(', ')}...`);
}
