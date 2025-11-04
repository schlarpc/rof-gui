/**
 * Visualization Engine
 * Plotly.js-based plotting for waveforms, envelopes, and burst timelines
 */

import Plotly from 'plotly.js-dist-min';
import * as signal from './signal-processing.js';

export class ROFVisualizer {
  constructor(plotElement) {
    this.plotDiv = plotElement;
  }

  /**
   * Render complete visualization with three subplots
   */
  render(detector, results) {
    const sampleRate = detector.sampleRate;
    const audioDuration = results.audioDuration;

    // Calculate threshold for envelope plot
    const meanLevel = signal.mean(detector.envelope);
    const stdLevel = signal.std(detector.envelope);
    const threshold = meanLevel + detector.peakThresholdStd * stdLevel;

    // Prepare time arrays
    const audioTimeArray = this.createTimeArray(detector.audioData.length, sampleRate);
    const envelopeTimeArray = this.createTimeArray(detector.envelope.length, sampleRate);

    // Downsample for performance if needed
    const maxPoints = 5000;
    const audioDownsampled = this.downsample(detector.audioData, audioTimeArray, maxPoints);
    const envelopeDownsampled = this.downsample(detector.envelope, envelopeTimeArray, maxPoints);

    const traces = [];

    // --- Trace 1: Raw Audio Waveform ---
    traces.push({
      x: audioDownsampled.time,
      y: audioDownsampled.data,
      type: 'scatter',
      mode: 'lines',
      name: 'Waveform',
      line: { color: '#4682B4', width: 1 },
      xaxis: 'x1',
      yaxis: 'y1',
      hovertemplate: 'Time: %{x:.3f}s<br>Amplitude: %{y:.3f}<extra></extra>'
    });

    // --- Trace 2: Audio Envelope ---
    traces.push({
      x: envelopeDownsampled.time,
      y: envelopeDownsampled.data,
      type: 'scatter',
      mode: 'lines',
      name: 'Envelope',
      line: { color: '#2E8B57', width: 1.5 },
      xaxis: 'x2',
      yaxis: 'y2',
      hovertemplate: 'Time: %{x:.3f}s<br>Envelope: %{y:.3f}<extra></extra>'
    });

    // --- Trace 3: Detection Threshold Line ---
    traces.push({
      x: [0, audioDuration],
      y: [threshold, threshold],
      type: 'scatter',
      mode: 'lines',
      name: 'Threshold',
      line: { color: '#FF4444', width: 2, dash: 'dash' },
      xaxis: 'x2',
      yaxis: 'y2',
      hovertemplate: 'Threshold: %{y:.3f}<extra></extra>'
    });

    // --- Trace 4: Detected Peaks (Shot Markers) ---
    if (results.peaks && results.peaks.length > 0) {
      const peakTimes = results.peaks.map(idx => idx / sampleRate);
      const peakValues = results.peaks.map(idx => detector.envelope[idx]);

      traces.push({
        x: peakTimes,
        y: peakValues,
        type: 'scatter',
        mode: 'markers',
        name: 'Detected Shots',
        marker: {
          color: '#FF0000',
          size: 8,
          symbol: 'circle',
          line: { color: '#8B0000', width: 1 }
        },
        xaxis: 'x2',
        yaxis: 'y2',
        hovertemplate: 'Shot at %{x:.3f}s<br>Peak: %{y:.3f}<extra></extra>'
      });
    }

    // --- Traces 5+: Burst Timeline ---
    if (detector.bursts && detector.bursts.length > 0) {
      const colors = this.generateColors(detector.bursts.length);

      for (let i = 0; i < detector.bursts.length; i++) {
        const burst = detector.bursts[i];
        const burstData = results.bursts[i];
        const shotTimes = burstData.shotTimes;
        const yPos = i + 1; // Y position for this burst

        // Burst span (rectangle background)
        traces.push({
          x: [burstData.startTime, burstData.endTime, burstData.endTime, burstData.startTime, burstData.startTime],
          y: [yPos - 0.3, yPos - 0.3, yPos + 0.3, yPos + 0.3, yPos - 0.3],
          type: 'scatter',
          mode: 'lines',
          fill: 'toself',
          fillcolor: colors[i] + '40', // Semi-transparent
          line: { width: 0 },
          name: `Burst ${i + 1} Span`,
          showlegend: false,
          xaxis: 'x3',
          yaxis: 'y3',
          hoverinfo: 'skip'
        });

        // Individual shots in this burst
        traces.push({
          x: shotTimes,
          y: Array(shotTimes.length).fill(yPos),
          type: 'scatter',
          mode: 'markers',
          name: `Burst ${i + 1} (${burstData.rateRpm.toFixed(0)} RPM)`,
          marker: {
            color: colors[i],
            size: 10,
            symbol: 'circle',
            line: { color: '#000', width: 1 }
          },
          xaxis: 'x3',
          yaxis: 'y3',
          hovertemplate:
            `<b>Burst ${i + 1}</b><br>` +
            'Shot at: %{x:.3f}s<br>' +
            `Rate: ${burstData.rateRpm.toFixed(0)} RPM<br>` +
            `Shots: ${burstData.numShots}<br>` +
            `Duration: ${burstData.duration.toFixed(3)}s` +
            '<extra></extra>'
        });
      }
    } else {
      // Empty burst plot
      traces.push({
        x: [audioDuration / 2],
        y: [0.5],
        type: 'scatter',
        mode: 'text',
        text: ['No bursts detected'],
        textfont: { size: 14, color: '#999' },
        showlegend: false,
        xaxis: 'x3',
        yaxis: 'y3',
        hoverinfo: 'skip'
      });
    }

    // Calculate Y-axis ranges (fixed ranges for Audacity-style behavior)
    const audioMin = signal.min(detector.audioData);
    const audioMax = signal.max(detector.audioData);
    const envelopeMax = signal.max(detector.envelope);
    const numBursts = detector.bursts ? detector.bursts.length : 0;

    // Layout configuration
    const layout = {
      title: {
        text: 'ROF Analysis',
        font: { size: 18 }
      },
      showlegend: true,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: -0.2,
        xanchor: 'center',
        x: 0.5
      },
      hovermode: 'closest',

      // Subplot 1: Raw Waveform
      xaxis1: {
        domain: [0, 1],
        anchor: 'y1',
        title: 'Time (s)',
        showgrid: true,
        zeroline: false,
        // Link to other x-axes for synchronized zooming
        matches: 'x'
      },
      yaxis1: {
        domain: [0.7, 1],
        anchor: 'x1',
        title: 'Amplitude',
        showgrid: true,
        zeroline: true,
        // Fixed range - won't zoom on Y axis
        fixedrange: true,
        range: [audioMin * 1.1, audioMax * 1.1]
      },

      // Subplot 2: Envelope with Peaks
      xaxis2: {
        domain: [0, 1],
        anchor: 'y2',
        title: 'Time (s)',
        showgrid: true,
        zeroline: false,
        // Link to other x-axes for synchronized zooming
        matches: 'x'
      },
      yaxis2: {
        domain: [0.38, 0.65],
        anchor: 'x2',
        title: 'Envelope',
        showgrid: true,
        zeroline: false,
        // Fixed range - won't zoom on Y axis
        fixedrange: true,
        range: [-envelopeMax * 0.05, envelopeMax * 1.1]
      },

      // Subplot 3: Burst Timeline
      xaxis3: {
        domain: [0, 1],
        anchor: 'y3',
        title: 'Time (s)',
        showgrid: true,
        zeroline: false,
        // Link to other x-axes for synchronized zooming
        matches: 'x'
      },
      yaxis3: {
        domain: [0, 0.3],
        anchor: 'x3',
        title: 'Burst #',
        showgrid: false,
        zeroline: false,
        tickmode: 'linear',
        tick0: 1,
        dtick: 1,
        // Fixed range - won't zoom on Y axis
        fixedrange: true,
        range: [0.5, numBursts + 0.5]
      },

      // Responsive sizing
      autosize: true,
      height: 800,
      margin: { l: 60, r: 50, t: 80, b: 120 }
    };

    // Plotly configuration
    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      displaylogo: false,
      toImageButtonOptions: {
        format: 'png',
        filename: 'rof_analysis',
        height: 1200,
        width: 1600,
        scale: 2
      },
      scrollZoom: true // Enable scroll wheel zooming
    };

    // Render the plot
    return Plotly.newPlot(this.plotDiv, traces, layout, config);
  }

  /**
   * Create a time array for data
   */
  createTimeArray(length, sampleRate) {
    const times = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      times[i] = i / sampleRate;
    }
    return times;
  }

  /**
   * Downsample data for performance
   */
  downsample(data, timeArray, maxPoints) {
    if (data.length <= maxPoints) {
      return { data: Array.from(data), time: Array.from(timeArray) };
    }

    const step = Math.floor(data.length / maxPoints);
    const downsampled = [];
    const downsampledTime = [];

    for (let i = 0; i < data.length; i += step) {
      downsampled.push(data[i]);
      downsampledTime.push(timeArray[i]);
    }

    return { data: downsampled, time: downsampledTime };
  }

  /**
   * Generate distinct colors for bursts
   */
  generateColors(count) {
    const baseColors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
      '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52C77C'
    ];

    const colors = [];
    for (let i = 0; i < count; i++) {
      colors.push(baseColors[i % baseColors.length]);
    }

    return colors;
  }

  /**
   * Export plot as PNG
   */
  async exportPNG() {
    const imgData = await Plotly.toImage(this.plotDiv, {
      format: 'png',
      width: 1600,
      height: 1200,
      scale: 2
    });

    // Convert data URL to blob
    const response = await fetch(imgData);
    return await response.blob();
  }

  /**
   * Resize plot (call when container size changes)
   */
  resize() {
    Plotly.Plots.resize(this.plotDiv);
  }
}
