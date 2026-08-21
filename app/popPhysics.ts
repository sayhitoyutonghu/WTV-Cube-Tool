import * as CANNON from "cannon-es";

/* Rigid body bake for the pop clump.
 *
 * Every other motion in the studio is a closed form: give it a time and it
 * hands back a pose, which is what lets the timeline scrub anywhere and the
 * exporter ask for frames in any order. A contact solve cannot work that way —
 * frame N only exists once frame N-1 has been solved. So the whole sequence is
 * simulated once, up front, and stored; playback and export then read it like
 * any other lookup and the rest of the studio never learns physics is involved.
 *
 * The setup follows the reference build: world gravity off, a point force at
 * the origin pulling everything onto the spot the camera looks at, heavy
 * translation damping so nothing is flung back out, and no floor at all. No
 * floor is what makes this a clump held in mid air rather than a heap sitting
 * on something, and it is why nothing in the reference casts a shadow.
 *
 * The solve is stepped at a fixed rate off a seeded start state, so the same
 * settings always bake the same clump. Nothing here reads the clock.
 */

export type PopBodySpec = {
  /** Box for the cube; every extruded outline is met as its own convex hull. */
  kind: "box" | "hull";
  /** Half-width of the box, or circumradius of the hull. */
  radius: number;
  /** Sides of the hull. A star's convex hull is the polygon through its tips. */
  sides: number;
  /** Extrusion depth. The mark sits on +x, so a hull's axis is x too. */
  depth: number;
};

export type PopBakeInput = {
  bodies: PopBodySpec[];
  cubeSize: number;
  /** Percent. Drives the strength of the pull onto the origin. */
  gravity: number;
  /** Percent. The reference leaves bounciness at zero; this rides under it. */
  bounce: number;
  /** Percent. Drives the spin the bodies are released with. */
  tumble: number;
  seed: number;
  duration: number;
  fps: number;
  /** Half-width of the array the bodies are released from. */
  spawnRadius: number;
};

/** Seven floats per body: position xyz, then quaternion xyzw. */
export const POP_STRIDE = 7;

export type PopBake = {
  frames: Float32Array[];
  count: number;
  fps: number;
};

const SUB_STEPS = 3;
const SOLVER_ITERATIONS = 12;
// A point force with no falloff, which is where the reference leaves its
// field: the same pull wherever a body happens to be. Held as an acceleration
// in body widths so it never has to be retuned when the bodies are resized.
const GATHER = 30;
// The reference's one deliberate move away from the defaults, and the setting
// the whole effect rests on. Without it the bodies reach the middle at speed,
// bounce off one another and scatter straight back out; at 0.8 they arrive,
// meet, and stay met.
const LINEAR_DAMPING = 0.8;
const ANGULAR_DAMPING = 0.1;
// Blender's rigid body defaults, which the reference does not open.
const FRICTION = 0.5;

function hash(value: number, seed: number) {
  const n = Math.sin(value * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function makeShape(spec: PopBodySpec): { shape: CANNON.Shape; orientation?: CANNON.Quaternion } {
  if (spec.kind === "box") {
    const half = spec.radius;
    return { shape: new CANNON.Box(new CANNON.Vec3(spec.depth / 2, half, half)) };
  }
  // Cannon builds a cylinder as an n-sided prism, so asking for the outline's
  // own side count gives its convex hull exactly — five sides for the star,
  // three for the triangle, which is what Convex Hull means for those shapes
  // in the reference too. The prism stands on y and every outline here is
  // extruded along x, so it is laid over to match.
  const orientation = new CANNON.Quaternion();
  orientation.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI / 2);
  return {
    shape: new CANNON.Cylinder(spec.radius, spec.radius, spec.depth, spec.sides),
    orientation,
  };
}

export function bakePopHeap(input: PopBakeInput): PopBake {
  const { bodies, cubeSize, seed, duration, fps, spawnRadius } = input;
  const gatherScale = Math.max(0.4, Math.min(1.8, input.gravity / 100));
  const restitution = Math.max(0, Math.min(1, input.bounce / 100)) * 0.12;
  const tumble = Math.max(0, Math.min(1, input.tumble / 100));

  // No world gravity and no floor. The pull onto the origin is the only force
  // in the scene, so there is no down for anything to fall to.
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  (world.solver as CANNON.GSSolver).iterations = SOLVER_ITERATIONS;

  const surface = new CANNON.Material("surface");
  world.addContactMaterial(
    new CANNON.ContactMaterial(surface, surface, { friction: FRICTION, restitution }),
  );
  world.defaultContactMaterial.friction = FRICTION;
  world.defaultContactMaterial.restitution = restitution;

  // Released as a block, the way the reference starts on an array of heads and
  // lets the field draw them in.
  const columns = Math.max(2, Math.round(Math.sqrt(bodies.length * 1.25)));
  const rows = Math.max(1, Math.ceil(bodies.length / columns));
  const pitch = (spawnRadius * 2) / Math.max(1, columns - 1);
  const dynamic: CANNON.Body[] = [];

  bodies.forEach((spec, index) => {
    const { shape, orientation } = makeShape(spec);
    const body = new CANNON.Body({
      mass: 1,
      material: surface,
      linearDamping: LINEAR_DAMPING,
      angularDamping: ANGULAR_DAMPING,
    });
    body.addShape(shape, new CANNON.Vec3(0, 0, 0), orientation);

    const col = index % columns;
    const row = Math.floor(index / columns);
    body.position.set(
      (hash(index + 11, seed) - 0.5) * pitch * 0.9,
      (row - (rows - 1) / 2) * pitch,
      (col - (columns - 1) / 2) * pitch,
    );
    body.quaternion.setFromEuler(
      (hash(index + 41, seed) - 0.5) * Math.PI * 2,
      (hash(index + 49, seed) - 0.5) * Math.PI * 2,
      (hash(index + 57, seed) - 0.5) * Math.PI * 2,
    );

    const spin = tumble * 7;
    body.angularVelocity.set(
      (hash(index + 71, seed) - 0.5) * spin,
      (hash(index + 79, seed) - 0.5) * spin,
      (hash(index + 83, seed) - 0.5) * spin,
    );

    world.addBody(body);
    dynamic.push(body);
  });

  const frameCount = Math.max(2, Math.round(duration * fps) + 1);
  const frames: Float32Array[] = [];
  const fixedStep = 1 / (fps * SUB_STEPS);
  const pull = GATHER * cubeSize * gatherScale;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame > 0) {
      for (let sub = 0; sub < SUB_STEPS; sub += 1) {
        for (const body of dynamic) {
          const { x, y, z } = body.position;
          const distance = Math.hypot(x, y, z);
          if (distance <= 1e-3) continue;
          body.force.x -= (x / distance) * pull * body.mass;
          body.force.y -= (y / distance) * pull * body.mass;
          body.force.z -= (z / distance) * pull * body.mass;
        }
        world.step(fixedStep);
      }
    }
    const slice = new Float32Array(dynamic.length * POP_STRIDE);
    dynamic.forEach((body, index) => {
      const at = index * POP_STRIDE;
      slice[at] = body.position.x;
      slice[at + 1] = body.position.y;
      slice[at + 2] = body.position.z;
      slice[at + 3] = body.quaternion.x;
      slice[at + 4] = body.quaternion.y;
      slice[at + 5] = body.quaternion.z;
      slice[at + 6] = body.quaternion.w;
    });
    frames.push(slice);
  }

  world.bodies.length = 0;
  return { frames, count: dynamic.length, fps };
}
