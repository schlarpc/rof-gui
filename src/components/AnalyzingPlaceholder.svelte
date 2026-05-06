<script lang="ts">
  interface Props {
    text: string;
  }
  const { text }: Props = $props();
</script>

<div class="card">
  <div class="bars">
    <span></span><span></span><span></span><span></span>
  </div>
  <div class="text">{text}</div>
  <div class="hint">your audio never leaves the browser</div>
</div>

<style>
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 80px 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    min-height: 320px;
    justify-content: center;
  }

  .bars {
    display: flex;
    gap: 5px;
    height: 32px;
    align-items: flex-end;
  }

  .bars span {
    display: block;
    width: 6px;
    background: var(--accent);
    border-radius: 2px;
    animation: bar 0.9s ease-in-out infinite;
  }

  .bars span:nth-child(1) { animation-delay: 0s; }
  .bars span:nth-child(2) { animation-delay: 0.12s; }
  .bars span:nth-child(3) { animation-delay: 0.24s; }
  .bars span:nth-child(4) { animation-delay: 0.36s; }

  @keyframes bar {
    0%, 100% { height: 6px; }
    50%      { height: 32px; }
  }

  .text {
    font-size: 15px;
    color: var(--text);
    font-weight: 500;
    margin-top: 4px;
  }

  .hint {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
