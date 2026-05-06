# ROF GUI

A browser-based tool for measuring **rate of fire** from audio or video recordings of automatic-weapon fire. Drop a clip, get cyclic RPM, per-burst rates, and an interactive timeline. Everything runs locally — your media never leaves the browser.

## Live application

**https://schlarpc.github.io/rof-gui/**

## Features

- **Client-side** — all decoding, DSP, and analysis run in the browser via WebAssembly. No uploads.
- **Auto-tuning detector** — estimates the cyclic period via autocorrelation, builds a per-recording shot template, and matched-filter detects shots. Adapts to supersonic/subsonic, suppressed/open, near/distant recordings without manual knobs.
- **Multiband shotness gating** — broadband-impulse score (geometric mean of LF and HF envelopes, each per-recording-normalized) rejects narrowband artifacts: brass clinks, distant thumps, reverberant tails.
- **Burst grouping** — gap-based clustering refined by amplitude coherence, cadence, and quality (interval / amplitude dispersion). Cadence-extension recovers shots whose envelope fell below the matched-filter threshold.
- **Interactive timeline** — canvas-based view with envelope / waveform / spectrogram modes, shot ticks, burst spans, drag-to-select analysis regions, click-to-seek playback.
- **Exports** — shareable PNG result card, full timeline plot PNG, raw analysis JSON.

## How it works

The pipeline runs in an off-thread Web Worker so the UI stays responsive:

1. **Audio extraction** — ffmpeg.wasm decodes the input to mono 48 kHz f32 PCM.
2. **Envelope** — short-window |·| smoothing.
3. **Period estimation** — autocorrelation of the onset signal of a smoothed envelope, with explicit harmonic-confusion checks (sub-harmonic and sub-period); cross-checked against an interval-histogram estimator.
4. **Shotness** — per-sample broadband-impulse score; geometric mean of LF/HF envelopes normalized by their own 95th percentiles.
5. **Matched-filter detection** — seed peaks → average shot template → cross-correlate envelope → adaptive-threshold peaks; gated by regional energy and shotness.
6. **Burst grouping & refinement** — gap-clustered, then amplitude-coherence, cadence-edge, and quality filters; cadence-extension recovers tail shots.
7. **Reporting** — per-burst RPM, headline cyclic rate (median of pooled inter-shot intervals), 95% CI, plus mean/median/min/max/std across bursts.

Algorithm details live in the per-method docstrings in [`src/rof-detector.ts`](src/rof-detector.ts) and [`src/auto-tune.ts`](src/auto-tune.ts).

## Building

### With Nix (matches CI)

```bash
direnv allow   # enables automatic nix develop shell
npm run dev    # starts development server
nix build      # production build → result/
```

### With Node.js

```bash
npm install
npm run dev      # development server
npm run build    # production build → dist/
npm run preview  # preview production build
```

## Project layout

```
src/
  app.ts                     # entrypoint: mounts the Svelte root
  App.svelte                 # top-level component, drag/paste handling
  state.svelte.ts            # shared app state, ffmpeg + worker glue
  analysis-worker.ts         # off-thread detector + spectrogram
  rof-detector.ts            # detector pipeline (envelope → bursts → rates)
  auto-tune.ts               # period estimation, shotness, matched filter
  signal-processing.ts       # numpy/scipy-style primitives
  audio-player.ts            # Web Audio playback wrapper
  exports.ts, result-card.ts # PNG/JSON download helpers
  components/                # Svelte UI components
test/
  test-runner.ts             # CLI validation harness
  debug-*.ts, render-plot.ts # algorithm-tuning aids
```

## Test corpus

`npm run test` runs the detector against the `test-corpus/validation/` set and reports per-file error and aggregate stats. `npm run test:all` includes the larger `test-corpus/test/` set used for regression tracking.

The `test-corpus/` directory is tracked via [Git LFS](https://git-lfs.com); install LFS before cloning if you want to run the validator. Ground truth is encoded in filenames as `_<rpm>rpm.flac` (or `_<rpm>rpm_<rounds>rds.flac` when shot count is also known). Compare against a saved baseline with `--baseline=test/baseline-validation.json`.

## Privacy & security

- No file ever leaves the browser. All decoding and analysis run locally.
- ffmpeg.wasm requires `SharedArrayBuffer`, so the page is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.

## License

[AGPL-3.0-or-later](LICENSE).
