/**
 * Pure-JS signal processing primitives — replacements for the numpy/scipy
 * helpers the detector pipeline needs. Each function takes either a typed
 * array or a plain number array and returns a `Float32Array` (for vector
 * outputs) or a `number` (for scalars).
 */

export type NumericArray = Float32Array | readonly number[] | number[];

export function mean(arr: NumericArray): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

export function std(arr: NumericArray): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  let sumSquaredDiff = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - m;
    sumSquaredDiff += diff * diff;
  }
  return Math.sqrt(sumSquaredDiff / arr.length);
}

export function max(arr: NumericArray): number {
  if (arr.length === 0) return -Infinity;
  let maxVal = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] > maxVal) maxVal = arr[i];
  return maxVal;
}

export function min(arr: NumericArray): number {
  if (arr.length === 0) return Infinity;
  let minVal = arr[0];
  for (let i = 1; i < arr.length; i++) if (arr[i] < minVal) minVal = arr[i];
  return minVal;
}

export function median(arr: NumericArray): number {
  if (arr.length === 0) return 0;
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export function abs(arr: NumericArray): Float32Array {
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) result[i] = Math.abs(arr[i]);
  return result;
}

export function diff(arr: NumericArray): Float32Array {
  if (arr.length <= 1) return new Float32Array(0);
  const result = new Float32Array(arr.length - 1);
  for (let i = 0; i < arr.length - 1; i++) result[i] = arr[i + 1] - arr[i];
  return result;
}

/**
 * 1D convolution, "same" mode. Detects a constant (boxcar) kernel and
 * switches to an O(N) running-sum implementation; the output matches the
 * O(N·K) zero-padded loop exactly, so edge bins effectively sum a partial
 * window weighted by the per-tap value (NOT the mean over valid samples).
 * Downstream thresholds and percentiles see the same statistics as the
 * legacy implementation.
 */
export function convolve(
  input: NumericArray,
  kernel: NumericArray,
  mode: 'same' = 'same'
): Float32Array {
  if (mode !== 'same') throw new Error('Only "same" mode is currently supported');

  const kernelLen = kernel.length;
  if (kernelLen > 0) {
    const w0 = kernel[0];
    let uniform = true;
    for (let j = 1; j < kernelLen; j++) {
      if (kernel[j] !== w0) { uniform = false; break; }
    }
    if (uniform) return boxcarSum(input, kernelLen, w0);
  }

  const signalLen = input.length;
  const result = new Float32Array(signalLen);
  const halfKernel = Math.floor(kernelLen / 2);
  for (let i = 0; i < signalLen; i++) {
    let sum = 0;
    for (let j = 0; j < kernelLen; j++) {
      const signalIdx = i - halfKernel + j;
      if (signalIdx >= 0 && signalIdx < signalLen) {
        sum += input[signalIdx] * kernel[j];
      }
    }
    result[i] = sum;
  }
  return result;
}

function boxcarSum(input: NumericArray, windowSize: number, w: number): Float32Array {
  const n = input.length;
  if (windowSize <= 1) {
    if (w === 1) return input instanceof Float32Array ? input.slice() : Float32Array.from(input);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = input[i] * w;
    return out;
  }
  const out = new Float32Array(n);
  const half = Math.floor(windowSize / 2);
  let sum = 0;
  for (let i = 0; i < Math.min(half, n); i++) sum += input[i];
  for (let i = 0; i < n; i++) {
    const addIdx = i + half;
    const dropIdx = i - half - 1;
    if (addIdx < n) sum += input[addIdx];
    if (dropIdx >= 0) sum -= input[dropIdx];
    out[i] = sum * w;
  }
  return out;
}

export interface FindPeaksOptions {
  /** Minimum peak height (default `-Infinity`). */
  height?: number;
  /** Minimum distance between peaks in samples (default `1`). */
  distance?: number;
  /** Minimum prominence as a fraction of the signal max (default `0`). */
  prominence?: number;
}

export interface FindPeaksResult {
  peaks: number[];
  properties: { heights: number[] };
}

/**
 * Reimplementation of scipy.signal.find_peaks. Returns peak indices and
 * their heights, filtered by height/prominence/min-distance.
 */
export function findPeaks(data: NumericArray, options: FindPeaksOptions = {}): FindPeaksResult {
  const { height = -Infinity, distance = 1, prominence = 0 } = options;

  const n = data.length;
  if (n < 3) return { peaks: [], properties: { heights: [] } };

  const localMaxima: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (data[i] > data[i - 1] && data[i] > data[i + 1]) localMaxima.push(i);
  }

  const heightFiltered = localMaxima.filter(idx => data[idx] >= height);

  let prominenceFiltered = heightFiltered;
  if (prominence > 0) {
    const maxSignal = max(data);
    const minProminence = prominence * maxSignal;

    prominenceFiltered = heightFiltered.filter(idx => {
      const peakHeight = data[idx];
      let leftMin = peakHeight;
      let rightMin = peakHeight;

      for (let i = idx - 1; i >= 0; i--) {
        if (data[i] < leftMin) leftMin = data[i];
        if (data[i] >= peakHeight) break;
      }
      for (let i = idx + 1; i < n; i++) {
        if (data[i] < rightMin) rightMin = data[i];
        if (data[i] >= peakHeight) break;
      }

      const prominenceValue = peakHeight - Math.max(leftMin, rightMin);
      return prominenceValue >= minProminence;
    });
  }

  if (prominenceFiltered.length === 0) {
    return { peaks: [], properties: { heights: [] } };
  }

  // Sort by height (descending) to prioritize higher peaks when min-distance
  // collisions force a choice.
  const sortedByHeight = prominenceFiltered
    .map(idx => ({ idx, height: data[idx] }))
    .sort((a, b) => b.height - a.height);

  const peaks: number[] = [];
  for (const { idx } of sortedByHeight) {
    let tooClose = false;
    for (const existingPeak of peaks) {
      if (Math.abs(idx - existingPeak) < distance) { tooClose = true; break; }
    }
    if (!tooClose) peaks.push(idx);
  }
  peaks.sort((a, b) => a - b);

  const heights = peaks.map(idx => data[idx]);
  return { peaks, properties: { heights } };
}

export function ones(n: number): Float32Array {
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = 1.0;
  return arr;
}

export function divide(arr: NumericArray, scalar: number): Float32Array {
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) result[i] = arr[i] / scalar;
  return result;
}

/** Linear-interpolating percentile, `p` in `[0, 1]`. */
export function percentile(arr: NumericArray, p: number): number {
  if (arr.length === 0) return 0;
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median absolute deviation — robust scale estimator. */
export function mad(arr: NumericArray): number {
  if (arr.length === 0) return 0;
  const m = median(arr);
  const deviations = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) deviations[i] = Math.abs(arr[i] - m);
  return median(deviations);
}

/**
 * Autocorrelation at lags `[0, maxLag]`. Biased estimator (no normalization
 * by `N - lag`), normalized so `R(0) = 1`.
 */
export function autocorrelate(signal: NumericArray, maxLag: number): Float32Array {
  const n = signal.length;
  maxLag = Math.min(maxLag, n - 1);
  const result = new Float32Array(maxLag + 1);

  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += signal[i] * signal[i];
  if (r0 === 0) return result;

  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) sum += signal[i] * signal[i + lag];
    result[lag] = sum / r0;
  }
  return result;
}

/**
 * Zero-phase 4th-order Butterworth low-pass via filtfilt (forward + reverse
 * biquad). Coefficients from the RBJ cookbook, Q = 1/√2 for Butterworth
 * response. Filtering both directions cancels the per-pass phase shift, so
 * the output is delay-free at the cost of doubling the effective filter
 * order (−24 dB/oct rolloff instead of −12).
 *
 * Used by `bandedEnvelopes` to split audio into LF (≲ cutoff) and HF
 * residual bands. Phase alignment matters there: a non-zero-phase lowpass
 * would desynchronize LF and HF impulses, breaking the multiband-agreement
 * signal which keys off simultaneous activity in both bands.
 */
export function lowpassButterworth(
  input: NumericArray,
  sampleRate: number,
  cutoffHz: number
): Float32Array {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const cosW = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2; // 2 * (1/√2) = √2; equivalent to sin(w0)/(2Q)
  const a0 = 1 + alpha;
  const b0 = (1 - cosW) / (2 * a0);
  const b1 = (1 - cosW) / a0;
  const b2 = b0;
  const a1 = -2 * cosW / a0;
  const a2 = (1 - alpha) / a0;

  const filterPass = (src: NumericArray): Float32Array => {
    const n = src.length;
    const out = new Float32Array(n);
    let z1 = 0, z2 = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      out[i] = y;
    }
    return out;
  };

  const fwd = filterPass(input);
  const rev = new Float32Array(fwd.length);
  for (let i = 0; i < fwd.length; i++) rev[i] = fwd[fwd.length - 1 - i];
  const back = filterPass(rev);
  const out = new Float32Array(back.length);
  for (let i = 0; i < back.length; i++) out[i] = back[back.length - 1 - i];
  return out;
}

export interface HistogramOptions {
  binWidth: number;
  minValue?: number;
  maxValue?: number;
}

export interface HistogramResult {
  counts: Int32Array;
  lo: number;
  hi: number;
  binWidth: number;
  numBins: number;
}

export function histogram(values: NumericArray, options: HistogramOptions): HistogramResult {
  const { binWidth, minValue, maxValue } = options;
  const lo = minValue ?? min(values);
  const hi = maxValue ?? max(values);
  const numBins = Math.max(1, Math.ceil((hi - lo) / binWidth));
  const counts = new Int32Array(numBins);

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo || v > hi) continue;
    let bin = Math.floor((v - lo) / binWidth);
    if (bin >= numBins) bin = numBins - 1;
    counts[bin]++;
  }

  return { counts, lo, hi, binWidth, numBins };
}
