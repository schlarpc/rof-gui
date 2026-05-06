/**
 * Auto-tune: estimate cyclic firing period from envelope, derive detection
 * params, and (optionally) build a matched-filter template for refinement.
 */

import * as signal from './signal-processing.js';
import type { NumericArray } from './signal-processing.js';

const MIN_PLAUSIBLE_PERIOD = 0.020; // 3000 RPM ceiling
const MAX_PLAUSIBLE_PERIOD = 0.200; // 300 RPM floor

export type TuningSource = 'autocorrelation' | 'intervals' | string;

export interface TuningEstimate {
  period: number;
  confidence: number;
  source?: TuningSource;
  intervals?: number[];
  localMaxes?: { lag: number; value: number }[];
  coarsePeaks?: number[];
  intervalEst?: TuningEstimate | null;
}

/**
 * Permissive coarse peak detection used as input to period estimation.
 * Robust (median + MAD) threshold rather than mean + std so loud outliers
 * don't pull the threshold above legitimate shots.
 */
export function coarsePeaks(envelope: NumericArray, sampleRate: number): number[] {
  const med = signal.median(envelope);
  const m = signal.mad(envelope);
  const threshold = med + 4 * m;
  const minDistance = Math.floor(0.010 * sampleRate); // 10 ms ≈ 6000 RPM

  const { peaks } = signal.findPeaks(envelope, {
    height: threshold,
    distance: minDistance,
    prominence: 0
  });

  return peaks;
}

/**
 * Estimate cyclic firing period from a coarse impulse train.
 * Confidence is the fraction of intervals that fall within ±20% of the mode.
 */
export function estimatePeriodFromIntervals(
  coarsePeakIndices: readonly number[],
  sampleRate: number
): TuningEstimate | null {
  if (coarsePeakIndices.length < 4) return null;

  const intervals = new Float32Array(coarsePeakIndices.length - 1);
  for (let i = 0; i < intervals.length; i++) {
    intervals[i] = (coarsePeakIndices[i + 1] - coarsePeakIndices[i]) / sampleRate;
  }

  const plausible = Array.from(intervals).filter(
    v => v >= MIN_PLAUSIBLE_PERIOD && v <= MAX_PLAUSIBLE_PERIOD
  );
  if (plausible.length < 3) return null;

  const { counts, lo, binWidth } = signal.histogram(plausible, {
    binWidth: 0.001,
    minValue: MIN_PLAUSIBLE_PERIOD,
    maxValue: MAX_PLAUSIBLE_PERIOD
  });

  let modeBin = 0;
  let modeCount = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > modeCount) { modeCount = counts[i]; modeBin = i; }
  }
  const modeCenter = lo + (modeBin + 0.5) * binWidth;

  const tolerance = 0.20 * modeCenter;
  const inMode = plausible.filter(v => Math.abs(v - modeCenter) <= tolerance);
  if (inMode.length < 3) return null;

  const period = signal.median(inMode);
  const confidence = inMode.length / plausible.length;

  return { period, confidence, intervals: plausible };
}

/**
 * Build a moderately smoothed envelope suitable for autocorrelation-based
 * period estimation. Within-shot transient gone (so doublet blast+crack
 * pairs collapse into one bump per shot) but the *between-shot* structure
 * preserved.
 */
function smoothedEnvelope(audio: NumericArray, sampleRate: number, windowMs = 5): Float32Array {
  const windowSamples = Math.max(Math.floor(windowMs * sampleRate / 1000), 1);
  const abs = signal.abs(audio);
  if (windowSamples === 1) return abs;
  const window = signal.divide(signal.ones(windowSamples), windowSamples);
  return signal.convolve(abs, window, 'same');
}

const BAND_SPLIT_HZ = 500;

export interface BandedEnvelopes {
  low: Float32Array;
  high: Float32Array;
}

/**
 * Decompose audio into a low-frequency band (≲ 500 Hz, dominated by
 * muzzle-blast pressure pulse and recoil/handling rumble) and a
 * high-frequency band (≳ 500 Hz, picking up action mechanics, ejection
 * noise, the upper end of the muzzle-blast spectrum, and any supersonic
 * crack when present). Lowpass is a zero-phase 4th-order Butterworth
 * (filtfilt) at 500 Hz; the high band is the residual.
 *
 * Combining the two bands distinguishes a real broadband shot (energy in
 * both bands at the same instant) from narrowband artifacts (brass clinks
 * live mostly above 1 kHz; distant thumps and HVAC live mostly below 500
 * Hz; reverberant tails preserve LF longer than HF). The bands are NOT
 * specific to a ballistic regime — subsonic and suppressed shots also
 * produce energy across both bands (action mechanics + muzzle-blast HF
 * tail), just with a different LF/HF balance than a supersonic shot.
 * Per-band normalization in `shotnessEnvelope` accommodates that range.
 */
export function bandedEnvelopes(
  audio: NumericArray,
  sampleRate: number,
  smoothMs = 2
): BandedEnvelopes {
  const n = audio.length;
  const lp = signal.lowpassButterworth(audio, sampleRate, BAND_SPLIT_HZ);

  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = audio[i] - lp[i];

  const envWin = Math.max(1, Math.floor(smoothMs * sampleRate / 1000));
  const lowAbs = signal.abs(lp);
  const highAbs = signal.abs(hp);
  if (envWin === 1) return { low: lowAbs, high: highAbs };
  const envKernel = signal.divide(signal.ones(envWin), envWin);
  return {
    low: signal.convolve(lowAbs, envKernel, 'same'),
    high: signal.convolve(highAbs, envKernel, 'same')
  };
}

/**
 * Per-sample "shotness" signal: geometric mean of low- and high-band
 * envelopes, each normalized by its own 95th-percentile reference.
 *
 * The per-band normalization is the load-bearing part. It calibrates "how
 * much LF and HF a typical shot in *this* file produces" rather than
 * assuming any absolute spectral signature. So a recording of supersonic
 * rifle fire and a recording of subsonic suppressed pistol fire each set
 * their own per-band reference; in both, real shots approach the file's
 * per-band 95th pct in BOTH bands and land near shotness ≈ 1. Geometric-
 * mean combination is then high only when both bands are simultaneously
 * energetic at a sample — the acoustic signature of a real broadband
 * impulse, regardless of ballistic regime. Narrowband artifacts (brass
 * clinks: HF-only; distant thumps and HVAC rumble: LF-only) score low.
 * Echoes preserve LF longer than HF in real environments, so reverberant
 * tails attenuate even while still energetic in the broadband envelope.
 *
 * Using the 95th percentile as reference (not max) prevents a single
 * over-the-top sample from pushing the rest of the recording's shotness
 * toward zero. The output is roughly in [0, 1] with shots near 1.
 */
export function shotnessEnvelope(
  audio: NumericArray,
  sampleRate: number,
  smoothMs = 2
): Float32Array {
  const { low, high } = bandedEnvelopes(audio, sampleRate, smoothMs);
  const lowRef = signal.percentile(low, 0.95) || 1;
  const highRef = signal.percentile(high, 0.95) || 1;
  const out = new Float32Array(low.length);
  for (let i = 0; i < out.length; i++) {
    const a = low[i] / lowRef;
    const b = high[i] / highRef;
    out[i] = Math.sqrt(a * b);
  }
  return out;
}

export interface AutocorrelationOptions {
  smoothMs?: number;
}

/**
 * Estimate period via autocorrelation of an ONSET signal (positive
 * first-difference of the smoothed envelope). The onset signal has energy
 * only at amplitude rises — i.e., shot starts — and is silent during
 * sustained burst-shape envelope plateaus and during between-burst
 * silence. That removes the slow burst-vs-silence DC structure that would
 * otherwise dominate the ACF in multi-burst recordings (and in those
 * cases the ACF over the smoothed envelope is monotonically decreasing
 * with no peaks at all).
 *
 * Picks the strongest local maximum in the plausible lag range, biased
 * toward shorter lags so we prefer the fundamental over harmonics.
 */
export function estimatePeriodFromAutocorrelation(
  audio: NumericArray,
  sampleRate: number,
  options: AutocorrelationOptions = {}
): TuningEstimate | null {
  // Smoothed amplitude envelope is robust for period estimation across the
  // corpus — its per-shot pulse is well-defined by the audio's sustained
  // amplitude. (We tried using the shotness signal here, but its sharper
  // pulse shape — driven by per-band normalization — caused 2T harmonic
  // confusion in many recordings where consecutive shots' overlapping
  // tails dominated the every-other-shot correlation.)
  const smoothMs = options.smoothMs ?? 5;
  const env = smoothedEnvelope(audio, sampleRate, smoothMs);

  const maxLag = Math.floor(MAX_PLAUSIBLE_PERIOD * sampleRate);
  if (env.length < maxLag * 2) return null;

  // Downsample-by-max to ~8 kHz, keeping the impulsive shot peaks intact.
  const downsampleFactor = Math.max(1, Math.floor(sampleRate / 8000));
  const dsRate = sampleRate / downsampleFactor;
  const dsLen = Math.floor(env.length / downsampleFactor);
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) {
    let m = 0;
    const base = i * downsampleFactor;
    for (let j = 0; j < downsampleFactor; j++) {
      const v = env[base + j];
      if (v > m) m = v;
    }
    ds[i] = m;
  }

  // Onset signal at the downsampled rate: shot rises only.
  const onsetLag = Math.max(1, Math.floor(0.003 * dsRate)); // 3ms
  const onset = new Float32Array(dsLen);
  for (let i = onsetLag; i < dsLen; i++) {
    const d = ds[i] - ds[i - onsetLag];
    if (d > 0) onset[i] = d;
  }

  // Mean-subtract the onset signal so the ACF reflects modulation around
  // the onset baseline rather than its DC component.
  const onsetMean = signal.mean(onset);
  for (let i = 0; i < onset.length; i++) onset[i] -= onsetMean;

  const dsMaxLag = Math.floor(MAX_PLAUSIBLE_PERIOD * dsRate);
  const dsMinLag = Math.floor(MIN_PLAUSIBLE_PERIOD * dsRate);
  const acf = signal.autocorrelate(onset, dsMaxLag);

  const localMaxes: { lag: number; value: number }[] = [];
  for (let lag = Math.max(2, dsMinLag); lag < acf.length - 1; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] > acf[lag + 1]) {
      localMaxes.push({ lag, value: acf[lag] });
    }
  }
  if (localMaxes.length === 0) return null;

  // Resolve harmonic confusion. For a true fundamental T, the ACF
  // peaks at T, 2T, 3T, … and successive peaks should decay
  // monotonically. Real recordings break that decay in two ways:
  //
  //   (a) Sub-harmonic dominance — the ACF's tallest peak lands at kT
  //       (k > 1) instead of T because shot envelope tails make
  //       every-other-shot pairs correlate better than consecutive
  //       ones (e.g. 3-round-burst recordings). Detect by looking
  //       for a peak near L/k that's comparable in strength to L.
  //   (b) Sub-period dominance — the ACF's tallest peak lands at T/k,
  //       caused e.g. by within-shot doublet structure (blast and
  //       crack arriving at the mic ~30 ms apart, repeated each
  //       cycle). Detect by looking for a peak near 2L that's
  //       comparable in strength to L AND has its own next harmonic.
  //
  // The "comparable strength" bar is set high (≥ 85%) so we only switch
  // when the harmonic and the chosen peak are essentially co-dominant
  // — that's a clear ACF symptom of harmonic confusion. A normal
  // harmonic train decays sharply enough that 2L is well below 85% of
  // L, so this rule doesn't fire on healthy recordings.
  //
  // Several "principled" alternatives were tried (comb-energy sum;
  // harmonic-confirmation count × ACF height) with the corpus harness;
  // all of them net-regressed against this height-walk approach. The
  // height comparison encodes information that the comb counts don't:
  // ACF(T) is reliably ≥ ACF(2T) under the biased estimator, and the
  // 85% threshold is the natural place where a real fundamental
  // separates from a sub-harmonic, while the sub-period 2× harmonic
  // confirmation rejects the case where the ACF tallest is genuinely T
  // and 2T is just the next lobe.
  const peakNear = (targetLag: number, tolerance = 0.10) => {
    let best: { lag: number; value: number } | null = null;
    for (const lm of localMaxes) {
      if (Math.abs(lm.lag - targetLag) <= tolerance * targetLag) {
        if (!best || lm.value > best.value) best = lm;
      }
    }
    return best;
  };

  localMaxes.sort((a, b) => b.value - a.value);
  let chosen = localMaxes[0];
  const COMPARABLE = 0.85;

  // Sub-harmonic check (case a): if L/k is a comparable-strength peak,
  // L was an integer multiple of the true period. Walk from largest k
  // down so we pick the smallest plausible fundamental.
  for (const k of [3, 2]) {
    const target = chosen.lag / k;
    if (target < dsMinLag) continue;
    const sub = peakNear(target);
    if (sub && sub.value >= chosen.value * COMPARABLE) {
      chosen = sub;
      break;
    }
  }

  // Sub-period check (case b): if 2L (or 3L) is a comparable-strength
  // peak AND that promoted candidate has its own next-harmonic peak
  // (its 2× position), L was a fraction of the true period. The 4L
  // confirmation suppresses over-switching on healthy fundamentals
  // where the 2nd harmonic happens to sit near the comparable bar.
  for (let k = 2; k <= 3; k++) {
    const target = k * chosen.lag;
    if (target >= acf.length) break;
    const mult = peakNear(target);
    if (!mult || mult.value < chosen.value * COMPARABLE) continue;
    if (2 * mult.lag >= acf.length) continue;
    const conf = peakNear(2 * mult.lag);
    if (!conf) continue;
    chosen = mult;
    break;
  }

  const period = chosen.lag / dsRate;
  const confidence = Math.max(0, Math.min(1, chosen.value));

  return { period, confidence, localMaxes };
}

/**
 * Top-level period estimation. Autocorrelation is the primary estimator
 * (robust against doublet harmonics with proper smoothing); the interval
 * histogram is used as a corroboration check that can pull the estimate
 * to an integer multiple if the ACF locked onto a sub-harmonic.
 */
export function estimatePeriod(
  audio: NumericArray,
  envelope: NumericArray,
  sampleRate: number
): TuningEstimate | null {
  const acfEst = estimatePeriodFromAutocorrelation(audio, sampleRate);
  const peaks = coarsePeaks(envelope, sampleRate);
  const intervalEst = estimatePeriodFromIntervals(peaks, sampleRate);

  if (acfEst) {
    return { ...acfEst, source: 'autocorrelation', coarsePeaks: peaks, intervalEst };
  }
  if (intervalEst) {
    return { ...intervalEst, source: 'intervals', coarsePeaks: peaks };
  }
  return null;
}

export interface DoubletInfo {
  period: number;
  loMed: number;
  hiMed: number;
}

/**
 * Detect a doublet pattern in an interval distribution: two clearly
 * separated modes T1 < T2 with T1 + T2 ≈ the current period estimate.
 * Each cycle of the gun is being captured as TWO peaks per shot,
 * alternating short/long, instead of one peak per shot. Common causes are
 * muzzle-blast / supersonic-crack pairs (one shot, two acoustic arrivals
 * at the mic) and close-distance early reflections.
 */
export function detectIntervalDoublet(
  intervals: readonly number[],
  currentPeriod: number
): DoubletInfo | null {
  if (intervals.length < 8) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const loMed = sorted[Math.floor(half / 2)];
  const hiMed = sorted[half + Math.floor(half / 2)];
  if (loMed <= 0 || hiMed <= 0) return null;

  // Modes must be clearly distinct (clear bimodality).
  if (loMed / hiMed > 0.55) return null;

  // Sum should match the current period (the "cycle" we're seeing peaks
  // twice within). If sum is way off, this isn't a doublet.
  const sum = loMed + hiMed;
  if (Math.abs(sum - currentPeriod) / currentPeriod > 0.20) return null;

  return { period: sum, loMed, hiMed };
}

/**
 * Half-wave-rectified first difference of an envelope. The standard onset-
 * detection function: positive only at amplitude rises, ≈0 during
 * sustained or decaying sound. Matched filtering on this signal gives a
 * meaningful score (instead of "anything positive looks like a shot").
 */
export function onsetSignal(
  envelope: NumericArray,
  sampleRate: number,
  lagMs = 3
): Float32Array {
  const lag = Math.max(1, Math.floor(lagMs * sampleRate / 1000));
  const result = new Float32Array(envelope.length);
  for (let i = lag; i < envelope.length; i++) {
    const d = envelope[i] - envelope[i - lag];
    if (d > 0) result[i] = d;
  }
  return result;
}

export interface BuildTemplateOptions {
  lengthMs?: number;
  preMs?: number;
  topN?: number;
}

export interface ShotTemplate {
  template: Float32Array;
  preSamples: number;
}

/**
 * Build a shot template by averaging windows around the strongest envelope
 * peaks. Normalized to unit L2 norm so the matched-filter score is a
 * normalized cross-correlation in [0, 1].
 */
export function buildTemplate(
  envelope: NumericArray,
  sampleRate: number,
  peaks: readonly number[],
  options: BuildTemplateOptions = {}
): ShotTemplate | null {
  const lengthMs = options.lengthMs ?? 12;
  const preMs = options.preMs ?? 2;
  const topN = options.topN ?? 24;

  const len = Math.floor(lengthMs * sampleRate / 1000);
  const pre = Math.floor(preMs * sampleRate / 1000);

  const ranked = peaks
    .map(idx => ({ idx, val: envelope[idx] }))
    .sort((a, b) => b.val - a.val)
    .slice(0, topN);

  const template = new Float32Array(len);
  let used = 0;
  for (const { idx } of ranked) {
    const start = idx - pre;
    if (start < 0 || start + len > envelope.length) continue;
    for (let i = 0; i < len; i++) template[i] += envelope[start + i];
    used++;
  }
  if (used === 0) return null;
  for (let i = 0; i < len; i++) template[i] /= used;

  let norm = 0;
  for (let i = 0; i < len; i++) norm += template[i] * template[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < len; i++) template[i] /= norm;

  return { template, preSamples: pre };
}

/**
 * Classical matched filter: dot product of the envelope window with a
 * unit-norm template. Unnormalized — the score is amplitude-weighted, so
 * a quiet noise blip with an onset-like shape scores low even if the
 * shape correlation is high. (Normalized cross-correlation is shape-only
 * and treats noise like signal here, which over-detects.)
 *
 * Output shape matches the envelope; entries near the right edge where
 * the template would overrun are zero.
 */
export function matchedFilter(envelope: NumericArray, template: NumericArray): Float32Array {
  const n = envelope.length;
  const m = template.length;
  const result = new Float32Array(n);
  if (n < m) return result;

  for (let i = 0; i + m <= n; i++) {
    let dot = 0;
    for (let j = 0; j < m; j++) dot += envelope[i + j] * template[j];
    result[i] = dot;
  }
  return result;
}

export interface DetectShotsOptions {
  knownShotCount?: number | null;
  minSpacingFraction?: number;
  shotness?: Float32Array | null;
}

export interface DetectShotsResult {
  peaks: number[];
  score: Float32Array | null;
  template: Float32Array | null;
  threshold: number;
  onset?: Float32Array;
}

/**
 * Run the full template-matching shot detector. Given a smooth envelope
 * and an estimated cyclic period T:
 *   1. Loose seed peaks → 2. Average them into a template →
 *   3. Matched filter the envelope → 4. Adaptive-threshold peaks on the
 *      score with min-spacing 0.7·T (rejects doublets and echoes by shape).
 *
 * Returns peak indices in original sample-rate units, plus the score
 * signal and template for diagnostics.
 *
 * If `knownShotCount` is provided, the threshold is bypassed and we keep
 * the top-N highest-scoring peaks (subject to min-spacing).
 */
export function detectShots(
  envelope: NumericArray,
  sampleRate: number,
  period: number,
  options: DetectShotsOptions = {}
): DetectShotsResult {
  const knownShotCount = options.knownShotCount ?? null;
  const minSpacingFraction = options.minSpacingFraction ?? 0.7;
  // Optional multiband-agreement signal — when supplied, gates the final
  // candidate list so only broadband impulses survive. The matched-filter
  // and template-construction stages still run on the amplitude envelope,
  // because the shotness signal's per-band normalization broadens the
  // per-shot pulse and pulls the ACF toward 2T harmonics.
  const shotness = options.shotness ?? null;

  const minDistance = Math.max(1, Math.floor(period * minSpacingFraction * sampleRate));

  // Match against the onset signal (positive amplitude rises) rather than
  // the raw envelope, so sustained background tones don't score high.
  const onset = onsetSignal(envelope, sampleRate, 3);

  const med = signal.median(onset);
  const m = signal.mad(onset);
  const seedThreshold = med + 4 * m;
  const { peaks: seedPeaks } = signal.findPeaks(onset, {
    height: seedThreshold,
    distance: minDistance,
    prominence: 0
  });

  if (seedPeaks.length < 4) {
    return { peaks: seedPeaks, score: null, template: null, threshold: 0, onset };
  }

  const tpl = buildTemplate(onset, sampleRate, seedPeaks, {
    lengthMs: Math.min(15, Math.max(6, period * 200)),  // up to 15ms, ≤ 0.2·period
    preMs: 2
  });
  if (!tpl) {
    return { peaks: seedPeaks, score: null, template: null, threshold: 0, onset };
  }

  const score = matchedFilter(onset, tpl.template);

  // Score peaks live at the start of each window. Shift them back by
  // `preSamples` so they line up with the original peak position.
  const { peaks: rawScorePeaks } = signal.findPeaks(score, {
    height: 0,
    distance: minDistance,
    prominence: 0
  });

  let chosen: number[];
  let threshold: number;

  if (knownShotCount && knownShotCount >= 3) {
    const ranked = rawScorePeaks
      .map(idx => ({ idx, val: score[idx] }))
      .sort((a, b) => b.val - a.val)
      .slice(0, knownShotCount);
    chosen = ranked.map(p => p.idx).sort((a, b) => a - b);
    threshold = ranked.length > 0 ? ranked[ranked.length - 1].val : 0;
  } else {
    // Adaptive threshold: real shots' scores cluster well above the
    // background, so median + k·MAD on the score gives a robust split.
    const scoreMed = signal.median(score);
    const scoreMad = signal.mad(score);
    threshold = scoreMed + 3 * scoreMad;
    chosen = rawScorePeaks.filter(idx => score[idx] >= threshold);
  }

  const candidatePeaks = chosen
    .map(i => i + tpl.preSamples)
    .filter(i => i < envelope.length);

  // Regional-energy gate. A real shot sits inside a burst — an audio region
  // whose local envelope energy is significantly elevated above the file's
  // silence floor. False positives in silence have low surrounding energy
  // even when individual onset features happen to score high. The reference
  // for "loud" is the file's own 95th-percentile envelope (~typical shot
  // peak); a candidate's local mean envelope must be a meaningful fraction
  // of that. This adapts whether the audio is mostly burst or mostly silence.
  const peakReference = signal.percentile(envelope, 0.95);
  const localWindow = Math.max(1, Math.floor(0.4 * sampleRate));
  const energyFloor = peakReference * 0.25;

  let peaks = candidatePeaks.filter(idx => {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, idx - localWindow);
    const hi = Math.min(envelope.length, idx + localWindow);
    for (let j = lo; j < hi; j++) { sum += envelope[j]; count++; }
    const localMean = count > 0 ? sum / count : 0;
    return localMean >= energyFloor;
  });

  // Multiband-agreement gate. When a shotness signal is supplied, drop
  // candidates whose local-peak shotness falls below a fraction of the
  // file's typical shot. The gate keys off per-band normalization, so
  // it adapts to whatever spectral character the recorded ammunition
  // actually has — supersonic vs. subsonic, suppressed vs. open. What
  // it rejects is *narrowband* events at moments where the file's
  // typical shot has both bands active: brass clinks (HF-only),
  // distant thumps (LF-only), reverberant tails (HF attenuated faster
  // than LF in air).
  if (shotness && shotness.length === envelope.length) {
    peaks = shotnessFilterPeaks(peaks, shotness, sampleRate, period);
  }

  return { peaks, score, template: tpl.template, threshold, onset };
}

export interface ShotnessFilterOptions {
  floorFraction?: number;
  windowFraction?: number;
}

/**
 * Filter a peak list down to those that clear a multiband-agreement bar.
 *
 * Each surviving peak must have local-peak shotness (the multiband
 * geometric-mean signal computed by `shotnessEnvelope`) of at least
 * `floorFraction` of the file's 95th-percentile shotness. The shotness
 * signal is high only on broadband impulses; brass clinks (HF only),
 * distant thumps (LF only), and reverberant tails (which lose HF first
 * in real environments) all attenuate in shotness even when they have
 * substantial amplitude in the time domain.
 */
export function shotnessFilterPeaks(
  peaks: readonly number[],
  shotness: Float32Array,
  sampleRate: number,
  period: number,
  options: ShotnessFilterOptions = {}
): number[] {
  if (!shotness || peaks.length === 0) return peaks.slice();
  const floorFraction = options.floorFraction ?? 0.40;
  const windowFraction = options.windowFraction ?? 0.30;
  const ref = signal.percentile(shotness, 0.95);
  if (ref <= 0) return peaks.slice();
  const floor = ref * floorFraction;
  const halfWin = Math.max(1, Math.floor(period * windowFraction * sampleRate));
  return peaks.filter(idx => {
    const lo = Math.max(0, idx - halfWin);
    const hi = Math.min(shotness.length, idx + halfWin);
    let m = 0;
    for (let j = lo; j < hi; j++) if (shotness[j] > m) m = shotness[j];
    return m >= floor;
  });
}
