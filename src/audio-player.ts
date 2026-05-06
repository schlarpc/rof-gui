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
    if (this.playing && this.context) {
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
    if (this.context.state === 'suspended') void this.context.resume();

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
    this.playing = true;

    this.timeupdateInterval = setInterval(() => this.emit('timeupdate'), 50);
    this.emit('play');
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
