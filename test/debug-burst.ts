/**
 * Dump intervals and amplitudes for each burst in a vector. Used to debug
 * burst-end trimming.
 *
 * Usage: tsx test/debug-burst.ts <filename-substring>
 */

import { basename } from 'node:path';

import { RateOfFireDetector } from '../src/rof-detector.js';
import * as signal from '../src/signal-processing.js';
import { findVector, decodeFlac, SAMPLE_RATE } from './_shared.js';

const filterArg = process.argv[2];
if (!filterArg) {
  console.error('Usage: tsx test/debug-burst.ts <filename-substring>');
  process.exit(1);
}

const found = findVector(filterArg);
if (!found) {
  console.error(`No vector matching "${filterArg}"`);
  process.exit(1);
}
console.log(`File: ${basename(found.path)}\n`);

const audio = decodeFlac(found.path);
const detector = new RateOfFireDetector({ autoTune: true });
detector.setAudio(audio, SAMPLE_RATE);

// Run pipeline manually so we can inspect bursts before/after trim.
detector.calculateEnvelope();
detector.estimatePeriod();
detector.detectShots();
detector.groupIntoBursts();

if (!detector.envelope) throw new Error('envelope was not computed');
const env = detector.envelope;

console.log(`Bursts before trim: ${detector.bursts.length}`);
for (let bi = 0; bi < detector.bursts.length; bi++) {
  const burst = detector.bursts[bi];
  const amps = burst.map(i => env[detector.shotPeakIndices[i]]);
  const times = burst.map(i => detector.shotTimes[i]);
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);

  const medAmp = signal.median(amps);
  const medInt = signal.median(intervals);

  console.log(`\n--- Burst ${bi + 1}: ${burst.length} shots ---`);
  console.log(`Median amp: ${medAmp.toFixed(4)}   Median interval: ${(medInt * 1000).toFixed(2)}ms (${(60 / medInt).toFixed(0)} RPM)`);
  console.log('  idx   time      amp       int(ms)   amp/med   int/med');

  for (let i = 0; i < burst.length; i++) {
    const t = times[i];
    const a = amps[i];
    const inv = i > 0 ? times[i] - times[i - 1] : null;
    const ampRatio = a / medAmp;
    const intRatio = inv != null ? inv / medInt : null;
    const flag = (ampRatio < 0.4 ? 'A' : '') + (intRatio != null && intRatio > 1.8 ? 'I' : '');
    console.log(
      `  ${String(i).padStart(3)}   ${t.toFixed(3).padStart(6)}s  ${a.toFixed(4).padStart(8)}  ${inv != null ? (inv * 1000).toFixed(1).padStart(7) : '   --- '}  ${ampRatio.toFixed(2).padStart(6)}    ${intRatio != null ? intRatio.toFixed(2).padStart(6) : '  --- '}  ${flag}`
    );
  }
}

console.log('\n--- Interval histogram (within bursts) ---');
const allIntervals: number[] = [];
for (const burst of detector.bursts) {
  for (let i = 1; i < burst.length; i++) {
    allIntervals.push(detector.shotTimes[burst[i]] - detector.shotTimes[burst[i - 1]]);
  }
}
allIntervals.sort((a, b) => a - b);
const totalT = (detector.tuning?.period ?? 0) * 1000;
console.log(`Current period (ACF): ${totalT.toFixed(2)}ms`);
console.log(`Intervals (ms, sorted): ${allIntervals.map(v => (v * 1000).toFixed(1)).join(', ')}`);
const half = Math.floor(allIntervals.length / 2);
const loMed = allIntervals[Math.floor(half / 2)] * 1000;
const hiMed = allIntervals[half + Math.floor(half / 2)] * 1000;
console.log(`Lower-half median: ${loMed.toFixed(2)}ms (${(60000 / loMed).toFixed(0)} RPM)`);
console.log(`Upper-half median: ${hiMed.toFixed(2)}ms (${(60000 / hiMed).toFixed(0)} RPM)`);
console.log(`Sum: ${(loMed + hiMed).toFixed(2)}ms (${(60000 / (loMed + hiMed)).toFixed(0)} RPM)`);
console.log(`Lower/upper ratio: ${(loMed / hiMed).toFixed(2)} (< 0.6 = bimodal-ish)`);

console.log('\n--- After cadence refinement ---');
detector.refineBurstsByCadence();
for (let bi = 0; bi < detector.bursts.length; bi++) {
  const burst = detector.bursts[bi];
  const times = burst.map(i => detector.shotTimes[i]);
  console.log(`Burst ${bi + 1}: ${burst.length} shots, ${times[0].toFixed(2)}s → ${times[times.length - 1].toFixed(2)}s`);
}
