import * as CANNON from "cannon-es";

/* Rigid body bake for the pop heap.
 *
 * Every other motion in the studio is a closed form: give it a time and it
 * hands back a pose, which is what lets the timeline scrub anywhere and the
 * exporter ask for frames in any order. A contact solve cannot work that way —
 * frame N only exists once frame N-1 has been solved. So the whole sequence is
 * simulated once, up front, and stored; playback and export then read it like
 * any other lookup and the rest of the studio never learns that physics is
 * involved.
 *
 * The solve is stepped at a fixed rate off a seeded start state, so the same
 * settings always bake the same heap. Nothing here reads the clock.
 */

export type PopBodySpec = {
  /** Box for the cube, disc for every extruded outline. */
  kind: "box" | "disc";
  /** Half-width of the box, or radius of the disc. */
  radius: number;
  /** Extrusion depth. The mark sits on +x, so a disc's axis is x too. */
  depth: number;
};

export type PopBakeInput = {
  bodies: PopBodySpec[];
  cubeSize: number;
  /** Percent, as the Gravity control reports it. */
  gravity: number;
  /** Percent, as the Bounce control reports it. */
  bounce: number;
  /** Percent, as the Tumble control reports it. */
  tumble: number;
  seed: number;
  duration: number;
  fps: number;
  /** Radius of the ring the bodies are thrown in from. */
  spawnRadius: number;
  /** Half-height of the column the attractor gathers them into. */
  columnHeight: number;
};

/** Seven floats per body: position xyz, then quaternion xyzw. */
export const POP_STRIDE = 7;

export type PopBake = {
  frames: Float32Array[];
  count: number;
  fps: number;
};

// Sub-stepping the solve rather than stepping it once per rendered frame. A
// stack this deep goes soft and sinks into itself at 30Hz; four sub-steps hold
// the contacts without making the bake noticeably slower.
const SUB_STEPS = 3;
const SOLVER_ITERATIONS = 10;
// The heap is held to a column by a radial spring, not by a wall of static
// bodies. A ring of boxes let roughly a third of the field straight through:
// cannon meets a cylinder as a convex hull, and convex-against-box contacts are
// the least reliable pair it has, so the discs simply walked out. A force needs
// no contact at all and holds every shape the same.
const CONTAINMENT = 240;
// Outward speed is bled off at the rim as well, or a body arrives with enough
// of it to ride out through the spring before the spring can turn it.
const CONTAINMENT_DAMPING = 0.55;
/** Column radius, in body widths. Roughly the reference's three-to-four wide. */
const COLUMN_RADIUS = 2.45;
// Low enough that the heap settles instead of arching. At 0.42 the bodies
// bridged against each other on the way down and set as a needle sixteen widths
// tall and barely two across; they need to be able to slide past one another to
// find the packing underneath them.
const FRICTION = 0.22;
// Bleed off spin and drift so the heap actually comes to rest inside the
// sequence instead of still creeping when the cut arrives.
const LINEAR_DAMPING = 0.16;
const ANGULAR_DAMPING = 0.22;

function hash(value: number, seed: number) {
  const n = Math.sin(value * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function makeShape(spec: PopBodySpec): { shape: CANNON.Shape; orientation?: CANNON.Quaternion } {
  if (spec.kind === "box") {
    const half = spec.radius;
    return { shape: new CANNON.Box(new CANNON.Vec3(spec.depth / 2, half, half)) };
  }
  // Cannon's cylinder stands on y; every outline here is extruded along x, so
  // the proxy is laid over to match or the heap would key off the wrong axis.
  const orientation = new CANNON.Quaternion();
  orientation.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI / 2);
  return { shape: new CANNON.Cylinder(spec.radius, spec.radius, spec.depth, 12), orientation };
}

export function bakePopHeap(input: PopBakeInput): PopBake {
  const { bodies, cubeSize, seed, duration, fps, spawnRadius, columnHeight } = input;
  const gravityScale = Math.max(0.4, Math.min(1.8, input.gravity / 100));
  // Bounce is held well under the control's face value: a lively restitution
  // keeps the top of the heap chattering long after the cut should have landed.
  const restitution = Math.max(0, Math.min(1, input.bounce / 100)) * 0.28;
  const tumble = Math.max(0, Math.min(1, input.tumble / 100));

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82 * cubeSize * 0.6 * gravityScale, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  (world.solver as CANNON.GSSolver).iterations = SOLVER_ITERATIONS;

  const surface = new CANNON.Material("surface");
  world.addContactMaterial(
    new CANNON.ContactMaterial(surface, surface, { friction: FRICTION, restitution }),
  );
  world.defaultContactMaterial.friction = FRICTION;
  world.defaultContactMaterial.restitution = restitution;

  const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: surface });
  ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  world.addBody(ground);

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

    // Thrown in from a ring, aimed a little above the floor so the heap builds
    // upward instead of skidding outward off the first contact.
    const angle = hash(index * 3 + 1, seed) * Math.PI * 2;
    // Released above the column rather than out on a wide ring. Thrown in from
    // far away they arrived with enough sideways speed to climb the wall and
    // spill over it; dropped down the shaft they pile instead.
    const height = columnHeight * (0.6 + hash(index * 3 + 2, seed) * 2.6);
    const radius = spawnRadius * hash(index * 3 + 3, seed);
    body.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
    body.quaternion.setFromEuler(
      (hash(index + 41, seed) - 0.5) * Math.PI * 2,
      (hash(index + 49, seed) - 0.5) * Math.PI * 2,
      (hash(index + 57, seed) - 0.5) * Math.PI * 2,
    );

    const speed = cubeSize * (1.4 + hash(index + 61, seed) * 2.2);
    body.velocity.set(-Math.cos(angle) * speed, -speed * 1.6, -Math.sin(angle) * speed);
    const spin = tumble * 9;
    body.angularVelocity.set(
      (hash(index + 71, seed) - 0.5) * spin,
      (hash(index + 79, seed) - 0.5) * spin,
      (hash(index + 83, seed) - 0.5) * spin,
    );

    world.addBody(body);
    dynamic.push(body);
  });

  const columnRadius = cubeSize * COLUMN_RADIUS;
  const frameCount = Math.max(2, Math.round(duration * fps) + 1);
  const frames: Float32Array[] = [];
  const fixedStep = 1 / (fps * SUB_STEPS);

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (frame > 0) {
      for (let sub = 0; sub < SUB_STEPS; sub += 1) {
        // Anything past the rim is pushed back toward the axis, harder the
        // further out it is, and has its outward speed bled off so it settles
        // against the boundary instead of bouncing along it.
        for (const body of dynamic) {
          const offsetX = body.position.x;
          const offsetZ = body.position.z;
          const distance = Math.hypot(offsetX, offsetZ);
          if (distance <= 1e-3) continue;
          const dirX = offsetX / distance;
          const dirZ = offsetZ / distance;
          const excess = distance - columnRadius;
          if (excess <= 0) continue;
          body.force.x -= dirX * CONTAINMENT * excess * body.mass;
          body.force.z -= dirZ * CONTAINMENT * excess * body.mass;
          const outward = body.velocity.x * dirX + body.velocity.z * dirZ;
          if (outward > 0) {
            body.velocity.x -= dirX * outward * CONTAINMENT_DAMPING;
            body.velocity.z -= dirZ * outward * CONTAINMENT_DAMPING;
          }
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
