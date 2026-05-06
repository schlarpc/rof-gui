/**
 * Audio playback driven by the Web Audio API. We already have the decoded
 * samples on hand from the analysis pipeline, so we avoid HTML5 <audio> and
 * the range-request quirks of blob URLs.
 *
 * Mimics the slice of HTMLAudioElement we actually use: play, pause,
 * currentTime, duration, plus play/pause/ended/timeupdate/loadedmetadata
 * callbacks.
 */

export type PlayerEvent = 'play' | 'pause' | 'ended' | 'timeupdate' | 'loadedmetadata';

type EventHandler = () => void;

interface WebkitAudioWindow {
  webkitAudioContext?: typeof AudioContext;
}

export class WebAudioPlayer {
  private context: AudioContext | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0; // context time when current playback started
  private offset = 0;    // seconds into the buffer where playback started
  private playing = false;
  private timeupdateInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: Partial<Record<PlayerEvent, EventHandler>> = {};

  on(event: PlayerEvent, handler: EventHandler): void {
    this.callbacks[event] = handler;
  }

  private emit(event: PlayerEvent): void {
    this.callbacks[event]?.();
  }

  setAudio(audioData: Float32Array, sampleRate: number): void {
    this.stop();
    if (!this.context) {
      const Ctor = window.AudioContext || (window as unknown as WebkitAudioWindow).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API unavailable');
      this.context = new Ctor();
    }
    const buffer = this.context.createBuffer(1, audioData.length, sampleRate);
    // TS lib has Float32Array<ArrayBuffer> here; our parameter is the more
    // generic ArrayBufferLike form. The runtime contract is identical.
    buffer.copyToChannel(audioData as Float32Array<ArrayBuffer>, 0);
    this.audioBuffer = buffer;
    this.offset = 0;
    this.startedAt = 0;
    this.emit('loadedmetadata');
    this.emit('timeupdate');
  }

  get duration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  get currentTime(): number {
    if (!this.audioBuffer) return 0;
    // `source` is set only after the buffer has actually been started — between
    // play() and resume() resolving on iOS, `playing` is true but `startedAt`
    // is still stale, so we fall through to `offset` until playback truly begins.
    if (this.playing && this.source && this.context) {
      return Math.min(this.duration, this.offset + (this.context.currentTime - this.startedAt));
    }
    return this.offset;
  }

  set currentTime(value: number) {
    if (!this.audioBuffer) return;
    const wasPlaying = this.playing;
    this.stop();
    this.offset = Math.max(0, Math.min(value, this.duration));
    this.emit('timeupdate');
    if (wasPlaying) this.play();
  }

  play(): void {
    if (!this.audioBuffer || !this.context || this.playing) return;
    // After a natural end, offset sits at duration — rewind so play restarts.
    if (this.offset >= this.duration) {
      this.offset = 0;
      this.emit('timeupdate');
    }

    // Mark playing immediately so re-entrant clicks during the resume await
    // are ignored, and emit `play` so the UI updates without waiting.
    this.playing = true;
    this.emit('play');

    // iOS Safari only produces audio once the context has actually reached
    // 'running'. Calling start() while still suspended yields silence, so
    // we initiate resume() synchronously (preserving the user-gesture token)
    // and start the source after it resolves. We capture `playing` so a
    // pause/stop racing the resume cancels the start.
    const startSource = (): void => {
      if (!this.audioBuffer || !this.context || !this.playing) return;
      const src = this.context.createBufferSource();
      src.buffer = this.audioBuffer;
      src.connect(this.context.destination);
      src.onended = () => {
        if (!this.playing) return; // stopped via stop()
        this.playing = false;
        this.offset = this.duration;
        if (this.timeupdateInterval) {
          clearInterval(this.timeupdateInterval);
          this.timeupdateInterval = null;
        }
        this.emit('timeupdate');
        this.emit('ended');
        this.emit('pause');
      };
      src.start(0, this.offset);
      this.source = src;
      this.startedAt = this.context.currentTime;
      this.timeupdateInterval = setInterval(() => this.emit('timeupdate'), 50);
    };

    if (this.context.state === 'suspended') {
      this.context.resume().then(startSource, () => {
        // Resume rejected (autoplay policy, etc.) — roll back the play state.
        if (!this.playing) return;
        this.playing = false;
        this.emit('pause');
      });
    } else {
      startSource();
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stop(false);
    this.emit('timeupdate');
    this.emit('pause');
  }

  stop(emit = true): void {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* not yet started */ }
      try { this.source.disconnect(); } catch { /* already disconnected */ }
      this.source = null;
    }
    if (this.timeupdateInterval) {
      clearInterval(this.timeupdateInterval);
      this.timeupdateInterval = null;
    }
    this.playing = false;
    if (emit) this.emit('pause');
  }

  get paused(): boolean {
    return !this.playing;
  }
}
