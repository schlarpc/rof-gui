/**
 * Rate-of-Fire Detector
 * Analyzes audio files to detect gunshots and calculate rate-of-fire for automatic weapons
 */

import * as signal from './signal-processing.js';

export class RateOfFireDetector {
  constructor(options = {}) {
    // Detection parameters
    this.peakThresholdStd = options.peakThresholdStd ?? 1.2;
    this.minShotSpacing = options.minShotSpacing ?? 0.05;
    this.burstGapThreshold = options.burstGapThreshold ?? 0.2;
    this.windowSize = options.windowSize ?? 0.002;
    this.minPeakProminence = options.minPeakProminence ?? 0.1;
    this.minBurstCount = options.minBurstCount ?? 5;

    // Analysis results
    this.sampleRate = null;
    this.audioData = null;
    this.envelope = null;
    this.shotTimes = [];
    this.bursts = [];
  }

  /**
   * Extract audio from video/audio file using ffmpeg to mono WAV
   * @param {File} file - The input file
   * @param {FFmpeg} ffmpeg - The FFmpeg instance
   * @param {Function} onProgress - Progress callback
   */
  async extractAudio(file, ffmpeg, onProgress = null) {
    if (onProgress) onProgress('Extracting audio...');

    // Write input file
    const fileData = await file.arrayBuffer();
    await ffmpeg.writeFile('input', new Uint8Array(fileData));

    // Extract to mono, 44.1kHz WAV
    await ffmpeg.exec([
      '-i', 'input',
      '-ac', '1',        // mono
      '-ar', '44100',    // 44.1kHz
      '-f', 'wav',       // WAV format
      '-y',              // overwrite
      'output.wav'
    ]);

    // Read the output WAV file
    const wavData = await ffmpeg.readFile('output.wav');

    // Decode WAV file using Web Audio API
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(wavData.buffer);

    // Get the first channel (mono)
    this.sampleRate = audioBuffer.sampleRate;
    this.audioData = audioBuffer.getChannelData(0); // Float32Array, normalized to [-1, 1]

    const duration = this.audioData.length / this.sampleRate;
    console.log(`Audio loaded: ${duration.toFixed(2)} seconds, ${this.sampleRate}Hz`);

    if (onProgress) onProgress(`Audio loaded: ${duration.toFixed(2)}s at ${this.sampleRate}Hz`);

    // Clean up
    await ffmpeg.deleteFile('input');
    await ffmpeg.deleteFile('output.wav');

    return { duration, sampleRate: this.sampleRate };
  }

  /**
   * Calculate audio envelope using minimal smoothing to preserve transients
   */
  calculateEnvelope(onProgress = null) {
    if (onProgress) onProgress('Calculating audio envelope...');

    if (!this.audioData || !this.sampleRate) {
      throw new Error('Must call extractAudio first');
    }

    // For high-rate automatic fire, we need minimal smoothing
    // Use a very short window (1-2ms) to preserve individual shot peaks
    const windowSamples = Math.max(Math.floor(this.windowSize * this.sampleRate), 1);

    // Use absolute value
    const absAudio = signal.abs(this.audioData);

    // Apply minimal smoothing
    if (windowSamples > 1) {
      const window = signal.divide(signal.ones(windowSamples), windowSamples);
      this.envelope = signal.convolve(absAudio, window, 'same');
    } else {
      this.envelope = absAudio;
    }

    console.log('Envelope calculated');
    if (onProgress) onProgress('Envelope calculated');
  }

  /**
   * Detect gunshot peaks in the envelope using adaptive thresholding
   */
  detectPeaks(onProgress = null) {
    if (onProgress) onProgress('Detecting gunshot peaks...');

    if (!this.envelope || !this.sampleRate) {
      throw new Error('Must call calculateEnvelope first');
    }

    // Calculate adaptive threshold
    const meanLevel = signal.mean(this.envelope);
    const stdLevel = signal.std(this.envelope);
    const threshold = meanLevel + this.peakThresholdStd * stdLevel;

    console.log(`Mean level: ${meanLevel.toFixed(4)}, Std: ${stdLevel.toFixed(4)}`);
    console.log(`Threshold: ${threshold.toFixed(4)}`);

    // Minimum distance between peaks in samples
    const minDistance = Math.floor(this.minShotSpacing * this.sampleRate);

    // Find peaks with minimum height, distance, and prominence
    const { peaks, properties } = signal.findPeaks(this.envelope, {
      height: threshold,
      distance: minDistance,
      prominence: this.minPeakProminence
    });

    // Convert peak indices to times
    this.shotTimes = peaks.map(idx => idx / this.sampleRate);

    console.log(`Detected ${this.shotTimes.length} potential shots`);
    if (onProgress) onProgress(`Detected ${this.shotTimes.length} shots`);

    return { peaks, properties };
  }

  /**
   * Group shots into bursts and calculate rate-of-fire for each
   */
  groupIntoBursts(onProgress = null) {
    if (onProgress) onProgress('Grouping shots into bursts...');

    if (this.shotTimes.length === 0) {
      console.log('No shots detected!');
      if (onProgress) onProgress('No shots detected');
      return;
    }

    this.bursts = [];
    let currentBurst = [0]; // indices into shotTimes

    for (let i = 1; i < this.shotTimes.length; i++) {
      const gap = this.shotTimes[i] - this.shotTimes[i - 1];

      if (gap <= this.burstGapThreshold) {
        // Continue current burst
        currentBurst.push(i);
      } else {
        // End current burst, start new one
        if (currentBurst.length >= this.minBurstCount) {
          this.bursts.push(currentBurst);
        }
        currentBurst = [i];
      }
    }

    // Don't forget the last burst
    if (currentBurst.length >= this.minBurstCount) {
      this.bursts.push(currentBurst);
    }

    console.log(`Found ${this.bursts.length} bursts`);
    if (onProgress) onProgress(`Found ${this.bursts.length} bursts`);
  }

  /**
   * Calculate rate-of-fire statistics for each burst
   */
  calculateRates() {
    const results = [];

    for (let burstIdx = 0; burstIdx < this.bursts.length; burstIdx++) {
      const burst = this.bursts[burstIdx];
      const times = burst.map(idx => this.shotTimes[idx]);

      const startTime = times[0];
      const endTime = times[times.length - 1];
      const duration = endTime - startTime;
      const numShots = times.length;

      // Rate = (number of shots - 1) / duration * 60
      // We use (n-1) because n shots have (n-1) intervals
      const rateRpm = duration > 0 ? ((numShots - 1) / duration) * 60 : 0;

      // Calculate inter-shot intervals
      const intervals = signal.diff(times);

      const burstInfo = {
        burstNumber: burstIdx + 1,
        startTime: startTime,
        endTime: endTime,
        duration: duration,
        numShots: numShots,
        rateRpm: rateRpm,
        meanInterval: signal.mean(intervals),
        stdInterval: signal.std(intervals),
        minInterval: signal.min(intervals),
        maxInterval: signal.max(intervals),
        shotTimes: times
      };

      results.push(burstInfo);

      console.log(`Burst ${burstIdx + 1}: ${numShots} shots, ${rateRpm.toFixed(1)} RPM (${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s)`);
    }

    return results;
  }

  /**
   * Generate overall summary statistics
   */
  generateSummary(burstResults) {
    if (!burstResults || burstResults.length === 0) {
      return {
        totalShots: 0,
        totalBursts: 0,
        overallRateRpm: 0,
        meanBurstRateRpm: 0,
        medianBurstRateRpm: 0,
        minBurstRateRpm: 0,
        maxBurstRateRpm: 0,
        stdBurstRateRpm: 0
      };
    }

    const rates = burstResults.map(b => b.rateRpm);
    const totalShots = burstResults.reduce((sum, b) => sum + b.numShots, 0);

    // Calculate overall rate (all shots across all bursts)
    const allShotTimes = [];
    for (const burst of burstResults) {
      allShotTimes.push(...burst.shotTimes);
    }

    let overallRate = 0;
    if (allShotTimes.length >= 2) {
      const totalDuration = signal.max(allShotTimes) - signal.min(allShotTimes);
      overallRate = ((allShotTimes.length - 1) / totalDuration) * 60;
    }

    return {
      totalShots,
      totalBursts: burstResults.length,
      overallRateRpm: overallRate,
      meanBurstRateRpm: signal.mean(rates),
      medianBurstRateRpm: signal.median(rates),
      minBurstRateRpm: signal.min(rates),
      maxBurstRateRpm: signal.max(rates),
      stdBurstRateRpm: signal.std(rates)
    };
  }

  /**
   * Run complete analysis pipeline
   */
  async analyze(file, ffmpeg, onProgress = null) {
    const audioInfo = await this.extractAudio(file, ffmpeg, onProgress);
    this.calculateEnvelope(onProgress);
    const { peaks, properties } = this.detectPeaks(onProgress);
    this.groupIntoBursts(onProgress);
    const burstResults = this.calculateRates();
    const summary = this.generateSummary(burstResults);

    return {
      inputFile: file.name,
      audioDuration: audioInfo.duration,
      sampleRate: audioInfo.sampleRate,
      parameters: {
        peakThresholdStd: this.peakThresholdStd,
        minShotSpacing: this.minShotSpacing,
        burstGapThreshold: this.burstGapThreshold,
        windowSize: this.windowSize,
        minPeakProminence: this.minPeakProminence,
        minBurstCount: this.minBurstCount
      },
      summary,
      bursts: burstResults,
      peaks
    };
  }
}
