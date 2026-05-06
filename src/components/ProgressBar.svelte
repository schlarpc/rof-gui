<script lang="ts">
  interface Props {
    text?: string;
  }
  const { text }: Props = $props();
</script>

<div class="bar-wrap" role="status" aria-live="polite">
  <div class="bar"><div class="bar-stripe"></div></div>
  {#if text}
    <div class="text">{text}</div>
  {/if}
</div>

<style>
  .bar-wrap {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 60;
    pointer-events: none;
  }

  .bar {
    height: 3px;
    background: var(--accent-bg);
    overflow: hidden;
  }

  .bar-stripe {
    width: 30%;
    height: 100%;
    background: var(--accent);
    animation: slide 1.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  }

  .text {
    position: absolute;
    top: 12px;
    right: 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--text-secondary);
    box-shadow: var(--shadow-sm);
  }

  @keyframes slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(450%); }
  }
</style>
