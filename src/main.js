import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { RateOfFireDetector } from './rof-detector.js';
import { ROFVisualizer } from './visualizer.js';

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const error = document.getElementById('error');

// ROF detection elements
const rofControlsHeader = document.getElementById('rofControlsHeader');
const rofControlsToggle = document.getElementById('rofControlsToggle');
const rofControlsContent = document.getElementById('rofControlsContent');
const rofResults = document.getElementById('rofResults');
const rofSummary = document.getElementById('rofSummary');
const rofBursts = document.getElementById('rofBursts');
const rofPlot = document.getElementById('rofPlot');
const downloadJsonBtn = document.getElementById('downloadJson');
const downloadPngBtn = document.getElementById('downloadPng');

// Parameter inputs
const peakThresholdInput = document.getElementById('peakThreshold');
const minShotSpacingInput = document.getElementById('minShotSpacing');
const burstGapThresholdInput = document.getElementById('burstGapThreshold');
const windowSizeInput = document.getElementById('windowSize');
const minPeakProminenceInput = document.getElementById('minPeakProminence');
const minBurstCountInput = document.getElementById('minBurstCount');

let ffmpeg = null;
let currentResults = null;
let visualizer = null;
let currentFile = null;
let reanalysisTimeout = null;

async function loadFFmpeg() {
  if (ffmpeg?.loaded) return;

  try {
    loadingText.textContent = 'Loading FFmpeg...';
    loading.classList.add('active');

    ffmpeg = new FFmpeg();

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    loading.classList.remove('active');
  } catch (err) {
    showError('Failed to load FFmpeg: ' + err.message);
    loading.classList.remove('active');
    throw err;
  }
}

async function handleFile(file) {
  if (!file) return;

  currentFile = file;

  try {
    await loadFFmpeg();

    loadingText.textContent = 'Analyzing file...';
    loading.classList.add('active');
    rofResults.classList.remove('active');
    error.classList.remove('active');

    await analyzeRateOfFire(file);
    loading.classList.remove('active');
    rofResults.classList.add('active');
  } catch (err) {
    showError('Error analyzing file: ' + err.message);
    loading.classList.remove('active');
  }
}

async function analyzeRateOfFire(file) {
  try {
    // Get parameters from UI
    const params = {
      peakThresholdStd: parseFloat(peakThresholdInput.value),
      minShotSpacing: parseFloat(minShotSpacingInput.value),
      burstGapThreshold: parseFloat(burstGapThresholdInput.value),
      windowSize: parseFloat(windowSizeInput.value),
      minPeakProminence: parseFloat(minPeakProminenceInput.value),
      minBurstCount: parseInt(minBurstCountInput.value)
    };

    // Create detector
    const detector = new RateOfFireDetector(params);

    // Run analysis with progress updates
    const onProgress = (message) => {
      loadingText.textContent = message;
    };

    currentResults = await detector.analyze(file, ffmpeg, onProgress);

    // Display results
    displayROFResults(detector, currentResults);

    // Create visualization
    if (!visualizer) {
      visualizer = new ROFVisualizer(rofPlot);
    }
    await visualizer.render(detector, currentResults);

    // Force resize to ensure plot fills container width
    setTimeout(() => visualizer.resize(), 0);

  } catch (err) {
    throw err;
  }
}

function displayROFResults(detector, results) {
  // Display summary
  const summary = results.summary;
  rofSummary.innerHTML = `
    <h2>Summary</h2>
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">Total Shots:</span>
        <span class="summary-value">${summary.totalShots}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total Bursts:</span>
        <span class="summary-value">${summary.totalBursts}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Overall Rate:</span>
        <span class="summary-value">${summary.overallRateRpm.toFixed(1)} RPM</span>
      </div>
      ${summary.totalBursts > 0 ? `
        <div class="summary-item">
          <span class="summary-label">Mean Burst Rate:</span>
          <span class="summary-value">${summary.meanBurstRateRpm.toFixed(1)} RPM</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Median Burst Rate:</span>
          <span class="summary-value">${summary.medianBurstRateRpm.toFixed(1)} RPM</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Rate Range:</span>
          <span class="summary-value">${summary.minBurstRateRpm.toFixed(1)} - ${summary.maxBurstRateRpm.toFixed(1)} RPM</span>
        </div>
      ` : ''}
    </div>
    <div class="file-details">
      <p><strong>File:</strong> ${results.inputFile}</p>
      <p><strong>Duration:</strong> ${results.audioDuration.toFixed(2)} seconds</p>
      <p><strong>Sample Rate:</strong> ${results.sampleRate} Hz</p>
    </div>
  `;

  // Display bursts
  if (results.bursts && results.bursts.length > 0) {
    let burstsHTML = '<h3>Burst Details</h3>';
    for (const burst of results.bursts) {
      burstsHTML += `
        <div class="burst-card">
          <h4>Burst ${burst.burstNumber}</h4>
          <div class="burst-details">
            <p><strong>Shots:</strong> ${burst.numShots}</p>
            <p><strong>Rate:</strong> ${burst.rateRpm.toFixed(1)} RPM</p>
            <p><strong>Duration:</strong> ${burst.duration.toFixed(3)} seconds</p>
            <p><strong>Time Range:</strong> ${burst.startTime.toFixed(2)}s - ${burst.endTime.toFixed(2)}s</p>
            <p><strong>Mean Interval:</strong> ${(burst.meanInterval * 1000).toFixed(1)} ms</p>
            <p><strong>Interval Range:</strong> ${(burst.minInterval * 1000).toFixed(1)} - ${(burst.maxInterval * 1000).toFixed(1)} ms</p>
          </div>
        </div>
      `;
    }
    rofBursts.innerHTML = burstsHTML;
  } else {
    rofBursts.innerHTML = '<p class="no-bursts">No bursts detected. Try adjusting the detection parameters.</p>';
  }
}

function scheduleReanalysis() {
  if (!currentFile) return;

  // Clear any pending reanalysis
  if (reanalysisTimeout) {
    clearTimeout(reanalysisTimeout);
  }

  // Schedule reanalysis after 500ms of no changes
  reanalysisTimeout = setTimeout(async () => {
    try {
      loadingText.textContent = 'Re-analyzing with new parameters...';
      loading.classList.add('active');
      error.classList.remove('active');

      await analyzeRateOfFire(currentFile);

      loading.classList.remove('active');
    } catch (err) {
      showError('Error re-analyzing file: ' + err.message);
      loading.classList.remove('active');
    }
  }, 500);
}

function showError(message) {
  error.textContent = message;
  error.classList.add('active');
}

// Parameter controls collapse/expand
rofControlsHeader.addEventListener('click', () => {
  const isExpanded = rofControlsContent.classList.contains('expanded');

  if (isExpanded) {
    rofControlsContent.classList.remove('expanded');
    rofControlsToggle.classList.remove('expanded');
  } else {
    rofControlsContent.classList.add('expanded');
    rofControlsToggle.classList.add('expanded');
  }
});

// Parameter change handlers - debounced reanalysis
const parameterInputs = [
  peakThresholdInput,
  minShotSpacingInput,
  burstGapThresholdInput,
  windowSizeInput,
  minPeakProminenceInput,
  minBurstCountInput
];

parameterInputs.forEach(input => {
  // On input change (typing)
  input.addEventListener('input', scheduleReanalysis);
  // On blur (leaving the field)
  input.addEventListener('blur', scheduleReanalysis);
});

// Download handlers
downloadJsonBtn.addEventListener('click', () => {
  if (!currentResults) return;

  const dataStr = JSON.stringify(currentResults, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rof_results.json';
  a.click();
  URL.revokeObjectURL(url);
});

downloadPngBtn.addEventListener('click', async () => {
  if (!visualizer) return;

  const blob = await visualizer.exportPNG();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rof_plot.png';
  a.click();
  URL.revokeObjectURL(url);
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

fileInput.addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
});
