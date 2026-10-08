// Eagle / dragon scenarios for ?test=craft (contract k.1; Milestone P item 3, "eagle perch and
// takeoff"):
//   eagle-perch-takeoff   a slow, hand-flown approach at the nearest perch from 70 m out: the
//                         auto-landing, standing still on the perch while the chase camera orbits,
//                         then raised flap power takes off and flies away
//   eagle-find-perch      the copilot's "find a perch" from 160 m out: the autopilot flies the
//                         approach, the bird perches and the approach lets go; "take off" leaves
//   eagle-ground-takeoff  a ground placement stands on its feet; full flap power takes off and climbs
//   eagle-stoop           the screech, then the tuck (held) folds the wings into a fast dive; released,
//                         the wings come out again
//   dragon-fire           the dragon skin (settings.craftSkins), fire breath held: the flame burns, the
//                         lantern in front of it lights through ctx.ignition and the one off to the
//                         side does not, the borrowed light comes and goes; back to the eagle after
// Perch starts begin on the perch point at a speed too fast to catch it, then the script moves the
// bird to its approach (flight.startAt) on the first frame, from a side where the ground stays low.
const APPROACH_HEADINGS = 16;

/** The perch nearest to the bird (colliders.perchesNear within radius), or null. */
function nearestPerch(api, radius) {
  const position = api.player.position;
  let best = null;
  api.colliders?.perchesNear?.(position.x, position.y, position.z, radius, (x, y, z, kind, id) => {
    const distance = Math.hypot(x - position.x, y - position.y, z - position.z);
    if (!best || distance < best.distance) best = { x, y, z, kind, id, distance };
  });
  return best;
}

/**
 * The approach start `distance` metres out from the perch and `above` metres over it, on the side
 * whose ground stays lowest under the approach line; null when every side rises into it.
 */
function approachStart(api, perch, distance, above) {
  let best = null;
  for (let index = 0; index < APPROACH_HEADINGS; index++) {
    const heading = (index / APPROACH_HEADINGS) * 360;
    const radians = (heading * Math.PI) / 180;
    // The bird starts out along -heading and flies toward the perch on heading.
    let margin = Infinity;
    for (let along = 5; along <= distance; along += 5) {
      const x = perch.x - Math.sin(radians) * along;
      const z = perch.z + Math.cos(radians) * along;
      const path = perch.y + (above * along) / distance;
      margin = Math.min(margin, path - api.surfaceHeight(x, z));
    }
    if (!best || margin > best.margin) best = { heading, margin, x: perch.x - Math.sin(radians) * distance, z: perch.z + Math.cos(radians) * distance };
  }
  if (!best || best.margin < 4) return null;
  return { mode: 'air', position: { x: best.x, y: perch.y + above, z: best.z }, heading: best.heading, speed: 10.5 };
}

/** Bank toward a point: the roll that turns the bird onto its bearing (wings level once on it). */
function steerToward(api, x, z) {
  const position = api.player.position;
  const bearing = (Math.atan2(x - position.x, -(z - position.z)) * 180) / Math.PI;
  const error = ((((bearing - api.flight.heading) % 360) + 540) % 360) - 180;
  const bank = Math.max(-25, Math.min(25, error * 1.2));
  return Math.max(-1, Math.min(1, 0.05 * (bank - api.flight.roll)));
}

/** Moves the bird to its approach on the first frame; returns false (fly level) until it is there. */
function setUpApproach(api, distance, above) {
  if (api.memo.setUpFailed) throw new Error(api.memo.setUpFailed);
  if (api.memo.perch) return true;
  if (!api.once('approach')) return false;
  const perch = nearestPerch(api, 12);
  if (!perch) {
    api.memo.setUpFailed = 'no perch at the start point';
    throw new Error(api.memo.setUpFailed);
  }
  const placement = approachStart(api, perch, distance, above);
  if (!placement) {
    api.memo.setUpFailed = `no clear approach to the ${perch.kind} perch ${perch.id}`;
    throw new Error(api.memo.setUpFailed);
  }
  api.controller.startAt(placement);
  api.memo.perch = perch;
  return false;
}

const perched = (api) => api.craftState.perched === true && ['tree', 'structure', 'peak'].includes(api.craftState.perchKind);

export default Object.freeze({
  craft: 'eagle',
  scenarios: Object.freeze([
    Object.freeze({
      id: 'eagle-perch-takeoff',
      views: ['third', 'first'],
      start: { at: 'perch', mode: 'air', speed: 15 },
      seconds: 36,
      script(t, api) {
        const memo = api.memo;
        if (!setUpApproach(api, 70, 9)) return { roll: 0, pitch: 0, yaw: 0, throttle: 0.25 };
        const perch = memo.perch;
        if (api.craftState.perched === true && memo.perchedAt === undefined) memo.perchedAt = t;
        if (memo.perchedAt !== undefined && t >= memo.perchedAt + 4) return { roll: 0, pitch: 0, yaw: 0, throttle: 0.85 };
        if (memo.perchedAt !== undefined) return { roll: 0, pitch: 0, yaw: 0, throttle: 0.25 };
        // Hand-flown: steer at the perch, slow (pitch up), a little flap power while low on the slope.
        const position = api.player.position;
        const distance = Math.hypot(perch.x - position.x, perch.z - position.z);
        const slope = perch.y + 2 + distance * 0.11;
        return { roll: steerToward(api, perch.x, perch.z), pitch: 0.3, yaw: 0, throttle: position.y < slope ? 0.4 : 0.1 };
      },
      checks: [
        { id: 'landing', label: 'the auto-landing starts on a slow approach', until: 24, test: (api) => api.craftState.landing > 0 && api.craftState.landing < 1 },
        { id: 'perched', label: 'perched on the perch (the perched event)', until: 26, test: (api) => perched(api) && api.events.count('perched') >= 1 && api.events.last('perched').perched === true },
        { id: 'still', label: 'standing still on the perch', until: 30, test: (api) => perched(api) && api.craftState.perchedSeconds > 2 && api.flight.groundSpeed < 0.05 && api.flight.onGround },
        { id: 'orbit', label: 'the idle chase camera orbits the perched bird', until: 32, test: (api) => perched(api) && Math.abs(api.module.cameraRig.chase.orbitYaw) > 2 },
        { id: 'takeoff', label: 'flap power takes off (perched false event)', until: 34, test: (api) => api.memo.perchedAt !== undefined && api.craftState.perched === false && api.events.last('perched')?.perched === false },
        { id: 'away', label: 'flies away from the perch', until: 36, test: (api) => api.memo.perchedAt !== undefined && api.craftState.perched === false && Math.hypot(api.player.position.x - api.memo.perch.x, api.player.position.z - api.memo.perch.z) > 15 },
      ],
    }),
    Object.freeze({
      id: 'eagle-find-perch',
      views: ['third', 'first'],
      start: { at: 'perch', mode: 'air', speed: 15 },
      seconds: 100,
      script(t, api) {
        const memo = api.memo;
        if (!setUpApproach(api, 160, 30)) return { roll: 0, pitch: 0, yaw: 0, throttle: 0.3 };
        if (t >= 0.5 && api.once('find')) memo.find = api.controller.runCraftCommand('findPerch');
        if (api.craftState.perched === true && memo.perchedAt === undefined) memo.perchedAt = t;
        if (memo.perchedAt !== undefined && t >= memo.perchedAt + 3 && api.once('takeOff')) memo.takeOff = api.controller.runCraftCommand('takeOff');
        return { roll: 0, pitch: 0, yaw: 0, throttle: memo.takeOff ? 0.8 : 0.3 };
      },
      checks: [
        { id: 'command', label: '"find a perch" finds one and engages the autopilot', from: 0.5, until: 4, test: (api) => api.memo.find?.ok === true && api.player.autopilot.enabled === true && api.craftState.perchTarget !== null },
        { id: 'perched', label: 'the autopilot brings it onto a perch', until: 90, test: (api) => perched(api) },
        { id: 'released', label: 'the approach lets go once perched', until: 92, test: (api) => perched(api) && api.player.autopilot.enabled === false && api.craftState.perchTarget === null },
        { id: 'takeoff', label: '"take off" leaves the perch', until: 98, test: (api) => api.memo.takeOff?.ok === true && api.craftState.perched === false },
      ],
    }),
    Object.freeze({
      id: 'eagle-ground-takeoff',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'ground', flatSpot: true },
      seconds: 16,
      script(t) {
        return { roll: 0, pitch: t < 3 ? 0 : 0.15, yaw: 0, throttle: t < 3 ? 0 : 1 };
      },
      checks: [
        { id: 'standing', label: 'stands on its feet on the ground', until: 2.5, test: (api) => api.craftState.perched === true && api.flight.onGround && api.flight.groundSpeed < 0.05 },
        { id: 'takeoff', label: 'full flap power takes off', from: 3, until: 6, test: (api) => api.craftState.perched === false && !api.flight.onGround },
        { id: 'climbs', label: 'climbs away (10 m up)', from: 3, until: 16, test: (api) => api.agl() > 10 },
      ],
    }),
    Object.freeze({
      id: 'eagle-stoop',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 900, clearRadius: 1500, speed: 13 },
      seconds: 24,
      script(t, api) {
        const actions = t >= 0.5 && api.once('screech') ? ['craftAbility'] : [];
        const tucking = t >= 2 && t < 12;
        return { roll: 0, pitch: tucking ? -0.25 : t >= 12 ? 0.3 : 0, yaw: 0, throttle: 0, actions, held: tucking ? ['craftAbilityAlt'] : [] };
      },
      checks: [
        { id: 'screech', label: 'the eagle screeches', until: 2, test: (api) => api.craftState.screechCount >= 1 },
        { id: 'tucked', label: 'the tuck folds the wings', from: 2, until: 6, test: (api) => api.craftState.wingTuck > 0.9 },
        { id: 'stoop', label: 'stooping faster than 35 m/s', from: 2, until: 12.5, test: (api) => api.flight.airspeed > 35 },
        { id: 'wingsOut', label: 'released, the wings come out and it pulls out', from: 12, until: 24, test: (api) => api.craftState.wingTuck < 0.05 && api.flight.verticalSpeed > -5 },
      ],
    }),
    Object.freeze({
      id: 'dragon-fire',
      views: ['third', 'first'],
      start: { at: 'spawn', mode: 'air', agl: 400, clearRadius: 500, speed: 12.5 },
      seconds: 12,
      script(t, api) {
        const memo = api.memo;
        const ctx = api.ctx;
        if (api.once('skin')) ctx.settings.update('craftSkins', { eagle: 'dragon' });
        if (t >= 1.5 && api.once('lanterns')) {
          // One lantern on the flame's line 7 m ahead of the mouth, one 30 m off to the side.
          const position = api.player.position;
          const heading = (api.flight.heading * Math.PI) / 180;
          const ahead = { x: position.x + Math.sin(heading) * 7.5, y: position.y - 0.8, z: position.z - Math.cos(heading) * 7.5 };
          const aside = { x: position.x + Math.cos(heading) * 30, y: position.y, z: position.z + Math.sin(heading) * 30 };
          ctx.ignition.add({ id: 'craftTest:lanternAhead', position: ahead, radius: 1, onIgnite: () => { memo.aheadLit = true; } });
          ctx.ignition.add({ id: 'craftTest:lanternAside', position: aside, radius: 1, onIgnite: () => { memo.asideLit = true; } });
          memo.lanterns = true;
        }
        const burning = t >= 1.5 && t < 4;
        if (burning && ctx.systems.spawns?.manager?.lights?.active > 0) memo.lightSeen = true;
        if (t >= 10 && api.once('cleanup')) {
          ctx.ignition.remove('craftTest:lanternAhead');
          ctx.ignition.remove('craftTest:lanternAside');
          ctx.settings.update('craftSkins', { eagle: 'eagle' });
          memo.cleaned = true;
        }
        return { roll: 0, pitch: 0, yaw: 0, throttle: 0.3, held: burning ? ['craftAbility'] : [] };
      },
      checks: [
        { id: 'skin', label: 'the dragon skin is flying', until: 1.4, test: (api) => api.craftState.skin === 'dragon' && api.flight.craft === 'eagle' },
        { id: 'flame', label: 'the flame burns while held (with a roar)', from: 1.5, until: 4, test: (api) => api.craftState.fireIntensity > 0.9 && api.craftState.roarCount >= 1 },
        { id: 'lit', label: 'the lantern in the flame lights (ctx.ignition)', from: 1.5, until: 5, test: (api) => api.memo.aheadLit === true && api.craftState.lanternsLit >= 1 },
        { id: 'light', label: 'a real light burns with the flame (the spawn light pool)', from: 1.5, until: 4.2, test: (api) => api.memo.lightSeen === true || (api.ctx.systems.spawns?.manager?.lights?.size ?? 0) === 0 },
        { id: 'out', label: 'released, the flame goes out and the light goes back', from: 5, until: 9, test: (api) => api.craftState.fireIntensity === 0 && api.craftState.fire === false },
        { id: 'aside', label: 'the lantern off to the side stays unlit', from: 9, until: 9.9, test: (api) => api.memo.asideLit !== true && api.memo.lanterns === true },
        { id: 'cleanup', label: 'back to the eagle, the lanterns removed', from: 10.5, until: 12, test: (api) => api.memo.cleaned === true && api.craftState.skin === 'eagle' && !api.ctx.ignition.ids().some((id) => id.startsWith('craftTest:')) },
      ],
    }),
  ]),
});
