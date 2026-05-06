<script lang="ts">
  /**
   * Timeline: canvas-based view of the audio with shot ticks, burst spans,
   * cursor, analysis-region selection, and an integrated playback header.
   *
   * Two layers:
   *   - View layer: envelope / waveform / spectrogram (any function of viewport)
   *   - Annotation layer: shot ticks (top), cursor, region shading, drag preview,
   *     burst strip (own canvas below), time axis (own canvas below that)
   *
   * Viewport (viewStart/viewEnd in seconds) is decoupled from cursorTime so
   * scrolling the view doesn't move playback and vice versa. Click=seek,
   * drag=pan, wheel/pinch=zoom around pointer, double-click=fit.
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    app, addAnalysisRegion, clearAnalysisRegions,
    setSelectMode, seekTo, togglePlay,
    getRawAudio, ensureSpectrogram
  } from '../state.svelte.js';
  import { downloadPlot } from '../exports.js';
  import type { SpectrogramData } from '../analysis-worker.js';

  type ViewMode = 'envelope' | 'waveform' | 'spectrogram';
  type DragMode = 'pan' | 'select' | null;

  interface WaveformMip {
    data: Float32Array;
    pairs: number;
    samplesPerPair: number;
  }

  let viewStart = $state(0);
  let viewEnd = $state(0);
  let viewMode = $state<ViewMode>('envelope');
  let hoverTime = $state<number | null>(null);

  // Hover tooltip state (mouse only — touch never sets these).
  let hoveredShotIdx = $state(-1);
  let hoveredBurstIdx = $state(-1);
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  let containerEl: HTMLElement;
  let mainCanvas: HTMLCanvasElement;
  let burstCanvas: HTMLCanvasElement;
  let axisCanvas: HTMLCanvasElement;

  let cssW = 0;
  const H_MAIN = 220;
  const H_BURST = 16;
  const H_AXIS = 20;
  const SHOT_TICK_AREA = 14;

  let dpr = 1;

  // Pre-computed mip pyramid for envelope (max-pooled, halving each level).
  // For 48kHz envelope, ~22 levels covers up to ~26 minutes at <1 sample/px.
  let envelopeMips: Float32Array[] = [];

  // Pre-computed min/max mip pyramid for waveform. Each level: Float32Array of
  // [min0, max0, min1, max1, ...]; samplesPerPair doubles each level.
  let waveformMips: WaveformMip[] = [];

  // Offscreen canvas containing the full colormapped spectrogram. Rendered
  // once per audio (or per spectrogram payload) and blit-scaled per frame.
  let spectrogramOffscreen: HTMLCanvasElement | null = null;
  let spectrogramAudioVersion = -1;

  // --- Coordinate transforms (CSS pixels) ---
  const span = $derived(Math.max(1e-6, viewEnd - viewStart));
  function timeToX(t: number) { return ((t - viewStart) / span) * cssW; }
  function xToTime(x: number) { return viewStart + (x / cssW) * span; }

  // --- Derived from app state ---
  const duration = $derived(app.results?.audioDuration || 0);
  const peakTimes = $derived(
    app.results?.peaks && app.results.sampleRate
      ? app.results.peaks.map(idx => idx / app.results!.sampleRate)
      : []
  );
  const bursts = $derived(app.results?.bursts ?? []);

  // --- Drag/pinch/pan state ---
  let pointerDown = false;
  let pointerStartX = 0;
  let pointerStartT = 0;
  let pointerStartViewStart = 0;
  let pointerStartViewEnd = 0;
  let pointerMoved = false;
  let dragMode: DragMode = null;
  let dragSelectT0 = 0;
  let dragSelectT1 = 0;

  let pinchStartDist = 0;
  let pinchStartCenterT = 0;
  let pinchStartViewStart = 0;
  let pinchStartViewEnd = 0;

  const DRAG_THRESHOLD = 4; // CSS px

  // --- Init viewport whenever a new result arrives ---
  let lastResultsKey: string | null = null;
  $effect(() => {
    const key = app.results ? `${app.results.inputFile}-${app.results.audioDuration}` : null;
    if (key !== lastResultsKey) {
      lastResultsKey = key;
      if (duration > 0) {
        viewStart = 0;
        viewEnd = duration;
      }
    }
  });

  // --- Build mip pyramid when envelope changes ---
  $effect(() => {
    const env = app.results?.envelope;
    if (!env) { envelopeMips = []; return; }
    envelopeMips = buildMips(env);
    requestRender();
  });

  // --- Build waveform min/max pyramid when audio is (re)loaded ---
  $effect(() => {
    void app.audioVersion;
    const raw = getRawAudio();
    if (!raw) { waveformMips = []; return; }
    waveformMips = buildWaveformMips(raw.audioData);
    requestRender();
  });

  // --- Build spectrogram offscreen when payload arrives ---
  $effect(() => {
    void app.audioVersion;
    if (spectrogramAudioVersion !== app.audioVersion) {
      spectrogramOffscreen = null;
      spectrogramAudioVersion = app.audioVersion;
    }
    const spec = app.spectrogram;
    if (!spec) return;
    spectrogramOffscreen = buildSpectrogramOffscreen(spec);
    requestRender();
  });

  // --- Lazily request spectrogram when its view is first selected ---
  $effect(() => {
    if (viewMode === 'spectrogram' && app.hasAudio && !app.spectrogram && !app.spectrogramLoading) {
      ensureSpectrogram();
    }
  });

  // --- Re-render on any reactive input change ---
  $effect(() => {
    void viewStart; void viewEnd; void viewMode;
    void app.cursorTime; void app.analysisRegions;
    void peakTimes; void bursts; void hoverTime;
    void hoveredShotIdx; void hoveredBurstIdx;
    requestRender();
  });

  function buildMips(data: Float32Array): Float32Array[] {
    const mips: Float32Array[] = [data];
    let cur = data;
    while (cur.length > 1024) {
      const next = new Float32Array(Math.ceil(cur.length / 2));
      for (let i = 0; i < next.length; i++) {
        const a = cur[2 * i];
        const b = (2 * i + 1 < cur.length) ? cur[2 * i + 1] : a;
        next[i] = a > b ? a : b;
      }
      mips.push(next);
      cur = next;
    }
    return mips;
  }

  function buildWaveformMips(audio: Float32Array): WaveformMip[] {
    // Level 0: pairs of (min, max) over consecutive sample pairs.
    const pairs0 = Math.ceil(audio.length / 2);
    const lvl0 = new Float32Array(pairs0 * 2);
    for (let i = 0; i < pairs0; i++) {
      const a = audio[2 * i];
      const b = (2 * i + 1 < audio.length) ? audio[2 * i + 1] : a;
      lvl0[2 * i] = a < b ? a : b;
      lvl0[2 * i + 1] = a > b ? a : b;
    }
    const mips: WaveformMip[] = [{ data: lvl0, pairs: pairs0, samplesPerPair: 2 }];
    let prev = lvl0;
    let prevPairs = pairs0;
    let spp = 2;
    while (prevPairs > 1024) {
      const nextPairs = Math.ceil(prevPairs / 2);
      const next = new Float32Array(nextPairs * 2);
      for (let i = 0; i < nextPairs; i++) {
        const a_min = prev[4 * i];
        const a_max = prev[4 * i + 1];
        const b_min = (4 * i + 2 < prev.length) ? prev[4 * i + 2] : a_min;
        const b_max = (4 * i + 3 < prev.length) ? prev[4 * i + 3] : a_max;
        next[2 * i] = a_min < b_min ? a_min : b_min;
        next[2 * i + 1] = a_max > b_max ? a_max : b_max;
      }
      prev = next;
      prevPairs = nextPairs;
      spp *= 2;
      mips.push({ data: next, pairs: nextPairs, samplesPerPair: spp });
    }
    return mips;
  }

  // Magma-ish colormap (perceptually uniform-ish, dark→purple→orange→yellow).
  const SPECTRO_PALETTE: [number, number, number][] = (() => {
    const stops: [number, [number, number, number]][] = [
      [0.00, [0, 0, 0]],
      [0.15, [40, 11, 84]],
      [0.40, [143, 36, 105]],
      [0.70, [241, 96, 93]],
      [0.90, [252, 186, 84]],
      [1.00, [252, 255, 164]]
    ];
    function paletteAt(t: number): [number, number, number] {
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
          const [t0, c0] = stops[i - 1];
          const [t1, c1] = stops[i];
          const f = (t - t0) / (t1 - t0);
          return [
            Math.round(c0[0] + (c1[0] - c0[0]) * f),
            Math.round(c0[1] + (c1[1] - c0[1]) * f),
            Math.round(c0[2] + (c1[2] - c0[2]) * f)
          ];
        }
      }
      return stops[stops.length - 1][1];
    }
    const arr: [number, number, number][] = new Array(256);
    for (let i = 0; i < 256; i++) arr[i] = paletteAt(i / 255);
    return arr;
  })();

  function buildSpectrogramOffscreen(spec: SpectrogramData): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = spec.numFrames;
    c.height = spec.numBins;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(spec.numFrames, spec.numBins);
    const arr = img.data;
    // Bin 0 (DC) at bottom of canvas; high frequency at top.
    for (let f = 0; f < spec.numFrames; f++) {
      for (let k = 0; k < spec.numBins; k++) {
        const py = spec.numBins - 1 - k;
        const v = spec.data[f * spec.numBins + k];
        const rgb = SPECTRO_PALETTE[v];
        const idx = (py * spec.numFrames + f) * 4;
        arr[idx] = rgb[0];
        arr[idx + 1] = rgb[1];
        arr[idx + 2] = rgb[2];
        arr[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // --- Render scheduler (one rAF per change) ---
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!mainCanvas || cssW === 0) return;
    drawMain();
    drawBurstStrip();
    drawAxis();
  }

  function drawMain() {
    const ctx = mainCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cssW, H_MAIN);

    drawAnalysisRegions(ctx);

    if (viewMode === 'envelope') drawEnvelope(ctx);
    else if (viewMode === 'waveform') drawWaveform(ctx);
    else if (viewMode === 'spectrogram') drawSpectrogram(ctx);

    drawShotTicks(ctx);
    drawHoverGuide(ctx);
    drawCursor(ctx);
    drawDragPreview(ctx);
  }

  function drawAnalysisRegions(ctx: CanvasRenderingContext2D) {
    const regions = app.analysisRegions;
    if (regions.length === 0) return;
    // Shade OUTSIDE included regions: they are NOT being analyzed.
    ctx.fillStyle = 'rgba(31, 41, 55, 0.10)';
    const sorted = [...regions].sort((a, b) => a.start - b.start);
    let prev = viewStart;
    for (const r of sorted) {
      if (r.end < viewStart) continue;
      if (r.start > viewEnd) break;
      const x0 = timeToX(prev);
      const x1 = timeToX(Math.min(r.start, viewEnd));
      if (x1 > x0) ctx.fillRect(x0, 0, x1 - x0, H_MAIN);
      prev = Math.max(prev, r.end);
    }
    if (prev < viewEnd) {
      const x0 = timeToX(prev);
      ctx.fillRect(x0, 0, cssW - x0, H_MAIN);
    }

    // Outline included regions in the accent color so they read as "selected"
    ctx.strokeStyle = 'rgba(0, 135, 154, 0.55)';
    ctx.lineWidth = 1;
    for (const r of sorted) {
      if (r.end < viewStart || r.start > viewEnd) continue;
      const x0 = timeToX(Math.max(r.start, viewStart));
      const x1 = timeToX(Math.min(r.end, viewEnd));
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0);
      ctx.lineTo(x0 + 0.5, H_MAIN);
      ctx.moveTo(x1 - 0.5, 0);
      ctx.lineTo(x1 - 0.5, H_MAIN);
      ctx.stroke();
    }
  }

  function drawEnvelope(ctx: CanvasRenderingContext2D) {
    if (!envelopeMips.length || !app.results?.sampleRate) return;
    const sr = app.results.sampleRate;
    const samplesPerPixel = (span * sr) / cssW;

    // Pick mip level so we pool over ≥1 sample per pixel.
    let level = 0;
    let scale = 1;
    while (level < envelopeMips.length - 1 && samplesPerPixel / scale > 2) {
      level++;
      scale *= 2;
    }
    const mip = envelopeMips[level];
    const mipSr = sr / scale;

    // Global max for stable y-scaling (avoids jumpy y-axis as you scroll).
    let maxVal = 0;
    const fullEnv = envelopeMips[envelopeMips.length - 1];
    for (let i = 0; i < fullEnv.length; i++) if (fullEnv[i] > maxVal) maxVal = fullEnv[i];
    if (maxVal <= 0) maxVal = 1;

    const padTop = SHOT_TICK_AREA + 2;
    const drawH = H_MAIN - padTop;

    // Build path: max-of-column for each pixel.
    ctx.fillStyle = 'rgba(31, 41, 55, 0.07)';
    ctx.strokeStyle = '#1F2937';
    ctx.lineWidth = 1;

    const ys = new Float32Array(cssW);
    for (let px = 0; px < cssW; px++) {
      const t0 = viewStart + (px / cssW) * span;
      const t1 = viewStart + ((px + 1) / cssW) * span;
      const i0 = Math.max(0, Math.floor(t0 * mipSr));
      const i1 = Math.min(mip.length, Math.max(i0 + 1, Math.ceil(t1 * mipSr)));
      let m = 0;
      for (let i = i0; i < i1; i++) if (mip[i] > m) m = mip[i];
      ys[px] = padTop + drawH - (m / maxVal) * drawH;
    }

    ctx.beginPath();
    ctx.moveTo(0, H_MAIN);
    for (let px = 0; px < cssW; px++) ctx.lineTo(px, ys[px]);
    ctx.lineTo(cssW, H_MAIN);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    for (let px = 0; px < cssW; px++) {
      if (px === 0) ctx.moveTo(0, ys[0]);
      else ctx.lineTo(px, ys[px]);
    }
    ctx.stroke();
  }

  function drawWaveform(ctx: CanvasRenderingContext2D) {
    if (!waveformMips.length) return;
    const raw = getRawAudio();
    if (!raw) return;
    const sr = raw.sampleRate;
    const samplesPerPx = (span * sr) / cssW;

    let level = 0;
    for (let i = 0; i < waveformMips.length - 1; i++) {
      if (waveformMips[i + 1].samplesPerPair > samplesPerPx) break;
      level = i + 1;
    }
    const mip = waveformMips[level];
    const spp = mip.samplesPerPair;

    const padTop = SHOT_TICK_AREA + 2;
    const drawH = H_MAIN - padTop;
    const midY = padTop + drawH / 2;
    const halfH = drawH / 2;

    // Zero line
    ctx.strokeStyle = 'rgba(98, 98, 88, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(midY) + 0.5);
    ctx.lineTo(cssW, Math.round(midY) + 0.5);
    ctx.stroke();

    ctx.fillStyle = '#1F2937';
    for (let px = 0; px < cssW; px++) {
      const t0 = viewStart + (px / cssW) * span;
      const t1 = viewStart + ((px + 1) / cssW) * span;
      const samp0 = t0 * sr;
      const samp1 = t1 * sr;
      const pair0 = Math.max(0, Math.floor(samp0 / spp));
      const pair1 = Math.min(mip.pairs, Math.max(pair0 + 1, Math.ceil(samp1 / spp)));
      let mn = Infinity, mx = -Infinity;
      for (let p = pair0; p < pair1; p++) {
        const lo = mip.data[2 * p];
        const hi = mip.data[2 * p + 1];
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
      if (mn === Infinity) continue;
      const y0 = midY - mx * halfH;
      const y1 = midY - mn * halfH;
      ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }

  function drawSpectrogram(ctx: CanvasRenderingContext2D) {
    const padTop = SHOT_TICK_AREA + 2;
    const drawH = H_MAIN - padTop;
    if (!spectrogramOffscreen || !app.spectrogram) {
      // Loading / not yet computed: paint background so the view isn't blank.
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, padTop, cssW, drawH);
      ctx.fillStyle = '#98988F';
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = app.spectrogramLoading ? 'Computing spectrogram…' : 'Spectrogram not loaded';
      ctx.fillText(label, cssW / 2, padTop + drawH / 2);
      return;
    }
    const spec = app.spectrogram;
    const sr = spec.sampleRate;
    const srcX = (viewStart * sr) / spec.hopSize;
    const srcW = (span * sr) / spec.hopSize;

    // Background for any audio-past-end region
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, padTop, cssW, drawH);

    // Bilinear smoothing fills in gaps when zoomed-in pixels would otherwise
    // be blocky from the source-frame grid. Acceptable trade — adjacent
    // freq bins are correlated for broadband transients anyway.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      spectrogramOffscreen,
      srcX, 0, srcW, spec.numBins,
      0, padTop, cssW, drawH
    );
  }

  function drawShotTicks(ctx: CanvasRenderingContext2D) {
    if (peakTimes.length === 0) return;
    ctx.strokeStyle = 'rgba(0, 135, 154, 0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < peakTimes.length; i++) {
      if (i === hoveredShotIdx) continue;
      const t = peakTimes[i];
      if (t < viewStart || t > viewEnd) continue;
      const x = Math.round(timeToX(t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SHOT_TICK_AREA);
    }
    ctx.stroke();
    if (hoveredShotIdx >= 0) {
      const t = peakTimes[hoveredShotIdx];
      if (t >= viewStart && t <= viewEnd) {
        ctx.strokeStyle = '#006B7C';
        ctx.lineWidth = 2;
        const x = Math.round(timeToX(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, SHOT_TICK_AREA + 2);
        ctx.stroke();
      }
    }
  }

  function drawHoverGuide(ctx: CanvasRenderingContext2D) {
    if (hoverTime == null) return;
    if (hoverTime < viewStart || hoverTime > viewEnd) return;
    ctx.strokeStyle = 'rgba(31, 41, 55, 0.25)';
    ctx.lineWidth = 1;
    const x = Math.round(timeToX(hoverTime)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, SHOT_TICK_AREA);
    ctx.lineTo(x, H_MAIN);
    ctx.stroke();
  }

  function drawCursor(ctx: CanvasRenderingContext2D) {
    const t = app.cursorTime;
    if (!Number.isFinite(t) || t < viewStart || t > viewEnd) return;
    ctx.strokeStyle = '#E07B00';
    ctx.lineWidth = 1.5;
    const x = Math.round(timeToX(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H_MAIN);
    ctx.stroke();
  }

  function drawDragPreview(ctx: CanvasRenderingContext2D) {
    if (dragMode !== 'select') return;
    const t0 = Math.min(dragSelectT0, dragSelectT1);
    const t1 = Math.max(dragSelectT0, dragSelectT1);
    const x0 = timeToX(t0);
    const x1 = timeToX(t1);
    ctx.fillStyle = 'rgba(0, 135, 154, 0.18)';
    ctx.fillRect(x0, 0, x1 - x0, H_MAIN);
    ctx.strokeStyle = 'rgba(0, 135, 154, 0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, H_MAIN - 1);
    ctx.setLineDash([]);
  }

  function drawBurstStrip() {
    if (!burstCanvas) return;
    const ctx = burstCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cssW, H_BURST);
    if (!bursts.length) return;
    const y = 4;
    const h = H_BURST - 8;
    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i];
      if (b.endTime < viewStart || b.startTime > viewEnd) continue;
      const x0 = timeToX(Math.max(b.startTime, viewStart));
      const x1 = timeToX(Math.min(b.endTime, viewEnd));
      const w = Math.max(2, x1 - x0);
      ctx.fillStyle = i === hoveredBurstIdx ? '#006B7C' : '#00879A';
      ctx.fillRect(x0, y, w, h);
    }
  }

  function drawAxis() {
    if (!axisCanvas) return;
    const ctx = axisCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cssW, H_AXIS);

    const targetTicks = Math.max(3, Math.floor(cssW / 90));
    const rawStep = span / targetTicks;
    const step = niceStep(rawStep);

    ctx.fillStyle = '#5C5C58';
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = '#D4D4CE';
    ctx.lineWidth = 1;

    const t0 = Math.ceil(viewStart / step) * step;
    for (let t = t0; t <= viewEnd + 1e-9; t += step) {
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, 4);
      ctx.stroke();
      // Keep the label on-canvas: clamp its center so it doesn't get clipped
      // at the left/right edges. Tick mark stays at the true x.
      const label = formatTime(t, step);
      const halfW = ctx.measureText(label).width / 2;
      const labelX = Math.max(halfW, Math.min(cssW - halfW, x));
      ctx.fillText(label, labelX, 6);
    }
  }

  function niceStep(raw: number): number {
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const m = raw / base;
    const niceM = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return niceM * base;
  }

  function formatTime(t: number, step: number): string {
    const dec = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
    if (Math.abs(t) >= 60) {
      const mins = Math.floor(t / 60);
      const secs = t - mins * 60;
      return `${mins}:${secs.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
    }
    return t.toFixed(dec) + 's';
  }

  // --- Resize handling ---
  function resize() {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const newW = Math.max(0, Math.floor(rect.width));
    if (newW === cssW && dpr === (window.devicePixelRatio || 1)) return;
    cssW = newW;
    dpr = window.devicePixelRatio || 1;
    setupCanvas(mainCanvas, H_MAIN);
    setupCanvas(burstCanvas, H_BURST);
    setupCanvas(axisCanvas, H_AXIS);
    requestRender();
  }

  function setupCanvas(c: HTMLCanvasElement | undefined, h: number) {
    if (!c) return;
    c.style.width = cssW + 'px';
    c.style.height = h + 'px';
    c.width = Math.max(1, Math.floor(cssW * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const ctx = c.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let resizeObs: ResizeObserver | undefined;
  onMount(() => {
    resize();
    resizeObs = new ResizeObserver(resize);
    resizeObs.observe(containerEl);
    window.addEventListener('resize', resize);
  });
  onDestroy(() => {
    resizeObs?.disconnect();
    window.removeEventListener('resize', resize);
  });

  // --- Pointer handling: mouse + single-touch ---
  function eventTime(clientX: number): number {
    const rect = mainCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(cssW, clientX - rect.left));
    return xToTime(x);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    mainCanvas.setPointerCapture(e.pointerId);
    pointerDown = true;
    pointerMoved = false;
    pointerStartX = e.clientX;
    pointerStartT = eventTime(e.clientX);
    pointerStartViewStart = viewStart;
    pointerStartViewEnd = viewEnd;
    // When fully zoomed out there's nothing to pan to, so a drag is more
    // useful as a region selection.
    if (app.selectMode || isFitted) {
      dragMode = 'select';
      dragSelectT0 = pointerStartT;
      dragSelectT1 = pointerStartT;
    } else {
      dragMode = null; // decided on first move
    }
  }

  function onPointerMove(e: PointerEvent) {
    const t = eventTime(e.clientX);
    hoverTime = t;

    // Update hover-tooltip targets (mouse only — touch shouldn't show them).
    if (e.pointerType === 'mouse') {
      const rect = mainCanvas.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      tooltipX = e.clientX;
      tooltipY = e.clientY;
      hoveredShotIdx = (localY <= SHOT_TICK_AREA) ? findShotNear(t) : -1;
    }

    if (!pointerDown) return;
    const dx = e.clientX - pointerStartX;
    if (!pointerMoved && Math.abs(dx) > DRAG_THRESHOLD) {
      pointerMoved = true;
      if (dragMode == null) dragMode = 'pan';
    }
    if (!pointerMoved) return;
    if (dragMode === 'pan') {
      const dtPerPx = (pointerStartViewEnd - pointerStartViewStart) / cssW;
      const shift = -dx * dtPerPx;
      let newStart = pointerStartViewStart + shift;
      let newEnd = pointerStartViewEnd + shift;
      const sp = newEnd - newStart;
      if (newStart < 0) { newStart = 0; newEnd = sp; }
      if (newEnd > duration) { newEnd = duration; newStart = Math.max(0, duration - sp); }
      viewStart = newStart;
      viewEnd = newEnd;
    } else if (dragMode === 'select') {
      dragSelectT1 = t;
      requestRender();
    }
  }

  function findShotNear(t: number): number {
    if (peakTimes.length === 0) return -1;
    const tolPx = 4;
    const tolT = tolPx * (span / cssW);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < peakTimes.length; i++) {
      const d = Math.abs(peakTimes[i] - t);
      if (d < tolT && d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function findBurstAt(t: number): number {
    for (let i = 0; i < bursts.length; i++) {
      if (t >= bursts[i].startTime && t <= bursts[i].endTime) return i;
    }
    return -1;
  }

  function onPointerUp(e: PointerEvent) {
    if (!pointerDown) return;
    pointerDown = false;
    try { mainCanvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!pointerMoved) {
      seekTo(eventTime(e.clientX));
    } else if (dragMode === 'select') {
      const t0 = Math.min(dragSelectT0, dragSelectT1);
      const t1 = Math.max(dragSelectT0, dragSelectT1);
      if (t1 - t0 > 0.01) addAnalysisRegion({ start: t0, end: t1 });
    }
    dragMode = null;
    requestRender();
  }

  function onPointerLeave() {
    if (!pointerDown) {
      hoverTime = null;
      hoveredShotIdx = -1;
    }
  }

  // --- Burst strip pointer (click to seek to burst start; hover for tooltip) ---
  function onBurstPointerMove(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    const rect = burstCanvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const t = xToTime(cssX);
    hoveredBurstIdx = findBurstAt(t);
    tooltipX = e.clientX;
    tooltipY = e.clientY;
  }
  function onBurstPointerLeave() {
    hoveredBurstIdx = -1;
  }
  function onBurstClick(e: MouseEvent) {
    const rect = burstCanvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const t = xToTime(cssX);
    const idx = findBurstAt(t);
    if (idx >= 0) seekTo(bursts[idx].startTime);
    else seekTo(t);
  }

  function onDoubleClick() {
    fitView();
  }

  function onWheel(e: WheelEvent) {
    if (!duration) return;
    e.preventDefault();
    const rect = mainCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const tAt = xToTime(px);
    // Negative deltaY = wheel up = zoom in.
    const factor = Math.exp(e.deltaY * 0.0015);
    zoomAround(tAt, factor);
  }

  function zoomAround(t: number, factor: number) {
    const newSpan = Math.max(Math.min(span * factor, duration), 0.01);
    const frac = (t - viewStart) / span;
    let newStart = t - frac * newSpan;
    let newEnd = newStart + newSpan;
    if (newStart < 0) { newStart = 0; newEnd = newSpan; }
    if (newEnd > duration) { newEnd = duration; newStart = Math.max(0, duration - newSpan); }
    viewStart = newStart;
    viewEnd = newEnd;
  }

  function fitView() {
    viewStart = 0;
    viewEnd = duration;
  }

  // --- Two-finger pinch (touch) ---
  const touchPoints = new Map<number, Touch>();
  function onTouchStart(e: TouchEvent) {
    for (const t of e.changedTouches) touchPoints.set(t.identifier, t);
    if (touchPoints.size === 2) {
      e.preventDefault();
      pointerDown = false; // cancel any single-finger drag
      const [a, b] = [...touchPoints.values()];
      pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const rect = mainCanvas.getBoundingClientRect();
      const cx = ((a.clientX + b.clientX) / 2) - rect.left;
      pinchStartCenterT = xToTime(cx);
      pinchStartViewStart = viewStart;
      pinchStartViewEnd = viewEnd;
    }
  }
  function onTouchMove(e: TouchEvent) {
    for (const t of e.changedTouches) {
      if (touchPoints.has(t.identifier)) touchPoints.set(t.identifier, t);
    }
    if (touchPoints.size === 2) {
      e.preventDefault();
      const [a, b] = [...touchPoints.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const factor = pinchStartDist / dist;
      const startSpan = pinchStartViewEnd - pinchStartViewStart;
      const newSpan = Math.max(Math.min(startSpan * factor, duration), 0.01);
      const frac = (pinchStartCenterT - pinchStartViewStart) / startSpan;
      let newStart = pinchStartCenterT - frac * newSpan;
      let newEnd = newStart + newSpan;
      if (newStart < 0) { newStart = 0; newEnd = newSpan; }
      if (newEnd > duration) { newEnd = duration; newStart = Math.max(0, duration - newSpan); }
      viewStart = newStart;
      viewEnd = newEnd;
    }
  }
  function onTouchEnd(e: TouchEvent) {
    for (const t of e.changedTouches) touchPoints.delete(t.identifier);
  }

  // --- Header helpers ---
  function fmtTime(t: number): string {
    if (!Number.isFinite(t)) t = 0;
    return t.toFixed(2);
  }

  // Tolerance is 1ms — any tighter and floating-point drift in the duration
  // value (re-derived per analysis result) can flip this false even when
  // the view hasn't actually moved.
  const isFitted = $derived(
    duration > 0 && viewStart < 1e-3 && viewEnd > duration - 1e-3
  );
</script>

<section class="timeline-card" bind:this={containerEl}>
  <header class="header">
    <button
      class="play"
      onclick={togglePlay}
      disabled={!app.hasAudio}
      aria-label={app.playing ? 'Pause' : 'Play'}
    >{app.playing ? '❚❚' : '▶'}</button>

    <span class="time" aria-live="off">
      <span class="cur">{fmtTime(app.cursorTime)}</span>
      <span class="sep">/</span>
      <span class="dur">{fmtTime(duration)}</span>
      <span class="unit">s</span>
    </span>

    <span class="spacer"></span>

    <div class="view-switch" role="group" aria-label="View">
      <button
        class:active={viewMode === 'envelope'}
        onclick={() => viewMode = 'envelope'}
      >Envelope</button>
      <button
        class:active={viewMode === 'waveform'}
        onclick={() => viewMode = 'waveform'}
      >Waveform</button>
      <button
        class:active={viewMode === 'spectrogram'}
        onclick={() => viewMode = 'spectrogram'}
        title={app.spectrogramLoading ? 'Computing…' : 'Spectrogram'}
      >Spectrogram{#if app.spectrogramLoading && viewMode === 'spectrogram'} …{/if}</button>
    </div>

    <button
      class="tool"
      class:active={app.selectMode}
      onclick={() => setSelectMode(!app.selectMode)}
      title="Drag on the timeline to mark a region to analyze"
    >◧ Select</button>

    {#if app.analysisRegions.length > 0}
      <button class="tool ghost" onclick={clearAnalysisRegions}>Clear</button>
    {/if}

    <button
      class="tool"
      onclick={fitView}
      disabled={isFitted}
      title="Reset zoom (double-click the timeline)"
    >Reset zoom</button>

    <button
      class="tool"
      onclick={downloadPlot}
      title="Save the plot as PNG"
    >Save plot</button>
  </header>

  <div class="canvas-stack">
    <canvas
      bind:this={mainCanvas}
      class="main-canvas"
      class:select-mode={app.selectMode || isFitted}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerLeave}
      ondblclick={onDoubleClick}
      onwheel={onWheel}
      ontouchstart={onTouchStart}
      ontouchmove={onTouchMove}
      ontouchend={onTouchEnd}
      ontouchcancel={onTouchEnd}
    ></canvas>
    <canvas
      bind:this={burstCanvas}
      class="strip-canvas"
      onpointermove={onBurstPointerMove}
      onpointerleave={onBurstPointerLeave}
      onclick={onBurstClick}
    ></canvas>
    <canvas bind:this={axisCanvas} class="axis-canvas"></canvas>
  </div>

  {#if (hoveredShotIdx >= 0 || hoveredBurstIdx >= 0)}
    <div
      class="tooltip"
      style="left:{tooltipX}px;top:{tooltipY}px;"
    >
      {#if hoveredBurstIdx >= 0}
        {@const b = bursts[hoveredBurstIdx]}
        <div class="tt-title">Burst #{b.burstNumber}</div>
        <div class="tt-row"><span>{Math.round(b.rateRpm)}</span> RPM</div>
        <div class="tt-row"><span>{b.numShots}</span> shots · {(b.duration * 1000).toFixed(0)} ms</div>
      {:else}
        {@const t = peakTimes[hoveredShotIdx]}
        <div class="tt-title">Shot</div>
        <div class="tt-row"><span>{t.toFixed(3)}</span> s</div>
        {#if findBurstAt(t) >= 0}
          {@const bi = findBurstAt(t)}
          <div class="tt-row tt-sub">in burst #{bursts[bi].burstNumber}</div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if app.analysisRegions.length > 0}
    <div class="region-summary">
      <span class="region-label">Analyzing only</span>
      {#each app.analysisRegions as r}
        <span class="region-chip">{r.start.toFixed(2)}–{r.end.toFixed(2)}s</span>
      {/each}
    </div>
  {/if}
</section>

<style>
  .timeline-card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 12px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .spacer { flex: 1; }

  .play {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: white;
    border: none;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s;
  }
  .play:hover:not(:disabled) { background: var(--accent-hover); }
  .play:disabled { background: var(--border-strong); cursor: not-allowed; }

  .time {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    min-width: 130px;
  }
  .cur { color: var(--text); font-weight: 600; }
  .sep { color: var(--text-tertiary); margin: 0 4px; }
  .unit { color: var(--text-tertiary); margin-left: 2px; }

  .view-switch {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .view-switch button {
    background: transparent;
    border: none;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text-secondary);
    border-right: 1px solid var(--border-strong);
    transition: background 0.1s, color 0.1s;
  }
  .view-switch button:last-child { border-right: none; }
  .view-switch button:hover:not(:disabled):not(.active) {
    background: var(--accent-bg);
    color: var(--accent);
  }
  .view-switch button.active {
    background: var(--accent);
    color: white;
  }
  .view-switch button:disabled {
    color: var(--text-tertiary);
    cursor: not-allowed;
  }

  .tool {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    padding: 5px 10px;
    border-radius: var(--radius);
    font-size: 12px;
    transition: all 0.12s;
  }
  .tool:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .tool.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .tool.ghost:hover { border-color: var(--danger); color: var(--danger); }
  .tool:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .canvas-stack {
    display: flex;
    flex-direction: column;
    user-select: none;
    touch-action: none;
  }
  .main-canvas {
    display: block;
    cursor: pointer;
  }
  .main-canvas.select-mode {
    cursor: crosshair;
  }
  .strip-canvas, .axis-canvas {
    display: block;
  }

  .region-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-tertiary);
  }
  .region-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }
  .region-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 8px;
    background: var(--accent-bg);
    color: var(--accent-hover);
    border-radius: 12px;
  }

  .tooltip {
    position: fixed;
    background: var(--text);
    color: white;
    padding: 6px 10px;
    border-radius: var(--radius);
    font-size: 11px;
    pointer-events: none;
    z-index: 100;
    transform: translate(10px, calc(-100% - 10px));
    white-space: nowrap;
    box-shadow: var(--shadow-md);
    line-height: 1.4;
  }
  .tt-title {
    font-weight: 600;
    margin-bottom: 2px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .tt-row {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .tt-row span {
    font-weight: 600;
    color: #FFE9B0;
  }
  .tt-sub {
    opacity: 0.7;
  }

  .strip-canvas {
    cursor: pointer;
  }
</style>
