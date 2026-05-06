/**
 * Rate-of-Fire Detector. Analyzes audio to detect gunshots and calculate
 * rate-of-fire for automatic weapons. Audio extraction is decoupled from
 * analysis — the same detector runs in the browser (via ffmpeg.wasm) and
 * in Node (via the ffmpeg CLI in the test runner).
 */

import * as signal from './signal-processing.js';
import * as autotune from './auto-tune.js';
import type { TuningEstimate } from './auto-tune.js';

export interface AnalysisRegion {
  start: number;
  end: number;
}

export interface DetectorParams {
  /** Auto-tune driven primary path. When false, falls back to the manual
   * knobs below. */
  autoTune: boolean;
  /** When set (≥3), the matched filter takes the top-N peaks instead of
   * threshold-filtering. */
  knownShotCount: number | null;
  /** Min spacing between shots (s). Used in the no-period fallback path. */
  minShotSpacing: number;
  /** Max gap between shots within a burst (s). Used in the no-period
   * fallback path. */
  burstGapThreshold: number;
  /** Envelope smoothing window (s). Smaller preserves transients. */
  windowSize: number;
  /** Min prominence in envelope-peak fallback, as a fraction of the
   * signal's max amplitude. */
  minPeakProminence: number;
  /** Reject bursts with fewer than this many shots. */
  minBurstCount: number;
  /** Restrict analysis to these `[start, end]` time windows (s). Empty =
   * analyze the whole clip. */
  includeRegions: AnalysisRegion[];
}

export const DEFAULT_PARAMS: DetectorParams = {
  // Fallback-only knobs: used when autoTune is off, or when period
  // estimation fails. In the autotune path the period drives min-spacing
  // (0.7·T), burst-gap (4·T), and the matched-filter score threshold,
  // so these don't fire.
  minShotSpacing: 0.020,      // 3000 RPM ceiling
  burstGapThreshold: 0.2,
  minPeakProminence: 0.05,
  // Always-on:
  windowSize: 0.002,
  minBurstCount: 3,
  autoTune: true,
  knownShotCount: null,
  includeRegions: []
};

export interface BurstResult {
  burstNumber: number;
  startTime: number;
  endTime: number;
  duration: number;
  numShots: number;
  rateRpm: number;
  rateRpmCI95: number;
  meanInterval: number;
  stdInterval: number;
  minInterval: number;
  maxInterval: number;
  shotTimes: number[];
}

export interface AnalysisSummary {
  totalShots: number;
  totalBursts: number;
  cyclicRateRpm: number;
  cyclicRateCI95: number;
  overallRateRpm: number;
  meanBurstRateRpm: number;
  medianBurstRateRpm: number;
  minBurstRateRpm: number;
  maxBurstRateRpm: number;
  stdBurstRateRpm: number;
  medianIntervalMs?: number;
  intervalStdMs?: number;
}

export interface AnalysisResult {
  audioDuration: number;
  sampleRate: number;
  parameters: DetectorParams;
  tuning: TuningEstimate | null;
  summary: AnalysisSummary;
  bursts: BurstResult[];
  peaks: number[];
  /** Set by the analysis worker before posting the message. */
  envelope?: Float32Array;
  /** Set by the state layer before exposing the result to UI components. */
  inputFile?: string;
}

export type ProgressCallback = (text: string) => void;

export class RateOfFireDetector implements DetectorParams {
  // Params (DetectorParams)
  autoTune: boolean;
  knownShotCount: number | null;
  minShotSpacing: number;
  burstGapThreshold: number;
  windowSize: number;
  minPeakProminence: number;
  minBurstCount: number;
  includeRegions: AnalysisRegion[];

  // Pipeline state
  sampleRate: number = 0;
  audioData: Float32Array | null = null; // analysis-ready audio (post-mask)
  envelope: Float32Array | null = null;  // amplitude envelope (smooth |audio|)
  shotness: Float32Array | null = null;  // multiband-agreement signal
  shotTimes: number[] = [];
  shotPeakIndices: number[] = [];
  bursts: number[][] = [];
  tuning: TuningEstimate | null = null;

  constructor(opts: Partial<DetectorParams> = {}) {
    this.autoTune = opts.autoTune ?? DEFAULT_PARAMS.autoTune;
    this.knownShotCount = opts.knownShotCount ?? DEFAULT_PARAMS.knownShotCount;
    this.minShotSpacing = opts.minShotSpacing ?? DEFAULT_PARAMS.minShotSpacing;
    this.burstGapThreshold = opts.burstGapThreshold ?? DEFAULT_PARAMS.burstGapThreshold;
    this.windowSize = opts.windowSize ?? DEFAULT_PARAMS.windowSize;
    this.minPeakProminence = opts.minPeakProminence ?? DEFAULT_PARAMS.minPeakProminence;
    this.minBurstCount = opts.minBurstCount ?? DEFAULT_PARAMS.minBurstCount;
    this.includeRegions = opts.includeRegions ?? DEFAULT_PARAMS.includeRegions;
  }

  setAudio(audioData: Float32Array, sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.audioData = applyInclusion(audioData, sampleRate, this.includeRegions);
  }

  calculateEnvelope(): void {
    if (!this.audioData) throw new Error('Must call setAudio first');

    const windowSamples = Math.max(Math.floor(this.windowSize * this.sampleRate), 1);
    const absAudio = signal.abs(this.audioData);

    if (windowSamples > 1) {
      const window = signal.divide(signal.ones(windowSamples), windowSamples);
      this.envelope = signal.convolve(absAudio, window, 'same');
    } else {
      this.envelope = absAudio;
    }

    // Multiband-agreement "shotness" signal: a per-sample score that lights
    // up only on broadband impulses (real shots) and stays low for narrowband
    // events (brass clinks, distant thumps, sustained noise). Passed to the
    // matched-filter detector as a final-stage gate so candidates that pass
    // the amplitude template are also required to be broadband impulses.
    this.shotness = autotune.shotnessEnvelope(this.audioData, this.sampleRate);
  }

  /**
   * Estimate the cyclic period via autocorrelation. Period is the central
   * quantity for the rest of the pipeline: sets min-spacing for peak
   * detection (via 0.7·T), the burst gap threshold (via ~4·T), and the
   * template length used by the matched filter.
   */
  estimatePeriod(): TuningEstimate | null {
    if (!this.envelope || !this.audioData) throw new Error('Must calculate envelope first');
    const tuning = autotune.estimatePeriod(this.audioData, this.envelope, this.sampleRate);
    this.tuning = tuning ?? { period: 0, confidence: 0, source: 'failed' };
    return tuning;
  }

  /**
   * Detect shots via template matching. Builds a shot template from the
   * loudest seed peaks, cross-correlates it with the envelope, and accepts
   * peaks in the score signal that pass a robust adaptive threshold (or
   * the top-N if a known shot count is provided).
   *
   * If we don't have a period estimate, fall back to plain envelope-peak
   * detection.
   */
  detectShots(): { peaks: number[] } {
    if (!this.envelope) throw new Error('Must calculate envelope first');

    if (this.tuning?.period) {
      const { peaks } = autotune.detectShots(
        this.envelope,
        this.sampleRate,
        this.tuning.period,
        { knownShotCount: this.knownShotCount, shotness: this.shotness }
      );
      this.shotPeakIndices = peaks;
      this.shotTimes = peaks.map(idx => idx / this.sampleRate);
      return { peaks };
    }

    // Fallback: no usable period → conventional envelope peak detection.
    const med = signal.median(this.envelope);
    const m = signal.mad(this.envelope);
    const threshold = med + 4 * m;
    const minDistance = Math.floor(this.minShotSpacing * this.sampleRate);
    const { peaks } = signal.findPeaks(this.envelope, {
      height: threshold,
      distance: minDistance,
      prominence: this.minPeakProminence
    });
    this.shotPeakIndices = peaks;
    this.shotTimes = peaks.map(idx => idx / this.sampleRate);
    return { peaks };
  }

  /**
   * Refine each burst by amplitude coherence: real automatic-fire bursts
   * have peaks of similar intensity ("dakka"), so the burst should reduce
   * to the longest contiguous run of strong peaks. A peak is "strong" if
   * its envelope value is at least `ratio` of the burst's loudest peak.
   * One weak peak between strong ones is allowed (a missed shot or an
   * occasional duck in amplitude shouldn't split the burst); two in a row
   * does break the run.
   *
   * Cleans up the case where a real burst is preceded/followed by stray
   * onsets (handling, breathing, brass clink) that survive the matched
   * filter — they have inconsistent amplitudes and get dropped, while
   * the dakka core stays.
   */
  refineBurstsByAmplitude(options: { ratio?: number; maxSkip?: number } = {}): void {
    if (!this.envelope) return;
    const ratio = options.ratio ?? 0.30;
    const maxSkip = options.maxSkip ?? 1;
    const env = this.envelope;

    const refined: number[][] = [];
    for (const burst of this.bursts) {
      if (burst.length < this.minBurstCount) continue;

      const amps = burst.map(idx => env[this.shotPeakIndices[idx]]);
      let maxAmp = -Infinity;
      for (const a of amps) if (a > maxAmp) maxAmp = a;
      const threshold = maxAmp * ratio;
      const strong = amps.map(a => a >= threshold);

      // Find the longest run of strong indices, allowing up to maxSkip weak
      // peaks between consecutive strong ones.
      let bestStart = 0, bestEnd = -1;
      let s = 0;
      while (s < burst.length) {
        while (s < burst.length && !strong[s]) s++;
        if (s >= burst.length) break;
        let lastStrong = s;
        let e = s + 1;
        while (e < burst.length) {
          if (strong[e]) {
            lastStrong = e;
            e++;
          } else if (e - lastStrong > maxSkip) {
            break;
          } else {
            e++;
          }
        }
        if (lastStrong - s > bestEnd - bestStart) {
          bestStart = s;
          bestEnd = lastStrong;
        }
        s = lastStrong + 1;
      }

      const sliced = burst.slice(bestStart, bestEnd + 1);
      if (sliced.length >= this.minBurstCount) refined.push(sliced);
    }
    this.bursts = refined;
  }

  /**
   * Refine each burst's edges by its OWN internal cadence. A leading or
   * trailing shot whose interval to its neighbour is much longer than the
   * burst's median inter-shot interval doesn't fit the cyclic structure —
   * it's a stray click, an echo, or a brass clink, not part of the string.
   *
   * Applies only to edges. Interior gaps stay (they're missed shots, not
   * anomalies).
   */
  refineBurstsByCadence(options: { tolerance?: number } = {}): void {
    const tolerance = options.tolerance ?? 1.5;
    const minLen = Math.max(this.minBurstCount, 3);

    const refined: number[][] = [];
    for (const burst of this.bursts) {
      if (burst.length < 4) {
        refined.push(burst);
        continue;
      }

      const intervals: number[] = [];
      for (let i = 1; i < burst.length; i++) {
        intervals.push(this.shotTimes[burst[i]] - this.shotTimes[burst[i - 1]]);
      }

      let lo = 0;
      let hi = burst.length - 1;
      let lead = intervals[0];
      let tail = intervals[intervals.length - 1];

      while (hi - lo + 1 > minLen) {
        const interior = intervals.slice(1, intervals.length - 1);
        const ref = interior.length > 0 ? signal.median(interior) : signal.median(intervals);

        let trimmedAny = false;
        if (tail > tolerance * ref) {
          hi--;
          intervals.pop();
          tail = intervals[intervals.length - 1];
          trimmedAny = true;
        }
        if (hi - lo + 1 > minLen && lead > tolerance * ref) {
          lo++;
          intervals.shift();
          lead = intervals[0];
          trimmedAny = true;
        }
        if (!trimmedAny) break;
      }

      const sliced = burst.slice(lo, hi + 1);
      if (sliced.length >= this.minBurstCount) refined.push(sliced);
    }
    this.bursts = refined;
  }

  /**
   * Reject "bursts" that don't actually look like dakka. A real burst has
   * tight cadence regularity AND uniform peak intensity; spurious clusters
   * (handling, dropped brass, voices) have neither. The interval test is
   * the decisive one — automatic fire is mechanically periodic to within a
   * few percent. The amplitude test catches clusters of unrelated transients
   * that happen to land within a gap-threshold of each other.
   *
   * Both checks use median/MAD-based dispersion (not std/mean) to stay
   * robust to one or two genuinely-missed shots inside an otherwise
   * regular burst.
   */
  rejectBurstsByQuality(options: {
    maxIntervalDispersion?: number;
    maxAmpDispersion?: number;
    shortBurstAmpDispersion?: number;
    shortBurstThreshold?: number;
  } = {}): void {
    if (!this.envelope) return;
    // Tight cadence (low intervalDispersion) is the strongest evidence
    // of mechanical periodicity — automatic fire is essentially never
    // off by more than a few percent in inter-shot interval.
    //
    // Amplitude dispersion is a secondary signal; real bursts often have
    // declining or modulated amplitudes (tail-off, multi-magazine, etc.)
    // so we only use it to filter out short bursts where cadence alone
    // isn't decisive.
    const maxIntervalDispersion = options.maxIntervalDispersion ?? 0.20;
    const maxAmpDispersion = options.maxAmpDispersion ?? 0.55;
    const shortBurstAmpDispersion = options.shortBurstAmpDispersion ?? 0.30;
    const shortBurstThreshold = options.shortBurstThreshold ?? 10;
    const env = this.envelope;

    const refined: number[][] = [];
    for (const burst of this.bursts) {
      if (burst.length < this.minBurstCount) continue;
      const times = burst.map(idx => this.shotTimes[idx]);
      const amps = burst.map(idx => env[this.shotPeakIndices[idx]]);
      const intervals: number[] = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);

      const tMed = signal.median(intervals);
      const tMad = signal.mad(intervals);
      const aMed = signal.median(amps);
      const aMad = signal.mad(amps);

      const intervalDispersion = tMed > 0 ? tMad / tMed : Infinity;
      const ampDispersion = aMed > 0 ? aMad / aMed : Infinity;

      if (intervalDispersion > maxIntervalDispersion) continue;
      const ampLimit = burst.length < shortBurstThreshold
        ? shortBurstAmpDispersion : maxAmpDispersion;
      if (ampDispersion > ampLimit) continue;
      refined.push(burst);
    }
    this.bursts = refined;
  }

  /**
   * Snap each shot index to the nearest local maximum of the envelope
   * within ±15% of the period. The matched filter places peaks at
   * `score_peak_idx + template.preSamples`, which is the AVERAGE peak
   * position over the seed peaks; cadence extension places peaks at the
   * exact envelope local max. The two methods can be a few ms apart on
   * any given shot, which makes the visualization show markers landing
   * at slightly different parts of the peak shape. Snapping after both
   * paths converge gives a consistent visual.
   */
  snapShotsToEnvelopePeaks(): void {
    if (!this.envelope) return;
    const env = this.envelope;
    const T = this.tuning?.period;
    const sr = this.sampleRate;
    const tolSamples = T ? Math.max(1, Math.floor(T * 0.15 * sr)) : Math.floor(0.005 * sr);
    const isLocalMax = (i: number) =>
      i > 0 && i < env.length - 1 &&
      env[i] >= env[i - 1] && env[i] >= env[i + 1];

    for (let i = 0; i < this.shotPeakIndices.length; i++) {
      const idx = this.shotPeakIndices[i];
      const lo = Math.max(0, idx - tolSamples);
      const hi = Math.min(env.length - 1, idx + tolSamples);
      let bestIdx = idx;
      let bestVal = env[idx];
      for (let j = lo; j <= hi; j++) {
        if (isLocalMax(j) && env[j] > bestVal) {
          bestVal = env[j];
          bestIdx = j;
        }
      }
      if (bestIdx !== idx) {
        this.shotPeakIndices[i] = bestIdx;
        this.shotTimes[i] = bestIdx / sr;
      }
    }
  }

  /**
   * Walk forward/backward from each burst's edges at the expected cadence,
   * adopting the local envelope maximum if it clears a fraction of the
   * burst's median peak amplitude. Picks up the tail of a burst whose
   * shots decay below the matched-filter threshold but are still above
   * the noise floor.
   */
  extendBurstsByCadence(options: { tolerance?: number; ampFloorRatio?: number } = {}): void {
    if (!this.tuning?.period || !this.envelope) return;
    const env = this.envelope;
    const T = this.tuning.period;
    const sr = this.sampleRate;
    const tolT = options.tolerance ?? 0.30;
    const ampFloorRatio = options.ampFloorRatio ?? 0.40;
    const periodSamples = Math.max(1, Math.floor(T * sr));
    const tolSamples = Math.max(1, Math.floor(T * tolT * sr));

    // Pick the highest TRUE local maximum in [lo, hi]. argmax alone would
    // happily return monotonic points at the window edge — those aren't
    // shots, they're just where the envelope dipped less.
    const findLocalMax = (lo: number, hi: number): number => {
      lo = Math.max(1, lo);
      hi = Math.min(env.length - 2, hi);
      if (lo > hi) return -1;
      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = lo; i <= hi; i++) {
        const v = env[i];
        if (v > env[i - 1] && v > env[i + 1] && v > bestVal) {
          bestVal = v;
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    for (const burst of this.bursts) {
      if (burst.length < 2) continue;
      const amps = burst.map(idx => env[this.shotPeakIndices[idx]]);
      const medAmp = signal.median(amps);
      const ampFloor = medAmp * ampFloorRatio;

      // Forward
      let lastSampleIdx = this.shotPeakIndices[burst[burst.length - 1]];
      while (true) {
        const expected = lastSampleIdx + periodSamples;
        const idx = findLocalMax(expected - tolSamples, expected + tolSamples);
        if (idx < 0 || env[idx] < ampFloor) break;
        // Avoid duplicates if the argmax landed on a sample already detected.
        if (idx === lastSampleIdx) break;
        const newShotIdx = this.shotPeakIndices.length;
        this.shotPeakIndices.push(idx);
        this.shotTimes.push(idx / sr);
        burst.push(newShotIdx);
        lastSampleIdx = idx;
      }

      // Backward
      lastSampleIdx = this.shotPeakIndices[burst[0]];
      while (true) {
        const expected = lastSampleIdx - periodSamples;
        const idx = findLocalMax(expected - tolSamples, expected + tolSamples);
        if (idx < 0 || env[idx] < ampFloor) break;
        if (idx === lastSampleIdx) break;
        const newShotIdx = this.shotPeakIndices.length;
        this.shotPeakIndices.push(idx);
        this.shotTimes.push(idx / sr);
        burst.unshift(newShotIdx);
        lastSampleIdx = idx;
      }
    }
  }

  /**
   * Merge bursts whose sample ranges overlap. Each burst is walked
   * independently in extendBurstsByCadence, so two neighbours can extend
   * toward each other and end up emitting separate shotPeakIndices entries
   * for the same envelope peaks — one burst per chain, both covering the
   * same window. The global peaks list dedupes via Set, but the per-burst
   * objects don't, leaving duplicate cards in the UI.
   *
   * Strategy: sort each burst's indices by sample idx, sort bursts by
   * first sample, then merge any pair whose ranges overlap, deduping
   * within the merged burst by envelope sample idx.
   */
  mergeOverlappingBursts(): void {
    if (this.bursts.length < 2) return;

    const sortedBursts = this.bursts.map(b => {
      const sorted = b.slice().sort((a, c) => this.shotPeakIndices[a] - this.shotPeakIndices[c]);
      return {
        burst: sorted,
        startSample: this.shotPeakIndices[sorted[0]],
        endSample: this.shotPeakIndices[sorted[sorted.length - 1]]
      };
    });
    sortedBursts.sort((a, b) => a.startSample - b.startSample);

    const merged = [sortedBursts[0]];
    for (let i = 1; i < sortedBursts.length; i++) {
      const cur = sortedBursts[i];
      const last = merged[merged.length - 1];
      if (cur.startSample <= last.endSample) {
        const seen = new Set(last.burst.map(idx => this.shotPeakIndices[idx]));
        for (const idx of cur.burst) {
          const samp = this.shotPeakIndices[idx];
          if (!seen.has(samp)) {
            last.burst.push(idx);
            seen.add(samp);
          }
        }
        last.burst.sort((a, b) => this.shotPeakIndices[a] - this.shotPeakIndices[b]);
        last.endSample = this.shotPeakIndices[last.burst[last.burst.length - 1]];
      } else {
        merged.push(cur);
      }
    }
    this.bursts = merged.map(m => m.burst);
  }

  /**
   * Empirical cyclic period: median of pooled inter-shot intervals across
   * all (post-trim) bursts. The most direct measurement of the cycle and
   * can be used to refine the ACF estimate.
   */
  empiricalPeriod(): number | null {
    const all = this._pooledIntervals();
    return all.length >= 4 ? signal.median(all) : null;
  }

  private _pooledIntervals(): number[] {
    const all: number[] = [];
    for (const burst of this.bursts) {
      for (let i = 1; i < burst.length; i++) {
        all.push(this.shotTimes[burst[i]] - this.shotTimes[burst[i - 1]]);
      }
    }
    return all;
  }

  /**
   * Group shots into bursts by gap. With a period estimate the gap
   * threshold becomes ~4·T (auto-tuned), so this step is just a clean
   * "where does the cadence pause?" rather than a heuristic patch over
   * detection noise — that's the matched filter's job.
   */
  groupIntoBursts(): void {
    this.bursts = [];
    if (this.shotTimes.length === 0) return;

    const gapThreshold = this.tuning?.period
      ? Math.max(0.1, this.tuning.period * 4)
      : this.burstGapThreshold;

    let currentBurst = [0];
    for (let i = 1; i < this.shotTimes.length; i++) {
      const gap = this.shotTimes[i] - this.shotTimes[i - 1];
      if (gap <= gapThreshold) {
        currentBurst.push(i);
      } else {
        if (currentBurst.length >= this.minBurstCount) this.bursts.push(currentBurst);
        currentBurst = [i];
      }
    }
    if (currentBurst.length >= this.minBurstCount) this.bursts.push(currentBurst);
  }

  calculateRates(): BurstResult[] {
    const results: BurstResult[] = [];

    for (let burstIdx = 0; burstIdx < this.bursts.length; burstIdx++) {
      const burst = this.bursts[burstIdx];
      const times = burst.map(idx => this.shotTimes[idx]);

      const startTime = times[0];
      const endTime = times[times.length - 1];
      const duration = endTime - startTime;
      const numShots = times.length;
      const rateRpm = duration > 0 ? ((numShots - 1) / duration) * 60 : 0;

      const intervals = signal.diff(times);

      const meanInt = signal.mean(intervals);
      const stdInt = signal.std(intervals);
      // Approximate 95% CI on the rate via std of the mean inter-shot interval.
      // SE on the period mean = std / sqrt(n_intervals); rate uncertainty
      // dRPM = 60 / period^2 * dPeriod.
      const nIntervals = intervals.length;
      const periodSE = nIntervals > 1 ? stdInt / Math.sqrt(nIntervals) : 0;
      const ciHalfWidth = meanInt > 0 ? 1.96 * 60 * periodSE / (meanInt * meanInt) : 0;

      results.push({
        burstNumber: burstIdx + 1,
        startTime,
        endTime,
        duration,
        numShots,
        rateRpm,
        rateRpmCI95: ciHalfWidth,
        meanInterval: meanInt,
        stdInterval: stdInt,
        minInterval: signal.min(intervals),
        maxInterval: signal.max(intervals),
        shotTimes: times
      });
    }

    return results;
  }

  generateSummary(burstResults: BurstResult[]): AnalysisSummary {
    if (!burstResults || burstResults.length === 0) {
      return {
        totalShots: 0,
        totalBursts: 0,
        cyclicRateRpm: 0,
        cyclicRateCI95: 0,
        overallRateRpm: 0,
        meanBurstRateRpm: 0,
        medianBurstRateRpm: 0,
        minBurstRateRpm: 0,
        maxBurstRateRpm: 0,
        stdBurstRateRpm: 0
      };
    }

    const rates = burstResults.map(b => b.rateRpm);
    const totalShots = burstResults.reduce((sum, b) => sum + b.numShots, 0);

    // Pool all within-burst inter-shot intervals. The median of these is the
    // best headline cyclic rate: robust to outliers and unaffected by pauses
    // between bursts.
    const allIntervals: number[] = [];
    for (const burst of burstResults) {
      const ivs = signal.diff(burst.shotTimes);
      for (let i = 0; i < ivs.length; i++) allIntervals.push(ivs[i]);
    }
    const medianInterval = allIntervals.length > 0 ? signal.median(allIntervals) : 0;
    const cyclicRateRpm = medianInterval > 0 ? 60 / medianInterval : 0;

    // Two-level CI on the cyclic rate. Inter-shot intervals within one
    // burst are NOT independent samples of the gun's period — they
    // share a per-burst mean (mechanical state, gas, temperature, the
    // particular magazine), and that mean varies between bursts. Pooling
    // every interval as i.i.d. understates uncertainty, sometimes by an
    // order of magnitude.
    //
    // Standard fix: when ≥2 bursts exist, treat each burst's median
    // interval as one trial estimate of the cycle period, and use the
    // between-burst SE. With one burst, fall back to the within-burst SE
    // since that's the only source of variation observable.
    const intervalStd = allIntervals.length > 1 ? signal.std(allIntervals) : 0;
    let cyclicRateCI95 = 0;
    if (medianInterval > 0) {
      const burstMedians: number[] = [];
      for (const b of burstResults) {
        if (b.shotTimes.length < 2) continue;
        const ivs = signal.diff(b.shotTimes);
        burstMedians.push(signal.median(ivs));
      }
      let seT = 0;
      if (burstMedians.length >= 2) {
        const meanBurstT = signal.mean(burstMedians);
        let ss = 0;
        for (const t of burstMedians) {
          const d = t - meanBurstT;
          ss += d * d;
        }
        const sdBetween = Math.sqrt(ss / (burstMedians.length - 1));
        seT = sdBetween / Math.sqrt(burstMedians.length);
      } else if (allIntervals.length > 1) {
        seT = intervalStd / Math.sqrt(allIntervals.length);
      }
      cyclicRateCI95 = 1.96 * 60 * seT / (medianInterval * medianInterval);
    }

    const allShotTimes: number[] = [];
    for (const burst of burstResults) allShotTimes.push(...burst.shotTimes);

    let overallRate = 0;
    if (allShotTimes.length >= 2) {
      const totalDuration = signal.max(allShotTimes) - signal.min(allShotTimes);
      overallRate = ((allShotTimes.length - 1) / totalDuration) * 60;
    }

    return {
      totalShots,
      totalBursts: burstResults.length,
      cyclicRateRpm,
      cyclicRateCI95,
      overallRateRpm: overallRate,
      meanBurstRateRpm: signal.mean(rates),
      medianBurstRateRpm: signal.median(rates),
      minBurstRateRpm: signal.min(rates),
      maxBurstRateRpm: signal.max(rates),
      stdBurstRateRpm: signal.std(rates),
      medianIntervalMs: medianInterval * 1000,
      intervalStdMs: intervalStd * 1000
    };
  }

  /**
   * Pure analysis pipeline. Assumes audio has already been loaded via
   * setAudio().
   */
  runAnalysis(onProgress?: ProgressCallback): AnalysisResult {
    if (!this.audioData) throw new Error('Must call setAudio first');
    onProgress?.('Calculating envelope...');
    this.calculateEnvelope();

    if (this.autoTune) {
      onProgress?.('Estimating firing period...');
      this.estimatePeriod();
    } else {
      this.tuning = null;
    }

    onProgress?.('Matching shot template...');
    this.detectShots();

    onProgress?.('Grouping bursts...');
    this.groupIntoBursts();
    this.refineBurstsByAmplitude();
    this.refineBurstsByCadence();
    this.rejectBurstsByQuality();

    // Refine the period using burst-internal regularity. Two checks, in
    // order of decisiveness:
    //   1. Doublet pattern — intervals bimodal with sum ≈ T. Means each
    //      shot was registering as two peaks (blast/crack arrival pair,
    //      blast/early-reflection pair, etc.); real T is the sum.
    //   2. Empirical drift — pooled inter-shot median differs from ACF by
    //      more than 7%. The median is a direct measurement of the cycle;
    //      defer to it.
    // After either, redo detection so the new period drives min-spacing
    // and burst grouping.
    if (this.autoTune && this.tuning?.period && this.bursts.length > 0) {
      const allIntervals = this._pooledIntervals();
      let refinedPeriod: number | null = null;
      let refinedSource: string | null = null;

      const doublet = autotune.detectIntervalDoublet(allIntervals, this.tuning.period);
      if (doublet) {
        refinedPeriod = doublet.period;
        refinedSource = '+doublet';
      } else {
        // Only defer to empirical when ACF and empirical disagree
        // substantially. Within ~7% they're indistinguishable noise; below
        // that, the ACF is generally better behaved (smoother estimator
        // over the whole signal vs. median over a finite sample).
        const empirical = this.empiricalPeriod();
        if (empirical && Math.abs(empirical - this.tuning.period) / this.tuning.period > 0.07) {
          refinedPeriod = empirical;
          refinedSource = '+cadence-refined';
        }
      }

      if (refinedPeriod) {
        this.tuning.period = refinedPeriod;
        this.tuning.source = (this.tuning.source ?? '') + refinedSource;
        onProgress?.('Refining period…');
        this.detectShots();
        this.groupIntoBursts();
        this.refineBurstsByAmplitude();
        this.refineBurstsByCadence();
      }
    }

    onProgress?.('Extending bursts at expected cadence…');
    this.extendBurstsByCadence();
    this.snapShotsToEnvelopePeaks();
    // Adjacent bursts can extend toward each other and produce parallel chains
    // covering the same window — collapse those before reporting.
    this.mergeOverlappingBursts();

    // Final shot list = union of peaks across surviving bursts (post-refine,
    // post-extend), in time order. The raw detector output included shots
    // that were later trimmed and missed shots later recovered by extension.
    const finalPeakSet = new Set<number>();
    for (const burst of this.bursts) for (const idx of burst) finalPeakSet.add(this.shotPeakIndices[idx]);
    const peaks = Array.from(finalPeakSet).sort((a, b) => a - b);

    const bursts = this.calculateRates();
    const summary = this.generateSummary(bursts);

    return {
      audioDuration: this.audioData.length / this.sampleRate,
      sampleRate: this.sampleRate,
      parameters: {
        minShotSpacing: this.minShotSpacing,
        burstGapThreshold: this.burstGapThreshold,
        windowSize: this.windowSize,
        minPeakProminence: this.minPeakProminence,
        minBurstCount: this.minBurstCount,
        autoTune: this.autoTune,
        knownShotCount: this.knownShotCount,
        includeRegions: this.includeRegions
      },
      tuning: this.tuning,
      summary,
      bursts,
      peaks
    };
  }
}

/**
 * Restrict analysis to the given regions by zeroing samples OUTSIDE them.
 * Empty regions array = pass through (analyze whole clip). Returns a new
 * array; original is unchanged.
 */
function applyInclusion(
  audioData: Float32Array,
  sampleRate: number,
  regions: AnalysisRegion[]
): Float32Array {
  if (!regions || regions.length === 0) return audioData;
  const out = new Float32Array(audioData.length);
  for (const region of regions) {
    const startIdx = Math.max(0, Math.floor(region.start * sampleRate));
    const endIdx = Math.min(out.length, Math.ceil(region.end * sampleRate));
    for (let i = startIdx; i < endIdx; i++) out[i] = audioData[i];
  }
  return out;
}
