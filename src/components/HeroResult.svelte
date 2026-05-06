<script lang="ts">
  import { downloadCard, downloadJson } from '../exports.js';
  import type { AnalysisResult } from '../rof-detector.js';

  interface Props {
    results: AnalysisResult;
  }
  const { results }: Props = $props();

  const summary = $derived(results.summary);

  // Headline = mean per-burst rate (validated ~7% mean error on test vectors).
  // Falls back to median-interval rate if no bursts grouped.
  const headlineRpm = $derived(
    summary.totalBursts > 0 ? summary.meanBurstRateRpm : summary.cyclicRateRpm
  );
  const ci95 = $derived(summary.cyclicRateCI95 || 0);
  // Use the canonical period the result card shows (median of pooled
  // inter-shot intervals). Inverting the headline RPM gives a different
  // number because the headline is per-burst-mean, not pooled-median.
  const periodMs = $derived(summary.medianIntervalMs || 0);
  const jitterMs = $derived(summary.intervalStdMs || 0);

  function fmt(n: number, d = 0): string {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(d);
  }

  function onCard() { downloadCard(results, headlineRpm, ci95); }
  function onJson() { downloadJson(results); }
</script>

<section class="hero">
  <div class="hero-actions">
    <button class="action" onclick={onCard} title="Save shareable PNG">Save result</button>
    <button class="action" onclick={onJson} title="Download raw analysis JSON">Raw data</button>
  </div>

  <div class="headline">
    <div class="rpm-row">
      <span class="rpm-value">{fmt(headlineRpm)}</span>
      <div class="rpm-unit">
        <div class="unit-main">RPM</div>
        {#if ci95 > 0}
          <div class="unit-sub">±{fmt(ci95, 1)} 95% CI</div>
        {/if}
      </div>
    </div>
  </div>

  <div class="stat-grid">
    <div class="stat">
      <div class="stat-label">Period</div>
      <div class="stat-value">{fmt(periodMs, 1)}<span class="stat-unit">ms</span></div>
    </div>
    <div class="stat">
      <div class="stat-label">Shots</div>
      <div class="stat-value">{summary.totalShots}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Jitter</div>
      <div class="stat-value">{fmt(jitterMs, 1)}<span class="stat-unit">ms</span></div>
    </div>
    <div class="stat">
      <div class="stat-label">Bursts</div>
      <div class="stat-value">{summary.totalBursts}</div>
    </div>
  </div>
</section>

<style>
  .hero {
    position: relative;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 28px 0 0;
    display: flex;
    flex-direction: column;
  }

  .hero-actions {
    position: absolute;
    top: 14px;
    right: 14px;
    display: flex;
    gap: 6px;
    z-index: 1;
  }
  .action {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    padding: 5px 10px;
    border-radius: var(--radius);
    font-size: 12px;
    transition: all 0.12s;
  }
  .action:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .headline {
    padding: 0 32px 28px;
  }

  .rpm-row {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }

  .rpm-value {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 96px;
    line-height: 0.9;
    letter-spacing: -0.04em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .rpm-unit {
    display: flex;
    flex-direction: column;
  }

  .unit-main {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 18px;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }

  .unit-sub {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid var(--border);
  }

  .stat {
    padding: 16px 24px 18px;
    border-right: 1px solid var(--border);
  }
  .stat:last-child { border-right: none; }

  .stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-tertiary);
    margin-bottom: 6px;
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .stat-unit {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-left: 4px;
    font-weight: 400;
  }

  @media (max-width: 720px) {
    .rpm-value { font-size: 64px; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .stat { border-right: none; }
    .stat:nth-child(odd) { border-right: 1px solid var(--border); }
    .stat:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  }
</style>
