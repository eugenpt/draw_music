# Draw Music

A mobile-first canvas instrument. Draw colorful lines, press play, and listen as a vertical playhead turns the picture into sound. Height controls pitch; each color uses a different synth voice.

## Features

- Pressure-aware freehand drawing with four color/sound voices
- Tap-to-preview colors and an iOS-compatible audio unlock
- Music-category audio sessions that remain audible through iPhone Silent mode
- Explicit dual-channel output for centered headphone playback
- Continuous play/pause sweep with adjustable duration
- Pentatonic pitch mapping from the canvas' vertical axis
- Stroke eraser, undo, and clear
- Automatic browser storage
- JSON import and export
- Responsive, touch-friendly UI
- No framework or build step

## Run locally

Serve this folder with any static server, for example:

```sh
python -m http.server 8080
```

Then open `http://localhost:8080`.

Browsers require a tap or click before audio can start, so sound is initialized by the play button.

## Deploy

The included GitHub Actions workflow publishes the repository root to GitHub Pages whenever `main` is updated. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
