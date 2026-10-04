// The real-light budget pool (the engine ctx's `lights`). Spawns light the world mostly with
// emissive materials and bloom; the few real PointLights they may use come from here.
//
// The pool's lights stay in the scene for the whole session once added, parked at intensity 0 while
// free. Adding or removing a light changes every lit material's light set, which in three.js rebuilds
// their shader programs (a visible hitch); a parked light only costs its shading, and a light at
// intensity 0 adds exactly nothing to the image. So the pool holds only as many lights as the
// registered engines declare (engine.budget.lights), decided when the SpawnManager starts behind the
// loading fade; ensure(size) grows it later (an engine registered at runtime), never shrinks it.
//
//   acquire(priority = 0, onRevoke?) -> PointLight | null
//       A free light, reset to white, intensity 0, no shadow. When the pool is full, a holder with a
//       lower priority that passed onRevoke loses its light to the caller: onRevoke(light) runs first,
//       and that holder must drop its reference. Otherwise null.
//   release(light)            parks it again (intensity 0) and returns it to the pool
//   releaseOwner(owner)       releases every light acquired while owner was current (see below)
//
// The SpawnManager sets `currentOwner` around each engine call, so the pool knows which spawn holds
// which light: a spawn disposed without releasing its lights gets them back through releaseOwner.
const PARK_DISTANCE = 1;

export function createLightPool({ THREE, scene, size = 0 }) {
  const slots = [];
  /** Adds parked lights until the pool holds size of them. */
  function ensure(target) {
    while (slots.length < target) {
      const light = new THREE.PointLight(0xffffff, 0, PARK_DISTANCE, 2);
      light.name = `spawn-light-${slots.length}`;
      light.castShadow = false;
      scene.add(light);
      slots.push({ light, held: false, priority: 0, owner: null, onRevoke: null });
    }
    return slots.length;
  }
  ensure(size);
  const stats = { acquired: 0, released: 0, refused: 0, revoked: 0, leaked: 0 };
  let currentOwner = null;

  function park(slot) {
    slot.held = false;
    slot.priority = 0;
    slot.owner = null;
    slot.onRevoke = null;
    slot.light.intensity = 0;
    slot.light.distance = PARK_DISTANCE;
    slot.light.color.setRGB(1, 1, 1);
  }

  function hand(slot, priority, onRevoke) {
    slot.held = true;
    slot.priority = priority;
    slot.owner = currentOwner;
    slot.onRevoke = typeof onRevoke === 'function' ? onRevoke : null;
    slot.light.intensity = 0;
    slot.light.color.setRGB(1, 1, 1);
    stats.acquired++;
    return slot.light;
  }

  function slotOf(light) {
    for (let index = 0; index < slots.length; index++) if (slots[index].light === light) return slots[index];
    return null;
  }

  return {
    ensure,
    acquire(priority = 0, onRevoke = null) {
      for (let index = 0; index < slots.length; index++) {
        if (!slots[index].held) return hand(slots[index], priority, onRevoke);
      }
      let victim = null;
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index];
        if (slot.onRevoke && slot.priority < priority && (!victim || slot.priority < victim.priority)) victim = slot;
      }
      if (!victim) {
        stats.refused++;
        return null;
      }
      const revoke = victim.onRevoke;
      try {
        revoke(victim.light);
      } catch (error) {
        console.error('[DRIFTWING] spawn light revoke callback failed', error);
      }
      stats.revoked++;
      park(victim);
      return hand(victim, priority, onRevoke);
    },
    release(light) {
      const slot = slotOf(light);
      if (!slot || !slot.held) return false;
      park(slot);
      stats.released++;
      return true;
    },
    /** Releases every light owner still holds; returns how many (each one is a leak by its engine). */
    releaseOwner(owner) {
      let count = 0;
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index];
        if (slot.held && slot.owner === owner) {
          park(slot);
          count++;
        }
      }
      stats.leaked += count;
      return count;
    },
    /** Lights held by owner. */
    heldBy(owner) {
      let count = 0;
      for (let index = 0; index < slots.length; index++) if (slots[index].held && slots[index].owner === owner) count++;
      return count;
    },
    get currentOwner() { return currentOwner; },
    set currentOwner(owner) { currentOwner = owner; },
    get size() { return slots.length; },
    get active() {
      let count = 0;
      for (let index = 0; index < slots.length; index++) if (slots[index].held) count++;
      return count;
    },
    getStats() {
      return { size: slots.length, active: this.active, ...stats };
    },
    dispose() {
      for (const slot of slots) {
        slot.light.removeFromParent();
        slot.light.dispose();
      }
      slots.length = 0;
    },
  };
}
