/**
 * Audio playback driven by the Web Audio API. We already have the decoded
 * samples on hand from the analysis pipeline, so we avoid HTML5 <audio> and
 * the range-request quirks of blob URLs.
 *
 * On iOS, raw Web Audio output is treated as the "Ambient" audio category,
 * which the silent switch mutes. To get the standard "Media" category
 * (volume-controlled but not silenced by the ringer switch), we route the
 * AudioContext through a MediaStreamAudioDestinationNode and feed an
 * <audio> element from it. Browsers without that node fall back to
 * connecting directly to context.destination.
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
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private mediaEl: HTMLAudioElement | null = null;
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
      // Feed an off-DOM <audio> element from the context so iOS classifies
      // playback as Media (plays through the silent switch, still respects
      // the volume slider). Older browsers without MediaStream support fall
      // back to direct connection in `output()`.
      if (typeof this.context.createMediaStreamDestination === 'function') {
        this.streamDest = this.context.createMediaStreamDestination();
        const audio = document.createElement('audio');
        audio.playsInline = true;
        audio.srcObject = this.streamDest.stream;
        this.mediaEl = audio;
      }
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

  private output(): AudioNode {
    if (!this.context) throw new Error('AudioContext not initialized');
    return this.streamDest ?? this.context.destination;
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
    // and start the source after it resolves. The <audio>.play() call must
    // also happen synchronously here so iOS attributes the Media category
    // promotion to this user gesture. We capture `playing` so a pause/stop
    // racing these promises cancels the start.
    const mediaPromise: Promise<unknown> = this.mediaEl
      ? this.mediaEl.play().catch(() => {/* element pause races, etc. */})
      : Promise.resolve();
    const resumePromise: Promise<unknown> = this.context.state === 'suspended'
      ? this.context.resume()
      : Promise.resolve();

    const startSource = (): void => {
      if (!this.audioBuffer || !this.context || !this.playing) return;
      const src = this.context.createBufferSource();
      src.buffer = this.audioBuffer;
      src.connect(this.output());
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

    Promise.all([resumePromise, mediaPromise]).then(startSource, () => {
      // Resume rejected (autoplay policy, etc.) — roll back the play state.
      if (!this.playing) return;
      this.playing = false;
      this.mediaEl?.pause();
      this.emit('pause');
    });
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
    this.mediaEl?.pause();
    this.playing = false;
    if (emit) this.emit('pause');
  }

  get paused(): boolean {
    return !this.playing;
  }
}
