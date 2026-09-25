(() => {
  "use strict";

  const canvas = document.querySelector("#drawingCanvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  const playButton = document.querySelector("#playButton");
  const eraserButton = document.querySelector("#eraserButton");
  const moreButton = document.querySelector("#moreButton");
  const moreControls = document.querySelector("#moreControls");
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
  const VERSION = 1;
  const state = {
    strokes: [],
    activeStroke: null,
    drawing: false,
    erasing: false,
    color: "#72f1b8",
    voice: "bloom",
    playing: false,
    sweep: 0,
    sweepDuration: 8,
    previousTime: performance.now(),
    width: 1,
    height: 1,
    dpr: 1,
  };

  let audio = null;
  let saveTimer = 0;
  let toastTimer = 0;
  let nextStrokeId = 1;

  const voiceSettings = {
    bloom: { wave: "sine", gain: 0.12, filter: 2600, detune: 0 },
    pluck: { wave: "triangle", gain: 0.1, filter: 1900, detune: 4 },
    spark: { wave: "square", gain: 0.055, filter: 1350, detune: 7 },
    buzz: { wave: "sawtooth", gain: 0.06, filter: 850, detune: -5 },
  };

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
      osc.frequency.value = yToFrequency(normalizedY);
      osc.detune.value = settings.detune;
      filter.type = "lowpass";
      filter.frequency.value = settings.filter;
      filter.Q.value = voiceName === "spark" ? 5 : 1.4;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(settings.gain * 0.72, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + 0.21);
    }

    update(hits) {
      const now = this.context.currentTime;
      const liveIds = new Set(hits.map((hit) => hit.id));

      hits.forEach((hit) => {
        const frequency = yToFrequency(hit.y);
        const existing = this.voices.get(hit.id);
        if (existing) {
          existing.osc.frequency.setTargetAtTime(frequency, now, 0.018);
          existing.gain.gain.setTargetAtTime(existing.volume, now, 0.025);
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
        gain.gain.value = 0.0001;
        osc.connect(filter).connect(gain).connect(this.master);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(settings.gain, now + 0.035);
        this.voices.set(hit.id, { osc, gain, volume: settings.gain });
      });

      this.voices.forEach((voice, id) => {
        if (!liveIds.has(id)) this.release(id, voice, now);
      });
    }

    release(id, voice, now = this.context.currentTime) {
      this.voices.delete(id);
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.055);
      voice.osc.stop(now + 0.28);
    }

    silence() {
      const now = this.context.currentTime;
      this.voices.forEach((voice, id) => this.release(id, voice, now));
    }
  }

  function yToFrequency(normalizedY) {
    const pentatonic = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33];
    const index = Math.round((1 - clamp(normalizedY, 0, 1)) * (pentatonic.length - 1));
    return 110 * Math.pow(2, pentatonic[index] / 12);
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

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    state.drawing = true;
    const point = pointFromEvent(event);
    if (state.erasing) {
      eraseAt(point);
      return;
    }
    state.activeStroke = {
      id: nextStrokeId++,
      color: state.color,
      voice: state.voice,
      size: 5.5,
      points: [point],
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
    const points = state.activeStroke?.points;
    if (!points) return;
    const last = points[points.length - 1];
    const dx = (point.x - last.x) * state.width;
    const dy = (point.y - last.y) * state.height;
    if (Math.hypot(dx, dy) >= 1.4) points.push(point);
  }

  function onPointerUp(event) {
    if (!state.drawing) return;
    state.drawing = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (state.activeStroke?.points.length === 1) {
      const first = state.activeStroke.points[0];
      state.activeStroke.points.push({ ...first, x: first.x + 0.0001 });
    }
    state.activeStroke = null;
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

  function eraseAt(point) {
    const radius = 21;
    const before = state.strokes.length;
    state.strokes = state.strokes.filter((stroke) => {
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
    state.strokes.forEach((stroke) => {
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

      clusters.forEach((cluster, index) => {
        hits.push({
          id: `${stroke.id}:${index}`,
          voice: stroke.voice,
          color: stroke.color,
          y: cluster.average,
        });
      });
    });
    return hits;
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
      state.sweep = (state.sweep + dt / state.sweepDuration) % 1;
      hits = intersectionsAt(state.sweep);
      audio?.update(hits);
    }
    ctx.clearRect(0, 0, state.width, state.height);
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
    if (!state.playing) audio.silence();
    else if (state.strokes.length) {
      const first = state.strokes[0];
      audio.preview(first.voice, first.points[0]?.y ?? 0.5);
    }
    showToast(state.playing ? "Playing your drawing" : "Paused");
  }

  function chooseColor(button) {
    state.color = button.dataset.color;
    state.voice = button.dataset.voice;
    state.erasing = false;
    eraserButton.setAttribute("aria-pressed", "false");
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
      audio.unlock().then(() => audio.preview(state.voice)).catch(() => {});
    }
  }

  function toggleEraser() {
    state.erasing = !state.erasing;
    eraserButton.setAttribute("aria-pressed", String(state.erasing));
    canvas.style.cursor = state.erasing ? "cell" : "crosshair";
  }

  function toggleMore() {
    const open = !moreControls.classList.contains("open");
    moreControls.classList.toggle("open", open);
    moreControls.setAttribute("aria-hidden", String(!open));
    moreButton.setAttribute("aria-expanded", String(open));
  }

  function updateEmptyState() {
    const empty = state.strokes.length === 0;
    hint.classList.toggle("hidden", !empty);
    undoButton.disabled = empty;
  }

  function compositionData() {
    return { version: VERSION, name: "My Draw Music composition", sweepDuration: state.sweepDuration, strokes: state.strokes };
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
    state.strokes = validStrokes.map((stroke) => ({
      id: nextStrokeId++,
      color: stroke.color,
      voice: voiceSettings[stroke.voice] ? stroke.voice : "bloom",
      size: Number(stroke.size) || 5.5,
      points: stroke.points.map((point) => ({ x: clamp(Number(point.x), 0, 1), y: clamp(Number(point.y), 0, 1), p: clamp(Number(point.p) || .55, .1, 1) })),
    })).filter((stroke) => stroke.points.length >= 2);
    state.sweepDuration = clamp(Number(data.sweepDuration) || 8, 4, 16);
    tempoRange.value = String(state.sweepDuration);
    tempoOutput.value = `${state.sweepDuration}s`;
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
  moreButton.addEventListener("click", toggleMore);
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
    if (!state.strokes.length) return;
    state.strokes = [];
    audio?.silence();
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
  updateEmptyState();
  requestAnimationFrame(render);
})();
