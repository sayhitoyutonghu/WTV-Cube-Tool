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
  cameraYaw: number;
  cameraPitch: number;
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
    shadow: 48,
    cameraYaw: 45,
    cameraPitch: 35,
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
    cameraYaw: 40,
    cameraPitch: 31,
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
    cameraYaw: 50,
    cameraPitch: 42,
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
  const cornerIndexes = [0, width - 1, (height - 1) * width, height * width - 1];
  const hasTransparentBackground = cornerIndexes.some((pixelIndex) => pixels.data[pixelIndex * 4 + 3] < 32);
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
      if (alpha > 8 && (hasTransparentBackground || !isWhite)) {
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

  if (!hasTransparentBackground) {
    const croppedPixels = croppedContext.getImageData(0, 0, cropWidth, cropHeight);
    const pixelCount = cropWidth * cropHeight;
    const backgroundMask = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let queueStart = 0;
    let queueEnd = 0;
    const isWhiteBackground = (pixelIndex: number) => {
      const dataIndex = pixelIndex * 4;
      return croppedPixels.data[dataIndex + 3] < 16 || (
        croppedPixels.data[dataIndex] > 232 &&
        croppedPixels.data[dataIndex + 1] > 232 &&
        croppedPixels.data[dataIndex + 2] > 232
      );
    };
    const enqueueBackground = (pixelIndex: number) => {
      if (pixelIndex < 0 || pixelIndex >= pixelCount || backgroundMask[pixelIndex] || !isWhiteBackground(pixelIndex)) return;
      backgroundMask[pixelIndex] = 1;
      queue[queueEnd] = pixelIndex;
      queueEnd += 1;
    };

    for (let x = 0; x < cropWidth; x += 1) {
      enqueueBackground(x);
      enqueueBackground((cropHeight - 1) * cropWidth + x);
    }
    for (let y = 0; y < cropHeight; y += 1) {
      enqueueBackground(y * cropWidth);
      enqueueBackground(y * cropWidth + cropWidth - 1);
    }
    while (queueStart < queueEnd) {
      const pixelIndex = queue[queueStart];
      queueStart += 1;
      const x = pixelIndex % cropWidth;
      if (x > 0) enqueueBackground(pixelIndex - 1);
      if (x < cropWidth - 1) enqueueBackground(pixelIndex + 1);
      enqueueBackground(pixelIndex - cropWidth);
      enqueueBackground(pixelIndex + cropWidth);
    }
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (backgroundMask[pixelIndex]) croppedPixels.data[pixelIndex * 4 + 3] = 0;
    }
    croppedContext.putImageData(croppedPixels, 0, 0);
  }
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

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function cameraVector(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = yawDegrees * Math.PI / 180;
  const pitch = pitchDegrees * Math.PI / 180;
  return normalize({
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  });
}

function project(point: Vec3, width: number, height: number, scale: number, yawDegrees: number, pitchDegrees: number): Vec2 {
  const yaw = yawDegrees * Math.PI / 180;
  const pitch = pitchDegrees * Math.PI / 180;
  const isoX = point.x * Math.cos(yaw) - point.z * Math.sin(yaw);
  const depth = point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
  const cameraY = point.y * Math.cos(pitch) - depth * Math.sin(pitch);
  return {
    x: width * 0.5 + isoX * scale,
    y: height * 0.49 - cameraY * scale,
  };
}

function polygon(ctx: CanvasRenderingContext2D, points: Vec2[], fill: string | CanvasGradient, edgeAlpha = 0.055) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = `rgba(255, 255, 255, ${edgeAlpha})`;
  ctx.lineWidth = 0.65;
  ctx.stroke();
}

function faceGradient(ctx: CanvasRenderingContext2D, points: Vec2[], color: string, lightAmount: number) {
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const gradient = ctx.createLinearGradient(0, minY, 0, Math.max(minY + 1, maxY));
  gradient.addColorStop(0, shade(color, lightAmount + 0.045));
  gradient.addColorStop(0.48, shade(color, lightAmount));
  gradient.addColorStop(1, shade(color, lightAmount - 0.035));
  return gradient;
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
    const maxLogoWidth = 0.82;
    const maxLogoHeight = 0.62;
    const logoWidth = logoAspect >= maxLogoWidth / maxLogoHeight ? maxLogoWidth : maxLogoHeight * logoAspect;
    const logoHeight = logoAspect >= maxLogoWidth / maxLogoHeight ? maxLogoWidth / logoAspect : maxLogoHeight;
    ctx.drawImage(logo, (1 - logoWidth) / 2, 0.08 + (maxLogoHeight - logoHeight) / 2, logoWidth, logoHeight);
  } else {
    ctx.fillStyle = ink;
    ctx.fillRect(0.13, 0.14, 0.74, 0.55);
    ctx.fillStyle = cubeColor;
    ctx.font = "900 0.245px Arial Black, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(logoText.slice(0, 4).toUpperCase(), 0.5, 0.425, 0.66);
  }
  ctx.fillStyle = ink;
  ctx.font = "800 0.115px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(subline.slice(0, 12), 0.5, 0.82, 0.82);
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
  const strength = amount / 100;
  let delay = random * 2.7;
  if (mode === "cascade") delay = Math.max(0, (row + 1) * 0.42 + (col + 1) * 0.16 + random * 0.35);
  if (mode === "signal") delay = Math.abs((row + col) % 3) * 0.85 + random * 0.65;

  const settleDuration = 5.4 + hash(index + 8, seed) * 2.8;
  const local = time - delay;
  const progress = clamp(local / settleDuration, 0, 1);
  const decay = local <= 0 ? 1 : Math.pow(1 - progress, 2.35);
  const directionX = hash(index + 17, seed) > 0.5 ? 1 : -1;
  const directionZ = hash(index + 23, seed) > 0.5 ? 1 : -1;
  const initialRx = directionX * (0.48 + hash(index + 31, seed) * 1.18) * strength;
  const initialRz = directionZ * (0.36 + hash(index + 41, seed) * 1.02) * strength;
  const initialRy = (hash(index + 49, seed) - 0.5) * 1.25 * strength;
  const oscillations = 4.2 + hash(index + 57, seed) * 1.8;
  const spring = local <= 0
    ? Math.sin(time * 0.72 + random * Math.PI * 2) * 0.025 * strength
    : Math.sin(progress * Math.PI * oscillations + random * Math.PI) * Math.exp(-progress * 4.15) * strength;
  const bounce = local <= 0
    ? 0
    : Math.abs(Math.sin(progress * Math.PI * (oscillations + 0.8))) * Math.exp(-progress * 3.4) * 0.12 * strength;
  const slideDecay = Math.pow(1 - progress, 2.1);

  return {
    rx: initialRx * decay + spring * 0.48 * directionX,
    rz: initialRz * decay - spring * 0.42 * directionZ,
    ry: initialRy * decay + spring * 0.18,
    lift: bounce,
    offsetX: (hash(index + 67, seed) - 0.5) * 38 * strength * slideDecay + spring * 5,
    offsetZ: (hash(index + 79, seed) - 0.5) * 38 * strength * slideDecay - spring * 4,
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const background = ctx.createRadialGradient(width * 0.43, height * 0.3, 0, width * 0.52, height * 0.54, Math.max(width, height) * 0.88);
  background.addColorStop(0, shade(settings.background, 0.115));
  background.addColorStop(0.54, shade(settings.background, 0.025));
  background.addColorStop(1, shade(settings.background, -0.045));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.022;
  ctx.fillStyle = "#3d3510";
  for (let grainIndex = 0; grainIndex < 180; grainIndex += 1) {
    const grainX = hash(grainIndex + 401, seed) * width;
    const grainY = hash(grainIndex + 809, seed) * height;
    const grainSize = 0.45 + hash(grainIndex + 1201, seed) * 0.8;
    ctx.fillRect(grainX, grainY, grainSize, grainSize);
  }
  ctx.restore();

  const aspect = width / height;
  const columns = Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.35 : aspect < 0.8 ? 0.68 : 1)));
  const rows = Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.78 : aspect < 0.8 ? 1.45 : 1)));
  // Keep the grid footprint stable so cube size remains an independent visual
  // control in every aspect ratio instead of cancelling out through auto-fit.
  const spacing = 76 * 1.72;
  const extent = Math.max(columns, rows) * spacing;
  const extentFactor = aspect > 1.2 ? 0.72 : aspect < 0.8 ? 0.58 : 0.78;
  const scale = Math.min(width, height) / Math.max(420, extent * extentFactor);
  const half = settings.cubeSize / 2;
  const viewVector = cameraVector(settings.cameraYaw, settings.cameraPitch);
  const yawRadians = settings.cameraYaw * Math.PI / 180;
  const projectPoint = (point: Vec3) => project(point, width, height, scale, settings.cameraYaw, settings.cameraPitch);
  const cubes: Array<{ index: number; row: number; col: number; x: number; z: number; depth: number }> = [];

  for (let row = -1; row <= rows; row += 1) {
    for (let col = -1; col <= columns; col += 1) {
      const index = (row + 2) * (columns + 3) + col + 2;
      const offset = row % 2 === 0 ? 0 : spacing * 0.5;
      const x = (col - (columns - 1) / 2) * spacing + offset;
      const z = (row - (rows - 1) / 2) * spacing;
      const depth = x * Math.sin(yawRadians) + z * Math.cos(yawRadians);
      cubes.push({ index, row, col, x, z, depth });
    }
  }
  cubes.sort((a, b) => a.depth - b.depth);

  const shadowStrength = clamp(settings.shadow / 100, 0, 1);
  const drawShadowLayer = (blur: number, alpha: number, radiusX: number, radiusY: number, offsetX: number, offsetY: number) => {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = shadowStrength * alpha;
    ctx.fillStyle = shade(settings.background, -0.68);
    ctx.filter = `blur(${blur}px)`;
    for (const cube of cubes) {
      const movement = getMotion(cube.index, cube.row, cube.col, time * settings.speed, seed, settings.mode, settings.motion);
      const ground = projectPoint({ x: cube.x + movement.offsetX, y: 0, z: cube.z + movement.offsetZ });
      const liftFade = 1 - clamp(movement.lift * 2.8, 0, 0.62);
      ctx.globalAlpha = shadowStrength * alpha * liftFade;
      ctx.beginPath();
      ctx.ellipse(
        ground.x + half * scale * offsetX,
        ground.y + half * scale * offsetY,
        half * scale * radiusX,
        half * scale * radiusY,
        -0.24,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  };
  drawShadowLayer(Math.max(7, half * scale * 0.24), 0.24, 1.02, 0.42, -0.3, 0.42);
  drawShadowLayer(Math.max(2.2, half * scale * 0.075), 0.2, 0.68, 0.24, -0.08, 0.18);

  for (const cube of cubes) {
    const movement = getMotion(cube.index, cube.row, cube.col, time * settings.speed, seed, settings.mode, settings.motion);
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
    const rotatedVertices = localVertices.map((point) => rotate(point, movement.rx, movement.ry, movement.rz));
    const minimumLocalY = Math.min(...rotatedVertices.map((point) => point.y));
    const contactHeight = -minimumLocalY + movement.lift * settings.cubeSize;
    const worldVertices = rotatedVertices.map((point) => ({
      x: point.x + cube.x + movement.offsetX,
      y: point.y + contactHeight,
      z: point.z + cube.z + movement.offsetZ,
    }));
    const screenVertices = worldVertices.map(projectPoint);
    const lightVector = normalize({ x: -0.42, y: 1, z: -0.52 });
    const faceDefinitions = [
      { id: "z-plus", indices: [3, 2, 6, 7], hasMark: true },
      { id: "x-plus", indices: [1, 5, 6, 2], hasMark: false },
      { id: "top", indices: [4, 7, 6, 5], hasMark: false },
      { id: "z-minus", indices: [0, 4, 5, 1], hasMark: false },
      { id: "x-minus", indices: [0, 3, 7, 4], hasMark: false },
      { id: "bottom", indices: [0, 1, 2, 3], hasMark: false },
    ];
    const visibleFaces = faceDefinitions.flatMap((face) => {
      const [first, second, third] = face.indices;
      const normal = normalize(cross(
        subtract(worldVertices[second], worldVertices[first]),
        subtract(worldVertices[third], worldVertices[first]),
      ));
      const visibility = dot(normal, viewVector);
      if (visibility <= 0.015) return [];
      const depth = face.indices.reduce((sum, vertexIndex) => sum + dot(worldVertices[vertexIndex], viewVector), 0) / face.indices.length;
      return [{ ...face, normal, depth }];
    }).sort((a, b) => a.depth - b.depth);

    for (const face of visibleFaces) {
      const points = face.indices.map((vertexIndex) => screenVertices[vertexIndex]);
      const illumination = Math.max(0, dot(face.normal, lightVector));
      const lightAmount = -0.085 + illumination * 0.19;
      polygon(ctx, points, faceGradient(ctx, points, settings.cube, lightAmount));
      if (face.hasMark) {
        // This is the cube's one physical sticker face. Back-face culling keeps
        // the artwork correctly oriented instead of mirroring it on another side.
        drawMark(ctx, points, settings.cube, settings.ink, settings.logoText, settings.subline, logo);
      }
    }
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
    shadow: 48,
    cameraYaw: 45,
    cameraPitch: 35,
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
            <div className="stage-overlay stage-overlay-bottom"><span>SEED {seed.toString().padStart(4, "0")}</span><span>CAM {settings.cameraYaw}° / {settings.cameraPitch}°</span><span>{settings.mode.toUpperCase()} / {settings.speed.toFixed(2)}X</span></div>
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
            <div className="control-divider"><span>CAMERA</span></div>
            <RangeControl label="Orbit" value={settings.cameraYaw} min={25} max={65} suffix="°" onChange={(value) => updateSetting("cameraYaw", value)} />
            <RangeControl label="Elevation" value={settings.cameraPitch} min={20} max={55} suffix="°" onChange={(value) => updateSetting("cameraPitch", value)} />
            <div className="segmented three">
              {(["settle", "cascade", "signal"] as MotionMode[]).map((mode) => <button key={mode} type="button" className={settings.mode === mode ? "active" : ""} onClick={() => updateSetting("mode", mode)}>{mode}</button>)}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading"><span>03</span><h2>BRAND</h2></div>
            <div className="text-grid">
              <label><span>Mark</span><input value={settings.logoText} maxLength={4} onChange={(event) => updateSetting("logoText", event.target.value)} /></label>
              <label><span>Type / subline</span><input value={settings.subline} maxLength={12} onChange={(event) => updateSetting("subline", event.target.value)} /></label>
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
