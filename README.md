# ROF GUI

A browser-based tool for analyzing rate-of-fire (ROF) from audio and video files. This application uses digital signal processing to detect gunshot peaks, calculate firing rates, and identify burst patterns in automatic weapon fire.

## 🔗 Live Application

Access the analyzer at: **https://schlarpc.github.io/rof-gui/**

## Features

- **Client-side processing** - All analysis runs locally in your browser using WebAssembly
- **Audio extraction** - Automatically extracts audio from video files using FFmpeg.js
- **Peak detection** - Identifies individual gunshots using adaptive thresholding and signal processing
- **Burst analysis** - Groups shots into bursts and calculates rate-of-fire statistics
- **Interactive visualization** - Multi-panel Plotly charts showing waveform, envelope, and burst timeline
- **Adjustable parameters** - Fine-tune detection sensitivity with real-time reanalysis
- **Export capabilities** - Download results as JSON or save visualizations as PNG

## How It Works

The detector processes audio through several stages:

1. **Audio Extraction** - Converts input media to mono 44.1kHz WAV using FFmpeg
2. **Envelope Calculation** - Computes audio envelope with minimal smoothing to preserve sharp transients
3. **Peak Detection** - Identifies gunshot peaks using adaptive thresholding based on signal statistics
4. **Burst Grouping** - Clusters shots into bursts based on inter-shot timing gaps
5. **Rate Analysis** - Calculates RPM (rounds per minute) for each burst and overall statistics

## Detection Parameters

The tool provides several adjustable parameters:

- **Peak Threshold** - Sensitivity for shot detection (in standard deviations above mean)
- **Minimum Shot Spacing** - Prevents double-counting rapid peaks (supports up to ~1200 RPM)
- **Burst Gap Threshold** - Maximum gap between shots within a burst
- **Window Size** - Envelope smoothing window (smaller preserves transients)
- **Minimum Peak Prominence** - Filters out low-amplitude peaks relative to signal max
- **Minimum Burst Count** - Filters out bursts with too few shots

## Building

### With Nix (Recommended)

```bash
# Development environment
direnv allow  # enables automatic nix develop shell
npm run dev   # starts development server

# Production build
nix build
```

### With Node.js/npm

```bash
# Install dependencies
npm install

# Development server
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

## Development

The project uses:
- **Vite** - Fast build tool and development server
- **FFmpeg.js** - WebAssembly-based audio extraction
- **Plotly.js** - Interactive charting library
- **Custom DSP** - Pure JavaScript signal processing implementations

### Project Structure

- `src/main.js` - Main application logic and UI handling
- `src/rof-detector.js` - Core rate-of-fire detection algorithm
- `src/signal-processing.js` - Signal processing utilities (peak detection, convolution, statistics)
- `src/visualizer.js` - Plotly-based visualization engine
- `index.html` - Single-page application with embedded styles
- `flake.nix` - Nix build configuration for reproducible builds
- `vectors/` - Test audio samples

## Algorithm Details

### Peak Detection

Uses a reimplementation of scipy's `find_peaks` with:
- Height-based filtering (adaptive threshold)
- Minimum distance enforcement (prevents double-counting)
- Prominence calculation (rejects low-amplitude peaks)

### Burst Classification

Shots are grouped into bursts when:
- Inter-shot intervals are below the burst gap threshold
- The burst contains at least the minimum number of shots

### Rate Calculation

ROF is calculated as: `RPM = (shots - 1) / duration * 60`

The tool reports:
- Per-burst rates
- Overall rate across all shots
- Mean, median, min, max, and standard deviation of burst rates

## Privacy & Security

- All processing happens locally in your browser
- No files are uploaded to external servers
- Uses SharedArrayBuffer for FFmpeg.js (requires COOP/COEP headers)

## License

This project is licensed under the AGPL-3.0-or-later license. See the LICENSE file for details.
