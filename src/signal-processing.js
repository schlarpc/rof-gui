/**
 * Signal Processing Library
 * Pure JavaScript implementations of signal processing functions
 * to replace numpy and scipy dependencies
 */

/**
 * Statistical Functions
 */

export function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum / arr.length;
}

export function std(arr) {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  let sumSquaredDiff = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - m;
    sumSquaredDiff += diff * diff;
  }
  return Math.sqrt(sumSquaredDiff / arr.length);
}

export function max(arr) {
  if (arr.length === 0) return -Infinity;
  let maxVal = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > maxVal) maxVal = arr[i];
  }
  return maxVal;
}

export function min(arr) {
  if (arr.length === 0) return Infinity;
  let minVal = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < minVal) minVal = arr[i];
  }
  return minVal;
}

export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Array Operations
 */

export function abs(arr) {
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    result[i] = Math.abs(arr[i]);
  }
  return result;
}

export function diff(arr) {
  if (arr.length <= 1) return new Float32Array(0);
  const result = new Float32Array(arr.length - 1);
  for (let i = 0; i < arr.length - 1; i++) {
    result[i] = arr[i + 1] - arr[i];
  }
  return result;
}

/**
 * Convolution
 * Implements 1D convolution with 'same' mode
 */
export function convolve(signal, kernel, mode = 'same') {
  const signalLen = signal.length;
  const kernelLen = kernel.length;

  if (mode === 'same') {
    const result = new Float32Array(signalLen);
    const halfKernel = Math.floor(kernelLen / 2);

    for (let i = 0; i < signalLen; i++) {
      let sum = 0;
      let count = 0;

      for (let j = 0; j < kernelLen; j++) {
        const signalIdx = i - halfKernel + j;
        if (signalIdx >= 0 && signalIdx < signalLen) {
          sum += signal[signalIdx] * kernel[j];
          count++;
        }
      }

      result[i] = sum;
    }

    return result;
  }

  throw new Error('Only "same" mode is currently supported');
}

/**
 * Peak Detection
 * Reimplementation of scipy.signal.find_peaks
 *
 * @param {Float32Array|Array} data - The signal data
 * @param {Object} options - Peak detection options
 * @param {number} options.height - Minimum peak height
 * @param {number} options.distance - Minimum distance between peaks (in samples)
 * @param {number} options.prominence - Minimum prominence (relative to max signal)
 * @returns {Object} {peaks: Array<number>, properties: Object}
 */
export function findPeaks(data, options = {}) {
  const {
    height = -Infinity,
    distance = 1,
    prominence = 0
  } = options;

  const n = data.length;
  if (n < 3) return { peaks: [], properties: { heights: [] } };

  // Step 1: Find local maxima (points higher than both neighbors)
  const localMaxima = [];
  for (let i = 1; i < n - 1; i++) {
    if (data[i] > data[i - 1] && data[i] > data[i + 1]) {
      localMaxima.push(i);
    }
  }

  // Step 2: Filter by height threshold
  const heightFiltered = localMaxima.filter(idx => data[idx] >= height);

  // Step 3: Calculate prominence and filter
  let prominenceFiltered = heightFiltered;
  if (prominence > 0) {
    const maxSignal = max(data);
    const minProminence = prominence * maxSignal;

    prominenceFiltered = heightFiltered.filter(idx => {
      const peakHeight = data[idx];

      // Find the lowest point between this peak and the next higher peak
      // on both sides (simplified prominence calculation)
      let leftMin = peakHeight;
      let rightMin = peakHeight;

      // Look left
      for (let i = idx - 1; i >= 0; i--) {
        if (data[i] < leftMin) leftMin = data[i];
        if (data[i] >= peakHeight) break;
      }

      // Look right
      for (let i = idx + 1; i < n; i++) {
        if (data[i] < rightMin) rightMin = data[i];
        if (data[i] >= peakHeight) break;
      }

      const prominenceValue = peakHeight - Math.max(leftMin, rightMin);
      return prominenceValue >= minProminence;
    });
  }

  // Step 4: Filter by distance (suppress nearby peaks, keep highest)
  const peaks = [];
  if (prominenceFiltered.length === 0) {
    return { peaks: [], properties: { heights: [] } };
  }

  // Sort by height (descending) to prioritize higher peaks
  const sortedByHeight = prominenceFiltered
    .map(idx => ({ idx, height: data[idx] }))
    .sort((a, b) => b.height - a.height);

  const used = new Set();

  for (const { idx } of sortedByHeight) {
    // Check if this peak is too close to any already selected peak
    let tooClose = false;
    for (const existingPeak of peaks) {
      if (Math.abs(idx - existingPeak) < distance) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      peaks.push(idx);
    }
  }

  // Sort peaks by position
  peaks.sort((a, b) => a - b);

  // Extract properties
  const heights = peaks.map(idx => data[idx]);

  return {
    peaks,
    properties: {
      heights
    }
  };
}

/**
 * Create a simple averaging window (box filter)
 */
export function ones(n) {
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = 1.0;
  }
  return arr;
}

/**
 * Normalize an array by a scalar
 */
export function divide(arr, scalar) {
  const result = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    result[i] = arr[i] / scalar;
  }
  return result;
}
