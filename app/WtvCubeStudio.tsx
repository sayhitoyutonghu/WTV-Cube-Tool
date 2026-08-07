"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Aspect = "16:9" | "9:16" | "1:1";
type MotionMode = "settle" | "cascade" | "signal";
type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; y: number };

type Settings = {
  density: number;
  cubeSize: number;
  motion: number;
  speed: number;
  shadow: number;
  background: string;
  cube: string;
  ink: string;
  logoText: string;
  subline: string;
  mode: MotionMode;
};

const DURATION = 15;
const RESOLUTIONS: Record<Aspect, [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1080, 1080],
};

const PRESETS: Record<string, Partial<Settings>> = {
  Reference: {
    density: 7,
    cubeSize: 76,
    motion: 64,
    speed: 1,
    shadow: 52,
    background: "#f5df18",
    cube: "#f1da1d",
    ink: "#111111",
    mode: "settle",
  },
  Broadcast: {
    density: 6,
    cubeSize: 84,
    motion: 78,
    speed: 1.15,
    shadow: 42,
    background: "#08a8df",
    cube: "#fff348",
    ink: "#111111",
    mode: "cascade",
  },
  Minimal: {
    density: 5,
    cubeSize: 94,
    motion: 34,
    speed: 0.72,
    shadow: 30,
    background: "#f0eee6",
    cube: "#ff493d",
    ink: "#111111",
    mode: "signal",
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hash(value: number, seed: number) {
  const n = Math.sin(value * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function shade(hex: string, amount: number) {
  const { r, g, b } = hexToRgb(hex);
  const target = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return `rgb(${Math.round(r + (target - r) * p)}, ${Math.round(g + (target - g) * p)}, ${Math.round(b + (target - b) * p)})`;
}

function prepareLogoSource(image: HTMLImageElement) {
  const maxDimension = 1200;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const working = document.createElement("canvas");
  working.width = width;
  working.height = height;
  const workingContext = working.getContext("2d", { willReadFrequently: true });
  if (!workingContext) return working;
  workingContext.drawImage(image, 0, 0, width, height);

  const pixels = workingContext.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const red = pixels.data[index];
      const green = pixels.data[index + 1];
      const blue = pixels.data[index + 2];
      const alpha = pixels.data[index + 3];
      const isWhite = red > 246 && green > 246 && blue > 246;
      if (alpha > 8 && !isWhite) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (minX > maxX || minY > maxY) return working;
  const padding = Math.max(4, Math.round(Math.max(width, height) * 0.008));
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const cropped = document.createElement("canvas");
  cropped.width = cropWidth;
  cropped.height = cropHeight;
  const croppedContext = cropped.getContext("2d", { willReadFrequently: true });
  if (!croppedContext) return working;
  croppedContext.drawImage(working, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const croppedPixels = croppedContext.getImageData(0, 0, cropWidth, cropHeight);
  for (let index = 0; index < croppedPixels.data.length; index += 4) {
    const red = croppedPixels.data[index];
    const green = croppedPixels.data[index + 1];
    const blue = croppedPixels.data[index + 2];
    const whiteness = Math.min(red, green, blue);
    const matte = clamp((250 - whiteness) / 18, 0, 1);
    croppedPixels.data[index + 3] = Math.round(croppedPixels.data[index + 3] * matte);
  }
  croppedContext.putImageData(croppedPixels, 0, 0);
  return cropped;
}

function rotate(point: Vec3, rx: number, ry: number, rz: number): Vec3 {
  let { x, y, z } = point;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  y = y1;
  z = z1;

  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2;
  z = z2;

  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return { x: x * cz - y * sz, y: x * sz + y * cz, z };
}

function project(point: Vec3, width: number, height: number, scale: number): Vec2 {
  const isoX = (point.x - point.z) * 0.7071;
  const depth = (point.x + point.z) * 0.7071;
  const pitch = 0.61;
  const cameraY = point.y * Math.cos(pitch) - depth * Math.sin(pitch);
  return {
    x: width * 0.5 + isoX * scale,
    y: height * 0.49 - cameraY * scale,
  };
}

function polygon(ctx: CanvasRenderingContext2D, points: Vec2[], fill: string) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function clipFace(ctx: CanvasRenderingContext2D, points: Vec2[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();
  ctx.clip();
}

function drawMark(
  ctx: CanvasRenderingContext2D,
  corners: Vec2[],
  cubeColor: string,
  ink: string,
  logoText: string,
  subline: string,
  logo: HTMLCanvasElement | null,
) {
  const bottomLeft = corners[0];
  const topRight = corners[2];
  const topLeft = corners[3];

  ctx.save();
  clipFace(ctx, corners);
  ctx.transform(
    topRight.x - topLeft.x,
    topRight.y - topLeft.y,
    bottomLeft.x - topLeft.x,
    bottomLeft.y - topLeft.y,
    topLeft.x,
    topLeft.y,
  );

  if (logo) {
    const logoAspect = logo.width / logo.height;
    const logoWidth = logoAspect >= 1 ? 0.92 : 0.92 * logoAspect;
    const logoHeight = logoAspect >= 1 ? 0.92 / logoAspect : 0.92;
    ctx.drawImage(logo, (1 - logoWidth) / 2, (1 - logoHeight) / 2, logoWidth, logoHeight);
  } else {
    ctx.fillStyle = ink;
    ctx.fillRect(0.13, 0.14, 0.74, 0.55);
    ctx.fillStyle = cubeColor;
    ctx.font = "900 0.245px Arial Black, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(logoText.slice(0, 4).toUpperCase(), 0.5, 0.425, 0.66);
    ctx.fillStyle = ink;
    ctx.font = "800 0.11px Arial, sans-serif";
    ctx.fillText(subline.slice(0, 10).toUpperCase(), 0.5, 0.81, 0.78);
  }
  ctx.restore();
}

function getMotion(
  index: number,
  row: number,
  col: number,
  time: number,
  seed: number,
  mode: MotionMode,
  amount: number,
) {
  const random = hash(index + 1, seed);
  let delay = random * 7.2;
  if (mode === "cascade") delay = (row * 0.58 + col * 0.2) % 7.4;
  if (mode === "signal") delay = ((row + col) % 3) * 1.6 + random * 1.2;

  const local = (time - delay + DURATION) % DURATION;
  const active = local < 5.4;
  const envelope = active ? Math.exp(-local * 0.62) : 0;
  const kick = Math.sin(local * (5.7 + random * 2.2)) * envelope;
  const magnitude = (amount / 100) * (0.28 + random * 0.95);
  const direction = hash(index + 17, seed) > 0.5 ? 1 : -1;

  return {
    rx: kick * magnitude * direction * (hash(index + 33, seed) > 0.36 ? 1 : 0.25),
    rz: kick * magnitude * -direction * (hash(index + 51, seed) > 0.52 ? 0.72 : 0.18),
    ry: kick * magnitude * 0.22,
    lift: Math.abs(kick) * magnitude * 0.42,
  };
}

function drawScene(
  canvas: HTMLCanvasElement,
  settings: Settings,
  time: number,
  seed: number,
  logo: HTMLCanvasElement | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;

  const background = ctx.createRadialGradient(width * 0.48, height * 0.38, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.82);
  background.addColorStop(0, shade(settings.background, 0.08));
  background.addColorStop(0.68, settings.background);
  background.addColorStop(1, shade(settings.background, -0.055));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const aspect = width / height;
  const columns = Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.35 : aspect < 0.8 ? 0.68 : 1)));
  const rows = Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.78 : aspect < 0.8 ? 1.45 : 1)));
  const spacing = settings.cubeSize * 1.72;
  const extent = Math.max(columns, rows) * spacing;
  const scale = Math.min(width, height) / Math.max(420, extent * (aspect > 1.2 ? 0.72 : 0.58));
  const half = settings.cubeSize / 2;
  const cubes: Array<{ index: number; row: number; col: number; x: number; z: number; depth: number }> = [];

  for (let row = -1; row <= rows; row += 1) {
    for (let col = -1; col <= columns; col += 1) {
      const index = (row + 2) * (columns + 3) + col + 2;
      const offset = row % 2 === 0 ? 0 : spacing * 0.5;
      const x = (col - (columns - 1) / 2) * spacing + offset;
      const z = (row - (rows - 1) / 2) * spacing;
      cubes.push({ index, row, col, x, z, depth: x + z });
    }
  }
  cubes.sort((a, b) => a.depth - b.depth);

  ctx.save();
  ctx.globalAlpha = clamp(settings.shadow / 100, 0, 0.8) * 0.36;
  ctx.fillStyle = "#4d4510";
  ctx.filter = `blur(${Math.max(4, half * scale * 0.17)}px)`;
  for (const cube of cubes) {
    const ground = project({ x: cube.x, y: 0, z: cube.z }, width, height, scale);
    ctx.beginPath();
    ctx.ellipse(ground.x - half * scale * 0.28, ground.y + half * scale * 0.34, half * scale * 0.84, half * scale * 0.35, -0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  for (const cube of cubes) {
    const movement = getMotion(cube.index, cube.row, cube.col, time * settings.speed, seed, settings.mode, settings.motion);
    const yCenter = half + movement.lift * settings.cubeSize;
    const localVertices: Vec3[] = [
      { x: -half, y: -half, z: -half },
      { x: half, y: -half, z: -half },
      { x: half, y: -half, z: half },
      { x: -half, y: -half, z: half },
      { x: -half, y: half, z: -half },
      { x: half, y: half, z: -half },
      { x: half, y: half, z: half },
      { x: -half, y: half, z: half },
    ];
    const vertices = localVertices.map((point) => {
      const turned = rotate(point, movement.rx, movement.ry, movement.rz);
      return project({ x: turned.x + cube.x, y: turned.y + yCenter, z: turned.z + cube.z }, width, height, scale);
    });

    const top = [vertices[4], vertices[5], vertices[6], vertices[7]];
    const xFace = [vertices[1], vertices[2], vertices[6], vertices[5]];
    const zFace = [vertices[3], vertices[2], vertices[6], vertices[7]];

    polygon(ctx, zFace, shade(settings.cube, -0.105));
    polygon(ctx, xFace, shade(settings.cube, -0.035));
    polygon(ctx, top, shade(settings.cube, 0.105));

    // The mark is a physical sticker on one local face only. The z-face corner
    // order stays top-left to top-right, so the artwork never mirrors.
    drawMark(ctx, zFace, settings.cube, settings.ink, settings.logoText, settings.subline, logo);
  }

  const vignette = ctx.createRadialGradient(width * 0.5, height * 0.47, Math.min(width, height) * 0.22, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.07)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function RangeControl({ label, value, min, max, step = 1, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  const percentage = ((value - min) / (max - min)) * 100;
  return (
    <label className="control range-control">
      <span className="control-label"><span>{label}</span><output>{value}{suffix}</output></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--range-fill": `${percentage}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="color-control">
      <span>{label}</span>
      <span className="color-value">{value.toUpperCase()}<input type="color" value={value} aria-label={`${label} color`} onChange={(event) => onChange(event.target.value)} /></span>
    </label>
  );
}

export default function WtvCubeStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const playheadRef = useRef(0);
  const logoRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [recording, setRecording] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [seed, setSeed] = useState(24);
  const [preset, setPreset] = useState("Reference");
  const [notice, setNotice] = useState("LIVE PREVIEW");
  const [settings, setSettings] = useState<Settings>({
    density: 7,
    cubeSize: 76,
    motion: 64,
    speed: 1,
    shadow: 52,
    background: "#f5df18",
    cube: "#f1da1d",
    ink: "#111111",
    logoText: "WTV",
    subline: "MUSIC",
    mode: "settle",
  });

  const [canvasWidth, canvasHeight] = RESOLUTIONS[aspect];
  const ratioClass = aspect.replace(":", "-");

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setPreset("Custom");
  }, []);

  const activateDefaultLogo = useCallback(() => {
    const image = new Image();
    image.onload = () => {
      logoRef.current = prepareLogoSource(image);
      setNotice("WTV LOGO ACTIVE");
      window.setTimeout(() => setNotice("LIVE PREVIEW"), 1000);
    };
    image.src = "/wtv-logo.png";
  }, []);

  useEffect(() => {
    activateDefaultLogo();
  }, [activateDefaultLogo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    drawScene(canvas, settings, playheadRef.current, seed, logoRef.current);
  }, [canvasWidth, canvasHeight, seed, settings]);

  useEffect(() => {
    const tick = (timestamp: number) => {
      if (!lastFrameRef.current) lastFrameRef.current = timestamp;
      const delta = Math.min(0.05, (timestamp - lastFrameRef.current) / 1000);
      lastFrameRef.current = timestamp;
      if (playing) {
        playheadRef.current = (playheadRef.current + delta) % DURATION;
        if (Math.floor(timestamp / 90) !== Math.floor((timestamp - delta * 1000) / 90)) {
          setPlayhead(playheadRef.current);
        }
      }
      if (canvasRef.current) drawScene(canvasRef.current, settings, playheadRef.current, seed, logoRef.current);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [playing, seed, settings]);

  const setTimeline = (value: number) => {
    playheadRef.current = value;
    setPlayhead(value);
  };

  const restart = () => {
    setTimeline(0);
    setPlaying(true);
    setNotice("RESTARTED");
    window.setTimeout(() => setNotice("LIVE PREVIEW"), 1000);
  };

  const randomize = () => {
    setSeed((current) => (current * 9301 + 49297) % 9999);
    setTimeline(0);
    setNotice("NEW SEED");
    window.setTimeout(() => setNotice("LIVE PREVIEW"), 1000);
  };

  const applyPreset = (name: string) => {
    const values = PRESETS[name];
    setSettings((current) => ({ ...current, ...values }));
    setPreset(name);
    setTimeline(0);
  };

  const uploadLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      logoRef.current = prepareLogoSource(image);
      URL.revokeObjectURL(url);
      setNotice("LOGO LOADED");
      setSeed((current) => current + 1);
    };
    image.src = url;
  };

  const clearLogo = () => {
    logoRef.current = null;
    setSeed((current) => current + 1);
    setNotice("TEXT LOGO");
  };

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `WTV-cubes-${aspect.replace(":", "x")}-${seed}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setNotice("PNG SAVED");
  };

  const recordVideo = async () => {
    const canvas = canvasRef.current;
    if (!canvas || recording) return;
    if (!("MediaRecorder" in window) || !canvas.captureStream) {
      setNotice("RECORDING UNSUPPORTED");
      return;
    }
    setRecording(true);
    setNotice("REC 00:15");
    setTimeline(0);
    setPlaying(true);
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `WTV-cubes-${aspect.replace(":", "x")}-${seed}.webm`;
      link.href = url;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
      setNotice("VIDEO SAVED");
    };
    recorder.start(250);
    window.setTimeout(() => recorder.stop(), DURATION * 1000);
  };

  const dragTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const update = (clientX: number) => {
      const rect = target.getBoundingClientRect();
      setTimeline(clamp((clientX - rect.left) / rect.width, 0, 1) * DURATION);
    };
    update(event.clientX);
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => update(moveEvent.clientX);
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };

  const formattedTime = useMemo(() => `${Math.floor(playhead).toString().padStart(2, "0")}:${Math.floor((playhead % 1) * 30).toString().padStart(2, "0")}`, [playhead]);

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">WTV</span>
          <span className="brand-title">CUBE STUDIO</span>
          <span className="version">v1.0</span>
        </div>
        <div className="top-meta"><span className="live-dot" /> RESPONSIVE BUMPER GENERATOR <span>15 SEC LOOP</span></div>
      </header>

      <section className="workspace">
        <div className="preview-column">
          <div className={`stage stage-${ratioClass}`}>
            <canvas ref={canvasRef} className="motion-canvas" aria-label="Animated WTV cube preview" />
            <div className="stage-overlay stage-overlay-top"><span>{notice}</span><span>{aspect} / {canvasWidth} x {canvasHeight}</span></div>
            <div className="stage-overlay stage-overlay-bottom"><span>SEED {seed.toString().padStart(4, "0")}</span><span>{settings.mode.toUpperCase()} / {settings.speed.toFixed(2)}X</span></div>
          </div>

          <div className="transport">
            <button className="play-button" type="button" onClick={() => setPlaying((current) => !current)} aria-label={playing ? "Pause animation" : "Play animation"}>{playing ? "Ⅱ" : "▶"}</button>
            <span className="timecode">{formattedTime}</span>
            <div className="timeline" onPointerDown={dragTimeline} role="slider" aria-label="Animation playhead" aria-valuemin={0} aria-valuemax={DURATION} aria-valuenow={playhead} tabIndex={0}>
              <span className="timeline-fill" style={{ width: `${(playhead / DURATION) * 100}%` }} />
              <span className="timeline-head" style={{ left: `${(playhead / DURATION) * 100}%` }} />
              {[0, 3, 6, 9, 12, 15].map((time) => <i key={time} style={{ left: `${(time / DURATION) * 100}%` }} />)}
            </div>
            <span className="timecode">15:00</span>
            <button className="transport-button" type="button" onClick={restart}>↺ RESET</button>
            <button className="transport-button" type="button" onClick={randomize}>✦ NEW SEED</button>
          </div>
        </div>

        <aside className="control-panel">
          <section className="panel-section preset-section">
            <div className="section-heading"><span>01</span><h2>LOOK</h2><small>{preset}</small></div>
            <div className="preset-grid">
              {Object.keys(PRESETS).map((name) => <button key={name} type="button" className={preset === name ? "active" : ""} onClick={() => applyPreset(name)}>{name}</button>)}
            </div>
            <ColorControl label="Background" value={settings.background} onChange={(value) => updateSetting("background", value)} />
            <ColorControl label="Cube faces" value={settings.cube} onChange={(value) => updateSetting("cube", value)} />
            <ColorControl label="Logo / ink" value={settings.ink} onChange={(value) => updateSetting("ink", value)} />
          </section>

          <section className="panel-section">
            <div className="section-heading"><span>02</span><h2>GRID + MOTION</h2></div>
            <RangeControl label="Density" value={settings.density} min={4} max={10} onChange={(value) => updateSetting("density", value)} />
            <RangeControl label="Cube size" value={settings.cubeSize} min={48} max={112} suffix=" px" onChange={(value) => updateSetting("cubeSize", value)} />
            <RangeControl label="Tumble" value={settings.motion} min={0} max={100} suffix="%" onChange={(value) => updateSetting("motion", value)} />
            <RangeControl label="Speed" value={settings.speed} min={0.35} max={1.8} step={0.05} suffix="x" onChange={(value) => updateSetting("speed", value)} />
            <RangeControl label="Soft shadow" value={settings.shadow} min={0} max={100} suffix="%" onChange={(value) => updateSetting("shadow", value)} />
            <div className="segmented three">
              {(["settle", "cascade", "signal"] as MotionMode[]).map((mode) => <button key={mode} type="button" className={settings.mode === mode ? "active" : ""} onClick={() => updateSetting("mode", mode)}>{mode}</button>)}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading"><span>03</span><h2>BRAND</h2></div>
            <div className="text-grid">
              <label><span>Mark</span><input value={settings.logoText} maxLength={4} onChange={(event) => updateSetting("logoText", event.target.value)} /></label>
              <label><span>Subline</span><input value={settings.subline} maxLength={10} onChange={(event) => updateSetting("subline", event.target.value)} /></label>
            </div>
            <div className="upload-row three">
              <button type="button" onClick={activateDefaultLogo}>WTV LOGO</button>
              <label className="upload-button">UPLOAD LOGO<input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadLogo} /></label>
              <button type="button" onClick={clearLogo}>USE TEXT MARK</button>
            </div>
          </section>

          <section className="panel-section export-section">
            <div className="section-heading"><span>04</span><h2>FORMAT + EXPORT</h2></div>
            <div className="segmented">
              {(["16:9", "9:16", "1:1"] as Aspect[]).map((item) => <button key={item} type="button" className={aspect === item ? "active" : ""} onClick={() => setAspect(item)}>{item}</button>)}
            </div>
            <div className="export-grid">
              <button className="primary-action" type="button" onClick={recordVideo} disabled={recording}>{recording ? "RECORDING 15S..." : "● RECORD WEBM"}</button>
              <button type="button" onClick={downloadPng}>DOWNLOAD PNG</button>
            </div>
            <p>Video records the live 15-second loop at 30 fps. Use the same seed across aspect ratios for a matched rollout system.</p>
          </section>
        </aside>
      </section>
    </main>
  );
}
