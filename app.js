(() => {
  "use strict";

  const canvas = document.querySelector("#drawingCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const playButton = document.querySelector("#playButton");
  const eraserButton = document.querySelector("#eraserButton");
  const deleteCurveButton = document.querySelector("#deleteCurveButton");
  const moreButton = document.querySelector("#moreButton");
  const moreControls = document.querySelector("#moreControls");
  const gridButton = document.querySelector("#gridButton");
  const tempoRange = document.querySelector("#tempoRange");
  const tempoOutput = document.querySelector("#tempoOutput");
  const undoButton = document.querySelector("#undoButton");
  const clearButton = document.querySelector("#clearButton");
  const saveButton = document.querySelector("#saveButton");
  const loadButton = document.querySelector("#loadButton");
  const fileInput = document.querySelector("#fileInput");
  const hint = document.querySelector("#hint");
  const toast = document.querySelector("#toast");
  const swatches = [...document.querySelectorAll(".color-swatch")];

  const STORAGE_KEY = "draw-music-composition-v1";
  const VERSION = 3;
  const state = {
    strokes: [],
    activeStroke: null,
    drawing: false,
    erasing: false,
    deletingCurve: false,
    instrumentKind: "line",
    lastPercussionPoint: null,
    color: "#72f1b8",
    voice: "bloom",
    playing: false,
    sweep: 0,
    sweepDuration: 8,
    gridMode: 0,
    previousTime: performance.now(),
    width: 1,
    height: 1,
    dpr: 1,
  };

  let audio = null;
  let saveTimer = 0;
  let toastTimer = 0;
  let nextStrokeId = 1;
  let nextIntersectionId = 1;
  let intersectionTracks = new Map();

  const voiceSettings = {
    bloom: { wave: "sine", gain: 0.12, filter: 2600, detune: 0, transpose: 0 },
    pluck: { wave: "triangle", gain: 0.1, filter: 1900, detune: 4, transpose: 0 },
    spark: { wave: "square", gain: 0.055, filter: 1350, detune: 7, transpose: 0 },
    buzz: { wave: "sawtooth", gain: 0.06, filter: 850, detune: -5, transpose: 0 },
    tide: { wave: "sine", gain: 0.14, filter: 1450, detune: -3, transpose: -12 },
    reed: { wave: "sawtooth", gain: 0.065, filter: 620, detune: 3, transpose: -5 },
    glass: { wave: "sine", gain: 0.085, filter: 4600, detune: 6, transpose: 12 },
  };

  const percussionSettings = {
    kick: { gain: 0.28 },
    snare: { gain: 0.16 },
    hat: { gain: 0.1 },
  };

  const C_MAJOR_MIDI = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
  const GRID_TOP = 0.08;
  const GRID_BOTTOM = 0.82;
  const GRID_MODES = [
    { name: "Off", beats: 0, pitchIndices: [] },
    { name: "Octaves", beats: 4, pitchIndices: [0, 7, 14] },
    { name: "Chord", beats: 8, pitchIndices: [0, 2, 4, 7, 9, 11, 14] },
    { name: "Scale", beats: 16, pitchIndices: C_MAJOR_MIDI.map((_, index) => index) },
  ];

  class AudioEngine {
    constructor() {
      this.requestPlaybackSession();
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.62;

      // Send the same mono mix to both output channels explicitly. This avoids
      // one-sided playback on a few iOS/Safari audio routes and Bluetooth sets.
      this.stereo = this.context.createChannelMerger(2);
      this.master.connect(this.stereo, 0, 0);
      this.master.connect(this.stereo, 0, 1);
      this.stereo.connect(this.context.destination);
      this.voices = new Map();
      this.activePercussion = new Set();
      this.noiseBuffer = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate);
      const noise = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    }

    requestPlaybackSession(refresh = false) {
      if (!("audioSession" in navigator)) return;
      try {
        // A music instrument is primary media, not an incidental notification.
        // "playback" keeps it audible through iPhone's Ring/Silent switch.
        if (refresh && navigator.audioSession.type === "playback") {
          // Reassert the category after iOS recreates its media process. Merely
          // assigning "playback" again can be ignored by affected Safari builds.
          navigator.audioSession.type = "ambient";
          window.setTimeout(() => { navigator.audioSession.type = "playback"; }, 0);
        } else {
          navigator.audioSession.type = "playback";
        }
      } catch { /* Audio Session API is experimental and may be read-only. */ }
    }

    unlock() {
      this.requestPlaybackSession(true);
      // iOS Safari needs an audio source to start synchronously inside the tap.
      // A one-sample silent buffer unlocks the route without making a sound.
      const buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.master);
      source.start(0);
      return this.context.state === "running" ? Promise.resolve() : this.context.resume();
    }

    preview(voiceName, normalizedY = 0.5) {
      const settings = voiceSettings[voiceName] || voiceSettings.bloom;
      const now = this.context.currentTime;
      const osc = this.context.createOscillator();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      osc.type = settings.wave;
      osc.frequency.value = frequencyForVoice(voiceName, normalizedY);
      osc.detune.value = settings.detune;
      filter.type = "lowpass";
      filter.frequency.value = settings.filter;
      filter.Q.value = voiceName === "spark" ? 5 : 1.4;
      const previewVolume = settings.gain * 0.72;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(previewVolume, now + 0.055);
      gain.gain.setValueAtTime(previewVolume, now + 0.1);
      gain.gain.linearRampToValueAtTime(0, now + 0.24);
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + 0.26);
    }

    triggerPercussion(voiceName, normalizedY = 0.5) {
      const settings = percussionSettings[voiceName];
      if (!settings) return;
      const now = this.context.currentTime;

      if (voiceName === "kick") {
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        const baseFrequency = 48 + (1 - normalizedY) * 16;
        osc.type = "sine";
        osc.frequency.setValueAtTime(baseFrequency * 2.8, now);
        osc.frequency.exponentialRampToValueAtTime(baseFrequency, now + 0.11);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(settings.gain, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
        osc.connect(gain).connect(this.master);
        osc.start(now);
        osc.stop(now + 0.42);
        return;
      }

      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      source.buffer = this.noiseBuffer;
      source.playbackRate.value = 0.9 + (1 - normalizedY) * 0.35;
      gain.gain.setValueAtTime(0, now);

      if (voiceName === "snare") {
        filter.type = "bandpass";
        filter.frequency.value = 1600 + (1 - normalizedY) * 800;
        filter.Q.value = 0.75;
        gain.gain.linearRampToValueAtTime(settings.gain, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        source.connect(filter).connect(gain).connect(this.master);
        source.start(now, Math.random() * 0.65, 0.24);
        return;
      }

      filter.type = "highpass";
      filter.frequency.value = 6500 + (1 - normalizedY) * 1500;
      filter.Q.value = 0.8;
      gain.gain.linearRampToValueAtTime(settings.gain, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
      source.connect(filter).connect(gain).connect(this.master);
      source.start(now, Math.random() * 0.8, 0.09);
    }

    update(hits) {
      const now = this.context.currentTime;
      const percussionHits = hits.filter((hit) => hit.kind === "percussion");
      const nextPercussion = new Set(percussionHits.map((hit) => hit.id));
      percussionHits.forEach((hit) => {
        if (!this.activePercussion.has(hit.id)) this.triggerPercussion(hit.voice, hit.y);
      });
      this.activePercussion = nextPercussion;

      const tonalHits = hits.filter((hit) => hit.kind !== "percussion");
      const liveIds = new Set(tonalHits.map((hit) => hit.id));

      tonalHits.forEach((hit) => {
        const frequency = frequencyForVoice(hit.voice, hit.y);
        const existing = this.voices.get(hit.id);
        if (existing) {
          existing.osc.frequency.setTargetAtTime(frequency, now, 0.018);
          return;
        }

        const settings = voiceSettings[hit.voice] || voiceSettings.bloom;
        const osc = this.context.createOscillator();
        const filter = this.context.createBiquadFilter();
        const gain = this.context.createGain();
        osc.type = settings.wave;
        osc.frequency.value = frequency;
        osc.detune.value = settings.detune;
        filter.type = "lowpass";
        filter.frequency.value = settings.filter;
        filter.Q.value = hit.voice === "spark" ? 5 : 1.4;
        gain.gain.setValueAtTime(0, now);
        osc.connect(filter).connect(gain).connect(this.master);
        osc.start(now);
        // A deliberately soft note-on prevents new polyphonic voices from
        // adding a sharp edge to voices that are already sounding.
        gain.gain.linearRampToValueAtTime(settings.gain, now + 0.085);
        this.voices.set(hit.id, { osc, gain, volume: settings.gain });
      });

      this.voices.forEach((voice, id) => {
        if (!liveIds.has(id)) this.release(id, voice, now);
      });
    }

    release(id, voice, now = this.context.currentTime) {
      this.voices.delete(id);
      const gain = voice.gain.gain;
      if (typeof gain.cancelAndHoldAtTime === "function") {
        gain.cancelAndHoldAtTime(now);
      } else {
        const currentLevel = gain.value;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(currentLevel, now);
      }
      // Let the tail decay exponentially to near-silence before stopping the
      // oscillator. This avoids an audible edge in Safari's audio renderer.
      gain.setTargetAtTime(0, now, 0.065);
      voice.osc.stop(now + 0.65);
    }

    silence() {
      const now = this.context.currentTime;
      this.voices.forEach((voice, id) => this.release(id, voice, now));
      this.activePercussion.clear();
    }
  }

  function yToFrequency(normalizedY) {
    const pitchPosition = clamp((normalizedY - GRID_TOP) / (GRID_BOTTOM - GRID_TOP), 0, 1);
    const index = Math.round((1 - pitchPosition) * (C_MAJOR_MIDI.length - 1));
    return 440 * Math.pow(2, (C_MAJOR_MIDI[index] - 69) / 12);
  }

  function frequencyForVoice(voiceName, normalizedY) {
    const settings = voiceSettings[voiceName] || voiceSettings.bloom;
    return yToFrequency(normalizedY) * Math.pow(2, (settings.transpose || 0) / 12);
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function resizeCanvas() {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function pointFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
      p: event.pointerType === "pen" ? clamp(event.pressure || 0.5, 0.18, 1) : 0.55,
    };
  }

  function canvasPoint(point) { return { x: point.x * state.width, y: point.y * state.height }; }

  function currentGrid() { return GRID_MODES[state.gridMode]; }

  function gridYForPitchIndex(index) {
    return GRID_BOTTOM - index / (C_MAJOR_MIDI.length - 1) * (GRID_BOTTOM - GRID_TOP);
  }

  function gridNodeForPoint(point) {
    const grid = currentGrid();
    if (!grid.beats) return null;
    const xIndex = clamp(Math.round(point.x * grid.beats), 0, grid.beats);
    let rowIndex = 0;
    let closestDistance = Infinity;
    grid.pitchIndices.forEach((pitchIndex, index) => {
      const distance = Math.abs(point.y - gridYForPitchIndex(pitchIndex));
      if (distance < closestDistance) {
        closestDistance = distance;
        rowIndex = index;
      }
    });
    return { xIndex, rowIndex };
  }

  function pointForGridNode(node, pressure = 0.55) {
    const grid = currentGrid();
    return {
      x: node.xIndex / grid.beats,
      y: gridYForPitchIndex(grid.pitchIndices[node.rowIndex]),
      p: pressure,
    };
  }

  function snapPointToGrid(point) {
    const node = gridNodeForPoint(point);
    return node ? pointForGridNode(node, point.p) : point;
  }

  function appendGridPath(points, targetPoint) {
    const targetNode = gridNodeForPoint(targetPoint);
    const currentNode = gridNodeForPoint(points[points.length - 1]);
    if (!targetNode || !currentNode) return;
    let xIndex = currentNode.xIndex;
    let rowIndex = currentNode.rowIndex;
    while (xIndex !== targetNode.xIndex || rowIndex !== targetNode.rowIndex) {
      xIndex += Math.sign(targetNode.xIndex - xIndex);
      rowIndex += Math.sign(targetNode.rowIndex - rowIndex);
      points.push(pointForGridNode({ xIndex, rowIndex }, targetPoint.p));
    }
  }

  function placePercussion(point) {
    const placedPoint = state.gridMode ? snapPointToGrid(point) : point;
    const last = state.lastPercussionPoint;
    if (last && Math.hypot(
      (placedPoint.x - last.x) * state.width,
      (placedPoint.y - last.y) * state.height
    ) < 0.5) return;
    state.strokes.push({
      id: nextStrokeId++,
      kind: "dot",
      color: state.color,
      voice: state.voice,
      size: 16,
      points: [placedPoint],
    });
    state.lastPercussionPoint = placedPoint;
    updateEmptyState();
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    state.drawing = true;
    const point = pointFromEvent(event);
    if (state.erasing) {
      eraseAt(point);
      return;
    }
    if (state.deletingCurve) {
      deleteCurveAt(point);
      return;
    }
    if (state.instrumentKind === "percussion") {
      state.activeStroke = null;
      placePercussion(point);
      return;
    }
    const drawingPoint = state.gridMode ? snapPointToGrid(point) : point;
    state.activeStroke = {
      id: nextStrokeId++,
      kind: "line",
      geometry: state.gridMode ? "grid" : "spline",
      color: state.color,
      voice: state.voice,
      size: 5.5,
      points: [drawingPoint],
    };
    state.strokes.push(state.activeStroke);
    updateEmptyState();
  }

  function onPointerMove(event) {
    if (!state.drawing) return;
    const point = pointFromEvent(event);
    if (state.erasing) {
      eraseAt(point);
      return;
    }
    if (state.deletingCurve) {
      deleteCurveAt(point);
      return;
    }
    if (state.instrumentKind === "percussion") {
      const last = state.lastPercussionPoint;
      const candidate = state.gridMode ? snapPointToGrid(point) : point;
      const distance = last
        ? Math.hypot((candidate.x - last.x) * state.width, (candidate.y - last.y) * state.height)
        : Infinity;
      if (state.gridMode ? distance >= 0.5 : distance >= 26) placePercussion(point);
      return;
    }
    const points = state.activeStroke?.points;
    if (!points) return;
    if (state.gridMode) {
      appendGridPath(points, point);
      return;
    }
    const last = points[points.length - 1];
    const dx = (point.x - last.x) * state.width;
    const dy = (point.y - last.y) * state.height;
    if (Math.hypot(dx, dy) >= 1.4) points.push(point);
  }

  function onPointerUp(event) {
    if (!state.drawing) return;
    state.drawing = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (state.instrumentKind === "line" && state.activeStroke?.points.length === 1) {
      const first = state.activeStroke.points[0];
      state.activeStroke.points.push({ ...first, x: first.x + 0.0001 });
    }
    state.activeStroke = null;
    state.lastPercussionPoint = null;
    scheduleSave();
  }

  function distanceToSegment(point, a, b) {
    const px = point.x * state.width;
    const py = point.y * state.height;
    const ax = a.x * state.width;
    const ay = a.y * state.height;
    const bx = b.x * state.width;
    const by = b.y * state.height;
    const vx = bx - ax;
    const vy = by - ay;
    const lengthSquared = vx * vx + vy * vy || 1;
    const t = clamp(((px - ax) * vx + (py - ay) * vy) / lengthSquared, 0, 1);
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  }

  function interpolatePoint(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      p: a.p + (b.p - a.p) * t,
    };
  }

  function segmentOutsideEraser(point, a, b, radius) {
    const centerX = point.x * state.width;
    const centerY = point.y * state.height;
    const startX = a.x * state.width;
    const startY = a.y * state.height;
    const vectorX = (b.x - a.x) * state.width;
    const vectorY = (b.y - a.y) * state.height;
    const offsetX = startX - centerX;
    const offsetY = startY - centerY;
    const quadraticA = vectorX * vectorX + vectorY * vectorY;
    const quadraticB = 2 * (offsetX * vectorX + offsetY * vectorY);
    const quadraticC = offsetX * offsetX + offsetY * offsetY - radius * radius;
    const cuts = [0, 1];

    if (quadraticA > 1e-9) {
      const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
      if (discriminant > 1e-9) {
        const root = Math.sqrt(discriminant);
        const first = (-quadraticB - root) / (2 * quadraticA);
        const second = (-quadraticB + root) / (2 * quadraticA);
        if (first > 0 && first < 1) cuts.push(first);
        if (second > 0 && second < 1) cuts.push(second);
      }
    }

    cuts.sort((first, second) => first - second);
    const parts = [];
    let erased = false;
    for (let i = 1; i < cuts.length; i++) {
      const start = cuts[i - 1];
      const end = cuts[i];
      if (end - start < 1e-7) continue;
      const middle = (start + end) / 2;
      const sampleX = startX + vectorX * middle - centerX;
      const sampleY = startY + vectorY * middle - centerY;
      const outside = sampleX * sampleX + sampleY * sampleY > radius * radius;
      if (outside) {
        parts.push([interpolatePoint(a, b, start), interpolatePoint(a, b, end)]);
      } else {
        erased = true;
      }
    }
    return { parts, erased };
  }

  function eraseAt(point) {
    const radius = 21;
    let changed = false;
    const nextStrokes = [];
    state.strokes.forEach((stroke) => {
      if (stroke.kind === "dot") {
        const dot = stroke.points[0];
        const distance = Math.hypot(
          (point.x - dot.x) * state.width,
          (point.y - dot.y) * state.height
        );
        if (distance <= radius + stroke.size / 2) changed = true;
        else nextStrokes.push(stroke);
        return;
      }
      let touched = false;
      const fragments = [];
      let fragment = [];
      for (let i = 1; i < stroke.points.length; i++) {
        const previous = stroke.points[i - 1];
        const current = stroke.points[i];
        const clipped = segmentOutsideEraser(point, previous, current, radius);
        if (clipped.erased) touched = true;
        clipped.parts.forEach(([start, end]) => {
          const last = fragment[fragment.length - 1];
          const joinsPrevious = last
            && Math.hypot((last.x - start.x) * state.width, (last.y - start.y) * state.height) < 0.5;
          if (!joinsPrevious) {
            if (fragment.length >= 2) fragments.push(fragment);
            fragment = [start];
          }
          fragment.push(end);
        });
        if (clipped.erased && !clipped.parts.length) {
          if (fragment.length >= 2) fragments.push(fragment);
          fragment = [];
        } else if (clipped.erased && clipped.parts.length > 1) {
          if (fragment.length >= 2) fragments.push(fragment);
          fragment = [];
        }
      }
      if (fragment.length >= 2) fragments.push(fragment);

      if (!touched) {
        nextStrokes.push(stroke);
        return;
      }

      changed = true;
      fragments.forEach((points, index) => {
        nextStrokes.push({
          ...stroke,
          id: index === 0 ? stroke.id : nextStrokeId++,
          points,
        });
      });
    });
    if (changed) {
      state.strokes = nextStrokes;
      updateEmptyState();
      scheduleSave();
    }
  }

  function deleteCurveAt(point) {
    const radius = 21;
    const before = state.strokes.length;
    state.strokes = state.strokes.filter((stroke) => {
      if (stroke.kind === "dot") {
        const dot = stroke.points[0];
        return Math.hypot(
          (point.x - dot.x) * state.width,
          (point.y - dot.y) * state.height
        ) > radius + stroke.size / 2;
      }
      for (let i = 1; i < stroke.points.length; i++) {
        if (distanceToSegment(point, stroke.points[i - 1], stroke.points[i]) <= radius) return false;
      }
      return true;
    });
    if (state.strokes.length !== before) {
      updateEmptyState();
      scheduleSave();
    }
  }

  function splineSegments(stroke) {
    const points = stroke.points;
    if (points.length < 2) return [];
    if (stroke.geometry === "grid") {
      return points.slice(1).map((end, index) => ({
        type: "line",
        start: points[index],
        end,
      }));
    }
    if (points.length === 2) return [{ type: "line", start: points[0], end: points[1] }];

    const segments = [];
    let start = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const end = {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2,
        p: (points[i].p + points[i + 1].p) / 2,
      };
      segments.push({ type: "quadratic", start, control: points[i], end });
      start = end;
    }
    segments.push({ type: "line", start, end: points[points.length - 1] });
    return segments;
  }

  function drawStroke(stroke) {
    if (stroke.kind === "dot") {
      const point = canvasPoint(stroke.points[0]);
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.shadowColor = stroke.color;
      ctx.shadowBlur = state.playing ? 9 : 5;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(point.x - 2, point.y - 2, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.65)";
      ctx.shadowBlur = 0;
      ctx.fill();
      ctx.restore();
      return;
    }
    const segments = splineSegments(stroke);
    if (!segments.length) return;
    const first = canvasPoint(segments[0].start);
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = stroke.color;
    ctx.shadowBlur = state.playing ? 5 : 2;
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    segments.forEach((segment) => {
      const end = canvasPoint(segment.end);
      if (segment.type === "quadratic") {
        const control = canvasPoint(segment.control);
        ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      } else {
        ctx.lineTo(end.x, end.y);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  function quadraticValue(start, control, end, t) {
    const inverse = 1 - t;
    return inverse * inverse * start + 2 * inverse * t * control + t * t * end;
  }

  function quadraticRootsAtX(segment, targetX) {
    const a = segment.start.x - 2 * segment.control.x + segment.end.x;
    const b = 2 * (segment.control.x - segment.start.x);
    const c = segment.start.x - targetX;
    const epsilon = 1e-9;

    if (Math.abs(a) < epsilon) {
      if (Math.abs(b) < epsilon) return [];
      return [-c / b];
    }

    const discriminant = b * b - 4 * a * c;
    if (discriminant < -epsilon) return [];
    if (Math.abs(discriminant) <= epsilon) return [-b / (2 * a)];
    const root = Math.sqrt(discriminant);
    return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  }

  function segmentIntersections(segment, targetX, verticalTolerance) {
    const epsilon = 1e-7;
    if (segment.type === "line") {
      const dx = segment.end.x - segment.start.x;
      if (Math.abs(dx) < epsilon) {
        return Math.abs(targetX - segment.start.x) <= verticalTolerance
          ? [(segment.start.y + segment.end.y) / 2]
          : [];
      }
      const t = (targetX - segment.start.x) / dx;
      if (t < -epsilon || t > 1 + epsilon) return [];
      const boundedT = clamp(t, 0, 1);
      return [segment.start.y + (segment.end.y - segment.start.y) * boundedT];
    }

    const xSpan = Math.max(segment.start.x, segment.control.x, segment.end.x)
      - Math.min(segment.start.x, segment.control.x, segment.end.x);
    if (xSpan < epsilon) {
      return Math.abs(targetX - segment.start.x) <= verticalTolerance
        ? [quadraticValue(segment.start.y, segment.control.y, segment.end.y, 0.5)]
        : [];
    }

    return quadraticRootsAtX(segment, targetX)
      .filter((t) => t >= -epsilon && t <= 1 + epsilon)
      .map((t) => {
        const boundedT = clamp(t, 0, 1);
        return quadraticValue(segment.start.y, segment.control.y, segment.end.y, boundedT);
      });
  }

  function intersectionsAt(normalizedX) {
    const verticalTolerance = 3 / state.width;
    const hits = [];
    const nextTracks = new Map();
    state.strokes.forEach((stroke) => {
      if (stroke.kind === "dot") {
        const point = stroke.points[0];
        const hitRadius = (stroke.size / 2 + 2) / state.width;
        if (Math.abs(normalizedX - point.x) <= hitRadius) {
          hits.push({
            id: `percussion-${stroke.id}`,
            kind: "percussion",
            voice: stroke.voice,
            color: stroke.color,
            y: point.y,
          });
        }
        return;
      }
      const ys = splineSegments(stroke).flatMap((segment) =>
        segmentIntersections(segment, normalizedX, verticalTolerance)
      );

      // A single winding stroke can cross the playhead many times. Sort the
      // crossings vertically and merge only points that are visually the same
      // intersection (usually two adjacent segments sharing an endpoint).
      ys.sort((a, b) => a - b);
      const mergeDistance = 7 / state.height;
      const clusters = [];
      ys.forEach((y) => {
        const cluster = clusters[clusters.length - 1];
        if (cluster && Math.abs(y - cluster.average) <= mergeDistance) {
          cluster.values.push(y);
          cluster.average = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
        } else {
          clusters.push({ values: [y], average: y });
        }
      });

      // Preserve oscillator identity as crossings appear and disappear. Using
      // the vertical array index directly causes every lower voice to be
      // reassigned when a crossing above it vanishes.
      const previousTracks = intersectionTracks.get(stroke.id) || [];
      const tracked = clusters.map((cluster) => ({ id: null, y: cluster.average }));
      const candidates = [];
      previousTracks.forEach((previous, previousIndex) => {
        tracked.forEach((current, currentIndex) => {
          candidates.push({
            previousIndex,
            currentIndex,
            distance: Math.abs(previous.y - current.y),
          });
        });
      });
      candidates.sort((a, b) => a.distance - b.distance);
      const usedPrevious = new Set();
      const usedCurrent = new Set();
      const maximumTrackingDistance = 80 / state.height;
      candidates.forEach((candidate) => {
        if (candidate.distance > maximumTrackingDistance
          || usedPrevious.has(candidate.previousIndex)
          || usedCurrent.has(candidate.currentIndex)) return;
        tracked[candidate.currentIndex].id = previousTracks[candidate.previousIndex].id;
        usedPrevious.add(candidate.previousIndex);
        usedCurrent.add(candidate.currentIndex);
      });

      tracked.forEach((track) => {
        if (!track.id) track.id = `intersection-${nextIntersectionId++}`;
        hits.push({
          id: track.id,
          voice: stroke.voice,
          color: stroke.color,
          y: track.y,
        });
      });
      if (tracked.length) nextTracks.set(stroke.id, tracked);
    });
    intersectionTracks = nextTracks;
    return hits;
  }

  function drawGrid() {
    const grid = currentGrid();
    if (!grid.beats) return;
    ctx.save();
    ctx.lineWidth = 1;

    for (let beat = 0; beat <= grid.beats; beat++) {
      const x = beat / grid.beats * state.width;
      const isMajorBeat = beat % Math.max(1, grid.beats / 4) === 0;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, state.height);
      ctx.strokeStyle = isMajorBeat ? "rgba(114,241,184,.16)" : "rgba(255,255,255,.065)";
      ctx.stroke();
    }

    grid.pitchIndices.forEach((pitchIndex) => {
      const y = gridYForPitchIndex(pitchIndex) * state.height;
      const isOctave = pitchIndex === 0 || pitchIndex === 7 || pitchIndex === 14;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(state.width, y);
      ctx.strokeStyle = isOctave ? "rgba(180,140,255,.18)" : "rgba(255,255,255,.07)";
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawSweep() {
    const x = state.sweep * state.width;
    const gradient = ctx.createLinearGradient(x, 0, x + 18, 0);
    gradient.addColorStop(0, "rgba(255,255,255,.92)");
    gradient.addColorStop(.18, "rgba(114,241,184,.38)");
    gradient.addColorStop(1, "rgba(114,241,184,0)");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.shadowColor = "rgba(114,241,184,.85)";
    ctx.shadowBlur = 15;
    ctx.fillRect(x - 1, 0, 19, state.height);
    ctx.restore();
  }

  function drawIntersections(hits) {
    if (!hits.length) return;
    const x = state.sweep * state.width;
    ctx.save();
    hits.forEach((hit) => {
      const y = hit.y * state.height;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#050609";
      ctx.shadowColor = "rgba(255,255,255,.5)";
      ctx.shadowBlur = 3;
      ctx.fill();
    });
    ctx.restore();
  }

  function render(time) {
    const dt = Math.min((time - state.previousTime) / 1000, 0.05);
    state.previousTime = time;
    let hits = [];
    if (state.playing) {
      const previousSweep = state.sweep;
      state.sweep = (state.sweep + dt / state.sweepDuration) % 1;
      if (state.sweep < previousSweep) intersectionTracks.clear();
      hits = intersectionsAt(state.sweep);
      audio?.update(hits);
    }
    ctx.clearRect(0, 0, state.width, state.height);
    drawGrid();
    state.strokes.forEach(drawStroke);
    if (state.playing) {
      drawSweep();
      drawIntersections(hits);
    }
    requestAnimationFrame(render);
  }

  async function togglePlay() {
    if (!audio && (window.AudioContext || window.webkitAudioContext)) audio = new AudioEngine();
    if (!audio) {
      showToast("Web Audio is not supported here");
      return;
    }
    try {
      await audio.unlock();
    } catch {
      showToast("Tap play once more to enable sound");
      return;
    }
    if (audio.context.state !== "running") {
      showToast("Turn off Silent Mode, then tap play again");
      return;
    }
    state.playing = !state.playing;
    playButton.setAttribute("aria-pressed", String(state.playing));
    playButton.setAttribute("aria-label", state.playing ? "Pause drawing" : "Play drawing");
    if (!state.playing) {
      audio.silence();
      intersectionTracks.clear();
    }
    else if (state.strokes.length) {
      const first = state.strokes[0];
      if (first.kind === "dot") audio.triggerPercussion(first.voice, first.points[0]?.y ?? 0.5);
      else audio.preview(first.voice, first.points[0]?.y ?? 0.5);
    }
    showToast(state.playing ? "Playing your drawing" : "Paused");
  }

  function chooseColor(button) {
    state.color = button.dataset.color;
    state.voice = button.dataset.voice;
    state.instrumentKind = button.dataset.kind || "line";
    state.erasing = false;
    state.deletingCurve = false;
    eraserButton.setAttribute("aria-pressed", "false");
    deleteCurveButton.setAttribute("aria-pressed", "false");
    canvas.style.cursor = "crosshair";
    swatches.forEach((swatch) => {
      const selected = swatch === button;
      swatch.classList.toggle("selected", selected);
      swatch.setAttribute("aria-checked", String(selected));
    });

    // Color taps double as sound previews and provide another iOS-safe gesture
    // with which to unlock Web Audio.
    if (window.AudioContext || window.webkitAudioContext) {
      if (!audio) audio = new AudioEngine();
      audio.unlock().then(() => {
        if (state.instrumentKind === "percussion") audio.triggerPercussion(state.voice);
        else audio.preview(state.voice);
      }).catch(() => {});
    }
  }

  function toggleEraser() {
    state.erasing = !state.erasing;
    state.deletingCurve = false;
    eraserButton.setAttribute("aria-pressed", String(state.erasing));
    deleteCurveButton.setAttribute("aria-pressed", "false");
    canvas.style.cursor = state.erasing ? "cell" : "crosshair";
  }

  function toggleDeleteCurve() {
    state.deletingCurve = !state.deletingCurve;
    state.erasing = false;
    deleteCurveButton.setAttribute("aria-pressed", String(state.deletingCurve));
    eraserButton.setAttribute("aria-pressed", "false");
    canvas.style.cursor = state.deletingCurve ? "not-allowed" : "crosshair";
  }

  function toggleMore() {
    const open = !moreControls.classList.contains("open");
    moreControls.classList.toggle("open", open);
    moreControls.setAttribute("aria-hidden", String(!open));
    moreButton.setAttribute("aria-expanded", String(open));
  }

  function updateGridButton() {
    const grid = currentGrid();
    gridButton.textContent = `Grid: ${grid.name}`;
    gridButton.setAttribute("aria-label", grid.beats
      ? `${grid.name} grid with ${grid.beats} time divisions`
      : "Grid is off");
  }

  function cycleGrid() {
    state.gridMode = (state.gridMode + 1) % GRID_MODES.length;
    updateGridButton();
    scheduleSave();
    const grid = currentGrid();
    showToast(grid.beats ? `${grid.name}: ${grid.beats} beats` : "Grid off");
  }

  function updateEmptyState() {
    const empty = state.strokes.length === 0;
    hint.classList.toggle("hidden", !empty);
    undoButton.disabled = empty;
  }

  function compositionData() {
    return {
      version: VERSION,
      name: "My Draw Music composition",
      sweepDuration: state.sweepDuration,
      gridMode: state.gridMode,
      strokes: state.strokes,
    };
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(compositionData())); } catch { /* Storage may be unavailable. */ }
    }, 180);
  }

  function loadComposition(data, notify = true) {
    if (!data || !Array.isArray(data.strokes)) throw new Error("Not a Draw Music file");
    const validStrokes = data.strokes.filter((stroke) =>
      typeof stroke.color === "string" && typeof stroke.voice === "string" && Array.isArray(stroke.points)
    );
    state.strokes = validStrokes.map((stroke) => {
      const isDot = stroke.kind === "dot" || Boolean(percussionSettings[stroke.voice]);
      return {
        id: nextStrokeId++,
        kind: isDot ? "dot" : "line",
        geometry: stroke.geometry === "grid" ? "grid" : "spline",
        color: stroke.color,
        voice: isDot
          ? (percussionSettings[stroke.voice] ? stroke.voice : "kick")
          : (voiceSettings[stroke.voice] ? stroke.voice : "bloom"),
        size: Number(stroke.size) || (isDot ? 16 : 5.5),
        points: stroke.points.map((point) => ({ x: clamp(Number(point.x), 0, 1), y: clamp(Number(point.y), 0, 1), p: clamp(Number(point.p) || .55, .1, 1) })),
      };
    }).filter((stroke) => stroke.points.length >= (stroke.kind === "dot" ? 1 : 2));
    state.sweepDuration = clamp(Number(data.sweepDuration) || 8, 4, 16);
    state.gridMode = clamp(Math.round(Number(data.gridMode) || 0), 0, GRID_MODES.length - 1);
    tempoRange.value = String(state.sweepDuration);
    tempoOutput.value = `${state.sweepDuration}s`;
    updateGridButton();
    updateEmptyState();
    scheduleSave();
    if (notify) showToast("Composition loaded");
  }

  function restoreLocal() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) loadComposition(JSON.parse(stored), false);
    } catch { localStorage.removeItem(STORAGE_KEY); }
  }

  function saveJson() {
    const blob = new Blob([JSON.stringify(compositionData(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `draw-music-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("JSON saved");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1500);
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  playButton.addEventListener("click", togglePlay);
  eraserButton.addEventListener("click", toggleEraser);
  deleteCurveButton.addEventListener("click", toggleDeleteCurve);
  moreButton.addEventListener("click", toggleMore);
  gridButton.addEventListener("click", cycleGrid);
  swatches.forEach((button) => button.addEventListener("click", () => chooseColor(button)));
  tempoRange.addEventListener("input", () => {
    state.sweepDuration = Number(tempoRange.value);
    tempoOutput.value = `${state.sweepDuration}s`;
    scheduleSave();
  });
  undoButton.addEventListener("click", () => {
    state.strokes.pop();
    updateEmptyState();
    scheduleSave();
  });
  clearButton.addEventListener("click", () => {
    if (!state.playing) state.sweep = 0;
    if (!state.strokes.length) return;
    state.strokes = [];
    audio?.silence();
    intersectionTracks.clear();
    updateEmptyState();
    scheduleSave();
    showToast("Canvas cleared");
  });
  saveButton.addEventListener("click", saveJson);
  loadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files;
    if (!file) return;
    try { loadComposition(JSON.parse(await file.text())); }
    catch { showToast("Could not load that file"); }
    fileInput.value = "";
  });
  window.addEventListener("resize", resizeCanvas, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.playing) {
      state.playing = false;
      playButton.setAttribute("aria-pressed", "false");
      audio?.silence();
    }
  });
  // Safari can still recognize its proprietary pinch gesture even when the
  // viewport and CSS disallow scaling. Cancel it at the document boundary.
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("gesturechange", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("gestureend", (event) => event.preventDefault(), { passive: false });

  resizeCanvas();
  restoreLocal();
  updateGridButton();
  updateEmptyState();
  requestAnimationFrame(render);
})();
