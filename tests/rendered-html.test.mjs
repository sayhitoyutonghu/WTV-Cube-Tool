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
  assert.match(component, /subline: "MUSIC",\s+mode: "roll",/, "roll should be the default motion mode");
  assert.match(component, /const REFERENCE_CAMERA_ZOOM = 94/, "the default camera should use the reference pull-back");
  assert.match(component, /const REFERENCE_CAMERA_YAW = 45/, "the reference camera should keep its isometric orbit");
  assert.match(component, /const REFERENCE_CAMERA_PITCH = 35/, "the reference camera should keep its isometric elevation");
  assert.match(component, /const LIGHT_WRAP = 0\.16/, "rolling faces should transition through wrapped light");
  assert.match(component, /hasTransparentBackground/, "transparent source artwork should preserve internal white details");
  assert.match(component, /backgroundMask/, "opaque white backgrounds should be removed from the edges only");
  assert.match(component, /cameraVector\(settings\.cameraYaw, settings\.cameraPitch\)/, "camera controls should drive projection");
  assert.match(component, /const MAX_DURATION = 10/, "the motion model should retain a ten-second reference simulation");
  assert.match(component, /sequenceDuration: 12/, "the slower reference default should expose its complete twelve-second sequence");
  assert.match(component, /speed: 0\.5/, "the reference motion should default to the calmer half-speed shown in the control reference");
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
  assert.match(component, /offsetZ: \(advance - ROLL_TURNS\) \* cubeSize/, "rolling cubes should translate one width per quarter turn");
  assert.match(component, /function stickyRollEase/, "rolling cubes should use the reference-style viscous release and landing curve");
  assert.match(component, /const ROLL_TIP_FRACTION = 0\.55/, "the sticky quarter-turn should spend longer in contact transition");
  assert.match(component, /const ROLL_FINAL_HOLD = 1\.5/, "roll mode should reserve only a one-and-a-half-second final hold");
  assert.match(component, /sequenceDuration - ROLL_FINAL_HOLD/, "the staggered roll should finish before the fixed final hold");
  assert.match(component, /const ROLL_ZOOM_IN = 1\.07/, "the camera should reproduce the reference's subtle roll zoom-in");
  assert.match(component, /const rollZoomProgress = settings\.mode === "roll"/, "only roll mode should animate the camera scale");
  assert.match(component, /aspect > 1\.2 \? 1\.18/, "the widescreen field should match the reference cube count");
  assert.match(component, /const lanes = new Map/, "the 3D renderer should prevent rolling cubes from interpenetrating in shared lanes");

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/wtv-logo.png", import.meta.url));
});
