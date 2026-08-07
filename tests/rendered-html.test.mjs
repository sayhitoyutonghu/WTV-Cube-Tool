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
  assert.match(html, /RESPONSIVE BUMPER GENERATOR/);
  assert.match(html, /Animated WTV cube preview/);
  assert.match(html, /EXPORT MP4/);
  assert.doesNotMatch(html, /WEBM/i);
  assert.match(html, /DOWNLOAD PNG/);
  assert.match(html, /Orbit/);
  assert.match(html, /Elevation/);
  assert.match(html, /Zoom/);
  assert.match(html, /Gravity/);
  assert.match(html, /Bounce/);
  assert.match(html, /SEC SEQUENCE/);
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
  assert.equal(component.match(/drawMark\(/g)?.length, 2, "drawMark should have one definition and one single-face call");
  assert.doesNotMatch(component, /const spacing = settings\.cubeSize/, "grid spacing must not cancel the cube-size control");
  assert.match(component, /const spacing = 76 \* 1\.72/);
  assert.match(component, /ctx\.fillText\(subline\.slice\(0, 12\)/, "the editable type line should render below uploaded artwork");
  assert.match(component, /hasTransparentBackground/, "transparent source artwork should preserve internal white details");
  assert.match(component, /backgroundMask/, "opaque white backgrounds should be removed from the edges only");
  assert.match(component, /cameraVector\(settings\.cameraYaw, settings\.cameraPitch\)/, "camera controls should drive projection");
  assert.match(component, /const MAX_DURATION = 10/, "the motion model should retain a ten-second reference simulation");
  assert.match(component, /sequenceDuration: 6/, "the default sequence should settle faster than the old ten-second version");
  assert.match(component, /const simulationTime = time \* \(MAX_DURATION \/ clamp\(sequenceDuration, 3, MAX_DURATION\)\)/, "the duration control should time-compress the complete physics sequence");
  assert.match(component, /const acceleration = 7\.2 \* gravityScale \* speedScale/, "falling cubes should use gravity-driven acceleration");
  assert.match(component, /const alignSpeedScale = clamp\(alignSpeed, 0\.75, 4\)/, "face alignment should have an independent speed control");
  assert.match(component, /label="Face align" value=\{settings\.alignSpeed\}/, "the face alignment speed controller should be visible");
  assert.match(component, /const alignDuration = Math\.max\(0\.22, \(settleEnd - impactTime\) \/ alignSpeedScale\)/, "alignment speed should shorten only the post-impact convergence");
  assert.match(component, /const rebound = Math\.abs\(collisionWave\)/, "ground impacts should create damped rebounds");
  assert.match(component, /const settleEnd = 8\.6/, "the reference simulation should converge before the selected end frame");
  assert.match(component, /cameraZoom: clamp\(current\.cameraZoom/, "scrolling the preview should control camera zoom");
  assert.match(component, /onPointerMove=\{moveCamera\}/, "dragging the preview should orbit the camera");
  assert.doesNotMatch(component, /time \* settings\.speed/, "speed should shape gravity without preventing the fixed ten-second convergence");
  assert.match(component, /minimumLocalY/, "rotating cubes should maintain physical ground contact");
  assert.match(component, /drawShadowLayer/, "rendering should include layered soft shadows");
  assert.match(component, /visibleFaces/, "tumbling cubes should use camera-aware face rendering");

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/wtv-logo.png", import.meta.url));
});
