"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

type Aspect = "16:9" | "9:16" | "1:1";
type MotionMode = "settle" | "roll";
type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; y: number };

type Settings = {
  density: number;
  cubeSize: number;
  sequenceDuration: number;
  motion: number;
  gravity: number;
  bounce: number;
  speed: number;
  alignSpeed: number;
  shadow: number;
  cameraYaw: number;
  cameraPitch: number;
  cameraZoom: number;
  background: string;
  cube: string;
  ink: string;
  logoText: string;
  subline: string;
  mode: MotionMode;
};

const MAX_DURATION = 10;
const EXPORT_FPS = 30;
// Simulation time by which every mode has come to rest, leaving a beat of held
// frames before the loop point.
const SEQUENCE_END = 8.6;
// Roll mode. Every cube tips this many quarter turns, all in one direction.
// A multiple of four, so the mark finishes upright again.
const ROLL_TURNS = 4;
const ROLL_CYCLE = 1.35;
// Fraction of a cycle spent tipping; the rest is the cube sitting still. Keep
// it low — in the reference only a handful of cubes are moving at any instant.
const ROLL_TIP_FRACTION = 0.35;
// Spread of release times across the grid. Wider means fewer cubes tipping at
// once, which is what makes the motion read as a wave crossing a settled field.
const ROLL_STAGGER = 7;
// Per-cube jitter on top of the diagonal wave. Without it whole diagonals tip
// in lockstep and open a bare stripe across the field.
const ROLL_SCATTER = 0.75;
// Lattice pitch in cube widths while rolling. Anything under 2 lets a rolled
// cube overlap a neighbour still sitting on its cell; past about 3 the ground
// opens up far wider than the footage. Picked at 2.4 by rendering 2.4/2.7/3.0
// beside a reference frame. The travel needn't divide into the pitch — the
// field just ends on a lattice offset from where it started.
const ROLL_SPACING = 2.4;
// Grid pitch every mode is framed against, so switching modes never changes how
// large a cube appears.
const BASE_SPACING = 76 * 1.72;
// How tightly the grid is framed, shared by every mode so drop and roll look
// through the same camera. Calibrated on cube size against the reference
// footage rather than on mark size: its mark covers about 45% of a cube face
// where this one covers 74%, so matching the marks would leave the cubes a
// third too small. Keep it above 0.443 — below that the Math.max floor on the
// divisor swallows the value and the constant stops doing anything at all.
// Density and Zoom still override it.
const FRAMING = 0.5;
// The source bumper uses the same 45° / 35° isometric view, but its field sits
// a touch farther from the lens. Keep that slight pull-back in the camera value
// so the UI reports the actual reference framing and Reset restores it.
const REFERENCE_CAMERA_YAW = 45;
const REFERENCE_CAMERA_PITCH = 35;
const REFERENCE_CAMERA_ZOOM = 94;
const RESOLUTIONS: Record<Aspect, [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1080, 1080],
};

const PRESETS: Record<string, Partial<Settings>> = {
  Reference: {
    density: 7,
    cubeSize: 76,
    sequenceDuration: 6,
    motion: 64,
    gravity: 100,
    bounce: 52,
    speed: 1,
    alignSpeed: 2.4,
    shadow: 48,
    cameraYaw: REFERENCE_CAMERA_YAW,
    cameraPitch: REFERENCE_CAMERA_PITCH,
    cameraZoom: REFERENCE_CAMERA_ZOOM,
    background: "#f5df18",
    cube: "#f1da1d",
    ink: "#111111",
  },
  Broadcast: {
    density: 6,
    cubeSize: 84,
    sequenceDuration: 5,
    motion: 78,
    gravity: 118,
    bounce: 66,
    speed: 1.15,
    alignSpeed: 2.8,
    shadow: 42,
    cameraYaw: 40,
    cameraPitch: 31,
    cameraZoom: 104,
    background: "#08a8df",
    cube: "#fff348",
    ink: "#111111",
  },
  Minimal: {
    density: 5,
    cubeSize: 94,
    sequenceDuration: 7,
    motion: 34,
    gravity: 82,
    bounce: 30,
    speed: 0.72,
    alignSpeed: 1.6,
    shadow: 30,
    cameraYaw: 50,
    cameraPitch: 42,
    cameraZoom: 92,
    background: "#f0eee6",
    cube: "#ff493d",
    ink: "#111111",
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatTimecode(value: number) {
  const seconds = Math.floor(value);
  const frames = Math.floor((value % 1) * EXPORT_FPS);
  return `${seconds.toString().padStart(2, "0")}:${frames.toString().padStart(2, "0")}`;
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

// A wrapped key prevents faces from snapping between lit and unlit as a cube
// rolls. The reference keeps strong side-to-side separation, but the transition
// is broad and photographic rather than a hard max(0, dot) cutoff.
const LIGHT_WRAP = 0.16;
const SHADE_FLOOR = -0.23;
const SHADE_RANGE = 0.42;

function polygon(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  fill: string | CanvasGradient,
  edgeAlpha = 0.055,
  edgeWidth = 0.65,
) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.strokeStyle = `rgba(255, 250, 214, ${edgeAlpha})`;
  ctx.lineWidth = edgeWidth;
  ctx.stroke();
}

function faceGradient(ctx: CanvasRenderingContext2D, points: Vec2[], color: string, lightAmount: number) {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  // Let the upper-right key drift diagonally across the face. A vertical-only
  // ramp made every cube read as the same rigid three-colour block.
  const gradient = ctx.createLinearGradient(maxX, minY, minX, Math.max(minY + 1, maxY));
  gradient.addColorStop(0, shade(color, lightAmount + 0.035));
  gradient.addColorStop(0.42, shade(color, lightAmount + 0.01));
  gradient.addColorStop(1, shade(color, lightAmount - 0.025));
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

// Mark block on the cube face, in face-normalised units.
const MARK_LEFT = 0.13;
const MARK_TOP = 0.14;
const MARK_WIDTH = 0.74;
const MARK_HEIGHT = 0.55;
const MARK_BOTTOM = MARK_TOP + MARK_HEIGHT;
// Subline proportions measured off the MTV Hits lockup, expressed against the
// mark block: caps are 0.299 of its height, sitting 0.124 below it.
const SUBLINE_CAP_RATIO = 0.299;
const SUBLINE_GAP_RATIO = 0.124;
// Helvetica Bold caps are 0.718em, which turns the cap ratio into a font size.
const SUBLINE_SIZE = Number(
  ((SUBLINE_CAP_RATIO * MARK_HEIGHT) / 0.718).toFixed(3),
);
const SUBLINE_MAX_WIDTH = MARK_WIDTH;
// The reference sets its subline tighter than Helvetica's default fit; this
// closes the ~10% width gap that remains once the cap height matches.
const SUBLINE_TRACKING = "-0.010px";

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
    ctx.fillRect(MARK_LEFT, MARK_TOP, MARK_WIDTH, MARK_HEIGHT);
    ctx.fillStyle = cubeColor;
    ctx.font = "900 0.245px Arial Black, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(logoText.slice(0, 4).toUpperCase(), 0.5, 0.425, 0.66);
  }
  // Subline proportions are taken from the MTV Hits lockup, measured against
  // the mark block: cap height 30% of the block, sitting 12% below it, in
  // Helvetica Bold. Long sublines scale down rather than being squeezed by
  // fillText's maxWidth, which would condense the letterforms.
  const sublineText = subline.slice(0, 12);
  const sublineFont = (size: number) =>
    `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = ink;
  ctx.letterSpacing = SUBLINE_TRACKING;
  ctx.font = sublineFont(SUBLINE_SIZE);
  const sublineWidth = ctx.measureText(sublineText).width;
  if (sublineWidth > SUBLINE_MAX_WIDTH) {
    ctx.font = sublineFont(SUBLINE_SIZE * (SUBLINE_MAX_WIDTH / sublineWidth));
  }
  ctx.textAlign = "center";
  // Must precede measureText: actualBoundingBoxAscent is reported relative to
  // whichever baseline is currently set.
  ctx.textBaseline = "alphabetic";
  // Anchor off the rendered cap height rather than the nominal one, so the gap
  // below the mark holds even when the size is reduced to fit a long subline.
  const capHeight = ctx.measureText("H").actualBoundingBoxAscent;
  ctx.fillText(
    sublineText,
    0.5,
    MARK_BOTTOM + SUBLINE_GAP_RATIO * MARK_HEIGHT + capHeight,
  );
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
  gravity: number,
  bounce: number,
  speed: number,
  alignSpeed: number,
  sequenceDuration: number,
  cubeSize: number,
) {
  const random = hash(index + 1, seed);
  const strength = amount / 100;
  const gravityScale = clamp(gravity / 100, 0.4, 1.8);
  const restitution = clamp(bounce / 100, 0, 1);
  const speedScale = clamp(speed, 0.35, 1.8);
  const alignSpeedScale = clamp(alignSpeed, 0.75, 4);
  // Sequence time compresses the same physically-shaped ten-second simulation
  // into the selected delivery duration instead of simply cutting it off.
  const simulationTime = time * (MAX_DURATION / clamp(sequenceDuration, 3, MAX_DURATION));

  if (mode === "roll") {
    // The reference tips its cubes about a bottom edge rather than dropping
    // them: the marked face keeps pointing at the camera and the mark turns 90°
    // per tip, which is what rotating about that face's own normal does. Most
    // cubes are still at any instant, so each quarter turn is a short tip
    // followed by a long pause, and the phase is offset across the grid so the
    // tipping reads as a wave rolling through a settled field.
    // Columns run negative on the run-up side, so fold the phase back into
    // [0,1) rather than letting those cubes start before the sequence does.
    const stagger = (((col * 0.64 + row * 0.31 + random * ROLL_SCATTER) % 1) + 1) % 1;
    // Face align tightens the wave here rather than reorienting cubes, since a
    // rolling cube is always already square to the grid.
    const start = (stagger * ROLL_STAGGER) / alignSpeedScale;
    const cycle = ROLL_CYCLE / speedScale;
    // Every cube rolls one way and keeps going, as the footage does. Rolling out
    // and back reads as cubes tipping in both directions, which is wrong.
    const local = clamp(simulationTime - start, 0, ROLL_TURNS * cycle);
    const progress = local / cycle;
    const done = Math.floor(progress);
    const tip = clamp((progress - done) / ROLL_TIP_FRACTION, 0, 1);
    // A tipping cube passes its balance point and falls onto the next face, so
    // it accelerates through the turn rather than drifting into it.
    const turns = Math.min(ROLL_TURNS, done + tip * tip * (3 - 2 * tip));
    const settled = Math.floor(turns);
    const partial = (turns - settled) * (Math.PI / 2);
    // Pivoting about the leading bottom edge advances the centre by exactly one
    // cube per quarter turn. This translation is essential to the reference:
    // the cube rolls through the field instead of rotating in place.
    const advance = settled + 0.5 * (1 - Math.cos(partial) + Math.sin(partial));
    // The whole field tips the same way on purpose.
    // Rolling has to turn about the marked face's own normal, or the mark swings
    // away from the camera instead of rotating on the spot. The mark sits on
    // x-plus, so that axis is x and the cube travels along z.
    return {
      rx: turns * (Math.PI / 2),
      ry: 0,
      rz: 0,
      lift: 0,
      offsetX: 0,
      // Measure back from the finished grid, so four physical quarter-turns
      // carry the cube into its final lattice position with the mark upright.
      offsetZ: (advance - ROLL_TURNS) * cubeSize,
    };
  }

  // The loop begins with every cube suspended above its final grid position.
  // Seeded release timing creates the selected drop pattern without changing
  // the deterministic, perfectly aligned end frame.
  let delay = 0.08 + random * 1.2;

  const dropHeight = 6.2 + hash(index + 8, seed) * 7.4;
  const acceleration = 7.2 * gravityScale * speedScale;
  const fallDuration = Math.sqrt((2 * dropHeight) / acceleration);
  const local = simulationTime - delay;
  const fallProgress = clamp(local / fallDuration, 0, 1);
  const impactElapsed = Math.max(0, local - fallDuration);
  const impactTime = delay + fallDuration;
  const settleEnd = SEQUENCE_END;
  // Face alignment is intentionally independent from fall speed. This lets the
  // cubes land with the chosen physics, then rotate into the shared logo face
  // quickly or slowly without changing their release or impact timing.
  const alignDuration = Math.max(0.22, (settleEnd - impactTime) / alignSpeedScale);
  const settleProgress = clamp(impactElapsed / alignDuration, 0, 1);
  const alignment = settleProgress * settleProgress * (3 - 2 * settleProgress);
  const remaining = 1 - alignment;

  const initialRx = (hash(index + 17, seed) - 0.5) * 1.45 * strength;
  const initialRy = (hash(index + 23, seed) - 0.5) * 1.65 * strength;
  const initialRz = (hash(index + 31, seed) - 0.5) * 1.4 * strength;
  const spinX = (hash(index + 41, seed) - 0.5) * 3.8 * strength;
  const spinY = (hash(index + 49, seed) - 0.5) * 4.4 * strength;
  const spinZ = (hash(index + 57, seed) - 0.5) * 3.6 * strength;
  const impactRx = initialRx + spinX;
  const impactRy = initialRy + spinY;
  const impactRz = initialRz + spinZ;
  const initialOffsetX = (hash(index + 67, seed) - 0.5) * 116 * strength;
  const initialOffsetZ = (hash(index + 79, seed) - 0.5) * 116 * strength;
  const driftX = (hash(index + 89, seed) - 0.5) * 32 * strength;
  const driftZ = (hash(index + 97, seed) - 0.5) * 32 * strength;

  if (local <= 0) {
    return {
      rx: initialRx,
      ry: initialRy,
      rz: initialRz,
      lift: dropHeight,
      offsetX: initialOffsetX,
      offsetZ: initialOffsetZ,
    };
  }

  if (local < fallDuration) {
    return {
      rx: initialRx + spinX * fallProgress,
      ry: initialRy + spinY * fallProgress,
      rz: initialRz + spinZ * fallProgress,
      lift: Math.max(0, dropHeight - 0.5 * acceleration * local * local),
      offsetX: initialOffsetX * (1 - fallProgress * 0.18) + driftX * fallProgress,
      offsetZ: initialOffsetZ * (1 - fallProgress * 0.18) + driftZ * fallProgress,
    };
  }

  const collisionRate = 6.3 + hash(index + 107, seed) * 2.2;
  const damping = 1.05 + (1 - restitution) * 1.8;
  const collisionWave = Math.sin(impactElapsed * collisionRate);
  const collisionDecay = Math.exp(-impactElapsed * damping);
  const rebound = Math.abs(collisionWave) * collisionDecay * (0.16 + restitution * 1.12) * remaining;
  const rocking = collisionWave * collisionDecay * (0.12 + restitution * 0.34) * strength;
  const impactOffsetX = initialOffsetX * 0.82 + driftX;
  const impactOffsetZ = initialOffsetZ * 0.82 + driftZ;

  return {
    rx: (impactRx + rocking) * remaining,
    ry: (impactRy - rocking * 0.58) * remaining,
    rz: (impactRz + rocking * 0.72) * remaining,
    lift: rebound,
    offsetX: (impactOffsetX + rocking * 18) * remaining,
    offsetZ: (impactOffsetZ - rocking * 14) * remaining,
  };
}

function drawScene2dLegacy(
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

  // The reference floor is a continuous matte sweep. A radial hotspot, grain,
  // or vignette makes it read like a textured card instead of a studio floor.
  ctx.fillStyle = shade(settings.background, 0.012);
  ctx.fillRect(0, 0, width, height);

  const aspect = width / height;
  const columns = Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.35 : aspect < 0.8 ? 0.68 : 1)));
  const rows = Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.78 : aspect < 0.8 ? 1.45 : 1)));
  // Keep the grid footprint stable so cube size remains an independent visual
  // control in every aspect ratio instead of cancelling out through auto-fit.
  // A quarter turn carries a cube a full cube width, so a rolled cube lands on
  // top of a neighbour that has not moved yet unless the lattice is more than
  // two cubes wide. Framing compensates, so the field reads the same size.
  const spacing = settings.mode === "roll"
    ? Math.max(BASE_SPACING, settings.cubeSize * ROLL_SPACING)
    : BASE_SPACING;
  // Frame from the base pitch, never the rolling one. Deriving the camera from
  // the widened lattice pulls it back and halves the cubes on screen; measured
  // against the reference footage they should stay the size the other modes
  // render them, with the wider pitch simply showing fewer of them.
  const extent = Math.max(columns, rows) * BASE_SPACING * FRAMING;
  const extentFactor = aspect > 1.2 ? 0.72 : aspect < 0.8 ? 0.58 : 0.78;
  const scale = Math.min(width, height) / Math.max(420, extent * extentFactor) * (settings.cameraZoom / 100);
  const half = settings.cubeSize / 2;
  const viewVector = cameraVector(settings.cameraYaw, settings.cameraPitch);
  const yawRadians = settings.cameraYaw * Math.PI / 180;
  const projectPoint = (point: Vec3) => project(point, width, height, scale, settings.cameraYaw, settings.cameraPitch);
  const cubes: Array<{ index: number; row: number; col: number; x: number; z: number; depth: number }> = [];

  // Mid-roll a cube sits up to ROLL_TURNS cubes along z from its cell, baring
  // the edge it rolled off. Extra rows on both sides cover that.
  const runUp = settings.mode === "roll"
    ? Math.ceil((ROLL_TURNS * settings.cubeSize) / spacing) + 1
    : 0;
  const stride = columns + 3;

  for (let row = -1 - runUp; row <= rows + runUp; row += 1) {
    for (let col = -1; col <= columns; col += 1) {
      const index = (row + 2 + runUp) * stride + col + 2;
      const offset = row % 2 === 0 ? 0 : spacing * 0.5;
      const x = (col - (columns - 1) / 2) * spacing + offset;
      const z = (row - (rows - 1) / 2) * spacing;
      const depth = x * Math.sin(yawRadians) + z * Math.cos(yawRadians);
      cubes.push({ index, row, col, x, z, depth });
    }
  }
  cubes.sort((a, b) => a.depth - b.depth);

  const shadowStrength = clamp(settings.shadow / 100, 0, 1);
  const appendShadowPolygon = (points: Vec2[]) => {
    ctx.moveTo(points[0].x, points[0].y);
    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      ctx.lineTo(points[pointIndex].x, points[pointIndex].y);
    }
    ctx.closePath();
  };
  const drawProjectedShadow = (
    footprint: Vec2[],
    offset: Vec2,
    blur: number,
    alpha: number,
  ) => {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = shade(settings.background, -0.68);
    ctx.filter = `blur(${blur}px)`;
    const shifted = footprint.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
    ctx.beginPath();
    appendShadowPolygon(footprint);
    appendShadowPolygon(shifted);
    for (let pointIndex = 0; pointIndex < footprint.length; pointIndex += 1) {
      const nextIndex = (pointIndex + 1) % footprint.length;
      appendShadowPolygon([
        footprint[pointIndex],
        footprint[nextIndex],
        shifted[nextIndex],
        shifted[pointIndex],
      ]);
    }
    ctx.fill();
    ctx.restore();
  };

  for (const cube of cubes) {
    const movement = getMotion(
      cube.index,
      cube.row,
      cube.col,
      time,
      seed,
      settings.mode,
      settings.motion,
      settings.gravity,
      settings.bounce,
      settings.speed,
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
    );
    const centerX = cube.x + movement.offsetX;
    const centerZ = cube.z + movement.offsetZ;
    const footprint = [
      projectPoint({ x: centerX - half, y: 0, z: centerZ - half }),
      projectPoint({ x: centerX + half, y: 0, z: centerZ - half }),
      projectPoint({ x: centerX + half, y: 0, z: centerZ + half }),
      projectPoint({ x: centerX - half, y: 0, z: centerZ + half }),
    ];
    const lift = clamp(movement.lift, 0, 2.5);
    const liftFade = clamp(1 / (1 + lift * 0.55), 0.18, 1);
    const castOffset = {
      x: -half * scale * (0.52 + lift * 0.14),
      y: half * scale * (0.36 + lift * 0.1),
    };
    // Keep the square footprint visible in the cast shadow. The original has
    // only a small penumbra; the darker contact layer anchors each cube.
    drawProjectedShadow(
      footprint,
      castOffset,
      Math.max(2.2, half * scale * (0.055 + lift * 0.012)),
      shadowStrength * 0.23 * liftFade,
    );
    drawProjectedShadow(
      footprint,
      { x: -half * scale * 0.035, y: half * scale * 0.025 },
      Math.max(0.8, half * scale * 0.018),
      shadowStrength * 0.13 * liftFade,
    );
  }

  for (const cube of cubes) {
    const movement = getMotion(
      cube.index,
      cube.row,
      cube.col,
      time,
      seed,
      settings.mode,
      settings.motion,
      settings.gravity,
      settings.bounce,
      settings.speed,
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
    );
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
    // Upper right, as in the reference. The x sign used to be negative, which
    // put the key light on the left while the cast shadows fell left as well —
    // faces lit from one side and shadowed from the same side is most of why
    // the render read as flat.
    const lightVector = normalize({ x: 0.88, y: 0.68, z: -0.48 });
    const faceDefinitions = [
      // The sticker goes on x-plus, not z-plus: at a 45° yaw that is the face
      // angled to the right of screen, which is where the reference carries it.
      { id: "z-plus", indices: [3, 2, 6, 7], hasMark: false },
      // Wound bottom-left, bottom-right, top-right, top-left like the other
      // marked face was, or drawMark maps the artwork onto its side. Screen
      // left on this face is +z, since isoX goes as (x − z) at a 45° yaw.
      { id: "x-plus", indices: [2, 1, 5, 6], hasMark: true },
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
      const illumination = clamp(
        (dot(face.normal, lightVector) + LIGHT_WRAP) / (1 + LIGHT_WRAP),
        0,
        1,
      );
      const lightAmount = SHADE_FLOOR + illumination * SHADE_RANGE;
      polygon(
        ctx,
        points,
        faceGradient(ctx, points, settings.cube, lightAmount),
        // A face turned away from the key gets almost no edge catch. Both faces
        // meeting at an edge stroke it, so this reads as a chamfer.
        0.018 + illumination * 0.055,
        0.7,
      );
      if (face.hasMark) {
        // This is the cube's one physical sticker face. Back-face culling keeps
        // the artwork correctly oriented instead of mirroring it on another side.
        drawMark(ctx, points, settings.cube, settings.ink, settings.logoText, settings.subline, logo);
      }
    }
  }

}

type ThreeCube = {
  index: number;
  row: number;
  col: number;
  x: number;
  z: number;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.Material[]>;
};

type ThreeSceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  cubes: ThreeCube[];
  cubeGeometry: THREE.BoxGeometry | null;
  cubeMaterials: THREE.Material[];
  brandTexture: THREE.CanvasTexture | null;
  groundGeometry: THREE.PlaneGeometry | null;
  groundMaterial: THREE.MeshStandardMaterial | null;
  keyLight: THREE.DirectionalLight | null;
  ambientLight: THREE.AmbientLight | null;
  hemisphereLight: THREE.HemisphereLight | null;
  structureKey: string;
  extent: number;
};

const threeScenes = new WeakMap<HTMLCanvasElement, ThreeSceneState>();
const logoIds = new WeakMap<HTMLCanvasElement, number>();
let nextLogoId = 1;

function logoIdentity(logo: HTMLCanvasElement | null) {
  if (!logo) return 0;
  let id = logoIds.get(logo);
  if (!id) {
    id = nextLogoId;
    nextLogoId += 1;
    logoIds.set(logo, id);
  }
  return id;
}

function createBrandTexture(settings: Settings, logo: HTMLCanvasElement | null) {
  const surface = document.createElement("canvas");
  surface.width = 512;
  surface.height = 512;
  const context = surface.getContext("2d");
  if (!context) return null;
  context.fillStyle = settings.cube;
  context.fillRect(0, 0, surface.width, surface.height);
  drawMark(
    context,
    [
      { x: 0, y: surface.height },
      { x: surface.width, y: surface.height },
      { x: surface.width, y: 0 },
      { x: 0, y: 0 },
    ],
    settings.cube,
    settings.ink,
    settings.logoText,
    settings.subline,
    logo,
  );
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function clearThreeScene(state: ThreeSceneState) {
  state.scene.clear();
  state.cubeGeometry?.dispose();
  state.cubeMaterials.forEach((material) => material.dispose());
  state.brandTexture?.dispose();
  state.groundGeometry?.dispose();
  state.groundMaterial?.dispose();
  state.cubes = [];
  state.cubeGeometry = null;
  state.cubeMaterials = [];
  state.brandTexture = null;
  state.groundGeometry = null;
  state.groundMaterial = null;
  state.keyLight = null;
  state.ambientLight = null;
  state.hemisphereLight = null;
}

function buildThreeScene(
  state: ThreeSceneState,
  canvas: HTMLCanvasElement,
  settings: Settings,
  logo: HTMLCanvasElement | null,
) {
  clearThreeScene(state);
  const width = canvas.width;
  const height = canvas.height;
  const aspect = width / height;
  const columns = Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.35 : aspect < 0.8 ? 0.68 : 1)));
  const rows = Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.78 : aspect < 0.8 ? 1.45 : 1)));
  const spacing = settings.mode === "roll"
    ? Math.max(BASE_SPACING, settings.cubeSize * ROLL_SPACING)
    : BASE_SPACING;
  state.extent = Math.max(columns, rows) * BASE_SPACING * FRAMING;

  const brandTexture = createBrandTexture(settings, logo);
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: settings.cube,
    roughness: 0.92,
    metalness: 0,
  });
  const markedMaterial = new THREE.MeshStandardMaterial({
    // The canvas texture already contains the selected cube colour underneath
    // the transparent PNG. Keep the material multiplier white; tinting it with
    // settings.cube again would multiply the yellow twice and darken this face.
    color: "#ffffff",
    map: brandTexture,
    roughness: 0.92,
    metalness: 0,
  });
  const cubeMaterials: THREE.Material[] = [
    markedMaterial,
    faceMaterial,
    faceMaterial,
    faceMaterial,
    faceMaterial,
    faceMaterial,
  ];
  const cubeGeometry = new THREE.BoxGeometry(settings.cubeSize, settings.cubeSize, settings.cubeSize);
  const stride = columns + 3;
  const margin = settings.mode === "roll"
    ? Math.ceil((ROLL_TURNS * settings.cubeSize) / spacing) + 1
    : 1;
  for (let row = -margin; row <= rows + margin; row += 1) {
    for (let col = -1; col <= columns; col += 1) {
      const index = (row + margin + 1) * stride + col + 2;
      const staggerX = row % 2 === 0 ? 0 : spacing * 0.5;
      const x = (col - (columns - 1) / 2) * spacing + staggerX;
      const z = (row - (rows - 1) / 2) * spacing;
      const mesh = new THREE.Mesh(cubeGeometry, cubeMaterials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = true;
      state.scene.add(mesh);
      state.cubes.push({ index, row, col, x, z, mesh });
    }
  }

  const floorSize = Math.max(3200, state.extent * 7);
  const groundGeometry = new THREE.PlaneGeometry(floorSize, floorSize);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: settings.background,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  ground.receiveShadow = true;
  state.scene.add(ground);

  // Broad environment light keeps every yellow face alive; the warm key is
  // responsible for the square, gently feathered shadow seen in the reference.
  const hemisphereLight = new THREE.HemisphereLight("#fff9df", shade(settings.background, -0.025), 1.9);
  const ambientLight = new THREE.AmbientLight("#fff5cf", 0.72);
  const keyLight = new THREE.DirectionalLight("#fff4c2", 1.45);
  keyLight.position.set(900, 1800, -650);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.00035;
  keyLight.shadow.normalBias = 0.055;
  keyLight.shadow.radius = 6;
  keyLight.shadow.blurSamples = 16;
  const shadowSpan = Math.max(760, state.extent * 1.3);
  keyLight.shadow.camera.left = -shadowSpan;
  keyLight.shadow.camera.right = shadowSpan;
  keyLight.shadow.camera.top = shadowSpan;
  keyLight.shadow.camera.bottom = -shadowSpan;
  keyLight.shadow.camera.near = 10;
  keyLight.shadow.camera.far = 5000;
  state.scene.add(hemisphereLight, ambientLight, keyLight, keyLight.target);

  state.cubeGeometry = cubeGeometry;
  state.cubeMaterials = cubeMaterials;
  state.brandTexture = brandTexture;
  state.groundGeometry = groundGeometry;
  state.groundMaterial = groundMaterial;
  state.keyLight = keyLight;
  state.ambientLight = ambientLight;
  state.hemisphereLight = hemisphereLight;
}

function drawScene(
  canvas: HTMLCanvasElement,
  settings: Settings,
  time: number,
  seed: number,
  logo: HTMLCanvasElement | null,
) {
  let state = threeScenes.get(canvas);
  if (!state) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    state = {
      renderer,
      scene: new THREE.Scene(),
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000),
      cubes: [],
      cubeGeometry: null,
      cubeMaterials: [],
      brandTexture: null,
      groundGeometry: null,
      groundMaterial: null,
      keyLight: null,
      ambientLight: null,
      hemisphereLight: null,
      structureKey: "",
      extent: 1,
    };
    threeScenes.set(canvas, state);
  }

  state.renderer.setSize(canvas.width, canvas.height, false);
  state.renderer.setClearColor(settings.background, 1);
  state.scene.background = new THREE.Color(settings.background);
  const structureKey = [
    canvas.width,
    canvas.height,
    settings.density,
    settings.cubeSize,
    settings.mode,
    settings.background,
    settings.cube,
    settings.ink,
    settings.logoText,
    settings.subline,
    logoIdentity(logo),
  ].join("|");
  if (state.structureKey !== structureKey) {
    buildThreeScene(state, canvas, settings, logo);
    state.structureKey = structureKey;
  }

  const width = canvas.width;
  const height = canvas.height;
  const aspect = width / height;
  const extentFactor = aspect > 1.2 ? 0.72 : aspect < 0.8 ? 0.58 : 0.78;
  const scale = Math.min(width, height) / Math.max(420, state.extent * extentFactor) * (settings.cameraZoom / 100);
  state.camera.left = -width / (2 * scale);
  state.camera.right = width / (2 * scale);
  state.camera.top = height / (2 * scale);
  state.camera.bottom = -height / (2 * scale);
  state.camera.near = 1;
  state.camera.far = 10000;
  const view = cameraVector(settings.cameraYaw, settings.cameraPitch);
  state.camera.position.set(view.x * 4200, view.y * 4200, view.z * 4200);
  state.camera.up.set(0, 1, 0);
  state.camera.lookAt(0, settings.cubeSize * 0.18, 0);
  state.camera.updateProjectionMatrix();

  const half = settings.cubeSize / 2;
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
  const cubeFrames = state.cubes.map((cube) => {
    const movement = getMotion(
      cube.index,
      cube.row,
      cube.col,
      time,
      seed,
      settings.mode,
      settings.motion,
      settings.gravity,
      settings.bounce,
      settings.speed,
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
    );
    const rotatedVertices = localVertices.map((point) => rotate(point, movement.rx, movement.ry, movement.rz));
    const minimumLocalY = Math.min(...rotatedVertices.map((point) => point.y));
    const contactHeight = -minimumLocalY + movement.lift * settings.cubeSize;
    return {
      cube,
      movement,
      contactHeight,
      centerZ: cube.z + movement.offsetZ,
      minimumLocalZ: Math.min(...rotatedVertices.map((point) => point.z)),
      maximumLocalZ: Math.max(...rotatedVertices.map((point) => point.z)),
    };
  });

  // Rows of the same parity share a physical rolling lane. At staggered phases
  // a rear cube can otherwise catch a front cube. Resolve that like a simple
  // 3D collision constraint instead of allowing the meshes to interpenetrate.
  const lanes = new Map<string, typeof cubeFrames>();
  for (const frame of cubeFrames) {
    const laneKey = `${((frame.cube.row % 2) + 2) % 2}:${frame.cube.col}`;
    const lane = lanes.get(laneKey) ?? [];
    lane.push(frame);
    lanes.set(laneKey, lane);
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => b.cube.z - a.cube.z);
    let nextMaximumZ = Number.POSITIVE_INFINITY;
    for (const frame of lane) {
      frame.centerZ = Math.min(frame.centerZ, nextMaximumZ - frame.maximumLocalZ);
      nextMaximumZ = frame.centerZ + frame.minimumLocalZ - settings.cubeSize * 0.04;
    }
  }

  for (const frame of cubeFrames) {
    const { cube, movement } = frame;
    cube.mesh.position.set(cube.x + movement.offsetX, frame.contactHeight, frame.centerZ);
    cube.mesh.rotation.set(movement.rx, movement.ry, movement.rz, "XYZ");
  }

  const shadowStrength = clamp(settings.shadow / 100, 0, 1);
  if (state.keyLight) state.keyLight.intensity = 1.0 + shadowStrength * 0.9;
  if (state.ambientLight) state.ambientLight.intensity = 0.68 + (1 - shadowStrength) * 0.2;
  if (state.hemisphereLight) state.hemisphereLight.intensity = 1.9;
  state.renderer.render(state.scene, state.camera);
}

function PanelSection({ title, value, defaultOpen = false, children }: { title: string; value?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="panel-section" open={defaultOpen}>
      <summary>
        <h2>{title}</h2>
        {value ? <span className="section-value">{value}</span> : null}
        <svg className="chevron" viewBox="0 0 10 16" aria-hidden="true" focusable="false">
          <path d="M2 1.5 8.5 8 2 14.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
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
  const cameraDragRef = useRef<{ pointerId: number; startX: number; startY: number; yaw: number; pitch: number } | null>(null);
  const [playing, setPlaying] = useState(true);
  const [recording, setRecording] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [cameraDragging, setCameraDragging] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [seed, setSeed] = useState(24);
  const [preset, setPreset] = useState("Reference");
  const [notice, setNotice] = useState("Live preview");
  const [settings, setSettings] = useState<Settings>({
    density: 7,
    cubeSize: 76,
    sequenceDuration: 6,
    motion: 64,
    gravity: 100,
    bounce: 52,
    speed: 1,
    alignSpeed: 2.4,
    shadow: 48,
    cameraYaw: REFERENCE_CAMERA_YAW,
    cameraPitch: REFERENCE_CAMERA_PITCH,
    cameraZoom: REFERENCE_CAMERA_ZOOM,
    background: "#f5df18",
    cube: "#f1da1d",
    ink: "#111111",
    logoText: "WTV",
    subline: "MUSIC",
    mode: "roll",
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
      window.setTimeout(() => setNotice("Live preview"), 1000);
    };
    image.src = new URL("wtv-logo.png", document.baseURI).href;
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
        playheadRef.current = (playheadRef.current + delta) % settings.sequenceDuration;
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

  useEffect(() => {
    if (playheadRef.current >= settings.sequenceDuration) {
      playheadRef.current = 0;
      setPlayhead(0);
    }
  }, [settings.sequenceDuration]);

  const setTimeline = (value: number) => {
    playheadRef.current = value;
    setPlayhead(value);
  };

  const restart = () => {
    setTimeline(0);
    setPlaying(true);
    setNotice("RESTARTED");
    window.setTimeout(() => setNotice("Live preview"), 1000);
  };

  const randomize = () => {
    setSeed((current) => (current * 9301 + 49297) % 9999);
    setTimeline(0);
    setNotice("NEW SEED");
    window.setTimeout(() => setNotice("Live preview"), 1000);
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

  const exportMp4 = async () => {
    if (recording) return;

    setRecording(true);
    setExportProgress(0);
    setNotice("PREPARING MP4");

    try {
      const {
        BufferTarget,
        CanvasSource,
        Mp4OutputFormat,
        Output,
        Quality,
        canEncodeVideo,
      } = await import("mediabunny");
      const [width, height] = RESOLUTIONS[aspect];
      const exportFrameCount = Math.max(1, Math.round(settings.sequenceDuration * EXPORT_FPS));
      const quality = new Quality({
        bitrate: width * height >= 1_000_000 ? 16_000_000 : 12_000_000,
        bitrateMode: "variable",
      });
      const supported = await canEncodeVideo("avc", {
        width,
        height,
        quality,
        latencyMode: "quality",
      });
      if (!supported) throw new Error("This browser cannot encode H.264 MP4 video.");

      // Encode from an isolated canvas so playback and camera interaction never
      // race with export. Each frame is rendered at an exact timestamp, making
      // every download a deterministic, frame-accurate 30 fps master.
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = width;
      exportCanvas.height = height;
      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const videoSource = new CanvasSource(exportCanvas, {
        codec: "avc",
        quality,
        keyFrameInterval: 2,
        latencyMode: "quality",
        alpha: "discard",
      });
      output.addVideoTrack(videoSource, {
        frameRate: EXPORT_FPS,
        maximumPacketCount: exportFrameCount,
      });
      output.setMetadataTags({
        title: `WTV Cube Studio — ${aspect}`,
        artist: "WTV",
        comment: `Seed ${seed}; ${settings.sequenceDuration}-second fall-and-align bumper`,
      });
      await output.start();

      for (let frame = 0; frame < exportFrameCount; frame += 1) {
        const timestamp = frame / EXPORT_FPS;
        drawScene(exportCanvas, settings, timestamp, seed, logoRef.current);
        await videoSource.add(timestamp, 1 / EXPORT_FPS);
        if (frame % 6 === 0 || frame === exportFrameCount - 1) {
          const progress = Math.round(((frame + 1) / exportFrameCount) * 100);
          setExportProgress(progress);
          setNotice(`ENCODING MP4 ${progress}%`);
          // Let React paint progress during longer portrait and square exports.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }

      videoSource.close();
      await output.finalize();
      if (!target.buffer) throw new Error("MP4 encoding finished without an output buffer.");

      const blob = new Blob([target.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = `WTV-cubes-${aspect.replace(":", "x")}-${seed}.mp4`;
      link.href = url;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setTimeline(settings.sequenceDuration - 1 / EXPORT_FPS);
      setNotice("MP4 SAVED");
    } catch (error) {
      console.error("MP4 export failed", error);
      setNotice("MP4 EXPORT UNSUPPORTED");
    } finally {
      setRecording(false);
      window.setTimeout(() => setNotice("Live preview"), 2400);
    }
  };

  const dragTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const update = (clientX: number) => {
      const rect = target.getBoundingClientRect();
      setTimeline(clamp((clientX - rect.left) / rect.width, 0, 1) * settings.sequenceDuration);
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

  const startCameraDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cameraDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      yaw: settings.cameraYaw,
      pitch: settings.cameraPitch,
    };
    setCameraDragging(true);
  };

  const moveCamera = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = cameraDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextYaw = clamp(drag.yaw + (event.clientX - drag.startX) * 0.16, 10, 80);
    const nextPitch = clamp(drag.pitch - (event.clientY - drag.startY) * 0.14, 12, 68);
    setSettings((current) => ({ ...current, cameraYaw: Math.round(nextYaw), cameraPitch: Math.round(nextPitch) }));
    setPreset("Custom");
  };

  const endCameraDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (cameraDragRef.current?.pointerId !== event.pointerId) return;
    cameraDragRef.current = null;
    setCameraDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const zoomCamera = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const zoomDelta = event.deltaY > 0 ? -4 : 4;
    setSettings((current) => ({ ...current, cameraZoom: clamp(current.cameraZoom + zoomDelta, 65, 150) }));
    setPreset("Custom");
  };

  const controlCameraWithKeyboard = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const cameraKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"];
    if (!cameraKeys.includes(event.key)) return;
    event.preventDefault();
    setSettings((current) => {
      if (event.key === "ArrowLeft") return { ...current, cameraYaw: clamp(current.cameraYaw - 2, 10, 80) };
      if (event.key === "ArrowRight") return { ...current, cameraYaw: clamp(current.cameraYaw + 2, 10, 80) };
      if (event.key === "ArrowUp") return { ...current, cameraPitch: clamp(current.cameraPitch + 2, 12, 68) };
      if (event.key === "ArrowDown") return { ...current, cameraPitch: clamp(current.cameraPitch - 2, 12, 68) };
      if (event.key === "-" ) return { ...current, cameraZoom: clamp(current.cameraZoom - 4, 65, 150) };
      return { ...current, cameraZoom: clamp(current.cameraZoom + 4, 65, 150) };
    });
    setPreset("Custom");
  };

  const controlTimelineWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") return setTimeline(0);
    if (event.key === "End") return setTimeline(settings.sequenceDuration - 1 / EXPORT_FPS);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setTimeline(clamp(playheadRef.current + direction / EXPORT_FPS, 0, settings.sequenceDuration - 1 / EXPORT_FPS));
  };

  const formattedTime = useMemo(() => formatTimecode(playhead), [playhead]);
  const sequenceLabel = Number.isInteger(settings.sequenceDuration) ? settings.sequenceDuration.toFixed(0) : settings.sequenceDuration.toFixed(1);

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">WTV</span>
          <span className="brand-title">CUBE STUDIO</span>
          <span className="version">v1.0</span>
        </div>
        <div className="top-meta"><span className="live-dot" /> Responsive bumper generator <span>{sequenceLabel} sec sequence</span></div>
      </header>

      <section className="workspace">
        <div className="preview-column">
          <div className={`stage stage-${ratioClass}`}>
            <canvas
              ref={canvasRef}
              className={`motion-canvas${cameraDragging ? " is-dragging" : ""}`}
              aria-label="Animated WTV cube preview. Drag to orbit and scroll to zoom."
              tabIndex={0}
              onPointerDown={startCameraDrag}
              onPointerMove={moveCamera}
              onPointerUp={endCameraDrag}
              onPointerCancel={endCameraDrag}
              onWheel={zoomCamera}
              onKeyDown={controlCameraWithKeyboard}
            />
            <div className="stage-overlay stage-overlay-top"><span>{notice}</span><span>{aspect} / {canvasWidth} x {canvasHeight}</span></div>
            <div className="camera-hint">Drag to orbit · scroll to zoom</div>
            <div className="stage-overlay stage-overlay-bottom"><span>Seed {seed.toString().padStart(4, "0")}</span><span>{settings.cameraYaw}° / {settings.cameraPitch}° / {settings.cameraZoom}%</span><span>{settings.mode === "settle" ? "Drop" : "Roll"} · {settings.speed.toFixed(2)}×</span></div>
          </div>

          <div className="transport">
            <button className="play-button" type="button" onClick={() => setPlaying((current) => !current)} aria-label={playing ? "Pause animation" : "Play animation"}>{playing ? "Ⅱ" : "▶"}</button>
            <span className="timecode">{formattedTime}</span>
            <div className="timeline" onPointerDown={dragTimeline} onKeyDown={controlTimelineWithKeyboard} role="slider" aria-label="Animation playhead" aria-valuemin={0} aria-valuemax={settings.sequenceDuration} aria-valuenow={playhead} tabIndex={0}>
              <span className="timeline-fill" style={{ width: `${(playhead / settings.sequenceDuration) * 100}%` }} />
              <span className="timeline-head" style={{ left: `${(playhead / settings.sequenceDuration) * 100}%` }} />
              {[0, 1, 2, 3, 4, 5].map((tick) => <i key={tick} style={{ left: `${tick * 20}%` }} />)}
            </div>
            <span className="timecode">{formatTimecode(settings.sequenceDuration)}</span>
            <button className="transport-button" type="button" onClick={restart}>↺ RESET</button>
            <button className="transport-button" type="button" onClick={randomize}>✦ NEW SEED</button>
          </div>
        </div>

        <aside className="control-panel">
          <PanelSection title="Look" value={preset} defaultOpen>
            <div className="preset-grid">
              {Object.keys(PRESETS).map((name) => <button key={name} type="button" className={preset === name ? "active" : ""} onClick={() => applyPreset(name)}>{name}</button>)}
            </div>
            <ColorControl label="Background" value={settings.background} onChange={(value) => updateSetting("background", value)} />
            <ColorControl label="Cube faces" value={settings.cube} onChange={(value) => updateSetting("cube", value)} />
            <ColorControl label="Logo / ink" value={settings.ink} onChange={(value) => updateSetting("ink", value)} />
          </PanelSection>

          <PanelSection title="Grid" value={`${settings.density} \u00d7 ${settings.cubeSize}px`}>
            <RangeControl label="Density" value={settings.density} min={4} max={10} onChange={(value) => updateSetting("density", value)} />
            <RangeControl label="Cube size" value={settings.cubeSize} min={48} max={112} suffix=" px" onChange={(value) => updateSetting("cubeSize", value)} />
          </PanelSection>

          <PanelSection title="Motion" value={settings.mode === "settle" ? "Drop" : "Roll"}>
            <div className="segmented two">
              {(["settle", "roll"] as MotionMode[]).map((mode) => <button key={mode} type="button" className={settings.mode === mode ? "active" : ""} onClick={() => updateSetting("mode", mode)}>{mode === "settle" ? "Drop" : "Roll"}</button>)}
            </div>
            <RangeControl label="Sequence time" value={settings.sequenceDuration} min={3} max={10} step={0.5} suffix=" s" onChange={(value) => updateSetting("sequenceDuration", value)} />
            <RangeControl label="Gravity" value={settings.gravity} min={45} max={170} suffix="%" onChange={(value) => updateSetting("gravity", value)} />
            <RangeControl label="Bounce" value={settings.bounce} min={0} max={100} suffix="%" onChange={(value) => updateSetting("bounce", value)} />
            <RangeControl label="Tumble" value={settings.motion} min={0} max={100} suffix="%" onChange={(value) => updateSetting("motion", value)} />
            <RangeControl label="Fall speed" value={settings.speed} min={0.35} max={1.8} step={0.05} suffix="x" onChange={(value) => updateSetting("speed", value)} />
            <RangeControl label="Face align" value={settings.alignSpeed} min={0.75} max={4} step={0.05} suffix="x" onChange={(value) => updateSetting("alignSpeed", value)} />
            <RangeControl label="Soft shadow" value={settings.shadow} min={0} max={100} suffix="%" onChange={(value) => updateSetting("shadow", value)} />
          </PanelSection>

          <PanelSection title="Camera" value={`${settings.cameraYaw}\u00b0 / ${settings.cameraPitch}\u00b0`}>
            <RangeControl label="Orbit" value={settings.cameraYaw} min={10} max={80} suffix="\u00b0" onChange={(value) => updateSetting("cameraYaw", value)} />
            <RangeControl label="Elevation" value={settings.cameraPitch} min={12} max={68} suffix="\u00b0" onChange={(value) => updateSetting("cameraPitch", value)} />
            <RangeControl label="Zoom" value={settings.cameraZoom} min={65} max={150} suffix="%" onChange={(value) => updateSetting("cameraZoom", value)} />
            <p className="camera-help">Drag on the preview to orbit. Scroll to zoom.</p>
          </PanelSection>

          <PanelSection title="Brand" value={settings.logoText}>
            <div className="text-grid">
              <label><span>Mark</span><input className="caps" value={settings.logoText} maxLength={4} onChange={(event) => updateSetting("logoText", event.target.value)} /></label>
              <label><span>Type / subline</span><input value={settings.subline} maxLength={12} onChange={(event) => updateSetting("subline", event.target.value)} /></label>
            </div>
            <div className="upload-row three">
              <button type="button" onClick={activateDefaultLogo}>WTV logo</button>
              <label className="upload-button">Upload<input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadLogo} /></label>
              <button type="button" onClick={clearLogo}>Text mark</button>
            </div>
          </PanelSection>

          <PanelSection title="Export" value={aspect}>
            <div className="segmented">
              {(["16:9", "9:16", "1:1"] as Aspect[]).map((item) => <button key={item} type="button" className={aspect === item ? "active" : ""} onClick={() => setAspect(item)}>{item}</button>)}
            </div>
            <div className="export-grid">
              <button className="primary-action" type="button" onClick={exportMp4} disabled={recording} aria-describedby="export-description">{recording ? `Encoding ${exportProgress}%` : "Export MP4"}</button>
              <button type="button" onClick={downloadPng}>Download PNG</button>
            </div>
            <p id="export-description" aria-live="polite">MP4 exports the full {sequenceLabel}-second sequence at 30 fps. Use the same seed across aspect ratios for a matched rollout.</p>
          </PanelSection>
        </aside>
      </section>
    </main>
  );
}
