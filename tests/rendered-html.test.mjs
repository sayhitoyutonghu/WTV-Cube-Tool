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
  assert.match(html, /RECORD WEBM/);
  assert.match(html, /DOWNLOAD PNG/);
  assert.match(html, /Orbit/);
  assert.match(html, /Elevation/);
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
  assert.match(component, /captureStream\(30\)/);
  assert.match(component, /"16:9"|"9:16"|"1:1"/);
  assert.match(component, /image\.src = "\/wtv-logo\.png"/);
  assert.match(component, /prepareLogoSource/);
  assert.equal(component.match(/drawMark\(/g)?.length, 2, "drawMark should have one definition and one single-face call");
  assert.doesNotMatch(component, /const spacing = settings\.cubeSize/, "grid spacing must not cancel the cube-size control");
  assert.match(component, /const spacing = 76 \* 1\.72/);
  assert.match(component, /ctx\.fillText\(subline\.slice\(0, 12\)/, "the editable type line should render below uploaded artwork");
  assert.match(component, /hasTransparentBackground/, "transparent source artwork should preserve internal white details");
  assert.match(component, /backgroundMask/, "opaque white backgrounds should be removed from the edges only");
  assert.match(component, /cameraVector\(settings\.cameraYaw, settings\.cameraPitch\)/, "camera controls should drive projection");
  assert.match(component, /const progress = clamp\(local \/ settleDuration, 0, 1\)/, "motion should converge toward a settled end state");
  assert.doesNotMatch(component, /\(time - delay \+ DURATION\) % DURATION/, "cubes must not start aligned and trigger later at random");
  assert.match(component, /minimumLocalY/, "rotating cubes should maintain physical ground contact");
  assert.match(component, /drawShadowLayer/, "rendering should include layered soft shadows");
  assert.match(component, /visibleFaces/, "tumbling cubes should use camera-aware face rendering");

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/wtv-logo.png", import.meta.url));
});
