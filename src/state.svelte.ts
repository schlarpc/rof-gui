/**
 * Shared application state expressed as Svelte 5 runes. Keeps the analysis
 * pipeline framework-free: this module is the only place the components
 * need to know about ffmpeg, the detector, the player, etc.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

import AnalysisWorker from './analysis-worker.js?worker';
import { WebAudioPlayer } from './audio-player.js';
import type { AnalysisResult, AnalysisRegion } from './rof-detector.js';
import type {
  WorkerRequest,
  WorkerResponse,
  SetAudioResponse,
  AnalyzedResponse,
  SpectrogramResponse,
  SpectrogramData,
  ProgressResponse
} from './analysis-worker.js';

interface CachedAudio {
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
}

interface AppState {
  file: File | null;
  loading: boolean;
  loadingText: string;
  error: string | null;
  results: AnalysisResult | null;
  analysisRegions: AnalysisRegion[];
  selectMode: boolean;
  cursorTime: number;
  player: WebAudioPlayer;
  /** Whether the audio buffer for `file` is decoded and ready in the player. */
  hasAudio: boolean;
  /** Bumped on every successful audio load so view backends can rebuild caches. */
  audioVersion: number;
  /** Pre-computed spectrogram for the current audio (null until requested). */
  spectrogram: SpectrogramData | null;
  spectrogramLoading: boolean;
  playing: boolean;
}

interface WebkitAudioWindow {
  webkitAudioContext?: typeof AudioContext;
}

export const app: AppState = $state({
  file: null,
  loading: false,
  loadingText: '',
  error: null,
  results: null,
  analysisRegions: [],
  selectMode: false,
  cursorTime: 0,
  player: new WebAudioPlayer(),
  hasAudio: false,
  audioVersion: 0,
  spectrogram: null,
  spectrogramLoading: false,
  playing: false
});

// Bind player events back into state so components can react reactively.
app.player.on('play', () => { app.playing = true; });
app.player.on('pause', () => { app.playing = false; });
app.player.on('timeupdate', onPlayerTimeUpdate);

// Tracks the cursor position last reported by the player so we can detect
// "we just crossed a region's right edge" within a single tick.
let prevCursor = 0;

function onPlayerTimeUpdate(): void {
  const t = app.player.currentTime;
  // Selection regions act as playback bounds: if playback exits a region
  // via its right edge, pause and snap back to the region's start so
  // hitting play again replays it.
  if (app.playing && app.analysisRegions.length > 0) {
    for (const r of app.analysisRegions) {
      if (prevCursor >= r.start && prevCursor < r.end && t >= r.end) {
        app.player.pause();
        app.player.currentTime = r.start;
        prevCursor = r.start;
        app.cursorTime = r.start;
        return;
      }
    }
  }
  prevCursor = t;
  app.cursorTime = t;
}

let ffmpeg: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
let cachedAudio: CachedAudio | null = null;
let reanalysisTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Analysis worker plumbing ---
const worker: Worker = new AnalysisWorker();
let nextRequestId = 1;
let lastAnalyzeId = 0;

interface PendingHandler {
  resolve: (msg: WorkerResponse) => void;
  reject: (err: Error) => void;
}

const pending = new Map<number, PendingHandler>();

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    if (msg.id === lastAnalyzeId) app.loadingText = (msg as ProgressResponse).text;
    return;
  }
  const handler = pending.get(msg.id);
  if (!handler) return;
  pending.delete(msg.id);
  if (msg.type === 'error') handler.reject(new Error(msg.error));
  else handler.resolve(msg);
};
worker.onerror = (e: ErrorEvent) => {
  for (const h of pending.values()) h.reject(new Error(e.message || 'Worker error'));
  pending.clear();
};

interface WorkerCallHandle<T extends WorkerResponse> {
  id: number;
  promise: Promise<T>;
}

// Distribute Omit over the union so each variant retains its discriminator.
type WorkerRequestMessage = WorkerRequest extends infer R
  ? R extends { id: number } ? Omit<R, 'id'> : never
  : never;

function workerCall<T extends WorkerResponse>(
  message: WorkerRequestMessage,
  transfer: Transferable[] = []
): WorkerCallHandle<T> {
  const id = nextRequestId++;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (m) => resolve(m as T),
      reject
    });
  });
  worker.postMessage({ ...message, id } as WorkerRequest, transfer);
  return { id, promise };
}

async function workerSetAudio(audioData: Float32Array, sampleRate: number): Promise<void> {
  // Send a copy (transferred) so the worker has its own buffer; main thread
  // keeps the original for playback.
  const copy = new Float32Array(audioData);
  const { promise } = workerCall<SetAudioResponse>(
    { type: 'setAudio', audioData: copy, sampleRate },
    [copy.buffer]
  );
  await promise;
}

async function workerAnalyze(): Promise<{ id: number; results: AnalysisResult }> {
  const { id, promise } = workerCall<AnalyzedResponse>({
    type: 'analyze',
    params: {
      autoTune: true,
      includeRegions: $state.snapshot(app.analysisRegions)
    }
  });
  lastAnalyzeId = id;
  const msg = await promise;
  return { id, results: msg.results };
}

async function loadFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    try {
      const instance = new FFmpeg();
      await instance.load({
        coreURL: await toBlobURL(coreURL, 'text/javascript'),
        wasmURL: await toBlobURL(wasmURL, 'application/wasm')
      });
      ffmpeg = instance;
      return instance;
    } catch (err) {
      ffmpegLoadPromise = null;
      throw err;
    }
  })();

  return ffmpegLoadPromise;
}

// Eagerly start loading the ffmpeg core in the background.
loadFFmpeg().catch(err => console.error('Failed to preload ffmpeg:', err));

// Serialize work that touches the shared ffmpeg instance. Without this, a
// second handleFile() call interleaves writeFile/deleteFile with the first
// invocation's ops on the same in-memory paths, surfacing as
// "ErrnoError: FS error".
let ffmpegQueue: Promise<unknown> = Promise.resolve();

function ffmpegSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = ffmpegQueue.then(fn, fn);
  ffmpegQueue = next.catch(() => undefined);
  return next;
}

// Monotonic token incremented per handleFile call. Stale invocations
// (a newer drop happened mid-extract) bail without touching app state, so
// their late-arriving errors don't replace the current results.
let activeFileToken = 0;

export async function handleFile(file: File | null | undefined): Promise<void> {
  if (!file) return;

  const token = ++activeFileToken;

  app.file = file;
  app.analysisRegions = [];
  app.selectMode = false;
  app.results = null;
  app.error = null;
  app.hasAudio = false;
  app.cursorTime = 0;
  app.spectrogram = null;
  app.spectrogramLoading = false;
  cachedAudio = null;
  app.player.stop();

  app.loading = true;
  app.loadingText = ffmpeg?.loaded ? 'Extracting audio…' : 'Loading ffmpeg…';

  try {
    await loadFFmpeg();
    if (token !== activeFileToken) return;
    await extractAudioToCache(file, token);
    if (token !== activeFileToken) return;
    await runAnalysis();
  } catch (err) {
    if (token === activeFileToken) {
      app.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (token === activeFileToken) {
      app.loading = false;
    }
  }
}

async function extractAudioToCache(file: File, token: number): Promise<void> {
  app.loadingText = 'Extracting audio…';
  const fileData = await file.arrayBuffer();
  if (token !== activeFileToken) return;

  const wavBytes = await ffmpegSerial(async (): Promise<Uint8Array | null> => {
    if (token !== activeFileToken) return null;
    if (!ffmpeg) throw new Error('ffmpeg not ready');
    await ffmpeg.writeFile('input', new Uint8Array(fileData));
    await ffmpeg.exec([
      '-i', 'input',
      '-ac', '1',
      '-ar', '48000',
      '-f', 'wav',
      '-y',
      'output.wav'
    ]);
    const data = await ffmpeg.readFile('output.wav');
    if (typeof data === 'string') throw new Error('ffmpeg returned text instead of bytes');
    // Cleanup is best-effort: a subsequent run will overwrite these paths
    // anyway, and a stale FS error here would obscure the real result.
    try { await ffmpeg.deleteFile('input'); } catch { /* best-effort */ }
    try { await ffmpeg.deleteFile('output.wav'); } catch { /* best-effort */ }
    return data;
  });

  if (!wavBytes || token !== activeFileToken) return;

  const Ctor = window.AudioContext || (window as unknown as WebkitAudioWindow).webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio API unavailable');
  const audioContext = new Ctor();
  const audioBuffer = await audioContext.decodeAudioData(wavBytes.buffer.slice(0) as ArrayBuffer);
  if (token !== activeFileToken) return;

  const channel = audioBuffer.getChannelData(0);
  cachedAudio = {
    audioData: new Float32Array(channel),
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration
  };
  app.player.setAudio(cachedAudio.audioData, cachedAudio.sampleRate);
  app.hasAudio = true;
  app.audioVersion++;
  await workerSetAudio(cachedAudio.audioData, cachedAudio.sampleRate);
}

export function getRawAudio(): CachedAudio | null {
  return cachedAudio;
}

export async function ensureSpectrogram(): Promise<SpectrogramData | null> {
  if (app.spectrogram) return app.spectrogram;
  if (app.spectrogramLoading) return null;
  if (!cachedAudio) return null;
  app.spectrogramLoading = true;
  try {
    const { promise } = workerCall<SpectrogramResponse>({ type: 'spectrogram' });
    const msg = await promise;
    app.spectrogram = msg.spectrogram;
    return app.spectrogram;
  } finally {
    app.spectrogramLoading = false;
  }
}

async function runAnalysis(): Promise<void> {
  if (!app.file || !cachedAudio) return;
  const { id, results } = await workerAnalyze();
  if (id !== lastAnalyzeId) return; // stale result; a newer analyze is in flight
  results.inputFile = app.file.name;
  results.audioDuration = cachedAudio.duration;
  app.results = results;
  app.error = null;
}

export function scheduleReanalysis(): void {
  if (!app.file || !cachedAudio) return;
  if (reanalysisTimeout) clearTimeout(reanalysisTimeout);
  reanalysisTimeout = setTimeout(async () => {
    app.loading = true;
    app.loadingText = 'Re-analyzing…';
    try {
      await runAnalysis();
    } catch (err) {
      app.error = err instanceof Error ? err.message : String(err);
    } finally {
      app.loading = false;
    }
  }, 300);
}

export function addAnalysisRegion(region: AnalysisRegion): void {
  const wasEmpty = app.analysisRegions.length === 0;
  const merged = mergeRegions([...app.analysisRegions, region]);
  app.analysisRegions = merged;
  // For the first region, park the cursor at its start so pressing play
  // immediately hears what's being analyzed. For subsequent regions, leave
  // the cursor alone so the user isn't yanked away from the part of the
  // clip they're currently inspecting.
  if (wasEmpty) seekTo(region.start);
  scheduleReanalysis();
}

export function clearAnalysisRegions(): void {
  if (app.analysisRegions.length === 0) return;
  app.analysisRegions = [];
  scheduleReanalysis();
}

export function setSelectMode(active: boolean): void {
  app.selectMode = active;
}

export function seekTo(time: number): void {
  app.player.currentTime = Math.max(0, Math.min(time, app.player.duration));
  app.cursorTime = app.player.currentTime;
}

export function togglePlay(): void {
  if (app.player.paused) app.player.play();
  else app.player.pause();
}

function mergeRegions(regions: AnalysisRegion[]): AnalysisRegion[] {
  if (regions.length <= 1) return regions.slice();
  const sorted = regions.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

export function reset(): void {
  app.file = null;
  app.results = null;
  app.analysisRegions = [];
  app.selectMode = false;
  app.error = null;
  app.hasAudio = false;
  app.cursorTime = 0;
  app.spectrogram = null;
  app.spectrogramLoading = false;
  cachedAudio = null;
  app.player.stop();
}
