// IGNITION (contract h.5): the registry of things a flame can light, ctx.ignition (engines reach it as
// ctx.game.ignition). The dragon's fire breath is the flame today; lantern and torch owners (the sky
// lantern festival, the monastery, the castle, the ghost galleon) register what they own.
//
//   add({ id, position: { x, y, z }, radius = 1, onIgnite(source) })  -> id
//       an unlit ignitable: a sphere in the WORLD frame (float64) that a flame lights on contact.
//       onIgnite runs once, when it lights; source is { kind, craft, position } of the flame.
//   remove(id)                       -> true when it was registered (owners remove theirs on dispose)
//   move(id, x, y, z)                a moving ignitable (a drifting lantern, a ship's torch)
//   ignite(id, source)               lights it now (once): calls onIgnite and returns true, false when
//                                    it was already lit or is unknown
//   extinguish(id)                   unlit again, so a flame can light it once more (dawn, rain)
//   isLit(id)
//   cone(origin, direction, length, angle, visit) -> count
//       every ignitable whose sphere touches the cone from origin along direction (normalised here),
//       `length` metres long with half-angle `angle` (radians): visit(id, lit, distance) for each, in
//       registration order. The flame owner decides what to light (ignite).
//   count, litCount, ids(), getStats(), clear()
//
// Owners follow the dispose rules of contract appendix B: whatever an instance adds it removes, and
// count shows what is left. A failing onIgnite logs one [DRIFTWING] error and the ignitable stays
// lit. Pure JS (no three.js), and allocation-free in cone() and move().

const MIN_RADIUS = 0.05;
const MAX_RADIUS = 200;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function isPoint(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function ignitionError(id, problem) {
  return new TypeError(`[DRIFTWING] ignitable "${id}": ${problem}`);
}

export function createIgnitionService() {
  /** Records in registration order (cone visits them in that order); index by id. */
  const records = [];
  const byId = new Map();
  const counters = { added: 0, removed: 0, ignitions: 0, extinguished: 0, cones: 0, failures: 0 };

  function find(id) {
    return byId.get(id) ?? null;
  }

  return {
    /** Registers an unlit ignitable; throws on a bad or duplicate definition. */
    add(definition) {
      const id = definition && definition.id;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw ignitionError(id, 'needs an id (letters, digits, ":._-")');
      if (byId.has(id)) throw ignitionError(id, 'is already registered');
      if (!isPoint(definition.position)) throw ignitionError(id, 'needs a position { x, y, z }');
      const radius = definition.radius === undefined ? 1 : definition.radius;
      if (!(Number.isFinite(radius) && radius >= MIN_RADIUS && radius <= MAX_RADIUS)) throw ignitionError(id, `radius must be ${MIN_RADIUS}-${MAX_RADIUS} m`);
      if (typeof definition.onIgnite !== 'function') throw ignitionError(id, 'needs onIgnite(source)');
      const record = {
        id,
        x: definition.position.x,
        y: definition.position.y,
        z: definition.position.z,
        radius,
        onIgnite: definition.onIgnite,
        lit: false,
      };
      records.push(record);
      byId.set(id, record);
      counters.added++;
      return id;
    },

    remove(id) {
      const record = find(id);
      if (!record) return false;
      byId.delete(id);
      records.splice(records.indexOf(record), 1);
      counters.removed++;
      return true;
    },

    move(id, x, y, z) {
      const record = find(id);
      if (!record || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
      record.x = x;
      record.y = y;
      record.z = z;
      return true;
    },

    ignite(id, source) {
      const record = find(id);
      if (!record || record.lit) return false;
      record.lit = true;
      counters.ignitions++;
      try {
        record.onIgnite(source);
      } catch (error) {
        counters.failures++;
        console.error(`[DRIFTWING] ignitable "${id}" onIgnite failed`, error);
      }
      return true;
    },

    extinguish(id) {
      const record = find(id);
      if (!record || !record.lit) return false;
      record.lit = false;
      counters.extinguished++;
      return true;
    },

    isLit(id) {
      const record = find(id);
      return Boolean(record && record.lit);
    },

    /**
     * Visits every ignitable whose sphere touches the cone: the point's distance along the axis lies
     * in [-radius, length + radius] and its distance off the axis is within the cone's radius there
     * (tan(angle) x the axial distance) plus its own radius.
     */
    cone(origin, direction, length, angle, visit) {
      const norm = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
      if (!(norm > 1e-9) || !(length > 0) || !isPoint(origin)) return 0;
      counters.cones++;
      const axisX = direction.x / norm;
      const axisY = direction.y / norm;
      const axisZ = direction.z / norm;
      const spread = Math.tan(Math.min(Math.max(angle, 0), 1.4));
      let count = 0;
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const offsetX = record.x - origin.x;
        const offsetY = record.y - origin.y;
        const offsetZ = record.z - origin.z;
        const along = offsetX * axisX + offsetY * axisY + offsetZ * axisZ;
        if (along < -record.radius || along > length + record.radius) continue;
        const crossX = offsetX - axisX * along;
        const crossY = offsetY - axisY * along;
        const crossZ = offsetZ - axisZ * along;
        const off = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
        const reach = spread * Math.min(Math.max(along, 0), length) + record.radius;
        if (off > reach) continue;
        count++;
        visit(record.id, record.lit, Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ));
      }
      return count;
    },

    get count() {
      return records.length;
    },

    get litCount() {
      let lit = 0;
      for (let index = 0; index < records.length; index++) if (records[index].lit) lit++;
      return lit;
    },

    /** The registered ids, in registration order (a new array: for tests and leak reports). */
    ids() {
      return records.map((record) => record.id);
    },

    getStats() {
      return { count: records.length, lit: this.litCount, ...counters };
    },

    /** Removes everything (a world reload). */
    clear() {
      counters.removed += records.length;
      records.length = 0;
      byId.clear();
    },
  };
}
