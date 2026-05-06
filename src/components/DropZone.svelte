<script lang="ts">
  import { handleFile } from '../state.svelte.js';

  let dragOver = $state(false);
  let inputEl: HTMLInputElement;

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  }

  function onChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleFile(file);
  }
</script>

<div
  class="dropzone"
  class:drag={dragOver}
  ondragover={(e) => { e.preventDefault(); dragOver = true; }}
  ondragleave={() => dragOver = false}
  ondrop={onDrop}
  onclick={() => inputEl.click()}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.click(); } }}
  role="button"
  tabindex="0"
>
  <div class="icon"></div>
  <div class="primary">Drop a video or audio file</div>
  <div class="secondary">or click to browse</div>
  <input bind:this={inputEl} type="file" accept="video/*,audio/*" onchange={onChange} />
</div>

<style>
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 80px 40px;
    background: var(--bg-elev);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all 0.18s ease;
    min-height: 320px;
    text-align: center;
  }

  .dropzone:hover, .dropzone.drag {
    border-color: var(--accent);
    background: var(--accent-bg);
  }

  .icon {
    width: 56px;
    height: 56px;
    border: 2px solid var(--border-strong);
    border-radius: 50%;
    position: relative;
    margin-bottom: 8px;
    transition: border-color 0.18s;
  }

  .icon::before,
  .icon::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    background: var(--text-tertiary);
    transition: background 0.18s;
  }
  .icon::before {
    width: 22px;
    height: 2px;
    transform: translate(-50%, -50%);
  }
  .icon::after {
    width: 2px;
    height: 22px;
    transform: translate(-50%, -50%);
  }

  .dropzone:hover .icon,
  .dropzone.drag .icon {
    border-color: var(--accent);
  }
  .dropzone:hover .icon::before,
  .dropzone:hover .icon::after,
  .dropzone.drag .icon::before,
  .dropzone.drag .icon::after {
    background: var(--accent);
  }

  .primary {
    font-size: 17px;
    font-weight: 500;
    color: var(--text);
  }

  .secondary {
    font-size: 13px;
    color: var(--text-tertiary);
  }

  input {
    display: none;
  }
</style>
