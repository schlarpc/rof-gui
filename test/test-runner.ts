/**
 * Node-side validation harness.
 *
 * Decodes test-corpus/**\/*.flac via the ffmpeg CLI to mono f32 PCM, then runs
 * the detector and compares the result against the RPM encoded in each
 * filename (e.g. `1lzajpw_458rpm.flac` → 458 RPM ground truth).
 *
 * Usage:
 *   tsx test/test-runner.ts [--corpus=test|validation|all] [filter]
 *   tsx test/test-runner.ts --json out.json     # save run results
 *   tsx test/test-runner.ts --baseline base.json   # compare vs saved
 *   tsx test/test-runner.ts --gate-mean=5       # exit nonzero if mean err > 5%
 */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RateOfFireDetector } from '../src/rof-detector.js';
import type { DetectorParams, AnalysisResult } from '../src/rof-detector.js';
import type { TuningEstimate } from '../src/auto-tune.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CORPUS_DIR = join(REPO_ROOT, 'test-corpus');

const SAMPLE_RATE = 48000;

function decodeFlac(path: string): Float32Array {
  const tmp = mkdtempSync(join(tmpdir(), 'rof-'));
  const pcmPath = join(tmp, 'audio.pcm');
  try {
    const result = spawnSync('ffmpeg', [
      '-loglevel', 'error',
      '-i', path,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-y', pcmPath
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed for ${path}: status ${result.status}`);
    }
    const buf = readFileSync(pcmPath);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseGroundTruth(filename: string): number | null {
  // Accept `1lzajpw_458rpm.flac` (rpm suffix), `1xyz_900rpm_5rds.flac`
  // (also has known round count), and the legacy `_<rpm>.<ext>.flac` form.
  const m = basename(filename).match(/_(\d+)rpm(?:_\d+rds)?\.[^/]*$/);
  if (m) return parseInt(m[1], 10);
  const legacy = basename(filename).match(/_(\d+)\.[^/]*$/);
  return legacy ? parseInt(legacy[1], 10) : null;
}

interface RunResult {
  path: string;
  truth: number | null;
  measured: number;
  meanBurst: number;
  cyclic: number;
  cyclicCI: number;
  bursts: number;
  shots: number;
  duration: number;
  tuning: string;
  rawTuning: TuningEstimate | null;
}

function runOne(path: string, options: Partial<DetectorParams> = {}): RunResult {
  const truth = parseGroundTruth(path);
  const audio = decodeFlac(path);

  const detector = new RateOfFireDetector({ autoTune: true, ...options });
  detector.setAudio(audio, SAMPLE_RATE);
  const result: AnalysisResult = detector.runAnalysis();

  const measured = result.summary.overallRateRpm;
  const meanBurst = result.summary.meanBurstRateRpm;
  const cyclic = result.summary.cyclicRateRpm;
  const cyclicCI = result.summary.cyclicRateCI95;

  const tuning = result.tuning;
  const tuningStr = tuning && tuning.period
    ? `period=${(tuning.period * 1000).toFixed(2)}ms (${(60 / tuning.period).toFixed(1)} RPM, conf=${tuning.confidence.toFixed(2)}, src=${tuning.source ?? 'n/a'})`
    : 'no tuning';

  return {
    path,
    truth,
    measured,
    meanBurst,
    cyclic,
    cyclicCI,
    bursts: result.summary.totalBursts,
    shots: result.summary.totalShots,
    duration: result.audioDuration,
    tuning: tuningStr,
    rawTuning: tuning
  };
}

function collectFiles(dir: string, filterArg: string | null): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectFiles(p, filterArg));
    } else if (e.name.endsWith('.flac') && (!filterArg || e.name.includes(filterArg))) {
      out.push(p);
    }
  }
  return out;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function tunedRpmOf(r: RunResult): number | null {
  return r.rawTuning?.period ? 60 / r.rawTuning.period : null;
}

type Metric = 'tuned' | 'cyclic' | 'meanBurst' | 'overall';

function metricValue(r: RunResult, metric: Metric): number | null {
  if (metric === 'tuned') return tunedRpmOf(r);
  if (metric === 'cyclic') return r.cyclic;
  if (metric === 'meanBurst') return r.meanBurst;
  if (metric === 'overall') return r.measured;
  return null;
}

interface Aggregate {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  max: number;
  within3: number;
}

function aggregate(results: RunResult[], metric: Metric): Aggregate | null {
  const errs: number[] = [];
  for (const r of results) {
    if (r.truth == null) continue;
    const v = metricValue(r, metric);
    if (v == null || !Number.isFinite(v)) continue;
    errs.push(Math.abs((v - r.truth) / r.truth) * 100);
  }
  if (errs.length === 0) return null;
  return {
    n: errs.length,
    mean: errs.reduce((a, b) => a + b, 0) / errs.length,
    p50: percentile(errs, 0.5),
    p90: percentile(errs, 0.9),
    max: Math.max(...errs),
    within3: errs.filter(e => e <= 3).length
  };
}

interface BaselineRecord {
  file: string;
  truth: number | null;
  tuned: number | null;
  cyclic: number;
  meanBurst: number;
  overall: number;
  cyclicCI: number;
  bursts: number;
  shots: number;
  duration: number;
  tuningSource: string | null;
  tuningConfidence: number | null;
}

interface Baseline {
  corpus: string;
  aggregates: Partial<Record<Metric, Aggregate>>;
  results: BaselineRecord[];
}

function main(): void {
  // Args: [--corpus=<test|validation|all>] [--json=path] [--baseline=path]
  //       [--gate-mean=<pct>] [--gate-p90=<pct>] [filter-substring]
  const args = process.argv.slice(2);
  let corpus = 'validation';
  let filterArg: string | null = null;
  let jsonOut: string | null = null;
  let baselinePath: string | null = null;
  let gateMean: number | null = null;
  let gateP90: number | null = null;
  for (const a of args) {
    if (a.startsWith('--corpus=')) corpus = a.slice('--corpus='.length);
    else if (a.startsWith('--json=')) jsonOut = a.slice('--json='.length);
    else if (a.startsWith('--baseline=')) baselinePath = a.slice('--baseline='.length);
    else if (a.startsWith('--gate-mean=')) gateMean = parseFloat(a.slice('--gate-mean='.length));
    else if (a.startsWith('--gate-p90=')) gateP90 = parseFloat(a.slice('--gate-p90='.length));
    else if (!a.startsWith('--')) filterArg = a;
  }

  const dirs: string[] = [];
  if (corpus === 'validation') dirs.push(join(CORPUS_DIR, 'validation'));
  else if (corpus === 'test') dirs.push(join(CORPUS_DIR, 'test'));
  else if (corpus === 'all') dirs.push(join(CORPUS_DIR, 'validation'), join(CORPUS_DIR, 'test'));
  else dirs.push(corpus); // raw path

  const files = dirs.flatMap(d => collectFiles(d, filterArg)).sort();

  if (files.length === 0) {
    console.error(`No .flac files found in ${dirs.join(', ')}`);
    process.exit(1);
  }

  console.log(`=== ROF Detector Validation (${files.length} files) ===\n`);

  const verbose = files.length <= 12;
  const results: RunResult[] = [];
  for (const file of files) {
    try {
      const r = runOne(file);
      results.push(r);
      const tunedRpm = r.rawTuning && r.rawTuning.period ? 60 / r.rawTuning.period : null;
      if (verbose) {
        console.log(`${basename(file)}`);
        console.log(`  truth=${r.truth} RPM   tuned=${tunedRpm ? tunedRpm.toFixed(1) : 'n/a'} RPM (conf=${r.rawTuning?.confidence?.toFixed(2)}, src=${r.rawTuning?.source})`);
        console.log(`  cyclic=${r.cyclic.toFixed(1)}±${r.cyclicCI.toFixed(1)} RPM   meanBurst=${r.meanBurst.toFixed(1)}   overall=${r.measured.toFixed(1)}`);
        console.log(`  shots=${r.shots}  bursts=${r.bursts}  duration=${r.duration.toFixed(2)}s\n`);
      } else {
        const best = r.meanBurst;
        const d = r.truth ? best - r.truth : null;
        const pct = r.truth && d != null ? (d / r.truth) * 100 : null;
        const flag = pct == null ? ' ' : Math.abs(pct) <= 3 ? '✓' : Math.abs(pct) <= 10 ? '~' : '✗';
        const tunedStr = tunedRpm ? tunedRpm.toFixed(0).padStart(5) : '   --';
        console.log(`${flag} ${basename(file).padEnd(30)} truth=${String(r.truth ?? '?').padStart(5)} tuned=${tunedStr} mean=${best.toFixed(0).padStart(5)} Δ=${pct == null ? ' ?' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'}  bursts=${r.bursts} shots=${r.shots}`);
      }
    } catch (err) {
      console.log(`${basename(file)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const withTruth = results.filter(r => r.truth != null);
  const aggregates: Partial<Record<Metric, Aggregate>> = {};
  if (withTruth.length > 0) {
    console.log('--- Summary ---');
    const metrics: Metric[] = ['tuned', 'cyclic', 'meanBurst', 'overall'];
    for (const metric of metrics) {
      const agg = aggregate(withTruth, metric);
      if (!agg) continue;
      aggregates[metric] = agg;
      console.log(`${metric.padEnd(12)} mean=${agg.mean.toFixed(2)}%  p50=${agg.p50.toFixed(2)}%  p90=${agg.p90.toFixed(2)}%  max=${agg.max.toFixed(2)}%  within3%: ${agg.within3}/${agg.n}`);
    }
  }

  if (jsonOut) {
    const records: BaselineRecord[] = results.map(r => ({
      file: basename(r.path),
      truth: r.truth,
      tuned: tunedRpmOf(r),
      cyclic: r.cyclic,
      meanBurst: r.meanBurst,
      overall: r.measured,
      cyclicCI: r.cyclicCI,
      bursts: r.bursts,
      shots: r.shots,
      duration: r.duration,
      tuningSource: r.rawTuning?.source ?? null,
      tuningConfidence: r.rawTuning?.confidence ?? null
    }));
    writeFileSync(jsonOut, JSON.stringify({ corpus, aggregates, results: records }, null, 2));
    console.log(`\nWrote ${records.length} records to ${jsonOut}`);
  }

  let regressed = false;
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    const byFile = new Map(baseline.results.map(r => [r.file, r]));
    console.log(`\n--- Baseline diff vs ${baselinePath} ---`);
    interface Move {
      name: string;
      prevErr: number;
      curErr: number;
      delta: number;
    }
    const moved: Move[] = [];
    for (const r of withTruth) {
      const name = basename(r.path);
      const prev = byFile.get(name);
      if (!prev || prev.truth == null) continue;
      const cur = tunedRpmOf(r);
      if (cur == null || prev.tuned == null) continue;
      const curErr = Math.abs((cur - r.truth!) / r.truth!) * 100;
      const prevErr = Math.abs((prev.tuned - prev.truth) / prev.truth) * 100;
      const delta = curErr - prevErr;
      if (Math.abs(delta) >= 0.5) moved.push({ name, prevErr, curErr, delta });
    }
    moved.sort((a, b) => b.delta - a.delta);
    const worse = moved.filter(m => m.delta > 0);
    const better = moved.filter(m => m.delta < 0);
    if (worse.length) {
      console.log(`\nRegressed (${worse.length}):`);
      for (const m of worse.slice(0, 20)) console.log(`  +${m.delta.toFixed(2)}%  ${m.name.padEnd(30)} ${m.prevErr.toFixed(2)}% → ${m.curErr.toFixed(2)}%`);
    }
    if (better.length) {
      console.log(`\nImproved (${better.length}):`);
      for (const m of better.slice(-20).reverse()) console.log(`  ${m.delta.toFixed(2)}%  ${m.name.padEnd(30)} ${m.prevErr.toFixed(2)}% → ${m.curErr.toFixed(2)}%`);
    }
    if (baseline.aggregates && aggregates.tuned && baseline.aggregates.tuned) {
      console.log('\nAggregate (tuned):');
      const a = aggregates.tuned, b = baseline.aggregates.tuned;
      const fmtDelta = (cur: number, prev: number): string => {
        const d = cur - prev;
        const sign = d >= 0 ? '+' : '';
        return `${prev.toFixed(2)} → ${cur.toFixed(2)} (${sign}${d.toFixed(2)})`;
      };
      console.log(`  mean    ${fmtDelta(a.mean, b.mean)}`);
      console.log(`  p50     ${fmtDelta(a.p50, b.p50)}`);
      console.log(`  p90     ${fmtDelta(a.p90, b.p90)}`);
      console.log(`  max     ${fmtDelta(a.max, b.max)}`);
      console.log(`  within3 ${b.within3}/${b.n} → ${a.within3}/${a.n}`);
    }
  }

  if (gateMean != null && aggregates.tuned && aggregates.tuned.mean > gateMean) {
    console.error(`\nFAIL: tuned mean error ${aggregates.tuned.mean.toFixed(2)}% > gate ${gateMean}%`);
    regressed = true;
  }
  if (gateP90 != null && aggregates.tuned && aggregates.tuned.p90 > gateP90) {
    console.error(`\nFAIL: tuned p90 error ${aggregates.tuned.p90.toFixed(2)}% > gate ${gateP90}%`);
    regressed = true;
  }
  if (regressed) process.exit(1);
}

main();
