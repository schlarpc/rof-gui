<script lang="ts">
  import { app, reset, handleFile } from './state.svelte.js';
  import DropZone from './components/DropZone.svelte';
  import HeroResult from './components/HeroResult.svelte';
  import Timeline from './components/Timeline.svelte';
  import BurstStrip from './components/BurstStrip.svelte';
  import ProgressBar from './components/ProgressBar.svelte';
  import AnalyzingPlaceholder from './components/AnalyzingPlaceholder.svelte';

  const TAGLINES = [
    'cyclic rate analyzer',
    'dakka counter',
    'brass throughput measurement',
    'lead delivery gauge',
    'rate of fire meter'
  ];
  const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

  let dragDepth = 0;
  let dragActive = $state(false);

  function hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  function onWindowDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    dragDepth++;
    dragActive = true;
  }

  function onWindowDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onWindowDragLeave(e: DragEvent) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragActive = false;
  }

  function onWindowDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragActive = false;
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  }

  function onWindowPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const type = file.type || '';
      if (type.startsWith('video/') || type.startsWith('audio/')) {
        e.preventDefault();
        handleFile(file);
        return;
      }
    }
  }
</script>

<svelte:window
  ondragenter={onWindowDragEnter}
  ondragover={onWindowDragOver}
  ondragleave={onWindowDragLeave}
  ondrop={onWindowDrop}
  onpaste={onWindowPaste}
/>

<div class="page">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark">ROF GUI</span>
      <span class="brand-sub">{tagline}</span>
    </div>
    {#if app.results}
      <div class="topbar-meta">
        <span class="filename">{app.results.inputFile}</span>
        <button class="ghost" onclick={reset}>New file</button>
      </div>
    {/if}
  </header>

  <main class="content">
    {#if !app.file}
      <DropZone />
    {:else if !app.results}
      <AnalyzingPlaceholder text={app.loadingText || 'Analyzing…'} />
    {:else}
      <HeroResult results={app.results} />
      <Timeline />
      <BurstStrip results={app.results} />
    {/if}

    {#if app.error}
      <div class="error">{app.error}</div>
    {/if}
  </main>

  {#if app.loading && app.results}
    <ProgressBar text={app.loadingText} />
  {/if}

  <footer class="footer">
    <div>
      open source:
      <a href="https://github.com/schlarpc/rof-gui" target="_blank" rel="noopener noreferrer">
        schlarpc/rof-gui
      </a>
    </div>
    <div>
      nfa trustee?
      <a href="https://schlarpc.github.io/atf-5320.23-generator/" target="_blank" rel="noopener noreferrer">
        5320.23 generator
      </a>
    </div>
  </footer>
</div>

{#if dragActive && app.file}
  <div class="drop-overlay">
    <div class="drop-overlay-inner">
      <div class="drop-overlay-icon">+</div>
      <div class="drop-overlay-text">Drop to analyze</div>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 32px 24px 64px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 100vh;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .brand-mark {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 22px;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .brand-sub {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-tertiary);
  }

  .topbar-meta {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .filename {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-secondary);
  }

  button.ghost {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: var(--radius);
    transition: all 0.12s;
  }

  button.ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .error {
    padding: 12px 16px;
    background: #FCEDED;
    border: 1px solid #F0C4C4;
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
  }

  .footer {
    margin-top: auto;
    padding-top: 24px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-tertiary);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .footer a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted var(--text-tertiary);
  }
  .footer a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: var(--accent-bg);
    border: 4px dashed var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .drop-overlay-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    color: var(--accent);
  }

  .drop-overlay-icon {
    width: 88px;
    height: 88px;
    border: 3px solid var(--accent);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 48px;
    font-weight: 300;
  }

  .drop-overlay-text {
    font-size: 22px;
    font-weight: 500;
  }
</style>
