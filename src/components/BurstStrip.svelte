<script lang="ts">
  import type { AnalysisResult } from '../rof-detector.js';

  interface Props {
    results: AnalysisResult;
  }
  const { results }: Props = $props();

  const bursts = $derived(results.bursts || []);

  function fmt(n: number, d = 1): string {
    return Number.isFinite(n) ? n.toFixed(d) : '—';
  }
</script>

{#if bursts.length > 0}
  <section class="strip">
    <div class="strip-header">
      <h3>Per burst</h3>
      <span class="count">{bursts.length} burst{bursts.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="cards">
      {#each bursts as b}
        <div class="card">
          <div class="card-id">#{b.burstNumber}</div>
          <div class="card-rpm">
            {Math.round(b.rateRpm)}
            <span class="card-rpm-unit">RPM</span>
          </div>
          {#if b.rateRpmCI95 > 0}
            <div class="card-ci">±{fmt(b.rateRpmCI95)}</div>
          {/if}
          <div class="card-row">
            <span class="card-label">shots</span>
            <span class="card-val">{b.numShots}</span>
          </div>
          <div class="card-row">
            <span class="card-label">window</span>
            <span class="card-val">{fmt(b.startTime, 2)}–{fmt(b.endTime, 2)}s</span>
          </div>
          <div class="card-row">
            <span class="card-label">interval</span>
            <span class="card-val">{fmt(b.meanInterval * 1000)} ms</span>
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .strip {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 18px 20px 20px;
  }

  .strip-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .strip-header h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }

  .count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.12s;
  }

  .card:hover {
    border-color: var(--accent);
  }

  .card-id {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-tertiary);
    letter-spacing: 0.04em;
  }

  .card-rpm {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 700;
    color: var(--text);
    line-height: 1;
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }

  .card-rpm-unit {
    font-size: 12px;
    color: var(--text-tertiary);
    font-weight: 500;
    margin-left: 4px;
  }

  .card-ci {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: -2px;
  }

  .card-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    margin-top: 2px;
  }

  .card-label {
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
  }

  .card-val {
    font-family: var(--font-mono);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
</style>
