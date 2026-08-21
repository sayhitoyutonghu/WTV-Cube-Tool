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
import { bakePopHeap, POP_STRIDE, type PopBake, type PopBodySpec } from "./popPhysics";

type Aspect = "16:9" | "9:16" | "1:1";
type MotionMode = "settle" | "roll" | "spin" | "pop" | "flip";
type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; y: number };
type MotionPose = {
  rx: number;
  ry: number;
  rz: number;
  lift: number;
  offsetX: number;
  offsetZ: number;
  scale: number;
  // Flip: after the edge-on midpoint the cell shows its end shape.
  revealed: boolean;
};

const MOTION_LABELS: Record<MotionMode, string> = {
  settle: "Drop",
  roll: "Roll",
  spin: "Spin",
  pop: "Pop",
  flip: "Flip",
};

type Settings = {
  density: number;
  cubeSize: number;
  // Percent of the face. Flip only; see the build site.
  cardThickness: number;
  sequenceDuration: number;
  rollTurns: number;
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
  shape: ShapeId;
  shapeB: ShapeId;
  mode: MotionMode;
};

const MAX_DURATION = 10;
const MIN_SEQUENCE_DURATION = 3;
const MAX_SEQUENCE_DURATION = 20;
const EXPORT_FPS = 30;
// Simulation time by which every mode has come to rest, leaving a beat of held
// frames before the loop point.
const SEQUENCE_END = 8.6;
// The source gives each cube one decisive 90° tip. It starts on the previous
// face and lands with the marked face upright instead of repeatedly tumbling.
const DEFAULT_ROLL_TURNS = 1;
const ROLL_CYCLE = 1.35;
const ROLL_FINAL_HOLD = 1;
// Measured from the reference's opening and settled frames: the cube faces
// grow by roughly seven percent while the orbit stays locked. Keep the move
// subtle and finish it with the rolling wave, before the final hold.
const ROLL_ZOOM_IN = 1.07;
// Fraction of a cycle spent tipping; the rest is the cube sitting still. Keep
// it low — in the reference only a handful of cubes are moving at any instant.
const ROLL_TIP_FRACTION = 0.55;
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
// Dense front-facing button wall measured from the supplied 720 × 1280 clip.
const FLIP_SHORT_AXIS_COUNT = 14;
const FLIP_GRID_SPACING = 80;
// Keep the front wall tight, but give each outline enough room for its true
// silhouette. Star and triangle are intentionally larger than the cube so the
// logo can stay at the same scale; their pitch must grow with that footprint.
const FLIP_SHAPE_GAP = 1.12;
const FLIP_FINAL_HOLD = 1;
const FLIP_WAVE_SPAN = 0.78;
// Share of the active window one cell spends turning from its back to its
// front. At 0.18 the half turn was over in about a second and a quarter and
// read as a snap between two shapes rather than one object turning over. The
// wave spread is capped at what is left of the window (see waveSpan), so
// lengthening the turn also draws the cells closer together in time — more of
// the field is mid-turn at once, which is the other half of reading slower.
const FLIP_TURN_FRACTION = 0.3;
// During a geometry swap, the outgoing and incoming outlines meet while the
// solid is nearly edge-on. Suppress the last sliver of face silhouette inside
// this window and converge both shapes on the same horizontal edge span; that
// keeps different outlines from jumping width on the crossover frame.
const FLIP_SHAPE_CROSSOVER_FACE = 0.42;
const FLIP_CROSSOVER_FACE_SCALE = 0.08;
const FLIP_CAMERA_SCALE = 1.12;
// Pop packs its bodies into a heap in the middle of frame. The reference is a
// force field pulling rigid bodies together until they collide and pile up, so
// the resting field has no order to its positions at all — every other mode
// ends on a lattice, this one ends on a clump. The order lives entirely in the
// rotations, which still come home so that every mark faces the camera.
// Radius of the heap, in body widths. Shared with the packing that lays the
// resting positions out, so the two cannot drift apart.
const POP_PACK_REACH = 3.2;
// Share of the sequence spent piled up before the heap turns to face the
// camera together. A pile reads as a pile because nothing in it agrees, so the
// bodies hold their own orientations for as long as possible; the mark only has
// to be readable on the frame the cut to the payoff actually lands on.
const POP_ALIGN_START = 0.74;
// Spread of the resting orientations, scaled by Tumble so the disorder in the
// heap is on the same control as the disorder in every other mode.
const POP_REST_SPREAD = 1.8;
// How far out a body starts, in body widths. Far enough to be off frame at
// every crop, so a body is never seen waiting to be pulled in.
const POP_ENTRY_DISTANCE = 26;
// Bodies deep in the heap arrive first and the outside lands on top of them,
// which is the order a pile actually forms in.
const POP_ARRIVAL_SPREAD = 0.7;
const POP_ARRIVAL_SCATTER = 0.34;
const POP_FLIGHT = 0.95;
// Carried a little past its resting place and drawn back — what reads as the
// jostle of settling into a pack without resolving a single real contact.
const POP_OVERSHOOT = 0.11;
const POP_TUMBLE = 3.2;

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
// Delivery size. The wide and tall crops used to export at 720p while the
// square already went out at 1080, so every finished bumper had to be upscaled
// on the way into the edit. Framing is taken from the aspect ratio alone (see
// extentFactor), so raising these changes sampling density and nothing else —
// the same take renders identically, just larger.
const RESOLUTIONS: Record<Aspect, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
};


// One hue per channel bumper, ground and faces a few points of saturation
// apart. Keeping them that close is the Tunecubes move: the shapes are read by
// their own shading and the shadow they drop, never by a value break against
// the floor. Hues come from the slot machine palette the client signed off on.
//
// Every ground clears 4.5:1 against the ink, so the mark holds on the faces.
// That floor is why purple sits lighter than its palette swatch — at the
// swatch's own lightness the logo goes to 2.8:1 and disappears.
//
// Chroma is capped at 0.21 in OKLCh. Matching the palette on HSL saturation
// instead put green, red and magenta at 0.25-0.28, and a full screen of that
// vibrates: HSL lightness is not a perceptual quantity, so the numbers that
// read as comfortable on yellow read as glare on the hues either side of it.
// Yellow is the one ground already approved on air, so its own chroma sets the
// ceiling and its pair stays exactly as delivered.
const COLOURWAYS: Record<string, { background: string; cube: string; ink: string }> = {
  Yellow:  { background: "#f5df18", cube: "#f1da1d", ink: "#111111" },
  Green:   { background: "#5bef72", cube: "#5aea70", ink: "#111111" },
  Purple:  { background: "#9b64f6", cube: "#9661ef", ink: "#111111" },
  Blue:    { background: "#18b3f5", cube: "#1daeee", ink: "#111111" },
  Red:     { background: "#ef4628", cube: "#e84426", ink: "#111111" },
  Magenta: { background: "#e150b8", cube: "#da4eb2", ink: "#111111" },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Collision proxies, not the drawn outline. A star is not convex and cannot be
// solved as one hull, so every extruded outline is met as a disc of its own
// footprint; packed this tightly the difference never surfaces, and the drawn
// geometry is untouched either way.
function popBodySpec(shape: ShapeId, cubeSize: number): PopBodySpec {
  const half = cubeSize / 2;
  if (shape === "cube") return { kind: "box", radius: half, sides: 4, depth: cubeSize };
  // The reference meets every body as a convex hull, and a hull of these
  // outlines is just the polygon through their corners: five sides for the
  // star, three for the triangle, a fine ring for the circle.
  const sides = shape === "star" ? 5 : shape === "triangle" ? 3 : 16;
  return { kind: "hull", radius: half * SHAPE_RADIUS[shape], sides, depth: cubeSize };
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

// The bumper's roll does not leave and meet the floor at an even rate. It
// clings briefly at the start, gathers speed after the balance point, then
// eases firmly into the next face. This asymmetric S-curve keeps the cube
// rigid while giving each quarter-turn the reference's viscous weight.
function stickyRollEase(value: number) {
  const heldUntil = 0.18;
  const landingAt = 0.72;
  if (value <= heldUntil) return 0;
  if (value < landingAt) {
    const t = (value - heldUntil) / (landingAt - heldUntil);
    const release = t * t * (3 - 2 * t);
    return release * 0.92;
  }
  const settle = (value - landingAt) / (1 - landingAt);
  return 0.92 + 0.08 * settle * settle * (3 - 2 * settle);
}

function flipEase(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
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

function waveStagger(col: number, row: number, random: number) {
  return (((col * 0.64 + row * 0.31 + random * ROLL_SCATTER) % 1) + 1) % 1;
}

function waveLocalTime(
  time: number,
  sequenceDuration: number,
  alignSpeed: number,
  stagger: number,
  cycle: number,
  staggerSpan = ROLL_STAGGER,
) {
  const alignSpeedScale = clamp(alignSpeed, 0.75, 4);
  const start = (stagger * staggerSpan) / alignSpeedScale;
  const activeDuration = Math.max(0.5, sequenceDuration - ROLL_FINAL_HOLD);
  const simulationEnd = staggerSpan / alignSpeedScale + cycle;
  const simulationTime = clamp(time / activeDuration, 0, 1) * simulationEnd;
  return { local: simulationTime - start, cycle, start };
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
  alignSpeed: number,
  sequenceDuration: number,
  cubeSize: number,
  rollTurns: number,
  cellX: number,
  cellY: number,
  cellZ: number,
): MotionPose {
  const random = hash(index + 1, seed);
  const strength = amount / 100;
  const gravityScale = clamp(gravity / 100, 0.4, 1.8);
  const restitution = clamp(bounce / 100, 0, 1);
  const alignSpeedScale = clamp(alignSpeed, 0.75, 4);
  // Fall speed is implemented as timeline retiming, so the same complete
  // physical performance is preserved at every speed. The selected sequence
  // duration is the real playback and export duration, not a fixed cutoff.
  const simulationTime = time * (MAX_DURATION / clamp(sequenceDuration, MIN_SEQUENCE_DURATION, MAX_SEQUENCE_DURATION));

  if (mode === "roll") {
    const turnCount = clamp(Math.round(rollTurns), 1, 4);
    // The reference tips its cubes about a bottom edge rather than dropping
    // them: the marked face keeps pointing at the camera and the mark turns 90°
    // per tip, which is what rotating about that face's own normal does. Most
    // cubes are still at any instant, so each quarter turn is a short tip
    // followed by a long pause, and the phase is offset across the grid so the
    // tipping reads as a wave rolling through a settled field.
    // Columns run negative on the run-up side, so fold the phase back into
    // [0,1) rather than letting those cubes start before the sequence does.
    const stagger = waveStagger(col, row, random);
    // Face align tightens the wave here rather than reorienting cubes, since a
    // rolling cube is always already square to the grid.
    const start = (stagger * ROLL_STAGGER) / alignSpeedScale;
    const cycle = ROLL_CYCLE;
    // Reserve exactly the final second for the completed tableau. The
    // whole staggered wave is fitted into the remaining delivery time, so
    // changing Fall speed still changes the full duration without stretching
    // the end hold back out again.
    const activeDuration = Math.max(0.5, sequenceDuration - ROLL_FINAL_HOLD);
    const rollSimulationEnd = ROLL_STAGGER / alignSpeedScale + turnCount * cycle;
    const rollSimulationTime = clamp(time / activeDuration, 0, 1) * rollSimulationEnd;
    // Each cube makes one decisive tip in the same direction. Repeating this
    // four times made the field feel busy and less graphic than the source.
    const local = clamp(rollSimulationTime - start, 0, turnCount * cycle);
    const progress = local / cycle;
    const done = Math.floor(progress);
    const tip = clamp((progress - done) / ROLL_TIP_FRACTION, 0, 1);
    // Hold onto the planted face before releasing, then absorb the landing
    // into the next face. The longer active window and sticky easing give the
    // roll weight without deforming the modeled cube.
    const turns = Math.min(turnCount, done + stickyRollEase(tip));
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
      // Begin on the previous face and finish upright after one quarter-turn.
      rx: (turns - turnCount) * (Math.PI / 2),
      ry: 0,
      rz: 0,
      lift: 0,
      offsetX: 0,
      // Measure back from the finished grid, so the single physical tip carries
      // the cube into its final lattice position with the mark upright.
      offsetZ: (advance - turnCount) * cubeSize,
      scale: 1,
      revealed: false,
    };
  }

  // Spin and pop are silhouette-safe: they never tip about a square edge the
  // way Roll does, so circle / star / triangle keep contact and mark facing.
  if (mode === "spin") {
    const turns = clamp(Math.round(rollTurns), 1, 4);
    const stagger = waveStagger(col, row, random);
    const { local, cycle } = waveLocalTime(time, sequenceDuration, alignSpeed, stagger, 1.15);
    const tip = clamp(local / (cycle * 0.9), 0, 1);
    const eased = tip * tip * (3 - 2 * tip);
    // Rotate about the mark normal so the artwork stays camera-right while the
    // outline twirls — a coin spin rather than a cube tip.
    return {
      rx: (1 - eased) * turns * Math.PI * 2,
      ry: 0,
      rz: 0,
      lift: 0,
      offsetX: 0,
      offsetZ: 0,
      scale: 1,
      revealed: false,
    };
  }

  if (mode === "pop") {
    // Bodies are pulled into the middle and pack, rather than being thrown out
    // of it onto a lattice. Each one comes in along its own outward direction
    // from far enough away to be off frame, so nothing is seen waiting.
    const homeLength = Math.max(1, Math.hypot(cellX, cellY, cellZ));
    const entry = cubeSize * POP_ENTRY_DISTANCE;
    const entryX = (cellX / homeLength) * entry;
    const entryY = (cellY / homeLength) * entry;
    const entryZ = (cellZ / homeLength) * entry;
    const depth = clamp(homeLength / Math.max(1, cubeSize * POP_PACK_REACH), 0, 1);
    const stagger = clamp(depth * POP_ARRIVAL_SPREAD + random * POP_ARRIVAL_SCATTER, 0, 1);
    const { local, cycle } = waveLocalTime(time, sequenceDuration, alignSpeed, stagger, POP_FLIGHT, ROLL_STAGGER * 0.62);
    const spinX = (hash(index + 41, seed) - 0.5) * POP_TUMBLE * strength;
    const spinY = (hash(index + 49, seed) - 0.5) * POP_TUMBLE * strength;
    const spinZ = (hash(index + 57, seed) - 0.5) * POP_TUMBLE * strength;
    // A body comes to rest at an orientation of its own and keeps it. Unwinding
    // every rotation on arrival is what made the heap read as a mosaic rather
    // than a collision: nothing in a pile agrees with anything else, and that
    // disagreement is the whole of the effect.
    const restX = (hash(index + 71, seed) - 0.5) * Math.PI * POP_REST_SPREAD * strength;
    const restY = (hash(index + 79, seed) - 0.5) * Math.PI * POP_REST_SPREAD * strength;
    const restZ = (hash(index + 83, seed) - 0.5) * Math.PI * POP_REST_SPREAD * strength;
    // The heap holds its disorder, then turns to face the camera all together
    // in the last beat. The mark only has to read on the frame the cut to the
    // payoff lands on, so it buys the collision look for everything before it.
    const timeline = clamp(time / Math.max(0.5, sequenceDuration - ROLL_FINAL_HOLD), 0, 1);
    const alignPhase = clamp((timeline - POP_ALIGN_START) / (1 - POP_ALIGN_START), 0, 1);
    const alignEase = alignPhase * alignPhase * (3 - 2 * alignPhase);
    const held = 1 - alignEase;
    if (local <= 0) {
      // Still on its way in from off frame. Held at nothing rather than drawn
      // out there, so a wide zoom can never catch the bodies queueing.
      return { rx: restX, ry: restY, rz: restZ, lift: 0, offsetX: entryX, offsetZ: entryZ, scale: 0.001, revealed: false };
    }
    const t = clamp(local / cycle, 0, 1);
    // Fast off the mark, decelerating in. The cubic ease-out is the whole
    // difference between being pulled and being faded up; this used to be
    // t * t, which starts slow and accelerates into a hard stop.
    const flight = 1 - Math.pow(1 - t, 3);
    const overshoot = Math.sin(Math.PI * t) * POP_OVERSHOOT * (1 - t);
    const reach = clamp(flight + overshoot, 0, 1.3);
    const remaining = 1 - flight;
    return {
      rx: restX * held + spinX * remaining,
      ry: restY * held + spinY * remaining,
      rz: restZ * held + spinZ * remaining,
      // lift carries the vertical leg of the approach; the heap floats where it
      // was packed rather than resting on the floor every other mode stands on.
      lift: (entryY * (1 - reach)) / Math.max(1, cubeSize),
      offsetX: entryX * (1 - reach),
      offsetZ: entryZ * (1 - reach),
      scale: 1,
      revealed: false,
    };
  }

  // One reveal wave: every plain rear cap turns once onto its marked front.
  if (mode === "flip") {
    const stagger = (((row * 0.055 + col * 0.018 + random * 0.08) % 1) + 1) % 1;
    const activeDuration = Math.max(0.5, sequenceDuration - FLIP_FINAL_HOLD);
    const finalFaceAligned = time >= activeDuration;
    const sequenceProgress = clamp(time / activeDuration, 0, 1);
    // The last cell to be released still needs a whole turn inside the active
    // window. Letting the spread run wider than that left it partway through
    // its rotation when the hold began, and finalFaceAligned then snapped it
    // the rest of the way in a single frame — a visible twitch across the
    // trailing edge of the wave. Capping the spread lets every cell land on
    // its own easing curve, which is what makes finalFaceAligned agree with
    // the turn instead of overriding it.
    const waveSpan = clamp(FLIP_WAVE_SPAN * (2.4 / alignSpeedScale), 0.48, 1 - FLIP_TURN_FRACTION);
    const local = sequenceProgress - stagger * waveSpan;
    const turnProgress = clamp(local / FLIP_TURN_FRACTION, 0, 1);
    // Turn about z, not y. The flip camera sits out on +x, so z is the axis
    // running across the screen: rotating about it tips each cell top over
    // bottom and foreshortens its height, the way the reference's keys do.
    // Turning about y swung them like a door instead, narrowing to a vertical
    // sliver — the same half turn, but reading as a swivel rather than a flip.
    return {
      rx: 0,
      ry: 0,
      rz: finalFaceAligned ? 0 : Math.PI - flipEase(turnProgress) * Math.PI,
      lift: 0,
      offsetX: 0,
      offsetZ: 0,
      scale: 1,
      revealed: turnProgress >= 0.5,
    };
  }

  // The loop begins with every cube suspended above its final grid position.
  // Seeded release timing creates the selected drop pattern without changing
  // the deterministic, perfectly aligned end frame.
  const delay = 0.08 + random * 1.2;

  const dropHeight = 6.2 + hash(index + 8, seed) * 7.4;
  const acceleration = 7.2 * gravityScale;
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
      scale: 1,
      revealed: false,
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
      scale: 1,
      revealed: false,
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
    scale: 1,
    revealed: false,
  };
}

// Kept as a deterministic Canvas 2D fallback for browsers that cannot create
// a WebGL renderer, even though the current runtime takes the Three.js path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // In the 16:9 reference, a settled frame shows about five complete rows and
  // eight complete columns, plus clipped edge cubes. This surface generates a
  // little beyond that crop so the zoom never reveals an empty border.
  const columns = Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.18 : aspect < 0.8 ? 0.68 : 1)));
  const rows = Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.72 : aspect < 0.8 ? 1.45 : 1)));
  // Keep the grid footprint stable so cube size remains an independent visual
  // control in every aspect ratio instead of cancelling out through auto-fit.
  // A quarter turn carries a cube a full cube width, so a rolled cube lands on
  // top of a neighbour that has not moved yet unless the lattice is more than
  // two cubes wide. Framing compensates, so the field reads the same size.
  const spacing = gridSpacing(settings.shape, settings.shapeB, settings.cubeSize, settings.mode);
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

  // A cube sits up to the selected number of turns along z from its cell,
  // baring the edge it rolled off. Extra rows on both sides cover that.
  const runUp = settings.mode === "roll"
    ? Math.ceil((settings.rollTurns * settings.cubeSize) / spacing) + 1
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
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
      settings.rollTurns,
      cube.x,
      0, // the legacy 2D path has no vertical axis; pop is Three.js only
      cube.z,
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
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
      settings.rollTurns,
      cube.x,
      0, // the legacy 2D path has no vertical axis; pop is Three.js only
      cube.z,
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
  y: number;
  z: number;
  startShape: ShapeId;
  endShape: ShapeId;
  contactStart: Vec3[];
  contactEnd: Vec3[];
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
};

type ThreeSceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  cubes: ThreeCube[];
  cubeGeometry: THREE.BufferGeometry | null;
  cubeMaterials: THREE.Material[];
  popBake: PopBake | null;
  popBakeKey: string;
  geometryByShape: Partial<Record<ShapeId, THREE.BufferGeometry>>;
  materialsByShape: Partial<Record<ShapeId, THREE.Material[]>>;
  brandTexture: THREE.CanvasTexture | null;
  groundGeometry: THREE.PlaneGeometry | null;
  groundMaterial: THREE.MeshStandardMaterial | null;
  keyLight: THREE.DirectionalLight | null;
  ambientLight: THREE.AmbientLight | null;
  hemisphereLight: THREE.HemisphereLight | null;
  structureKey: string;
  extent: number;
  gridColumns: number;
  gridRows: number;
  gridSpacing: number;
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

/* ── shapes ─────────────────────────────────────────────────────────
 * Every solid is one outline extruded along x, because +x is the face the mark
 * sits on. The cube keeps its own BoxGeometry rather than being expressed as a
 * four-sided prism, so switching shapes cannot change what the default
 * renders. The others are turned so their marked cap lands on +x too.
 *
 * Mark UVs are fitted per outline so logo + MUSIC never clip. Shapes grow first;
 * the lockup only scales down when the silhouette still cannot hold cube size.
 */
type ShapeId = "cube" | "circle" | "star" | "triangle";

const SHAPE_LABELS: Record<ShapeId, string> = {
  cube: "Cube",
  circle: "Circle",
  star: "Star",
  triangle: "Triangle",
};

// Outline radius as a fraction of half the cube size, chosen so every shape
// carries roughly the circle's visual mass rather than the same logo. Sizing
// them to hold a full cube-scale lockup instead put the star at 3.04 and the
// triangle at 2.6 — on a mixed flip wall those read as a different, much
// larger object than the cube beside them, which is what the pairing is meant
// to compare. Radii are equal-area against the circle, then nudged for how
// each outline actually reads: a star's spread points look larger than its
// area, a triangle's single mass looks smaller. The lockup now scales down to
// fit these instead (SHAPE_MARK_ROOM).
const SHAPE_RADIUS: Record<ShapeId, number> = {
  cube: 1,
  circle: 1.26,
  star: 1.85,
  triangle: 2.05,
};

// How far the notches cut in, as a fraction of the outer radius. This is what
// sets both how fat the star's body reads and — through SHAPE_MARK_ROOM — how
// much lockup it can carry, since the mark has to clear the notch circle. At
// the old 0.44 the body was too lean to hold the mark at anything near the
// scale the other outlines give it. Pushing it out to 0.58 opens the centre
// without reaching 0.68, where the inner and outer radii sit close enough that
// the outline reads as a lumpy decagon rather than a star.
const STAR_INNER_RATIO = 0.58;

// Distance from the face centre to the corner of the drawn lockup, in half-cube
// units, taken from drawMark's layout: the artwork spans 0.82 of the face wide
// and the block plus subline runs from y 0.08 to about 0.85, so the corner sits
// at hypot(0.41, 0.42) ≈ 0.587 of the face — 1.17 half-units.
const MARK_CORNER_REACH = 1.17;

// Share of its own radius each outline can actually give the lockup. A circle
// offers all of it; a star only the notch circle through its inner vertices;
// an equilateral triangle only its inradius, which is half the circumradius.
const SHAPE_MARK_ROOM: Record<ShapeId, number> = {
  cube: 1,
  circle: 1,
  star: STAR_INNER_RATIO,
  triangle: 0.5,
};

// How large the lockup may be drawn on a shape, as a fraction of the cube-face
// scale. The cube is the reference and always keeps it; the others take the
// most their silhouette can hold without clipping.
function markScaleFor(shape: ShapeId) {
  if (shape === "cube") return 1;
  return Math.min(1, (SHAPE_RADIUS[shape] * SHAPE_MARK_ROOM[shape]) / MARK_CORNER_REACH);
}

function starOutline(points: number, outer: number, inner: number) {
  const vertices: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < points * 2; index += 1) {
    // Start at the top so the star stands on two points rather than balancing.
    const angle = Math.PI / 2 + (index * Math.PI) / points;
    const radius = index % 2 === 0 ? outer : inner;
    vertices.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  // Same fillet, same radius as the triangle, so the two outlines read as a
  // family rather than one arriving with needle points beside the other's
  // softened corners.
  return roundedOutline(vertices);
}

type TriangleDims = { top: number; bottom: number; base: number };

// A true equilateral triangle, apex up, inscribed in a circle of this radius
// — the earlier "broad shield" (top 1.6·half, bottom 1.1·half, base 3.4·half)
// widened the base far past the top specifically to keep the MTV lockup from
// clipping, but the result reads as a wide flat dart rather than a triangle.
// The outline grows around the shared cube-scale mark while staying a true
// equilateral triangle.
function triangleDims(half: number): TriangleDims {
  const radius = half * SHAPE_RADIUS.triangle;
  return {
    top: radius,
    bottom: radius * 0.5,
    base: radius * 0.866, // radius * sin(60°)
  };
}

// Share of its shorter edge every corner spends on its fillet. Rounding to a
// fixed radius instead makes the softness depend on the corner's angle: at one
// radius the triangle's 60° corners looked right while the star's narrow tips
// swallowed 44% of each edge and its wide notches barely curved at all. Holding
// the setback to a share of the edge gives every corner the same softness
// whatever its angle, so a star's tips and notches match a triangle's corners.
// Because it is a share rather than a radius, one value keeps every corner on
// every outline equally soft: each gives up the same proportion of its edge.
// Two corners meet on every edge, so it has to stay under 0.5 or one fillet
// would run past its neighbour's. At 0.22 an edge keeps 56% of its length
// straight, which still reads as a star rather than a flower.
const CORNER_EDGE_FRACTION = 0.22;

// A regular polygon with each corner rounded by a quadratic curve toward the
// vertex — the cheap approximation of a tangent-arc fillet, close enough at
// this size and a fraction of the construction a true arc would take.
function roundedOutline(vertices: Array<{ x: number; y: number }>, edgeFraction = CORNER_EDGE_FRACTION) {
  const path = new THREE.Shape();
  const count = vertices.length;
  for (let index = 0; index < count; index += 1) {
    const previous = vertices[(index - 1 + count) % count];
    const current = vertices[index];
    const next = vertices[(index + 1) % count];
    const towardPrevious = { x: previous.x - current.x, y: previous.y - current.y };
    const towardNext = { x: next.x - current.x, y: next.y - current.y };
    const lenPrev = Math.hypot(towardPrevious.x, towardPrevious.y) || 1;
    const lenNext = Math.hypot(towardNext.x, towardNext.y) || 1;
    const unitPrev = { x: towardPrevious.x / lenPrev, y: towardPrevious.y / lenPrev };
    const unitNext = { x: towardNext.x / lenNext, y: towardNext.y / lenNext };
    // Distance back from the vertex to the tangent point, measured off the edge
    // rather than off a radius so that a narrow tip and a wide notch on the same
    // outline come out equally soft.
    const setback = Math.min(lenPrev, lenNext) * edgeFraction;
    const start = { x: current.x + unitPrev.x * setback, y: current.y + unitPrev.y * setback };
    const end = { x: current.x + unitNext.x * setback, y: current.y + unitNext.y * setback };
    if (index === 0) path.moveTo(start.x, start.y);
    else path.lineTo(start.x, start.y);
    path.quadraticCurveTo(current.x, current.y, end.x, end.y);
  }
  path.closePath();
  return path;
}

function triangleOutline(half: number) {
  const { top, bottom, base } = triangleDims(half);
  return roundedOutline(
    [
      { x: 0, y: top },
      { x: base, y: -bottom },
      { x: -base, y: -bottom },
    ],
  );
}

function extrudeAlongX(shape: THREE.Shape, size: number, curveSegments = 1, depth = size) {
  const half = size / 2;
  const halfDepth = depth / 2;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    // The bevel eats in from both caps. Left at a fraction of the face it would
    // swallow a thin card whole and the front cap would stop being flat, so it
    // is held against the depth as well.
    bevelThickness: Math.min(half * 0.05, halfDepth * 0.4),
    bevelSize: Math.min(half * 0.045, halfDepth * 0.36),
    bevelSegments: 2,
    curveSegments,
  });
  // Extrusion runs along +z; centre it, then turn that axis onto +x.
  geometry.translate(0, 0, -halfDepth);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

// depth is the wall the turn shows edge-on. At the default it equals the face
// and every cell is a solid block; pulled down it becomes a card, and at the
// bottom of the range a coin. That is the whole point of the control: the A/B
// swap happens at 90deg, so the thinner the wall, the less there is to see it in.
function buildShapeGeometry(shape: ShapeId, size: number, depth = size): THREE.BufferGeometry {
  const half = size / 2;
  // Box rather than an extruded square: identical at full depth, and it keeps
  // the thin axis on x, the one the flip camera looks down.
  if (shape === "cube") return new THREE.BoxGeometry(depth, size, size);

  if (shape === "star") {
    const radius = half * SHAPE_RADIUS.star;
    // Use the same curve tessellation as the triangle. Leaving the star on the
    // default single segment turned every quadratic fillet into a straight
    // chord, which is why its tips still looked horizontally sliced off even
    // though both outlines shared the same roundedOutline path.
    return extrudeAlongX(starOutline(5, radius, radius * STAR_INNER_RATIO), size, 6, depth);
  }

  if (shape === "triangle") {
    return extrudeAlongX(triangleOutline(half), size, 6, depth);
  }

  // Circle as an extruded disc so caps and UVs match the star/triangle path.
  const radius = half * SHAPE_RADIUS.circle;
  const circle = new THREE.Shape();
  circle.absarc(0, 0, radius, 0, Math.PI * 2, false);
  return extrudeAlongX(circle, size, 48, depth);
}

/* Each geometry type orders its material groups differently, and an extrusion's
 * order also depends on how it was built. Rather than keep a table of slots per
 * shape — which is what kept putting the mark on a wall — ask the geometry which
 * group actually sits on the +x cap. */
function markedGroupIndex(geometry: THREE.BufferGeometry, half: number, capX = half): number {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || geometry.groups.length === 0) return 0;
  const vertexAt = (slot: number) => (index ? index.getX(slot) : slot);
  // Wide enough to clear the bevel's inset with margin, and never wider than
  // the card is thick, or a thin one would match its own back face too.
  const tolerance = Math.min(half * 0.09, capX * 0.5);
  let best = 0;
  let bestShare = -1;
  geometry.groups.forEach((group, groupIndex) => {
    const limit = group.start + group.count;
    let onCap = 0;
    let sampled = 0;
    for (let slot = group.start; slot < limit; slot += 3) {
      const vertex = vertexAt(slot);
      if (vertex >= position.count) continue;
      sampled += 1;
      if (Math.abs(position.getX(vertex) - capX) <= tolerance) onCap += 1;
    }
    const share = sampled > 0 ? onCap / sampled : 0;
    if (share > bestShare) {
      bestShare = share;
      best = groupIndex;
    }
  });
  return bestShare > 0.6 ? best : 0;
}

function shapeMaterials(geometry: THREE.BufferGeometry, half: number, marked: THREE.Material, plain: THREE.Material, capX = half): THREE.Material[] {
  const slots = Math.max(1, geometry.groups.length);
  const markedSlot = markedGroupIndex(geometry, half, capX);
  return Array.from({ length: slots }, (_, slot) => (slot === markedSlot ? marked : plain));
}

function isolateExtrudedFrontCap(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position) return;
  const vertexAt = (slot: number) => (index ? index.getX(slot) : slot);
  const slotCount = index ? index.count : position.count;
  let frontX = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < position.count; vertex += 1) frontX = Math.max(frontX, position.getX(vertex));
  const tolerance = Math.max(0.001, Math.abs(frontX) * 0.0001);
  geometry.clearGroups();
  let runStart = 0;
  let runMaterial = -1;
  for (let slot = 0; slot < slotCount; slot += 3) {
    const isFrontCap = [slot, slot + 1, slot + 2].every(
      (triangleSlot) => Math.abs(position.getX(vertexAt(triangleSlot)) - frontX) <= tolerance,
    );
    const materialIndex = isFrontCap ? 0 : 1;
    if (runMaterial === -1) runMaterial = materialIndex;
    if (materialIndex !== runMaterial) {
      geometry.addGroup(runStart, slot - runStart, runMaterial);
      runStart = slot;
      runMaterial = materialIndex;
    }
  }
  geometry.addGroup(runStart, slotCount - runStart, runMaterial);
}

/* Each geometry type lays its UVs out differently — extrusions use world units
 * outright, which blows the texture up far past the shape. Rewrite the UVs on
 * the +x cap from vertex positions. Every outline uses the cube face's exact
 * UV scale, so the logo and MUSIC remain the same size across shapes. */
// half sizes the mark and belongs to the face; capX is where the front cap
// actually sits, which is depth/2 and only equals half at full thickness. They
// were the same value until the card could be thinned, and conflating them is
// what makes a thin card lose its logo entirely: the cap test finds nothing.
function applyCapUVs(geometry: THREE.BufferGeometry, shape: ShapeId, half: number, capX = half) {
  if (shape === "cube") return;
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (!position || !uv) return;
  // The texture is painted onto this much of the cap, so a smaller value draws
  // a smaller lockup and leaves the rest of the outline in the flat cube colour
  // the texture is cleared to. Shapes that cannot hold the full cube-scale mark
  // shrink it rather than growing themselves past the other outlines.
  const markHalf = half * markScaleFor(shape);
  // Matches markedGroupIndex's tolerance, so the bevel rim gets mapped along
  // with the flat cap instead of left with the extrusion's default UVs.
  const tolerance = Math.min(half * 0.09, capX * 0.5);
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    // Only the cap facing the camera-right carries the mark; leave the walls
    // and the far cap with whatever they had.
    if (Math.abs(x - capX) > tolerance) continue;
    const z = position.getZ(index);
    const y = position.getY(index);
    uv.setXY(index, 0.5 - z / (markHalf * 2), 0.5 + y / (markHalf * 2));
  }
  uv.needsUpdate = true;
}

// Corners used to sit the solid on the ground. The renderer drops each object
// until its lowest rotated point touches, so this has to follow the outline
// rather than stay a cube.
function shapeContactPoints(shape: ShapeId, half: number): Vec3[] {
  if (shape === "cube") {
    return [
      { x: -half, y: -half, z: -half }, { x: half, y: -half, z: -half },
      { x: half, y: -half, z: half }, { x: -half, y: -half, z: half },
      { x: -half, y: half, z: -half }, { x: half, y: half, z: -half },
      { x: half, y: half, z: half }, { x: -half, y: half, z: half },
    ];
  }
  const points: Vec3[] = [];
  if (shape === "star") {
    const radius = half * SHAPE_RADIUS.star;
    for (let index = 0; index < 10; index += 1) {
      const angle = Math.PI / 2 + (index * Math.PI) / 5;
      const r = index % 2 === 0 ? radius : radius * STAR_INNER_RATIO;
      points.push({ x: half, y: Math.sin(angle) * r, z: Math.cos(angle) * r });
      points.push({ x: -half, y: Math.sin(angle) * r, z: Math.cos(angle) * r });
    }
    return points;
  }
  if (shape === "triangle") {
    const { top, bottom, base } = triangleDims(half);
    const corners = [
      { y: top, z: 0 },
      { y: -bottom, z: base },
      { y: -bottom, z: -base },
    ];
    for (const corner of corners) {
      points.push({ x: half, y: corner.y, z: corner.z });
      points.push({ x: -half, y: corner.y, z: corner.z });
    }
    return points;
  }
  const radius = half * SHAPE_RADIUS.circle;
  const segments = 24;
  for (let index = 0; index < segments; index += 1) {
    const angle = (index * Math.PI * 2) / segments;
    points.push({ x: half, y: Math.sin(angle) * radius, z: Math.cos(angle) * radius });
    points.push({ x: -half, y: Math.sin(angle) * radius, z: Math.cos(angle) * radius });
  }
  return points;
}

// Keep non-cube silhouettes from overlapping when their outline outgrows the cube.
function shapeFootprint(shape: ShapeId, cubeSize: number) {
  const half = cubeSize / 2;
  if (shape === "circle" || shape === "star") return cubeSize * SHAPE_RADIUS[shape];
  if (shape === "triangle") {
    const { top, bottom, base } = triangleDims(half);
    return Math.max(base * 2, top + bottom);
  }
  return cubeSize;
}

// Exact width of an outline across the locked flip camera's horizontal z axis.
// At the edge-on midpoint only this span and the solid's extrusion remain
// visible, so matching it across A/B makes the geometry handoff continuous.
function flipHorizontalSpan(shape: ShapeId, cubeSize: number) {
  const half = cubeSize / 2;
  if (shape === "circle") return cubeSize * SHAPE_RADIUS.circle;
  if (shape === "star") return cubeSize * SHAPE_RADIUS.star * Math.cos(Math.PI / 10);
  if (shape === "triangle") return triangleDims(half).base * 2;
  return cubeSize;
}

function flipShapeCrossover(rotationZ: number, shownShape: ShapeId, startShape: ShapeId, endShape: ShapeId, cubeSize: number) {
  // Same outline on both sides means there is no handoff to cover. Flattening
  // the silhouette anyway would pinch the shape at 90 degrees for no reason.
  if (startShape === endShape) return { face: 1, edge: 1 };
  const faceShare = Math.abs(Math.cos(rotationZ));
  const t = clamp(faceShare / FLIP_SHAPE_CROSSOVER_FACE, 0, 1);
  const faceEase = t * t * (3 - 2 * t);
  const edgeBlend = 1 - faceEase;
  const sharedSpan = Math.min(
    flipHorizontalSpan(startShape, cubeSize),
    flipHorizontalSpan(endShape, cubeSize),
  );
  const shownSpan = flipHorizontalSpan(shownShape, cubeSize);
  return {
    // Local y carries the recognizable face outline. Ease it almost flat around
    // the swap so a frame that lands just before/after 90° cannot expose a cut.
    face: 1 - edgeBlend * (1 - FLIP_CROSSOVER_FACE_SCALE),
    // Keep the edge itself present, but make both geometries exactly the same
    // width at 90° before restoring the incoming outline symmetrically.
    edge: 1 + (sharedSpan / shownSpan - 1) * edgeBlend,
  };
}

function gridSpacing(shape: ShapeId, shapeB: ShapeId, cubeSize: number, mode: MotionMode) {
  // Only flip puts both shapes on the field. Every other mode renders shape A
  // alone, so widening their lattice to clear shape B thinned the grid to a
  // handful of oversized solids for an outline that never appears — picking
  // Star as the flip partner used to gut the roll field.
  const footprint = mode === "flip"
    ? Math.max(shapeFootprint(shape, cubeSize), shapeFootprint(shapeB, cubeSize))
    : shapeFootprint(shape, cubeSize);
  const shapePitch = footprint * 1.55;
  if (mode === "roll") return Math.max(BASE_SPACING, cubeSize * ROLL_SPACING, shapePitch);
  if (mode === "flip") return Math.max(FLIP_GRID_SPACING, footprint * FLIP_SHAPE_GAP);
  return Math.max(BASE_SPACING, shapePitch);
}

function flipPair(row: number, col: number, shapeA: ShapeId, shapeB: ShapeId) {
  const alt = (((row + col) % 2) + 2) % 2 === 0;
  return alt
    ? { startShape: shapeA, endShape: shapeB }
    : { startShape: shapeB, endShape: shapeA };
}

function clearThreeScene(state: ThreeSceneState) {
  state.scene.clear();
  const disposedGeometry = new Set<THREE.BufferGeometry>();
  Object.values(state.geometryByShape).forEach((geometry) => {
    if (!geometry || disposedGeometry.has(geometry)) return;
    geometry.dispose();
    disposedGeometry.add(geometry);
  });
  if (state.cubeGeometry && !disposedGeometry.has(state.cubeGeometry)) {
    state.cubeGeometry.dispose();
  }
  const disposedMaterial = new Set<THREE.Material>();
  const disposeMaterial = (material: THREE.Material) => {
    if (disposedMaterial.has(material)) return;
    material.dispose();
    disposedMaterial.add(material);
  };
  state.cubeMaterials.forEach(disposeMaterial);
  Object.values(state.materialsByShape).forEach((materials) => {
    materials?.forEach(disposeMaterial);
  });
  state.brandTexture?.dispose();
  state.groundGeometry?.dispose();
  state.groundMaterial?.dispose();
  state.cubes = [];
  state.cubeGeometry = null;
  state.cubeMaterials = [];
  state.geometryByShape = {};
  state.materialsByShape = {};
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
  const flipShortAxisCount = Math.max(8, Math.round((settings.density / 7) * FLIP_SHORT_AXIS_COUNT));
  const columns = settings.mode === "flip"
    ? Math.max(6, Math.round(flipShortAxisCount * Math.max(1, aspect)))
    : Math.max(3, Math.round(settings.density * (aspect > 1.2 ? 1.35 : aspect < 0.8 ? 0.68 : 1)));
  const rows = settings.mode === "flip"
    ? Math.max(6, Math.round(flipShortAxisCount * Math.max(1, 1 / aspect)))
    : Math.max(4, Math.round(settings.density * (aspect > 1.2 ? 0.78 : aspect < 0.8 ? 1.45 : 1)));
  const spacing = gridSpacing(settings.shape, settings.shapeB, settings.cubeSize, settings.mode);
  // The solve decides how tall the heap ends up, so pop is framed off the one
  // dimension that is fixed: the radius it is held to.
  // The clump settles to roughly two body widths of radius, so it is framed
  // off that rather than off a lattice it no longer has.
  state.extent = settings.mode === "pop"
    ? settings.cubeSize * 5.2
    : Math.max(columns, rows) * BASE_SPACING * FRAMING;
  state.gridColumns = columns;
  state.gridRows = rows;
  state.gridSpacing = spacing;

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

  // Flip shows the two selected outlines across the turn. Pop takes all four:
  // the reference gathers a crowd of different objects, and a clump of one or
  // two outlines reads as a repeat rather than a crowd.
  const shapesNeeded: ShapeId[] = settings.mode === "pop"
    ? (Object.keys(SHAPE_LABELS) as ShapeId[])
    : settings.mode === "flip"
      ? Array.from(new Set<ShapeId>([settings.shape, settings.shapeB]))
      : [settings.shape];
  const geometryByShape: Partial<Record<ShapeId, THREE.BufferGeometry>> = {};
  const materialsByShape: Partial<Record<ShapeId, THREE.Material[]>> = {};
  const half = settings.cubeSize / 2;
  // Thickness is a flip control. Every other mode wants the solid block, and
  // this cache is keyed by shape alone, so a thin wall applied unconditionally
  // would follow the shape straight into Drop, Roll and Spin.
  const cardDepth = settings.mode === "flip"
    ? settings.cubeSize * (settings.cardThickness / 100)
    : settings.cubeSize;
  const capX = cardDepth / 2;
  for (const shape of shapesNeeded) {
    const geometry = buildShapeGeometry(shape, settings.cubeSize, cardDepth);
    applyCapUVs(geometry, shape, half, capX);
    if (shape !== "cube") isolateExtrudedFrontCap(geometry);
    geometryByShape[shape] = geometry;
    materialsByShape[shape] = shape === "cube"
      ? shapeMaterials(geometry, half, markedMaterial, faceMaterial, capX)
      : [markedMaterial, faceMaterial];
  }
  const cubeGeometry = geometryByShape[settings.shape] ?? buildShapeGeometry(settings.shape, settings.cubeSize, cardDepth);
  const cubeMaterials = materialsByShape[settings.shape] ?? [markedMaterial, faceMaterial];
  const contactByShape: Partial<Record<ShapeId, Vec3[]>> = {};
  for (const shape of shapesNeeded) {
    contactByShape[shape] = shapeContactPoints(shape, half);
  }

  const stride = columns + 3;
  // Pop no longer lays its bodies out at all: a contact solve decides where
  // they end up, so all that is fixed here is how many there are. They are
  // parked at the origin and the bake overwrites every transform each frame.
  // The reference gathers twenty. Enough to read as a crowd, few enough that
  // every one of them is still its own object rather than part of a mass.
  const popCount = settings.mode === "pop"
    ? clamp(Math.round(settings.density * 3), 10, 80)
    : 0;
  let popSlot = 0;

  const margin = settings.mode === "roll"
    ? Math.ceil((settings.rollTurns * settings.cubeSize) / spacing) + 1
    : 1;
  for (let row = -margin; row <= rows + margin; row += 1) {
    for (let col = -1; col <= columns; col += 1) {
      const index = (row + margin + 1) * stride + col + 2;
      if (settings.mode === "pop" && popSlot++ >= popCount) continue;
      const slot = settings.mode === "pop" ? { x: 0, y: 0, z: 0 } : undefined;
      const staggerX = settings.mode === "flip" ? 0 : row % 2 === 0 ? 0 : spacing * 0.5;
      const x = slot ? slot.x : settings.mode === "flip" ? 0 : (col - (columns - 1) / 2) * spacing + staggerX;
      const y = slot ? slot.y : settings.mode === "flip" ? ((rows - 1) / 2 - row) * spacing : 0;
      const z = slot
        ? slot.z
        : settings.mode === "flip"
          ? (col - (columns - 1) / 2) * spacing
          : (row - (rows - 1) / 2) * spacing;
      // Flip pairs its two outlines across the turn; pop deals every body one
      // of the four and it keeps it from end to end.
      const popOutlines = Object.keys(SHAPE_LABELS) as ShapeId[];
      const popShape = popOutlines[Math.min(
        popOutlines.length - 1,
        Math.floor(hash(index + 61, 0) * popOutlines.length),
      )];
      const pair = settings.mode === "flip"
        ? flipPair(row, col, settings.shape, settings.shapeB)
        : settings.mode === "pop"
          ? { startShape: popShape, endShape: popShape }
          : { startShape: settings.shape, endShape: settings.shape };
      const startGeometry = geometryByShape[pair.startShape] ?? cubeGeometry;
      const startMaterials = materialsByShape[pair.startShape] ?? cubeMaterials;
      const mesh = new THREE.Mesh(startGeometry, startMaterials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = true;
      state.scene.add(mesh);
      state.cubes.push({
        index,
        row,
        col,
        x,
        y,
        z,
        startShape: pair.startShape,
        endShape: pair.endShape,
        contactStart: contactByShape[pair.startShape] ?? shapeContactPoints(pair.startShape, half),
        contactEnd: contactByShape[pair.endShape] ?? shapeContactPoints(pair.endShape, half),
        mesh,
      });
    }
  }

  const floorSize = Math.max(
    3200,
    settings.mode === "flip"
      ? Math.max(state.gridColumns, state.gridRows) * state.gridSpacing * 1.35
      : state.extent * 7,
  );
  const groundGeometry = new THREE.PlaneGeometry(floorSize, floorSize);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: settings.background,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  // Pop has no floor. The clump is held in mid air by the pull onto the origin,
  // and a floor would give it a bottom to sit on and a shadow to cast — neither
  // of which the reference has.
  ground.visible = settings.mode !== "pop";
  if (settings.mode === "flip") {
    ground.rotation.y = Math.PI / 2;
    ground.position.x = -settings.cubeSize * 0.7;
  } else {
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
  }
  ground.receiveShadow = true;
  state.scene.add(ground);

  // Broad environment light keeps every yellow face alive; the warm key is
  // responsible for the square, gently feathered shadow seen in the reference.
  const hemisphereLight = new THREE.HemisphereLight("#fff9df", shade(settings.background, -0.025), 1.9);
  const ambientLight = new THREE.AmbientLight("#fff5cf", 0.72);
  const keyLight = new THREE.DirectionalLight("#fff4c2", 1.45);
  if (settings.mode === "flip") keyLight.position.set(1800, 900, 700);
  else keyLight.position.set(900, 1800, -650);
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
  state.cubeMaterials = [faceMaterial, markedMaterial];
  state.geometryByShape = geometryByShape;
  state.materialsByShape = materialsByShape;
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
      popBake: null,
      popBakeKey: "",
      geometryByShape: {},
      materialsByShape: {},
      brandTexture: null,
      groundGeometry: null,
      groundMaterial: null,
      keyLight: null,
      ambientLight: null,
      hemisphereLight: null,
      structureKey: "",
      extent: 1,
      gridColumns: 1,
      gridRows: 1,
      gridSpacing: BASE_SPACING,
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
    settings.shape,
    settings.shapeB,
    settings.mode,
    settings.rollTurns,
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
  const rollActiveDuration = Math.max(0.5, settings.sequenceDuration - ROLL_FINAL_HOLD);
  const rollZoomProgress = settings.mode === "roll" || settings.mode === "spin" || settings.mode === "pop"
    ? clamp(time / rollActiveDuration, 0, 1)
    : 0;
  // Smoothly push in during the roll and hold the final framing. Orthographic
  // projection makes this a true scale move with no unwanted perspective shift.
  const rollZoom = 1 + (ROLL_ZOOM_IN - 1) * (rollZoomProgress * rollZoomProgress * (3 - 2 * rollZoomProgress));
  const flipScale = Math.min(
    width / ((state.gridColumns + 0.25) * state.gridSpacing),
    height / ((state.gridRows + 0.25) * state.gridSpacing),
  ) * (settings.cameraZoom / REFERENCE_CAMERA_ZOOM) * FLIP_CAMERA_SCALE;
  const scale = settings.mode === "flip"
    ? flipScale
    : Math.min(width, height) / Math.max(420, state.extent * extentFactor) * (settings.cameraZoom / 100) * rollZoom;
  state.camera.left = -width / (2 * scale);
  state.camera.right = width / (2 * scale);
  state.camera.top = height / (2 * scale);
  state.camera.bottom = -height / (2 * scale);
  state.camera.near = 1;
  state.camera.far = 10000;
  const view = settings.mode === "flip" ? cameraVector(90, 0) : cameraVector(settings.cameraYaw, settings.cameraPitch);
  state.camera.position.set(view.x * 4200, view.y * 4200, view.z * 4200);
  state.camera.up.set(0, 1, 0);
  // Pop has to be looked at where the heap actually is. Every other mode sits
  // on the floor, so the shared target is just above it.
  // The clump gathers on the origin, which is exactly where the camera looks.
  const popTarget = 0;
  state.camera.lookAt(
    0,
    settings.mode === "flip" ? 0 : settings.mode === "pop" ? popTarget : settings.cubeSize * 0.18,
    0,
  );
  state.camera.updateProjectionMatrix();

  // Solve the whole sequence once and keep it. Contacts only exist in order,
  // so this is the one thing in the studio that cannot be evaluated at an
  // arbitrary time — bake it and every reader downstream stays a lookup.
  if (settings.mode === "pop") {
    const popKey = [
      state.cubes.length,
      settings.cubeSize,
      settings.density,
      settings.shape,
      settings.shapeB,
      settings.gravity,
      settings.bounce,
      settings.motion,
      settings.sequenceDuration,
      seed,
    ].join("|");
    if (state.popBakeKey !== popKey) {
      state.popBake = bakePopHeap({
        bodies: state.cubes.map((cube) => popBodySpec(cube.startShape, settings.cubeSize)),
        cubeSize: settings.cubeSize,
        gravity: settings.gravity,
        bounce: settings.bounce,
        tumble: settings.motion,
        seed,
        duration: settings.sequenceDuration,
        fps: EXPORT_FPS,
        // Released as a block a few widths out and drawn in, the way the
        // reference starts on an array and lets the field do the gathering.
        spawnRadius: settings.cubeSize * 2.6,
      });
      state.popBakeKey = popKey;
    }
  } else if (state.popBake) {
    state.popBake = null;
    state.popBakeKey = "";
  }

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
      settings.alignSpeed,
      settings.sequenceDuration,
      settings.cubeSize,
      settings.rollTurns,
      cube.x,
      cube.y,
      cube.z,
    );
    const shownShape = movement.revealed ? cube.endShape : cube.startShape;
    const localVertices = movement.revealed ? cube.contactEnd : cube.contactStart;
    const geometry = state.geometryByShape[shownShape];
    const materials = state.materialsByShape[shownShape];
    if (geometry && cube.mesh.geometry !== geometry) {
      cube.mesh.geometry = geometry;
      if (materials) cube.mesh.material = materials;
    }
    const rotatedVertices = localVertices.map((point) => rotate(point, movement.rx, movement.ry, movement.rz));
    const minimumLocalY = Math.min(...rotatedVertices.map((point) => point.y));
    const contactHeight = settings.mode === "flip"
      ? cube.y
      : settings.mode === "pop"
        ? cube.y + movement.lift * settings.cubeSize
        : -minimumLocalY + movement.lift * settings.cubeSize;
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
  // Only Roll translates along z; Spin/Pop would jitter if rotating footprints
  // were lane-resolved the same way.
  if (settings.mode === "roll") {
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
  }

  const popBake = settings.mode === "pop" ? state.popBake : null;
  // The turn onto the camera happens inside the solve, not here: the bodies are
  // packed while pointing every which way, so turning them afterwards would
  // leave that packing meaningless and run them through one another. What the
  // bake hands back is already facing the right way.
  const popUpright = new THREE.Quaternion();
  const popSolved = new THREE.Quaternion();

  cubeFrames.forEach((frame, bodyIndex) => {
    const { cube, movement } = frame;
    if (popBake) {
      const at = clamp(time * popBake.fps, 0, popBake.frames.length - 1);
      const before = Math.floor(at);
      const after = Math.min(before + 1, popBake.frames.length - 1);
      const mix = at - before;
      const a = popBake.frames[before];
      const b = popBake.frames[after];
      const i = bodyIndex * POP_STRIDE;
      if (!a || !b || i + POP_STRIDE > a.length) return;
      // Not let into the solve yet, so it is not anywhere. Bodies arrive one at
      // a time; twenty of them already in frame on frame one is a crowd that
      // was always there, not a thing that pops.
      if (a[i + 7] < 0.5) {
        cube.mesh.scale.setScalar(0);
        return;
      }
      cube.mesh.position.set(
        a[i] + (b[i] - a[i]) * mix,
        a[i + 1] + (b[i + 1] - a[i + 1]) * mix,
        a[i + 2] + (b[i + 2] - a[i + 2]) * mix,
      );
      popSolved.set(a[i + 3], a[i + 4], a[i + 5], a[i + 6]);
      popUpright.set(b[i + 3], b[i + 4], b[i + 5], b[i + 6]);
      popSolved.slerp(popUpright, mix);
      cube.mesh.quaternion.copy(popSolved);
      cube.mesh.scale.setScalar(1);
      return;
    }
    cube.mesh.position.set(cube.x + movement.offsetX, frame.contactHeight, frame.centerZ);
    cube.mesh.rotation.set(movement.rx, movement.ry, movement.rz, "XYZ");
    if (settings.mode === "flip") {
      const shownShape = movement.revealed ? cube.endShape : cube.startShape;
      const crossover = flipShapeCrossover(
        movement.rz,
        shownShape,
        cube.startShape,
        cube.endShape,
        settings.cubeSize,
      );
      cube.mesh.scale.set(
        movement.scale,
        movement.scale * crossover.face,
        movement.scale * crossover.edge,
      );
    } else {
      cube.mesh.scale.setScalar(movement.scale);
    }
  });

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
  // The duration at 1x is kept separately so dragging the speed slider back
  // and forth never accumulates rounding errors in the displayed half-seconds.
  const baseSequenceDurationRef = useRef(6);
  const cameraDragRef = useRef<{ pointerId: number; startX: number; startY: number; yaw: number; pitch: number } | null>(null);
  const [playing, setPlaying] = useState(true);
  const [recording, setRecording] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [cameraDragging, setCameraDragging] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [seed, setSeed] = useState(24);
  const [colourway, setColourway] = useState<string | null>("Yellow");
  const [notice, setNotice] = useState("Live preview");
  const [settings, setSettings] = useState<Settings>({
    density: 7,
    cubeSize: 76,
    cardThickness: 100,
    sequenceDuration: 8,
    rollTurns: DEFAULT_ROLL_TURNS,
    motion: 64,
    gravity: 100,
    bounce: 52,
    speed: 0.75,
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
    shape: "cube",
    shapeB: "circle",
    mode: "roll",
  });

  const [canvasWidth, canvasHeight] = RESOLUTIONS[aspect];
  const ratioClass = aspect.replace(":", "-");

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => {
      if (key === "speed") {
        const nextSpeed = value as number;
        const nextDuration = clamp(
          Math.round((baseSequenceDurationRef.current / nextSpeed) * 2) / 2,
          MIN_SEQUENCE_DURATION,
          MAX_SEQUENCE_DURATION,
        );
        return { ...current, speed: nextSpeed, sequenceDuration: nextDuration };
      }
      if (key === "sequenceDuration") {
        baseSequenceDurationRef.current = (value as number) * current.speed;
      }
      if (key === "shape") {
        const nextShape = value as ShapeId;
        // Roll is a square-edge tip; non-cubes default onto Spin so the mark
        // stays put while the silhouette turns.
        const nextMode = nextShape !== "cube" && current.mode === "roll" ? "spin" : current.mode;
        return { ...current, shape: nextShape, mode: nextMode };
      }
      // A and B may be the same shape. Picking one used to shove the other onto
      // a different outline, which made a same-shape flip impossible to select
      // and contradicted flip's own defaults below, where both are circle. The
      // turn is a back-to-front reveal; changing outline across it is optional.
      if (key === "mode" && value === "pop") {
        // The clump floats on the camera's own centre, so it reads from more or
        // less head on. Any elevation just tips a ball.
        return { ...current, mode: "pop", cameraYaw: 90, cameraPitch: 0, cameraZoom: 100 };
      }
      if (key === "mode" && value === "flip") {
        return {
          ...current,
          mode: "flip",
          shape: "circle",
          shapeB: "circle",
          density: 4,
          cubeSize: 56,
          cameraYaw: REFERENCE_CAMERA_YAW,
          cameraPitch: REFERENCE_CAMERA_PITCH,
          cameraZoom: 150,
        };
      }
      return { ...current, [key]: value };
    });
    if (key === "background" || key === "cube" || key === "ink") setColourway(null);
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

  // Colour only — the motion, camera and grid stay exactly where they were, so
  // a colourway can be swapped mid-take without losing the setup.
  const applyColourway = (name: string) => {
    setSettings((current) => ({ ...current, ...COLOURWAYS[name] }));
    setColourway(name);
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
    const nextYaw = clamp(drag.yaw + (event.clientX - drag.startX) * 0.16, 10, 90);
    const nextPitch = clamp(drag.pitch - (event.clientY - drag.startY) * 0.14, 0, 68);
    setSettings((current) => ({ ...current, cameraYaw: Math.round(nextYaw), cameraPitch: Math.round(nextPitch) }));
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
  };

  const controlCameraWithKeyboard = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const cameraKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"];
    if (!cameraKeys.includes(event.key)) return;
    event.preventDefault();
    setSettings((current) => {
      if (event.key === "ArrowLeft") return { ...current, cameraYaw: clamp(current.cameraYaw - 2, 10, 90) };
      if (event.key === "ArrowRight") return { ...current, cameraYaw: clamp(current.cameraYaw + 2, 10, 90) };
      if (event.key === "ArrowUp") return { ...current, cameraPitch: clamp(current.cameraPitch + 2, 0, 68) };
      if (event.key === "ArrowDown") return { ...current, cameraPitch: clamp(current.cameraPitch - 2, 0, 68) };
      if (event.key === "-" ) return { ...current, cameraZoom: clamp(current.cameraZoom - 4, 65, 150) };
      return { ...current, cameraZoom: clamp(current.cameraZoom + 4, 65, 150) };
    });
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
            <div className="camera-hint">{settings.mode === "flip" ? "Front camera locked · scroll to zoom" : "Drag to orbit · scroll to zoom"}</div>
            <div className="stage-overlay stage-overlay-bottom"><span>Seed {seed.toString().padStart(4, "0")}</span><span>{settings.mode === "flip" ? `Front / ${settings.cameraZoom}%` : `${settings.cameraYaw}° / ${settings.cameraPitch}° / ${settings.cameraZoom}%`}</span><span>{MOTION_LABELS[settings.mode]} · {settings.speed.toFixed(2)}×</span></div>
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
          <PanelSection title="Colourway" value={colourway ?? "Custom"} defaultOpen>
            <div className="preset-grid colourways">
              {Object.keys(COLOURWAYS).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={colourway === name ? "active" : ""}
                  onClick={() => applyColourway(name)}
                >
                  <span className="dot" style={{ background: COLOURWAYS[name].background }} />
                  {name}
                </button>
              ))}
            </div>
            <ColorControl label="Background" value={settings.background} onChange={(value) => updateSetting("background", value)} />
            <ColorControl label="Cube faces" value={settings.cube} onChange={(value) => updateSetting("cube", value)} />
            <ColorControl label="Logo / ink" value={settings.ink} onChange={(value) => updateSetting("ink", value)} />
          </PanelSection>

          <PanelSection title="Shape" value={`${SHAPE_LABELS[settings.shape]} / ${SHAPE_LABELS[settings.shapeB]}`}>
            <p className="camera-help" style={{ marginTop: 0 }}>Shape A</p>
            <div className="segmented four">
              {(Object.keys(SHAPE_LABELS) as ShapeId[]).map((shape) => (
                <button
                  key={`a-${shape}`}
                  type="button"
                  className={settings.shape === shape ? "active" : ""}
                  onClick={() => updateSetting("shape", shape)}
                >
                  {SHAPE_LABELS[shape]}
                </button>
              ))}
            </div>
            <p className="camera-help" style={{ marginTop: 0 }}>Shape B · Flip pair</p>
            <div className="segmented four">
              {(Object.keys(SHAPE_LABELS) as ShapeId[]).map((shape) => (
                <button
                  key={`b-${shape}`}
                  type="button"
                  className={settings.shapeB === shape ? "active" : ""}
                  onClick={() => updateSetting("shapeB", shape)}
                >
                  {SHAPE_LABELS[shape]}
                </button>
              ))}
            </div>
            <p className="camera-help">Flip waves A↔B on a checkerboard. Pick the same shape twice to turn one outline over. Pop ignores the pair and gathers all four. Logo stays inside every outline.</p>
          </PanelSection>

          <PanelSection title="Grid" value={`${settings.density} \u00d7 ${settings.cubeSize}px`}>
            <RangeControl label="Density" value={settings.density} min={4} max={10} onChange={(value) => updateSetting("density", value)} />
            <RangeControl label="Size" value={settings.cubeSize} min={48} max={112} suffix=" px" onChange={(value) => updateSetting("cubeSize", value)} />
          </PanelSection>

          <PanelSection title="Motion" value={MOTION_LABELS[settings.mode]}>
            <div className="segmented five">
              {(["settle", "roll", "spin", "pop", "flip"] as MotionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.mode === mode ? "active" : ""}
                  onClick={() => updateSetting("mode", mode)}
                >
                  {MOTION_LABELS[mode]}
                </button>
              ))}
            </div>
            <p className="camera-help">Flip = card turn, A/B swap at the edge. Drop / Roll / Spin / Pop as before.</p>
            <RangeControl label="Sequence time" value={settings.sequenceDuration} min={MIN_SEQUENCE_DURATION} max={MAX_SEQUENCE_DURATION} step={0.5} suffix=" s" onChange={(value) => updateSetting("sequenceDuration", value)} />
            <RangeControl label="Gravity" value={settings.gravity} min={45} max={170} suffix="%" onChange={(value) => updateSetting("gravity", value)} />
            <RangeControl label="Bounce" value={settings.bounce} min={0} max={100} suffix="%" onChange={(value) => updateSetting("bounce", value)} />
            <RangeControl label="Tumble" value={settings.motion} min={0} max={100} suffix="%" onChange={(value) => updateSetting("motion", value)} />
            <RangeControl label="Fall speed" value={settings.speed} min={0.35} max={1.8} step={0.05} suffix="x" onChange={(value) => updateSetting("speed", value)} />
            {(settings.mode === "roll" || settings.mode === "spin") && (
              <RangeControl
                label={settings.mode === "spin" ? "Spin turns" : "Roll turns"}
                value={settings.rollTurns}
                min={1}
                max={4}
                step={1}
                suffix={settings.mode === "spin" ? " × 360°" : " × 90°"}
                onChange={(value) => updateSetting("rollTurns", value)}
              />
            )}
            {settings.mode === "flip" && (
              <RangeControl
                label="Thickness"
                value={settings.cardThickness}
                min={6}
                max={100}
                step={2}
                suffix="%"
                onChange={(value) => updateSetting("cardThickness", value)}
              />
            )}
            <RangeControl label="Face align" value={settings.alignSpeed} min={0.75} max={4} step={0.05} suffix="x" onChange={(value) => updateSetting("alignSpeed", value)} />
            <RangeControl label="Soft shadow" value={settings.shadow} min={0} max={100} suffix="%" onChange={(value) => updateSetting("shadow", value)} />
          </PanelSection>

          <PanelSection title="Camera" value={settings.mode === "flip" ? "Front" : `${settings.cameraYaw}\u00b0 / ${settings.cameraPitch}\u00b0`}>
            {settings.mode !== "flip" && <RangeControl label="Orbit" value={settings.cameraYaw} min={10} max={90} suffix="\u00b0" onChange={(value) => updateSetting("cameraYaw", value)} />}
            {settings.mode !== "flip" && <RangeControl label="Elevation" value={settings.cameraPitch} min={0} max={68} suffix="\u00b0" onChange={(value) => updateSetting("cameraPitch", value)} />}
            <RangeControl label="Zoom" value={settings.cameraZoom} min={65} max={150} suffix="%" onChange={(value) => updateSetting("cameraZoom", value)} />
            <p className="camera-help">{settings.mode === "flip" ? "Flip uses a locked front elevation. Scroll to zoom." : "Drag on the preview to orbit. Scroll to zoom."}</p>
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
