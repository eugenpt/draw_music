# Draw Music

A mobile-first canvas instrument. Draw colorful lines, press play, and listen as a vertical playhead turns the picture into sound. Height controls pitch; each color uses a different synth voice.

## Features

- Pressure-aware freehand drawing with seven melodic color/sound voices
- Dot-based Kick, Snare, and Hi-hat percussion instruments
- Tap for one beat or drag to paint an evenly spaced percussion sequence
- Optional bottom drum sequencer with 16 steps and Kick, Snare, and Hi-hat lanes
- The drum playhead loops four times while the melodic playhead crosses the canvas once
- Hiding the drum editor expands its pattern into four visible playback copies
- Hidden drum copies use a compact lower preview; drum-panel erasing never reaches drawings underneath
- Cycleable Octaves, Chord, and C-major Scale grids with musical snapping
- Grid strokes follow neighboring horizontal, vertical, and diagonal edges
- Tap-to-preview colors and an iOS-compatible audio unlock
- Music-category audio sessions that remain audible through iPhone Silent mode
- Explicit dual-channel output for centered headphone playback
- Continuous play/pause sweep with adjustable duration
- Polyphonic playback for every distinct playhead intersection
- Visible black markers at all active intersections
- Exact quadratic-spline intersection detection matching the rendered curves
- Click-free attack and release envelopes for polyphonic note changes
- Persistent intersection-to-oscillator tracking across animation frames
- Three extended-register instruments: Tide, Reed, and Glass
- Compact two-row instrument palette for mobile screens
- Two-octave C-major pitch mapping from the canvas' vertical axis
- Paint-style partial eraser plus a separate whole-curve delete tool
- Undo and clear controls
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
