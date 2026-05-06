/**
 * Analysis worker. Owns the heavy detector pipeline so re-analyses on
 * param/region changes don't block the UI thread. Also computes the
 * spectrogram on demand for the spectrogram view.
 *
 * Protocol:
 *   { id, type: 'setAudio', audioData: Float32Array, sampleRate }
 *     → { id, type: 'setAudio', ok: true }
 *   { id, type: 'analyze', params }
 *     → { id, type: 'progress', text } (zero or more)
 *     → { id, type: 'analyzed', results }   (envelope buffer transferred)
 *   { id, type: 'spectrogram' }
 *     → { id, type: 'spectrogram', spectrogram }  (data buffer transferred)
 *   any failure → { id, type: 'error', error: string }
 */

import { RateOfFireDetector } from './rof-detector.js';
import type { AnalysisResult, DetectorParams } from './rof-detector.js';

export interface SetAudioRequest {
  id: number;
  type: 'setAudio';
  audioData: Float32Array;
  sampleRate: number;
}

export interface AnalyzeRequest {
  id: number;
  type: 'analyze';
  params: Partial<DetectorParams>;
}

export interface SpectrogramRequest {
  id: number;
  type: 'spectrogram';
}

export type WorkerRequest = SetAudioRequest | AnalyzeRequest | SpectrogramRequest;

export interface SetAudioResponse {
  id: number;
  type: 'setAudio';
  ok: true;
}

export interface ProgressResponse {
  id: number;
  type: 'progress';
  text: string;
}

export interface AnalyzedResponse {
  id: number;
  type: 'analyzed';
  results: AnalysisResult;
}

export interface SpectrogramData {
  data: Uint8Array;
  numFrames: number;
  numBins: number;
  hopSize: number;
  sampleRate: number;
  maxFreq: number;
  fftSize: number;
}

export interface SpectrogramResponse {
  id: number;
  type: 'spectrogram';
  spectrogram: SpectrogramData;
}

export interface ErrorResponse {
  id: number;
  type: 'error';
  error: string;
}

export type WorkerResponse =
  | SetAudioResponse
  | ProgressResponse
  | AnalyzedResponse
  | SpectrogramResponse
  | ErrorResponse;

let cachedAudio: Float32Array | null = null;
let cachedSampleRate = 0;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'setAudio') {
      cachedAudio = msg.audioData;
      cachedSampleRate = msg.sampleRate;
      const reply: SetAudioResponse = { id: msg.id, type: 'setAudio', ok: true };
      self.postMessage(reply);
      return;
    }
    if (msg.type === 'analyze') {
      if (!cachedAudio) {
        const reply: ErrorResponse = { id: msg.id, type: 'error', error: 'No audio set' };
        self.postMessage(reply);
        return;
      }
      const det = new RateOfFireDetector(msg.params);
      det.setAudio(cachedAudio, cachedSampleRate);
      const onProgress = (text: string) => {
        const progress: ProgressResponse = { id: msg.id, type: 'progress', text };
        self.postMessage(progress);
      };
      const results = det.runAnalysis(onProgress);
      const envelope = det.envelope ? new Float32Array(det.envelope) : new Float32Array(0);
      results.envelope = envelope;
      results.sampleRate = det.sampleRate;
      const reply: AnalyzedResponse = { id: msg.id, type: 'analyzed', results };
      self.postMessage(reply, { transfer: [envelope.buffer] });
      return;
    }
    if (msg.type === 'spectrogram') {
      if (!cachedAudio) {
        const reply: ErrorResponse = { id: msg.id, type: 'error', error: 'No audio set' };
        self.postMessage(reply);
        return;
      }
      const spec = computeSpectrogram(cachedAudio, cachedSampleRate);
      const reply: SpectrogramResponse = { id: msg.id, type: 'spectrogram', spectrogram: spec };
      self.postMessage(reply, { transfer: [spec.data.buffer] });
      return;
    }
  } catch (err) {
    const reply: ErrorResponse = {
      id: msg.id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err)
    };
    self.postMessage(reply);
  }
};

// --- STFT spectrogram ---
// Magnitude is log-scaled then quantized to Uint8 with min/max as the
// dynamic range. Stored row-major: frame f, bin k → data[f * numBins + k].
// numBins covers 0…maxFreq (Hz); higher freq bins are dropped because
// they contribute almost nothing to gunshot diagnosis.
function computeSpectrogram(audio: Float32Array, sampleRate: number): SpectrogramData {
  const fftSize = 1024;
  // ~1.3 ms per frame at 48 kHz; gives plenty of horizontal detail when
  // zoomed in. Bumping further mostly inflates memory without visible gain.
  const hopSize = 64;
  const maxFreq = 8000;
  const allBins = fftSize / 2 + 1;
  const numBins = Math.min(allBins, Math.floor(maxFreq * fftSize / sampleRate) + 1);
  const numFrames = Math.max(0, Math.floor((audio.length - fftSize) / hopSize) + 1);

  const window = hannWindow(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const magsLog = new Float32Array(numFrames * numBins);

  let gMin = Infinity;
  let gMax = -Infinity;

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      real[i] = audio[start + i] * window[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);
    const off = f * numBins;
    for (let k = 0; k < numBins; k++) {
      const m = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
      const log = 20 * Math.log10(m + 1e-9);
      magsLog[off + k] = log;
      if (log > gMax) gMax = log;
      if (log < gMin) gMin = log;
    }
  }

  // Floor the very-bottom of the dynamic range so the noise floor doesn't
  // wash out the interesting transients.
  const floor = Math.max(gMin, gMax - 80); // 80 dB display range
  const range = Math.max(1e-3, gMax - floor);
  const data = new Uint8Array(numFrames * numBins);
  for (let i = 0; i < magsLog.length; i++) {
    const v = (magsLog[i] - floor) / range;
    data[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }

  return {
    data,
    numFrames,
    numBins,
    hopSize,
    sampleRate,
    maxFreq,
    fftSize
  };
}

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  }
  return w;
}

/** In-place radix-2 Cooley-Tukey FFT. `n` must be a power of 2. */
function fftInPlace(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  // Bit reversal
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  // Butterflies
  for (let size = 2; size <= n; size *= 2) {
    const half = size >> 1;
    const step = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const a = i + k;
        const b = a + half;
        const tre = real[b] * cosA - imag[b] * sinA;
        const tim = real[b] * sinA + imag[b] * cosA;
        real[b] = real[a] - tre;
        imag[b] = imag[a] - tim;
        real[a] += tre;
        imag[a] += tim;
      }
    }
  }
}
