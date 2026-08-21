import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the WTV Cube Studio controls", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>WTV Cube Studio<\/title>/i);
  assert.match(html, /CUBE STUDIO/);
  assert.match(html, /Responsive bumper generator/i);
  assert.match(html, /Animated WTV cube preview/);
  assert.match(html, /Export MP4/i);
  assert.doesNotMatch(html, /WEBM/i);
  assert.match(html, /Download PNG/i);
  assert.match(html, /Orbit/);
  assert.match(html, /Elevation/);
  assert.match(html, /Zoom/);
  assert.match(html, /Gravity/);
  assert.match(html, /Bounce/);
  assert.match(html, /sec sequence/i);
  assert.match(html, /Sequence time/);
  assert.match(html, /og:image/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("removes starter-only assets and dependencies", async () => {
  const [page, layout, packageJson, component] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/WtvCubeStudio.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<WtvCubeStudio \/>/);
  assert.match(layout, /generateMetadata/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(component, /new Mp4OutputFormat\(\{ fastStart: "in-memory" \}\)/);
  assert.match(component, /new CanvasSource\(exportCanvas/);
  assert.match(component, /codec: "avc"/);
  assert.match(component, /Math\.round\(settings\.sequenceDuration \* EXPORT_FPS\)/);
  assert.match(component, /link\.download = `WTV-cubes-\$\{aspect\.replace\(":", "x"\)\}-\$\{seed\}\.mp4`/);
  assert.doesNotMatch(component, /MediaRecorder|video\/webm|\.webm/);
  assert.match(component, /"16:9"|"9:16"|"1:1"/);
  assert.match(component, /new URL\("wtv-logo\.png", document\.baseURI\)\.href/);
  assert.match(component, /prepareLogoSource/);
  assert.equal(component.match(/drawMark\(/g)?.length, 3, "drawMark should feed the 3D face texture and remain available to the legacy fallback");
  assert.doesNotMatch(component, /const spacing = settings\.cubeSize/, "grid spacing must not cancel the cube-size control");
  assert.match(component, /const BASE_SPACING = 76 \* 1\.72/);
  assert.match(component, /const sublineText = subline\.slice\(0, 12\)/, "the editable type line should render below uploaded artwork");
  assert.match(component, /subline: "MUSIC",[\s\S]*?mode: "roll",/, "roll should be the default motion mode");
  assert.match(component, /const REFERENCE_CAMERA_ZOOM = 94/, "the default camera should use the reference pull-back");
  assert.match(component, /const REFERENCE_CAMERA_YAW = 45/, "the reference camera should keep its isometric orbit");
  assert.match(component, /const REFERENCE_CAMERA_PITCH = 35/, "the reference camera should keep its isometric elevation");
  assert.match(component, /const LIGHT_WRAP = 0\.16/, "rolling faces should transition through wrapped light");
  assert.match(component, /hasTransparentBackground/, "transparent source artwork should preserve internal white details");
  assert.match(component, /backgroundMask/, "opaque white backgrounds should be removed from the edges only");
  assert.match(component, /cameraVector\(settings\.cameraYaw, settings\.cameraPitch\)/, "camera controls should drive projection");
  assert.match(component, /const MAX_DURATION = 10/, "the motion model should retain a ten-second reference simulation");
  assert.match(component, /sequenceDuration: 8/, "the three-quarter-speed reference default should expose its complete eight-second sequence");
  assert.match(component, /speed: 0\.75/, "the reference motion should default to three-quarter speed");
  assert.match(component, /baseSequenceDurationRef/, "speed changes should retime the complete sequence instead of cutting it off");
  assert.match(component, /baseSequenceDurationRef\.current \/ nextSpeed/, "lower speed should proportionally increase the playback and export duration");
  assert.match(component, /const simulationTime = time \* \(MAX_DURATION \/ clamp\(sequenceDuration, MIN_SEQUENCE_DURATION, MAX_SEQUENCE_DURATION\)\)/, "the displayed duration should time-stretch the complete physics sequence");
  assert.match(component, /const acceleration = 7\.2 \* gravityScale/, "falling cubes should keep the same physical arc while timeline speed changes");
  assert.match(component, /const alignSpeedScale = clamp\(alignSpeed, 0\.75, 4\)/, "face alignment should have an independent speed control");
  assert.match(component, /label="Face align" value=\{settings\.alignSpeed\}/, "the face alignment speed controller should be visible");
  assert.match(component, /const alignDuration = Math\.max\(0\.22, \(settleEnd - impactTime\) \/ alignSpeedScale\)/, "alignment speed should shorten only the post-impact convergence");
  assert.match(component, /const rebound = Math\.abs\(collisionWave\)/, "ground impacts should create damped rebounds");
  assert.match(component, /const SEQUENCE_END = 8\.6/, "the reference simulation should converge before the selected end frame");
  assert.match(component, /cameraZoom: clamp\(current\.cameraZoom/, "scrolling the preview should control camera zoom");
  assert.match(component, /onPointerMove=\{moveCamera\}/, "dragging the preview should orbit the camera");
  assert.doesNotMatch(component, /time \* settings\.speed/, "speed should retime the full sequence rather than truncate its physics");
  assert.match(component, /minimumLocalY/, "rotating cubes should maintain physical ground contact");
  assert.match(component, /new THREE\.WebGLRenderer/, "the preview should be rendered as a real 3D scene");
  assert.match(component, /THREE\.VSMShadowMap/, "the 3D scene should use soft variance shadow maps");
  assert.match(component, /new THREE\.HemisphereLight/, "the 3D scene should include environment light");
  assert.match(component, /new THREE\.DirectionalLight/, "the 3D scene should include a shadow-casting key light");
  assert.match(component, /const markedMaterial[\s\S]*?color: "#ffffff"/, "the logo texture should not multiply the selected cube colour twice");
  assert.match(component, /mesh\.castShadow = true/, "every cube should cast a physical shadow");
  assert.match(component, /ground\.receiveShadow = true/, "the modeled ground plane should receive cube shadows");
  assert.match(component, /offsetZ: \(advance - turnCount\) \* cubeSize/, "rolling cubes should translate one width per selected quarter turn");
  assert.match(component, /const DEFAULT_ROLL_TURNS = 1/, "the reference default should make one decisive quarter-turn");
  assert.match(component, /rx: \(turns - turnCount\) \* \(Math\.PI \/ 2\)/, "the cube should start on its selected previous face and land upright");
  assert.match(component, /label=\{settings\.mode === "spin" \? "Spin turns" : "Roll turns"\}/, "roll turns should remain user-adjustable alongside spin turns");
  assert.match(component, /function stickyRollEase/, "rolling cubes should use the reference-style viscous release and landing curve");
  assert.match(component, /const ROLL_TIP_FRACTION = 0\.55/, "the sticky quarter-turn should spend longer in contact transition");
  assert.match(component, /const ROLL_FINAL_HOLD = 1;/, "roll mode should reserve only a one-second final hold");
  assert.match(component, /sequenceDuration - ROLL_FINAL_HOLD/, "the staggered roll should finish before the fixed final hold");
  assert.match(component, /const ROLL_ZOOM_IN = 1\.07/, "the camera should reproduce the reference's subtle roll zoom-in");
  assert.match(component, /const rollZoomProgress = settings\.mode === "roll" \|\| settings\.mode === "spin" \|\| settings\.mode === "pop"/, "ground-based motions should share the subtle camera move while flip stays locked");
  assert.match(component, /const lanes = new Map/, "the 3D renderer should prevent rolling cubes from interpenetrating in shared lanes");
  assert.match(component, /type MotionMode = "settle" \| "roll" \| "spin" \| "pop" \| "flip"/, "flip should remain a first-class motion mode alongside the new motions");
  assert.match(component, /cameraVector\(90, 0\)/, "flip should lock the camera to a square front elevation");
  assert.match(component, /settings\.mode === "flip" \? 0 : settings\.mode === "pop" \? popTarget : settings\.cubeSize \* 0\.18/, "the front camera should look at the centre of the flip wall, and pop at the centre of its heap");
  assert.match(component, /cube\.mesh\.quaternion\.copy\(popSolved\)/, "pop should read its transforms straight off the bake, quaternions included, not through the euler pose every other mode uses");
  assert.match(component, /const sequenceProgress = clamp\(time \/ activeDuration, 0, 1\)/, "flip should run one reveal wave across the sequence");
  assert.match(component, /rz: finalFaceAligned \? 0 : Math\.PI - flipEase\(turnProgress\) \* Math\.PI/, "objects should make one half-turn about z, tipping top over bottom from their plain back to their marked front");
  assert.match(component, /const CORNER_EDGE_FRACTION = 0\.22/, "star tips, star notches and triangle corners should share the same softened edge fraction");
  assert.match(component, /return roundedOutline\(vertices\);/, "the star should use the shared rounded outline treatment");
  assert.match(component, /extrudeAlongX\(starOutline\(5, radius, radius \* STAR_INNER_RATIO\), size, 6[,)]/, "star fillets should use the same six curve segments as the rounded triangle rather than flattening to one chord");
  assert.match(component, /function buildShapeGeometry\(shape: ShapeId, size: number, depth = size\)/, "shape geometry should take its extrusion depth separately from the face size");
  assert.match(component, /"16:9": \[1920, 1080\],\s*\n\s*"9:16": \[1080, 1920\]/, "wide and tall crops should export at delivery size, not 720p");
  assert.match(component, /const tolerance = Math\.min\(half \* 0\.09, capX \* 0\.5\)/, "the front-cap test should follow the card's real depth, or a thinned card loses its mark");
  assert.match(component, /settings\.mode === "flip"\s*\n\s*\? settings\.cubeSize \* \(settings\.cardThickness \/ 100\)/, "thickness should apply to flip only, so the block modes keep full-depth geometry");
  assert.match(component, /function flipShapeCrossover/, "flip should hide the A/B geometry handoff inside a smooth edge-on crossover");
  assert.match(component, /const sharedSpan = Math\.min\(/, "outgoing and incoming shapes should converge on one edge width at the handoff");
  assert.match(component, /movement\.scale \* crossover\.face,[\s\S]*?movement\.scale \* crossover\.edge,/, "flip should smoothly suppress the face silhouette and match the edge span around the shape swap");
  assert.match(component, /const FLIP_GRID_SPACING = 80/, "flip should retain a compact minimum lattice for the default circle");
  assert.match(component, /const FLIP_SHAPE_GAP = 1\.12/, "flip should expand its pitch to fit large star and triangle silhouettes");
  assert.match(component, /mode === "flip"\) return Math\.max\(FLIP_GRID_SPACING, footprint \* FLIP_SHAPE_GAP\)/, "flip spacing should be based on the largest visible outline");
  assert.match(component, /const footprint = mode === "flip"\s*\? Math\.max\(shapeFootprint\(shape, cubeSize\), shapeFootprint\(shapeB, cubeSize\)\)\s*: shapeFootprint\(shape, cubeSize\)/, "only flip renders shape B, so it must not widen the lattice of the modes that show shape A alone");
  assert.match(component, /settings\.mode === "flip"\s*\? Array\.from\(new Set<ShapeId>\(\[settings\.shape, settings\.shapeB\]\)\)/, "flip draws on both selected outlines across the turn, so both geometries must be built");
  assert.match(component, /settings\.mode === "pop"\s*\? \(Object\.keys\(SHAPE_LABELS\) as ShapeId\[\]\)/, "pop gathers a crowd, so it takes all four outlines rather than the selected pair");
  assert.match(component, /settings\.mode === "flip"\s*\? flipPair\(row, col, settings\.shape, settings\.shapeB\)/, "flip should use the selected A/B pair on the checkerboard");
  assert.doesNotMatch(component, /otherShape\(/, "picking one flip shape must not shove the other onto a different outline, or a same-shape flip cannot be selected");
  assert.match(component, /if \(startShape === endShape\) return \{ face: 1, edge: 1 \}/, "a same-shape flip has no handoff to hide, so it should not pinch at the midpoint");
  assert.match(component, /offsetX: entryX \* \(1 - reach\)/, "pop should pull each body in from off frame to its place in the heap");
  assert.match(component, /state\.popBake = bakePopHeap\(\{/, "pop should solve its heap with rigid bodies rather than laying it out by hand");
  assert.match(component, /if \(state\.popBakeKey !== popKey\)/, "the solve is the one thing here that cannot be evaluated at an arbitrary time, so it must be baked once and cached");
  assert.match(component, /rx: restX \* held \+ spinX \* remaining/, "the heap should hold its own orientations and only face the camera in the last beat, or it reads as a mosaic rather than a collision");
  assert.match(component, /offsetZ: entryZ, scale: 0\.001, revealed: false/, "a body still on its way in must not render, or a wide zoom catches the bodies queueing");
  assert.match(component, /const flight = 1 - Math\.pow\(1 - t, 3\)/, "the throw should ease out — accelerating into a stop reads as inflating, not popping");
  assert.match(component, /const stagger = clamp\(depth \* POP_ARRIVAL_SPREAD/, "bodies deep in the heap should arrive first, so the outside lands on top of them");
  assert.match(component, /circle: 1\.26,[\s\S]*?star: 1\.85,[\s\S]*?triangle: 2\.05,/, "every outline should read at a comparable size instead of growing around a cube-scale logo");
  assert.match(component, /const markHalf = half \* markScaleFor\(shape\);/, "the lockup should scale to the outline that carries it");
  assert.match(component, /star: STAR_INNER_RATIO,/, "the star should size its lockup to the notch circle it can actually hold");
  assert.match(component, /const FLIP_CAMERA_SCALE = 1\.12/, "the flip camera should push closer than the measured base framing");
  assert.match(component, /const FLIP_FINAL_HOLD = 1;/, "flip should reserve a full second for its aligned final tableau");
  assert.match(component, /rz: finalFaceAligned \? 0/, "every object should lock to an exact front-facing rotation during the final hold");
  assert.match(component, /const FLIP_SHORT_AXIS_COUNT = 14/, "the default flip framing should match the reference's dense fourteen-object short edge");
  assert.match(component, /width \/ \(\(state\.gridColumns \+ 0\.25\) \* state\.gridSpacing\)/, "flip framing should preserve the reference object scale across aspect ratios");
  assert.match(component, /mode: "flip",[\s\S]*?shape: "circle",[\s\S]*?shapeB: "circle",[\s\S]*?density: 4,[\s\S]*?cubeSize: 56,[\s\S]*?cameraZoom: 150/, "selecting flip should apply its reference defaults");
  assert.match(component, /Front camera locked/, "the interface should explain that flip uses a locked front camera");
  assert.match(component, /function isolateExtrudedFrontCap/, "extruded shapes should keep their rear cap plain during a flip");
  assert.match(component, /const materialIndex = isFrontCap \? 0 : 1/, "only the camera-facing cap should receive the logo material");

  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /@media \(min-width: 961px\)[\s\S]*?\.transport[\s\S]*?position: fixed/, "the desktop transport should stay pinned to the viewport");
  assert.match(styles, /\.preview-column[\s\S]*?grid-template-rows: minmax\(0, 1fr\) 66px/, "the preview should retain the transport row so the canvas does not move");

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/wtv-logo.png", import.meta.url));
});
