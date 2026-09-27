import { CONFIG } from '../core/config.js';
import { dayTimeForSunElevation } from '../core/sun.js';
import { DEG, clamp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, compassName } from '../core/util.js';
import { FLIGHT_ACTION_TYPES, createFlightGrammar, describeAirspeed, sanitizeFlightAction } from './grammar.js';
import { buildFlightFields } from './flightState.js';
import { createFlightActionHandlers, createOutcomeWaiter, helpLine, keyFor } from './flightActions.js';
import { createFlightChatter } from './flightChatter.js';
import { createCommandChips } from './commandChips.js';

/**
 * COPILOT "WREN".
 * - Copilot: the default local brain, a tolerant keyword grammar that turns a
 *   transcript into { speech, action } using only the flight-state snapshot. The v2
 *   aircraft grammar (craft, CLASSIC | SIM, assists, views, chute, engine, relaunch,
 *   calibration, airspeed, landings) lives in grammar.js.
 * - RemoteCopilot: POSTs { flightState, transcript } to an HTTP brain with an
 *   800 ms budget, validates the reply, and falls back to the local grammar
 *   ('local-fallback') on any timeout, network error, bad JSON or bad shape.
 * - createCopilotSystem: the action executor (ctx.executeAction), speech out
 *   (speechSynthesis after a user gesture), speech in (Web Speech API: the v1 mic
 *   toggle, and hold-to-talk on the copilotPTT action), the ui:command / ui:action /
 *   mic:toggle pipeline, and gentle chatter (flightChatter.js adds the v2 events).
 * docs/copilot-api.md is the remote contract: request, flightState and every action.
 */
export class Copilot {
  static ACTION_TYPES = Object.freeze([
    'waypoint', 'clearWaypoint', 'autopilot', 'time', 'ringCourse', 'cancelRingCourse',
    'barrelRoll', 'boost', 'find', 'describe', 'photoMode', 'journal', 'none',
    ...FLIGHT_ACTION_TYPES,
  ]);

  static FIND_TARGETS = Object.freeze([
    'mountains', 'snow', 'ocean', 'archipelago', 'islands', 'desert', 'dunes', 'forest', 'pine',
    'meadows', 'flowers', 'landmark', 'arch', 'monoliths', 'lighthouse', 'balloons',
  ]);

  static TIME_PRESETS = Object.freeze(['dawn', 'sunrise', 'morning', 'noon', 'golden', 'sunset', 'dusk', 'night', 'midnight']);

  static MAX_SPEECH_LENGTH = 400;
  static MAX_LABEL_LENGTH = 48;
  static MIN_RINGS = 3;
  static MAX_RINGS = 24;

  static NUMBER_WORDS = Object.freeze({
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  });

  static QUANTITY = `(half an?|\\d+(?:\\.\\d+)?|${Object.keys(Copilot.NUMBER_WORDS).join('|')})`;
  static DISTANCE_PATTERN = new RegExp(`\\b${Copilot.QUANTITY}\\s*(kilomet(?:er|re)s?|kms?|k|clicks?|miles?|met(?:er|re)s?|m)\\b`);
  /** Ring counts need a real number: "a ring course with 8 rings" must not read as one ring. */
  static RING_COUNT_PATTERN = new RegExp(
    `\\b(\\d+|${Object.keys(Copilot.NUMBER_WORDS).filter((word) => word !== 'a' && word !== 'an').join('|')})\\s*(?:rings?|hoops?|gates?)\\b`,
  );

  /** Ordered target synonyms: specific landmarks first, broad terrain last. */
  static TARGET_SYNONYMS = Object.freeze([
    ['lighthouse', /\blight ?houses?\b/],
    ['balloons', /\b(hot[ -]?air )?balloons?\b/],
    ['monoliths', /\b(monoliths?|standing stones?|stone circles?|stonehenge|menhirs?)\b/],
    ['arch', /\b(arch|arches|rock arch|stone arch)\b/],
    ['landmark', /\b(landmarks?|points? of interest|something (interesting|cool|new)|sights?|ruins?)\b/],
    ['snow', /\b(snow peaks?|snow|snowy|ice|icy|glaciers?|frozen|tundra|winter)\b/],
    ['mountains', /\b(mountains?|mountain range|peaks?|summits?|ridges?|alps|highlands?)\b/],
    ['archipelago', /\b(archipelago|islands?|isles?|atolls?|reefs?|tropic(s|al)?|lagoons?|beach(es)?)\b/],
    ['ocean', /\b(ocean|sea|seas|open water|water|coast|coastline|shore)\b/],
    ['dunes', /\b(dunes?|desert|sand|sandy|dune sea)\b/],
    ['pine', /\b(forests?|woods|woodlands?|pines?|pine trees|trees|valleys?|taiga)\b/],
    ['meadows', /\b(meadows?|flowers?|fields?|grasslands?|prairies?|plains?|countryside)\b/],
  ]);

  static TIME_WORDS = Object.freeze([
    ['midnight', /\bmidnight\b/],
    ['golden', /\b(golden( hour)?|magic hour)\b/],
    ['dusk', /\b(dusk|twilight|blue hour|nightfall)\b/],
    ['sunset', /\b(sunset|sundown|evening)\b/],
    ['sunrise', /\bsunrise\b/],
    ['dawn', /\b(dawn|first light|daybreak)\b/],
    ['morning', /\bmorning\b/],
    ['night', /\b(night|nighttime|night ?time|dark|starry|stars|moonlight)\b/],
    ['noon', /\b(noon|midday|mid-day|day ?time|day|afternoon|daylight)\b/],
  ]);

  static TIME_FILLER_WORDS = new Set([
    'the', 'a', 'it', 'please', 'hour', 'time', 'now', 'again', 'wren', 'to', 'some',
    'golden', 'magic', 'blue', 'first', 'light', 'mid-day',
  ]);

  static cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const cut = text.slice(0, maxLength);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (sentenceEnd > maxLength * 0.5) return cut.slice(0, sentenceEnd + 1);
    const wordEnd = cut.lastIndexOf(' ');
    return `${cut.slice(0, wordEnd > 0 ? wordEnd : maxLength - 3).trim()}...`;
  }

  /** Validates one action against the shared schema; returns a clean copy or null. */
  static sanitizeAction(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (!Copilot.ACTION_TYPES.includes(type)) return null;
    const present = (value) => value !== undefined && value !== null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    const action = { type };
    switch (type) {
      case 'waypoint': {
        if (present(raw.x) !== present(raw.z)) return null;
        if (present(raw.x)) {
          if (!finite(raw.x) || !finite(raw.z) || Math.abs(raw.x) > 1e7 || Math.abs(raw.z) > 1e7) return null;
          action.x = raw.x;
          action.z = raw.z;
        }
        if (present(raw.bearing)) {
          if (!finite(raw.bearing)) return null;
          action.bearing = wrapDegrees(raw.bearing);
        }
        if (present(raw.distance)) {
          if (!finite(raw.distance)) return null;
          action.distance = clamp(raw.distance, 50, 40000);
        }
        if (present(raw.label)) {
          if (typeof raw.label !== 'string') return null;
          const label = Copilot.cleanText(raw.label, Copilot.MAX_LABEL_LENGTH);
          if (label) action.label = label;
        }
        if (present(raw.autopilot)) {
          if (typeof raw.autopilot !== 'boolean') return null;
          action.autopilot = raw.autopilot;
        }
        return action;
      }
      case 'autopilot': {
        if (typeof raw.enabled !== 'boolean') return null;
        action.enabled = raw.enabled;
        if (present(raw.heading)) {
          if (!finite(raw.heading)) return null;
          action.heading = wrapDegrees(raw.heading);
        }
        if (present(raw.altitude)) {
          if (!finite(raw.altitude)) return null;
          action.altitude = clamp(raw.altitude, 40, CONFIG.MAX_ALTITUDE);
        }
        if (present(raw.followWaypoint)) {
          if (typeof raw.followWaypoint !== 'boolean') return null;
          action.followWaypoint = raw.followWaypoint;
        }
        return action;
      }
      case 'time': {
        if (present(raw.preset)) {
          const preset = typeof raw.preset === 'string' ? raw.preset.toLowerCase() : '';
          if (!Copilot.TIME_PRESETS.includes(preset)) return null;
          action.preset = preset;
        } else if (present(raw.dayTime)) {
          if (!finite(raw.dayTime)) return null;
          action.dayTime = ((raw.dayTime % 1) + 1) % 1;
        } else {
          return null;
        }
        return action;
      }
      case 'ringCourse': {
        if (present(raw.count)) {
          if (!finite(raw.count)) return null;
          action.count = clamp(Math.round(raw.count), Copilot.MIN_RINGS, Copilot.MAX_RINGS);
        }
        return action;
      }
      case 'barrelRoll': {
        if (present(raw.direction)) {
          const direction = typeof raw.direction === 'string' ? raw.direction.toLowerCase() : '';
          if (direction !== 'left' && direction !== 'right') return null;
          action.direction = direction;
        }
        return action;
      }
      case 'find': {
        const target = typeof raw.target === 'string' ? raw.target.toLowerCase() : '';
        if (!Copilot.FIND_TARGETS.includes(target)) return null;
        action.target = target;
        if (present(raw.autopilot)) {
          if (typeof raw.autopilot !== 'boolean') return null;
          action.autopilot = raw.autopilot;
        }
        return action;
      }
      case 'photoMode': {
        if (present(raw.enabled)) {
          if (typeof raw.enabled !== 'boolean') return null;
          action.enabled = raw.enabled;
        }
        return action;
      }
      default:
        return FLIGHT_ACTION_TYPES.includes(type) ? sanitizeFlightAction(raw) : action;
    }
  }

  /** Validates a full brain reply; returns { speech, action } or null when the shape is wrong. */
  static sanitizeReply(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    let speech = '';
    if (typeof raw.speech === 'string') speech = Copilot.cleanText(raw.speech, Copilot.MAX_SPEECH_LENGTH);
    else if (raw.speech !== undefined && raw.speech !== null) return null;
    let action = null;
    if (raw.action !== undefined && raw.action !== null) {
      action = Copilot.sanitizeAction(raw.action);
      if (!action) return null;
    }
    if (!speech && (!action || action.type === 'none')) return null;
    return { speech, action };
  }

  static normalize(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[‘’`]/g, "'")
      .replace(/[^a-z0-9'.\-\s]/g, ' ')
      .replace(/(^|\s)[.'-]+|[.'-]+(\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Removes politeness and filler so short bare commands ("ocean please") can be recognised. */
  static coreWords(text) {
    return text
      .replace(/\b(hey|hi there|ok|okay|so|um+|uh+|er+|erm|please|pls|wren|could you|can you|would you|will you|would you mind|i'd like to|i would like to|i want to|i wanna|go ahead and|kindly|just|maybe|quickly|now|the|a|an|us|me)\b/g, ' ')
      .split(' ')
      .filter(Boolean);
  }

  static parseQuantity(token) {
    if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
    if (/^half an?$/.test(token)) return 0.5;
    return Copilot.NUMBER_WORDS[token] ?? Number.NaN;
  }

  /** Distance in metres from phrases like "3 km", "half a kilometre", "800 metres"; null if absent. */
  static parseDistance(text) {
    const match = text.match(Copilot.DISTANCE_PATTERN);
    if (!match) return null;
    const quantity = Copilot.parseQuantity(match[1]);
    if (!Number.isFinite(quantity)) return null;
    const unit = match[2];
    if (/^(k|km|kms|kilomet|click)/.test(unit)) return quantity * 1000;
    if (/^mile/.test(unit)) return quantity * 1609;
    return quantity;
  }

  static parseCardinal(text) {
    const compound = text.match(/\b(north|south)[\s-]?(east|west)(?:ward|wards|erly)?\b/);
    if (compound) return { northeast: 45, northwest: 315, southeast: 135, southwest: 225 }[compound[1] + compound[2]];
    const single = text.match(/\b(north|east|south|west)(?:ward|wards|erly)?\b/);
    return single ? { north: 0, east: 90, south: 180, west: 270 }[single[1]] : null;
  }

  static parseRelativeBearing(text, heading) {
    if (/\b(behind|to the rear|back there)\b/.test(text)) return wrapDegrees(heading + 180);
    if (/\bleft\b/.test(text)) return wrapDegrees(heading - 90);
    if (/\bright\b/.test(text) && !/\bright (here|now|there|below|away|under)\b/.test(text)) return wrapDegrees(heading + 90);
    if (/\b(ahead|forward|in front|straight on|up ahead)\b/.test(text)) return wrapDegrees(heading);
    return null;
  }

  static findTarget(text) {
    for (const [target, pattern] of Copilot.TARGET_SYNONYMS) if (pattern.test(text)) return target;
    return null;
  }

  static formatDistance(metres) {
    if (!Number.isFinite(metres)) return 'some distance';
    if (metres < 950) return `${Math.max(10, Math.round(metres / 10) * 10)} metres`;
    const kilometres = metres / 1000;
    return `${kilometres < 9.95 ? kilometres.toFixed(1) : Math.round(kilometres)} km`;
  }

  /** "straight ahead" when the bearing is close to the heading, otherwise "to the north-east". */
  static directionPhrase(bearing, heading) {
    const relative = Math.abs(((bearing - heading + 540) % 360) - 180);
    if (relative < 18) return 'straight ahead';
    if (relative > 162) return `behind us, to the ${compassName(bearing)}`;
    return `to the ${compassName(bearing)}`;
  }

  /** Speakable name for a waypoint label: generic labels become "the waypoint". */
  static waypointName(label) {
    return !label || label === 'Waypoint' ? 'the waypoint' : label;
  }

  static clockFromDayTime(dayTime) {
    if (!Number.isFinite(dayTime)) return '';
    const minutes = Math.round((((dayTime % 1) + 1) % 1) * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  /** Sky-module-independent fallback for time presets (sun elevation in degrees, evening side). */
  static dayTimeForPreset(preset) {
    switch (preset) {
      case 'dawn': return dayTimeForSunElevation(-4, false);
      case 'sunrise': return dayTimeForSunElevation(2, false);
      case 'morning': return dayTimeForSunElevation(24, false);
      case 'noon': return 0.5;
      case 'golden': return dayTimeForSunElevation(8, true);
      case 'sunset': return dayTimeForSunElevation(1, true);
      case 'dusk': return dayTimeForSunElevation(-4, true);
      case 'night': return dayTimeForSunElevation(-35, true);
      default: return 0;
    }
  }

  static pickVariant(memory, key, options) {
    if (options.length === 1) return options[0];
    const last = memory.get(key);
    let index = Math.floor(Math.random() * options.length);
    if (index === last) index = (index + 1 + Math.floor(Math.random() * (options.length - 1))) % options.length;
    memory.set(key, index);
    return options[index];
  }

  /** Settings intents that always stay on the device, whatever brain is active. */
  static localSettingIntent(text) {
    if (/\b(voice off|mute (your )?voice|turn (your )?voice off|turn off (your )?voice|subtitles only|text only|stop speaking out loud)\b/.test(text)) return 'voiceOff';
    if (/\b(voice on|unmute|turn (your )?voice on|turn on (your )?voice|speak out loud|talk out loud)\b/.test(text)) return 'voiceOn';
    if (/\b(chatter on|talk to me more|keep me company|you can talk|more chatter|talk more)\b/.test(text)) return 'chatterOn';
    if (/\b(be quiet|quiet|hush|shush|stop talking|less talking|less chatter|no more chatter|chatter off|silence|pipe down|stop chatting)\b/.test(text)) return 'chatterOff';
    return null;
  }

  /** The world's own colouring rule: above this height snow and pine ground is drawn white. */
  static snowLineFor(temperature) {
    return 140 + 640 * temperature;
  }

  /** Index of the second-strongest biome weight. */
  static secondBiomeIndex(info) {
    let second = -1;
    for (let index = 0; index < info.weights.length; index++) {
      if (index === info.index) continue;
      if (second < 0 || info.weights[index] > info.weights[second]) second = index;
    }
    return second;
  }

  /** True when snow-covered ground (above the local snow line, snow/pine colouring) lies within ~1.5 km. */
  static snowyPeaksAround(world, x, z) {
    for (const radius of [700, 1500]) {
      for (let sample = 0; sample < 8; sample++) {
        const angle = (sample / 8) * Math.PI * 2;
        const sampleX = x + Math.sin(angle) * radius;
        const sampleZ = z - Math.cos(angle) * radius;
        const info = world.biomeAt(sampleX, sampleZ);
        if (info.weights[0] + info.weights[1] < 0.6) continue;
        if (world.heightAt(sampleX, sampleZ) > Copilot.snowLineFor(info.temperature) + 20) return true;
      }
    }
    return false;
  }

  /**
   * Share (0..1) of the ground around (x, z) drawn snow-white: the centre plus rings at 250 m and
   * 550 m. Snow is only as white as the snow and pine weight in the colour blend, so a meadow-blended
   * slope just above the snow line counts as partly green.
   */
  static snowCover(world, x, z) {
    let snowy = 0;
    let total = 0;
    for (const radius of [0, 250, 550]) {
      const count = radius === 0 ? 1 : 4;
      for (let sample = 0; sample < count; sample++) {
        const angle = (sample / count) * Math.PI * 2 + (radius === 550 ? Math.PI / 4 : 0);
        const sampleX = x + Math.sin(angle) * radius;
        const sampleZ = z - Math.cos(angle) * radius;
        const info = world.biomeAt(sampleX, sampleZ);
        total++;
        if (world.heightAt(sampleX, sampleZ) > Copilot.snowLineFor(info.temperature)) snowy += Math.min(1, info.weights[0] + info.weights[1]);
      }
    }
    return snowy / total;
  }

  /** The strongest other biome when its weight is high enough to show in the ground colours, else null. */
  static blendPartner(world, info) {
    const secondIndex = Copilot.secondBiomeIndex(info);
    return secondIndex >= 0 && info.weights[secondIndex] >= 0.25 ? world.BIOMES[secondIndex] : null;
  }

  /** Flower country under the Snow Peaks: 'high meadows' only when the ground really is high. */
  static meadowsBelowPeaks(ground) {
    return ground >= 150 ? 'the high meadows below the Snow Peaks' : 'the meadows at the foot of the Snow Peaks';
  }

  /**
   * Snow-dominant ground, judged the way the terrain is coloured: white only above the local snow
   * line (and only as white as the snow weight in the blend), grey scree just under it, and below
   * that foothills tinted by the blend partner (green meadows, pines, sand). Fills place.phrase /
   * snowy / foothills / peaksNearby.
   */
  static describeSnowCountry(world, x, z, ground, info, partner, place) {
    const snowLine = Copilot.snowLineFor(info.temperature);
    const cover = Copilot.snowCover(world, x, z);
    if (ground > snowLine && cover >= 0.5) {
      place.snowy = true;
      place.phrase = partner?.key === 'pine' ? 'the snowfields above the Pine Valleys' : 'the snowfields of the Snow Peaks';
      return;
    }
    if (ground > snowLine) {
      const climbing = {
        meadows: 'the slopes where the Flower Meadows climb into the Snow Peaks',
        pine: 'the slopes where the pines give way to snow',
        dunes: 'the dry slopes at the edge of the Snow Peaks',
        archipelago: 'the coastal slopes of the Snow Peaks',
      };
      place.phrase = (partner && climbing[partner.key]) || 'the snowline of the Snow Peaks';
      return;
    }
    place.foothills = true;
    place.peaksNearby = cover >= 0.2 || Copilot.snowyPeaksAround(world, x, z);
    const below = {
      meadows: Copilot.meadowsBelowPeaks(ground),
      pine: 'the wooded foothills of the Snow Peaks',
      dunes: 'the dry foothills of the Snow Peaks',
      archipelago: 'the coastal foothills of the Snow Peaks',
    };
    if (partner && below[partner.key]) place.phrase = below[partner.key];
    else place.phrase = ground > snowLine - 60 ? 'the high slopes just below the snowline' : 'the foothills of the Snow Peaks';
  }

  /**
   * Visually honest description of the ground around (x, z), always a noun phrase that reads after
   * "over" or "above". The dominant biome alone misleads: 'snow' ground below the snow line is drawn
   * as grey-green foothills, pine ground above it is white, and strong blends look like both, so the
   * blend partner is named when its weight shows. With a heading, land is judged a little ahead
   * (PLACE_LEAD metres), where the pilot is actually looking, unless that point is water. Returns
   * { phrase, key, snowy, foothills, overWater, peaksNearby }.
   */
  static describePlace(world, x, z, groundHeight, heading) {
    const PLACE_LEAD = 300;
    const groundBelow = Number.isFinite(groundHeight) ? groundHeight : world.groundHeight(x, z);
    if (Number.isFinite(heading) && groundBelow >= CONFIG.WATER_LEVEL - 0.5) {
      const radians = heading * DEG;
      const leadX = x + Math.sin(radians) * PLACE_LEAD;
      const leadZ = z - Math.cos(radians) * PLACE_LEAD;
      const leadGround = world.groundHeight(leadX, leadZ);
      if (leadGround >= CONFIG.WATER_LEVEL - 0.5) return Copilot.describePlace(world, leadX, leadZ, leadGround);
    }
    const info = world.biomeAt(x, z);
    const ground = groundBelow;
    const name = info.name;
    const partner = Copilot.blendPartner(world, info);
    const place = {
      phrase: `the ${name}`,
      key: info.key,
      snowy: false,
      foothills: false,
      overWater: false,
      peaksNearby: false,
    };
    if (ground < CONFIG.WATER_LEVEL - 0.5) {
      place.overWater = true;
      const deep = ground < CONFIG.WATER_LEVEL - 18;
      if (info.key === 'archipelago') place.phrase = deep ? 'open water between the islands' : 'the lagoons of the Archipelago';
      else place.phrase = deep ? `open water off the ${name}` : `the shallows off the ${name}`;
      return place;
    }
    switch (info.key) {
      case 'snow':
        Copilot.describeSnowCountry(world, x, z, ground, info, partner, place);
        break;
      case 'pine': {
        const cover = Copilot.snowCover(world, x, z);
        if (cover >= 0.5 && ground > Copilot.snowLineFor(info.temperature)) {
          place.snowy = true;
          place.phrase = 'the snowy ridges of the Pine Valleys';
        } else if (cover >= 0.5) {
          place.phrase = 'a pine valley between snowy ridges';
        } else if (partner) {
          place.phrase = partner.key === 'snow' ? 'the Pine Valleys, below the Snow Peaks' : `the Pine Valleys, on the edge of the ${partner.name}`;
        }
        break;
      }
      case 'archipelago':
        place.phrase = 'the islands of the Archipelago';
        break;
      case 'meadows':
        if (partner) place.phrase = partner.key === 'snow' ? Copilot.meadowsBelowPeaks(ground) : `the Flower Meadows, on the edge of the ${partner.name}`;
        break;
      default:
        if (partner) place.phrase = `the ${name}, on the edge of the ${partner.name}`;
    }
    return place;
  }

  /** Plain-language summary of where we are, built only from the flight-state snapshot. */
  static describe(flight) {
    const sentences = [];
    const place = typeof flight.place === 'string' && flight.place ? flight.place : `the ${flight.biome?.name ?? 'open country'}`;
    const altitude = Math.round(flight.altitude ?? 0);
    const clearance = flight.overWater ? altitude : Math.round(flight.altitudeAboveGround ?? altitude);
    const kmh = Math.round(flight.speedKmh ?? 0);
    const height = clearance >= 100 ? Math.round(clearance / 10) * 10 : Math.max(0, clearance);
    sentences.push(`We're ${height} metres above ${place}, heading ${flight.headingName ?? 'on'} at ${kmh} km/h.`);
    const clock = Copilot.clockFromDayTime(flight.dayTime);
    if (flight.timeLabel) sentences.push(`It's ${flight.timeLabel}${clock ? `, ${clock}` : ''}.`);
    const ring = flight.ringCourse;
    const waypoint = flight.waypoint;
    const landmark = Array.isArray(flight.nearbyLandmarks) ? flight.nearbyLandmarks[0] : null;
    if (ring?.active && ring.nextRingDistance) {
      sentences.push(`Ring ${ring.nextIndex + 1} of ${ring.total} is ${Copilot.formatDistance(ring.nextRingDistance)} out.`);
    } else if (waypoint) {
      const subject = !waypoint.label || waypoint.label === 'Waypoint' ? 'The waypoint' : `Our waypoint, ${waypoint.label},`;
      sentences.push(`${subject} is ${Copilot.formatDistance(waypoint.distance)} ${Copilot.directionPhrase(waypoint.bearing, flight.heading)}.`);
    } else if (landmark && Number.isFinite(landmark.distance)) {
      const note = landmark.discovered ? '' : ", and it's not in the journal yet";
      sentences.push(`${landmark.name} is ${Copilot.formatDistance(landmark.distance)} ${Copilot.directionPhrase(landmark.bearing, flight.heading)}${note}.`);
    }
    return sentences.join(' ');
  }

  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'local';
    this.phraseMemory = new Map();
    const pick = (key, options) => this.pick(key, options);
    const flightGrammar = createFlightGrammar({ pick, helpLine: () => helpLine(ctx, pick) });
    // Help first, then the v2 aircraft commands, then v1's grammar unchanged.
    this.matchers = [
      flightGrammar.matchHelp, ...flightGrammar.matchers, this.matchCancelCourse, this.matchAutopilotOff, this.matchClearWaypoint,
      this.matchPhotoMode, this.matchJournal, this.matchRingCourse, this.matchBarrelRoll, this.matchBoost,
      this.matchHome, this.matchFind, this.matchFlyToWaypoint, this.matchSetWaypoint, this.matchHeading,
      this.matchAltitude, this.matchAutopilotOn, this.matchStatus, this.matchGreeting, this.matchTime,
      this.matchThanks,
    ];
  }

  pick(key, options) {
    return Copilot.pickVariant(this.phraseMemory, key, options);
  }

  async respond(flightState, transcript) {
    try {
      const reply = this.interpret(flightState && typeof flightState === 'object' ? flightState : {}, transcript);
      return { speech: Copilot.cleanText(reply.speech ?? '', Copilot.MAX_SPEECH_LENGTH), action: reply.action ?? null, source: 'local' };
    } catch (error) {
      console.error('[DRIFTWING] WREN local grammar failed', error);
      return { speech: 'Sorry, I lost my train of thought. Could you say that again?', action: null, source: 'local' };
    }
  }

  interpret(flight, transcript) {
    const text = Copilot.normalize(transcript);
    if (!text) return { speech: this.pick('empty', ["I'm listening.", "Go ahead, I'm here."]), action: null };
    const setting = Copilot.localSettingIntent(text);
    if (setting) return this.applySetting(setting);
    const core = Copilot.coreWords(text);
    for (const matcher of this.matchers) {
      const reply = matcher.call(this, text, flight, core);
      if (reply) return reply;
    }
    return {
      speech: this.pick('unknown', [
        "I didn't quite catch that. Try 'where am I' or 'find mountains'.",
        "Not sure I follow. You could say 'set waypoint', 'autopilot on' or 'make it dusk'.",
        "I missed that one. Try 'find the ocean', 'ring course' or 'what can you do'.",
        "Sorry, I didn't get that. Say 'help' and I'll list what I can do.",
      ]),
      action: null,
    };
  }

  applySetting(setting) {
    const settings = this.ctx.settings;
    switch (setting) {
      case 'voiceOff':
        settings.set('copilotVoice', false);
        return { speech: this.pick('voiceOff', ["Voice off. I'll keep to subtitles.", 'Going quiet on the speaker. Subtitles only.']), action: null };
      case 'voiceOn':
        settings.set('copilotVoice', true);
        return { speech: this.pick('voiceOn', ['Voice on. Good to talk properly.', "Voice is back on. I'm here."]), action: null };
      case 'chatterOn':
        settings.set('copilotChatter', true);
        return { speech: this.pick('chatterOn', ["Happy to keep you company. I'll point things out now and then.", "Glad to. I'll mention anything lovely I see."]), action: null };
      default:
        settings.set('copilotChatter', false);
        return { speech: this.pick('chatterOff', ["Understood. I'll only speak when you ask.", "Got it. I'll stay quiet unless you need me."]), action: null };
    }
  }

  matchCancelCourse(text) {
    if (!/\b(cancel|stop|end|quit|abort|abandon|finish|forget|clear|drop|scrap)\b.*\b(course|rings?|race|run|hoops|gates)\b/.test(text) && !/\bno more rings\b/.test(text)) return null;
    return { speech: this.pick('cancelCourse', ['Course cancelled. Back to cruising.', 'Rings cleared. Just us and the sky again.', 'Calling the course off.']), action: { type: 'cancelRingCourse' } };
  }

  matchAutopilotOff(text) {
    const off = /\bauto[ -]?pilot\b.*\b(off|disengage|disengaged|stop|disable|cancel|out)\b/.test(text)
      || /\b(disengage|disable|stop|turn off|kill|cancel|switch off)\b.*\bauto[ -]?pilot\b/.test(text)
      || /\b(i have (the )?(control|controls|stick)|my (controls|airplane|plane)|manual (control|flight|mode)|let me fly|i'll fly|i will fly)\b/.test(text);
    if (!off) return null;
    return { speech: this.pick('autopilotOff', ['Autopilot off. You have control.', "Autopilot's off. She's all yours.", 'Handing the controls back to you.']), action: { type: 'autopilot', enabled: false } };
  }

  matchClearWaypoint(text) {
    if (!/\b(clear|remove|delete|cancel|drop|forget|lose|hide|turn off)\b.*\b(waypoint|marker|beacon|pin)\b/.test(text) && !/\bno (more )?waypoints?\b/.test(text)) return null;
    return { speech: this.pick('clearWaypoint', ['Waypoint cleared.', 'Beacon off.', 'Marker removed.']), action: { type: 'clearWaypoint' } };
  }

  matchPhotoMode(text) {
    if (/\b(exit|leave|close|stop|end|quit)\b.*\bphoto\b/.test(text)) {
      return { speech: this.pick('photoOff', ['Back to flying.', 'Photo mode off. Where to next?']), action: { type: 'photoMode', enabled: false } };
    }
    if (!/\b(photo( mode)?|camera mode|take a (photo|picture|shot|screenshot)|screenshot|snapshot|pictures?)\b/.test(text)) return null;
    return { speech: this.pick('photoOn', ["Photo mode. Take your time, I'll hold everything still.", 'Framing mode. The world will wait for you.', 'Photo mode on. Find your shot.']), action: { type: 'photoMode', enabled: true } };
  }

  matchJournal(text) {
    if (!/\b(journal|logbook|log book|discoveries|what have (we|i) (found|seen|discovered)|my progress|how many landmarks|our progress)\b/.test(text)) return null;
    return { speech: '', action: { type: 'journal' } };
  }

  matchRingCourse(text) {
    if (/\b(of course|(fly|follow) the (course|rings))\b/.test(text)) return null;
    if (!/\b(ring course|rings|ring race|race|time trial|hoops|obstacle course|course|slalom|gates)\b/.test(text)) return null;
    const action = { type: 'ringCourse' };
    const countMatch = text.match(Copilot.RING_COUNT_PATTERN);
    const count = countMatch ? Copilot.parseQuantity(countMatch[1]) : Number.NaN;
    if (Number.isFinite(count) && count >= 1) action.count = clamp(Math.round(count), Copilot.MIN_RINGS, Copilot.MAX_RINGS);
    else if (/\b(long|big|epic)\b/.test(text)) action.count = 16;
    else if (/\b(short|quick|small)\b/.test(text)) action.count = 6;
    return { speech: this.pick('ringCourse', ["Here's a course for you.", 'Rings are out.', 'Course is up. Nice and smooth.']), action };
  }

  matchBarrelRoll(text) {
    if (!/\b(barrel ?roll|aileron roll|do a roll|roll (it|over|left|right)|do a flip|flip|loop|trick|spin)\b/.test(text)) return null;
    const direction = /\bleft\b/.test(text) ? 'left' : /\bright\b/.test(text) ? 'right' : null;
    const action = { type: 'barrelRoll' };
    if (direction) action.direction = direction;
    const speech = direction
      ? this.pick(`roll-${direction}`, [`Rolling ${direction}. Hold on.`, `Here we go, ${direction} roll.`])
      : this.pick('roll', ['Hold on.', 'Here we go.', 'One barrel roll, coming up.']);
    return { speech, action };
  }

  matchBoost(text) {
    if (!/\b(boost|speed up|faster|go fast|punch it|afterburners?|full (speed|throttle)|hit it|gun it|turbo)\b/.test(text)) return null;
    return { speech: this.pick('boost', ['Boost!', 'Punching it.', 'Hang on, boosting.']), action: { type: 'boost' } };
  }

  matchHome(text) {
    if (!/\b(home|back to (the )?start|where we (started|began)|starting point|spawn point)\b/.test(text)) return null;
    const spawn = this.ctx.state?.spawn;
    if (!spawn) return null;
    const autopilot = /\b(take|fly|go|head|bring|return|back|get)\b/.test(text);
    return {
      speech: autopilot ? this.pick('home', ['Taking us home.', 'Heading back to where we started.']) : '',
      action: { type: 'waypoint', x: spawn.x, z: spawn.z, label: 'Home', autopilot },
    };
  }

  matchFind(text, flight, core) {
    const target = Copilot.findTarget(text);
    const searchVerb = /\b(find|locate|search|look for|seek|where's|where is|where are|show me|nearest|closest|any)\b/.test(text);
    const travelVerb = /\b(take (me|us)|fly (me |us )?(to|toward|towards|over|there)|head (to|for|toward|towards|over|there)|go (to|toward|towards|over|there)|navigate|bring (me|us)|steer (to|toward|towards)|visit|explore|get us|and (go|fly|head|take)|autopilot)\b/.test(text);
    if (!target) {
      if (/\b(find|locate|search for|look for)\b/.test(text) && !/\bwaypoint|marker|beacon\b/.test(text)) {
        return { speech: 'What should I look for? Mountains, ocean, desert, forest, meadows, islands, or a landmark.', action: null };
      }
      return null;
    }
    if (!searchVerb && !travelVerb && core.length > 2) return null;
    return {
      speech: this.pick('find', ['', 'Let me look.', 'On it.', 'One moment.']),
      action: { type: 'find', target, autopilot: travelVerb },
    };
  }

  matchFlyToWaypoint(text, flight) {
    const pattern = /\b(take (us|me) there|fly (us |me )?there|go there|head there|let's go|fly to (the )?(waypoint|marker|beacon)|follow (the )?(waypoint|marker|beacon)|head (to|for) (the )?(waypoint|marker|beacon)|navigate to (the )?(waypoint|marker|beacon)|take (us|me) to (the )?(waypoint|marker|beacon)|fly the course|follow the (rings|course))\b/;
    if (!pattern.test(text)) return null;
    if (!flight.waypoint && !flight.ringCourse?.active) {
      return { speech: "There's no waypoint yet. Say 'set waypoint' or 'find the mountains' first.", action: null };
    }
    const destination = flight.ringCourse?.active ? 'the next ring' : Copilot.waypointName(flight.waypoint?.label);
    return {
      speech: this.pick('followWaypoint', [`Autopilot on. Heading for ${destination}.`, `On our way to ${destination}. Sit back.`, `I'll fly us to ${destination}.`]),
      action: { type: 'autopilot', enabled: true, followWaypoint: true },
    };
  }

  matchSetWaypoint(text, flight) {
    const setPattern = /\b(set|drop|place|put|mark|add|make|create|plant|leave)\b.*\b(waypoint|marker|beacon|pin)\b/;
    const markPattern = /\bmark (this|here|it|the spot|that|this spot|this place|our position)\b/;
    const barePattern = /^(a )?(new )?waypoint\b/;
    if (!setPattern.test(text) && !markPattern.test(text) && !barePattern.test(text)) return null;
    const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
    const action = { type: 'waypoint' };
    const distance = Copilot.parseDistance(text);
    const cardinal = Copilot.parseCardinal(text);
    const here = /\b(here|this spot|this place|right here|current (position|location)|our position|below us|mark this|mark it)\b/.test(text);
    if (here && distance === null && cardinal === null) {
      const position = flight.position ?? this.ctx.state?.player?.position;
      if (position && Number.isFinite(position.x) && Number.isFinite(position.z)) {
        action.x = position.x;
        action.z = position.z;
        action.label = 'Marked spot';
      }
    } else {
      const relative = Copilot.parseRelativeBearing(text, heading);
      action.bearing = cardinal ?? relative ?? heading;
      action.distance = clamp(distance ?? 1500, 100, 40000);
    }
    if (/\b(and (fly|go|head|take)|fly (us )?there|take us)\b/.test(text)) action.autopilot = true;
    return { speech: '', action };
  }

  matchHeading(text, flight) {
    const heading = Number.isFinite(flight.heading) ? flight.heading : 0;
    const verb = /\b(head|turn|fly|go|steer|bear|point|bank|veer|come|swing)\b/.test(text);
    let target = null;
    let phrase = '';
    if (/\b(turn (around|back)|u-?turn|about face|reverse course)\b/.test(text)) {
      target = wrapDegrees(heading + 180);
      phrase = 'Turning around';
    } else if (/\b(into|toward|towards|at) the (sun|sunset|sunrise)\b/.test(text)) {
      const sun = this.ctx.state?.time?.sunDirection;
      if (sun) {
        target = headingFromVector(sun.x, sun.z);
        phrase = 'Turning into the sun';
      }
    } else if (verb) {
      const degreeMatch = text.match(/\b(?:heading|bearing|course|turn to|head|fly|steer|come to|come)\s*(?:to|onto|on)?\s*(\d{1,3})\b(?!\s*(?:k|km|kms|m|metres?|meters?|kilomet(?:er|re)s?|miles?|clicks?)\b)/)
        || text.match(/\b(\d{1,3})\s*(?:degrees|deg)\b/);
      const cardinal = Copilot.parseCardinal(text);
      if (degreeMatch && Number(degreeMatch[1]) <= 360) {
        target = wrapDegrees(Number(degreeMatch[1]));
      } else if (cardinal !== null) {
        target = cardinal;
      } else if (/\b(left|right)\b/.test(text) && /\b(turn|bank|veer|steer|go|head|swing)\b/.test(text)) {
        const amount = /\b(slightly|a little|a bit|gently|a touch)\b/.test(text) ? 30 : 90;
        target = wrapDegrees(heading + (/\bleft\b/.test(text) ? -amount : amount));
      }
    }
    if (target === null) return null;
    const rounded = Math.round(target) % 360;
    const lead = phrase || this.pick('turnLead', ['Turning', 'Coming around', 'Bringing us']);
    return {
      speech: `${lead} to ${rounded} degrees, ${compassName(target)}.`,
      action: { type: 'autopilot', enabled: true, heading: target, followWaypoint: false },
    };
  }

  matchAltitude(text, flight) {
    const climb = /\b(climb|go up|higher|gain (some )?altitude|ascend|pull up|more altitude|get (some )?height|fly high)\b/.test(text);
    const descend = /\b(descend|go down|lower|drop down|lose (some )?altitude|dive|get low|fly low|come down|down low|fly lower)\b/.test(text);
    const hold = /\b(level off|hold (this )?altitude|maintain altitude|stay at this (height|altitude)|keep this altitude)\b/.test(text);
    if (!climb && !descend && !hold) return null;
    const altitude = Number.isFinite(flight.altitude) ? flight.altitude : 400;
    const groundBelow = altitude - (Number.isFinite(flight.altitudeAboveGround) ? flight.altitudeAboveGround : altitude);
    let target = altitude;
    const absolute = text.match(/\bto (\d{2,4})\b/);
    const amount = Copilot.parseDistance(text);
    if (absolute) target = Number(absolute[1]);
    else if (climb) target = altitude + (amount ?? 200);
    else if (descend) target = altitude - (amount ?? 200);
    target = clamp(Math.round(target), Math.max(60, groundBelow + 80), CONFIG.MAX_ALTITUDE - 100);
    const following = Boolean(flight.autopilot?.enabled && flight.autopilot?.followWaypoint && (flight.waypoint || flight.ringCourse?.active));
    const action = { type: 'autopilot', enabled: true, altitude: target, followWaypoint: following };
    if (!following && Number.isFinite(flight.heading)) action.heading = flight.heading;
    let speech;
    if (hold) speech = this.pick('hold', [`Levelling off at ${target} metres.`, `Holding ${target} metres.`]);
    else if (target > altitude + 5) speech = this.pick('climb', [`Climbing to ${target} metres.`, `Taking us up to ${target} metres.`]);
    else if (target < altitude - 5) speech = this.pick('descend', [`Descending to ${target} metres.`, `Easing down to ${target} metres.`]);
    else speech = `That's as low as I'll take us here: ${target} metres.`;
    return { speech, action };
  }

  matchAutopilotOn(text, flight) {
    if (!/\b(auto[ -]?pilot|take (the )?(controls|wheel|stick|over)|you (fly|have (the )?controls|drive|take it)|fly for me|cruise( control)?|hands off)\b/.test(text)) return null;
    const hasTarget = Boolean(flight.waypoint || flight.ringCourse?.active);
    const action = { type: 'autopilot', enabled: true, followWaypoint: hasTarget };
    if (!hasTarget && Number.isFinite(flight.heading)) {
      action.heading = flight.heading;
      if (Number.isFinite(flight.altitude)) action.altitude = Math.round(flight.altitude);
    }
    const rings = Boolean(flight.ringCourse?.active);
    const speech = hasTarget
      ? this.pick(rings ? 'autopilotRings' : 'autopilotFollow', rings
        ? ["Autopilot on. I'll thread us through the rings.", 'I have the controls. Next ring coming up.']
        : ['Autopilot on. Heading for the marker.', "I have the controls. We're on our way."])
      : this.pick('autopilotHold', [
        `Autopilot engaged, holding ${Math.round(flight.heading ?? 0)} degrees. Sit back and enjoy the view.`,
        "I have the controls. Relax, I'll keep us steady.",
        'Autopilot on. Holding our course.',
      ]);
    return { speech, action };
  }

  matchStatus(text, flight) {
    const overWater = typeof flight.overWater === 'boolean' ? flight.overWater : (this.ctx.state?.player?.groundHeight ?? 1) < CONFIG.WATER_LEVEL;
    if (/\b(where am i|where are we|status|report|position|location|describe|look around|what do you see|surroundings|sitrep|where is this|what biome|what (place|region|area) is this|what's (around|below|down there|nearby)|what is (around|below|down there|nearby)|anything (nearby|around|interesting))\b/.test(text)) {
      return { speech: '', action: { type: 'describe' } };
    }
    if (/\b(how high|altitude|elevation|how far (up|above)|height)\b/.test(text)) {
      const altitude = Math.round(flight.altitude ?? 0);
      const agl = Math.round(flight.altitudeAboveGround ?? 0);
      return { speech: `We're at ${altitude} metres, ${agl} above the ${overWater ? 'water' : 'ground'}.`, action: null };
    }
    if (/\b(how fast|speed|air ?speed|ground ?speed|velocity|throttle|mach|knots)\b/.test(text)) {
      return { speech: describeAirspeed(flight), action: null };
    }
    if (/\b(what time|time is it|the time|clock|what hour)\b/.test(text)) {
      const clock = Copilot.clockFromDayTime(flight.dayTime);
      return { speech: `It's ${clock}${flight.timeLabel ? `, ${flight.timeLabel}` : ''}.`, action: null };
    }
    if (/\b(which way|our heading|my heading|the heading|what heading|direction are we|where are we (going|headed|heading))\b/.test(text)) {
      return { speech: `Heading ${Math.round(flight.heading ?? 0)} degrees, ${flight.headingName ?? 'onward'}.`, action: null };
    }
    return null;
  }

  matchGreeting(text, flight, core) {
    if (/\b(how are you|how's it going|how is it going|how are things)\b/.test(text)) {
      return { speech: this.pick('howAreYou', ["Calm and content. The air's smooth today.", 'Happy to be up here with you.', 'All systems gentle. Thanks for asking.']), action: null };
    }
    if (!/^(hi|hello|hey|hiya|howdy|greetings|yo|good (morning|afternoon|evening|day|night))\b/.test(text) || core.length > 3) return null;
    return {
      speech: this.pick('greeting', ['Hello. Lovely air up here today.', 'Hi there. Smooth flying so far.', 'Hello, pilot. Where shall we go?', "Hey. The view's worth it today."]),
      action: null,
    };
  }

  matchTime(text, flight, core) {
    let preset = null;
    for (const [name, pattern] of Copilot.TIME_WORDS) {
      if (pattern.test(text)) {
        preset = name;
        break;
      }
    }
    if (!preset) return null;
    const timeVerb = /\b(make|set|switch|change|skip|jump|go|take|bring|turn|fast ?forward|forward|advance|wind|roll|move|have|give|want|show|let it be)\b/.test(text);
    const onlyTimeWords = core.every((word) => Copilot.TIME_FILLER_WORDS.has(word) || Copilot.TIME_WORDS.some(([, pattern]) => pattern.test(word)));
    if (!timeVerb && !onlyTimeWords) return null;
    const lines = {
      dawn: ['Dawn it is. Watch the east.', 'Rolling the clock to first light.'],
      sunrise: ['Sunrise coming up.', "Let's watch the sun come up."],
      morning: ['Good morning, then.', 'Bright morning light, coming right up.'],
      noon: ['Midday it is. Clear and bright.', 'Full daylight, coming up.'],
      golden: ["Golden hour. My favourite.", 'Warm light, long shadows. Golden hour it is.'],
      sunset: ["Let's catch the sunset.", 'Sunset it is.'],
      dusk: ['Dusk. Everything goes soft and blue.', 'Blue hour, coming up.'],
      night: ['Bringing on the night.', "Night it is. Let's see the stars.", 'Lights out. Stars on.'],
      midnight: ['Midnight. Just us and the stars.', 'Deep night it is.'],
    };
    return { speech: this.pick(`time-${preset}`, lines[preset]), action: { type: 'time', preset } };
  }

  matchThanks(text) {
    if (!/\b(thanks|thank you|thank u|cheers|much appreciated|appreciate it|nice one|good job|great job|well done|awesome|nice work)\b/.test(text)) return null;
    return { speech: this.pick('thanks', ['Any time.', 'My pleasure.', 'Happy to help.', 'Of course. Enjoy the view.']), action: null };
  }
}

export class RemoteCopilot extends Copilot {
  static FAILURES_BEFORE_PAUSE = 3;
  static PAUSE_MS = 20000;

  static validEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint ?? ''));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  }

  constructor(ctx, endpoint, timeoutMs = CONFIG.REMOTE_COPILOT_TIMEOUT_MS) {
    super(ctx);
    this.name = 'remote';
    this.endpoint = RemoteCopilot.validEndpoint(endpoint);
    this.timeoutMs = clamp(Number(timeoutMs) || CONFIG.REMOTE_COPILOT_TIMEOUT_MS, 100, 10000);
    this.lastError = this.endpoint ? null : 'invalid endpoint';
    this.consecutiveFailures = 0;
    this.pausedUntil = 0;
  }

  async respond(flightState, transcript) {
    const text = Copilot.normalize(transcript);
    if (Copilot.localSettingIntent(text)) return super.respond(flightState, transcript);
    if (!this.endpoint) return this.fallback(flightState, transcript, 'invalid endpoint');
    if (performance.now() < this.pausedUntil) return this.fallback(flightState, transcript, this.lastError || 'unreachable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flightState, transcript: Copilot.cleanText(String(transcript ?? ''), 300) }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const reply = Copilot.sanitizeReply(payload);
      if (!reply) throw new Error('invalid reply shape');
      this.lastError = null;
      this.consecutiveFailures = 0;
      return { ...reply, source: 'remote' };
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : error instanceof SyntaxError ? 'bad JSON' : String(error?.message || 'network error');
      this.noteFailure();
      return this.fallback(flightState, transcript, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  /** After a few failures in a row, answer locally for a while instead of waiting on a dead endpoint. */
  noteFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < RemoteCopilot.FAILURES_BEFORE_PAUSE) return;
    this.consecutiveFailures = 0;
    this.pausedUntil = performance.now() + RemoteCopilot.PAUSE_MS;
  }

  async fallback(flightState, transcript, reason) {
    this.lastError = reason;
    const local = await super.respond(flightState, transcript);
    return { ...local, source: 'local-fallback', fallbackReason: reason };
  }
}

export function createCopilotSystem(ctx) {
  const { state, bus, settings, world } = ctx;
  const MIN_CHATTER_GAP = 30;
  const QUIET_AFTER_ANY_LINE = 10;
  const PENDING_CHATTER_TTL = 40;
  const ERROR_DISPLAY_SECONDS = 3;
  const LANDMARK_SEARCH_RADIUS = 12000;
  const BIOME_SEARCH_RADIUS = 24000;

  const phraseMemory = new Map();
  const pick = (key, options) => Copilot.pickVariant(phraseMemory, key, options);
  const scratchDirection = new ctx.THREE.Vector3();

  // ---- Brain -------------------------------------------------------------------------------------------
  function createBrain() {
    return settings.get('remoteCopilot') ? new RemoteCopilot(ctx, settings.get('remoteEndpoint')) : new Copilot(ctx);
  }
  let brain = createBrain();
  let remoteFailureNotified = false;

  // ---- Speech out ----------------------------------------------------------------------------------------
  const voiceOutput = (() => {
    const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    const UtteranceClass = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined;
    let chosenVoice = null;
    let lastError = null;

    function scoreVoice(voice) {
      const lang = String(voice.lang || '').toLowerCase();
      if (!lang.startsWith('en')) return -1;
      const name = String(voice.name || '').toLowerCase();
      let score = 0;
      if (/natural|neural/.test(name)) score += 6;
      if (/google/.test(name)) score += 3;
      if (/online/.test(name)) score += 1;
      if (/(aria|jenny|sonia|libby|ava|emma|samantha|serena|karen|moira|tessa|zira|hazel|female)/.test(name)) score += 2;
      if (lang === 'en-gb' || lang === 'en-us' || lang === 'en_gb' || lang === 'en_us') score += 1;
      if (voice.localService) score += 0.5;
      return score;
    }

    function chooseVoice() {
      if (!synth) return;
      let best = null;
      let bestScore = -1;
      for (const voice of synth.getVoices()) {
        const score = scoreVoice(voice);
        if (score > bestScore) {
          best = voice;
          bestScore = score;
        }
      }
      chosenVoice = best;
    }

    if (synth) {
      chooseVoice();
      synth.addEventListener?.('voiceschanged', chooseVoice);
    }

    function cancel() {
      if (synth && (synth.speaking || synth.pending)) synth.cancel();
    }

    function speak(text) {
      if (!synth || typeof UtteranceClass !== 'function' || !text) return false;
      if (!ctx.userHasInteracted || !settings.get('copilotVoice')) return false;
      const volume = clamp(Number(settings.get('masterVolume')) || 0, 0, 1);
      if (volume < 0.01) return false;
      try {
        cancel();
        if (!chosenVoice) chooseVoice();
        const utterance = new UtteranceClass(text);
        if (chosenVoice) {
          utterance.voice = chosenVoice;
          utterance.lang = chosenVoice.lang;
        } else {
          utterance.lang = 'en-US';
        }
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = clamp(0.35 + volume * 0.75, 0, 1);
        utterance.onerror = (event) => {
          const reason = event?.error || 'unknown';
          if (reason !== 'interrupted' && reason !== 'canceled') lastError = reason;
        };
        synth.speak(utterance);
        return true;
      } catch (error) {
        lastError = error?.message || 'speech synthesis failed';
        return false;
      }
    }

    return {
      speak,
      cancel,
      getVoiceName: () => chosenVoice?.name ?? null,
      getLastError: () => lastError,
    };
  })();

  let lastLineAt = -Infinity;
  function say(text, source) {
    const line = Copilot.cleanText(String(text ?? ''), Copilot.MAX_SPEECH_LENGTH);
    if (!line) return '';
    lastLineAt = state.time.realElapsed;
    bus.emit('copilot:speech', { text: line, source });
    voiceOutput.speak(line);
    return line;
  }

  // ---- Input hints -----------------------------------------------------------------------------------------
  /** How to open the command bar on this device: the C key, or the chat button on touch screens. */
  function commandHint() {
    const touch = window.matchMedia?.('(pointer: coarse)').matches || new URLSearchParams(window.location.search).get('touch') === '1';
    return touch ? 'Tap the chat button' : 'Press C';
  }
  function typeInsteadLine(lead) {
    const hint = commandHint();
    const joined = /(^|\s)or$/.test(lead) ? hint.charAt(0).toLowerCase() + hint.slice(1) : hint;
    return `${lead} ${joined} to type to me instead.`;
  }

  // ---- Speech in ------------------------------------------------------------------------------------------
  const voiceInput = (() => {
    // Resolved when a session starts (not once at boot), so a recognizer the page gains later counts.
    const recognitionClass = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null);
    let recognition = null;
    let listening = false;
    let finalTranscript = '';
    let errored = false;
    let errorTimer = 0;
    let lastError = null;
    // Hold-to-talk: the copilotPTT action holds the session open until it is released.
    let holding = false;
    let sessionIsHold = false;
    // Built on demand so the hint matches the device (key or chat button).
    const ERROR_LINES = {
      'not-allowed': () => typeInsteadLine("I can't use the microphone. Check the browser's permission, or"),
      'service-not-allowed': () => typeInsteadLine('Voice input is blocked here.'),
      'no-speech': () => (sessionIsHold
        ? `I didn't hear anything. Hold ${keyFor(ctx, 'copilotPTT', '`')} while you talk and try again.`
        : "I didn't hear anything. Tap the mic and try again."),
      'audio-capture': () => typeInsteadLine("I can't find a microphone."),
      network: () => typeInsteadLine('Voice recognition needs a network connection.'),
      'language-not-supported': () => typeInsteadLine("Voice input isn't available in this language."),
      'bad-grammar': () => "I couldn't make sense of that. Try again?",
    };
    const unsupportedLine = () => typeInsteadLine("Voice input isn't available in this browser.");

    function setState(nextState, message) {
      bus.emit('copilot:listening', message ? { state: nextState, message } : { state: nextState });
    }

    function reportError(code) {
      errored = true;
      lastError = code;
      const message = ERROR_LINES[code] ? ERROR_LINES[code]() : typeInsteadLine('Voice input hit a snag.');
      setState('error', message);
      say(message, 'system');
      errorTimer = ERROR_DISPLAY_SECONDS;
    }

    function handleResult(event) {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? '';
        if (result.isFinal) finalTranscript += `${transcript} `;
        else interim += transcript;
      }
      const text = `${finalTranscript}${interim}`.replace(/\s+/g, ' ').trim();
      if (text) bus.emit('copilot:transcript', { text, final: interim === '' });
    }

    function handleEnd() {
      listening = false;
      recognition = null;
      holding = false;
      const heard = finalTranscript.trim();
      finalTranscript = '';
      if (heard) {
        setState('thinking');
        ask(heard, 'voice');
      } else if (!errored) {
        setState('idle');
      }
    }

    /** Starts a session; hold keeps it open (continuous) until holdEnd() stops it. */
    function start(hold = false) {
      const RecognitionClass = recognitionClass();
      if (!RecognitionClass) {
        setState('unsupported', unsupportedLine());
        say(unsupportedLine(), 'system');
        return false;
      }
      if (listening) return true;
      voiceOutput.cancel();
      finalTranscript = '';
      errored = false;
      sessionIsHold = hold;
      try {
        const session = new RecognitionClass();
        session.lang = /^en\b/i.test(navigator.language || '') ? navigator.language : 'en-US';
        session.interimResults = true;
        session.continuous = hold;
        session.maxAlternatives = 1;
        session.onstart = () => setState('listening');
        session.onresult = handleResult;
        session.onerror = (event) => {
          const code = event?.error || 'unknown';
          if (code === 'aborted') {
            errored = true;
            setState('idle');
            return;
          }
          reportError(code);
        };
        session.onend = handleEnd;
        recognition = session;
        listening = true;
        session.start();
        return true;
      } catch (error) {
        listening = false;
        recognition = null;
        holding = false;
        reportError(error?.name === 'NotAllowedError' ? 'not-allowed' : 'unknown');
        return false;
      }
    }

    /** stop() lets the browser deliver the final result; abort() discards it. Both throw if the session already ended. */
    function endSession(method) {
      if (!recognition) return;
      try {
        recognition[method]();
      } catch (error) {
        lastError = error?.name || 'InvalidStateError';
        listening = false;
        recognition = null;
        setState('idle');
      }
    }

    return {
      get supported() {
        return Boolean(recognitionClass());
      },
      toggle() {
        if (listening) {
          holding = false;
          endSession('stop');
          return false;
        }
        return start(false);
      },
      /** Push-to-talk pressed: listen until release (a session the mic toggle opened is adopted). */
      holdStart() {
        if (holding) return listening;
        holding = true;
        if (listening) return true;
        const started = start(true);
        if (!started) holding = false;
        return started;
      },
      /** Push-to-talk released: stop listening and answer what was heard. */
      holdEnd() {
        if (!holding) return false;
        holding = false;
        if (listening) endSession('stop');
        return true;
      },
      isHolding: () => holding,
      abort: () => {
        holding = false;
        endSession('abort');
      },
      isListening: () => listening,
      getLastError: () => lastError,
      update(realDt) {
        if (errorTimer <= 0) return;
        errorTimer -= realDt;
        if (errorTimer <= 0 && !listening) setState('idle');
      },
      announceSupport() {
        if (!recognitionClass()) setState('unsupported', unsupportedLine());
      },
    };
  })();

  // ---- Action executor ------------------------------------------------------------------------------------
  const FIND_SPECS = {
    mountains: { kind: 'biome', key: 'mountains', phrase: 'the mountains', label: 'Mountains' },
    snow: { kind: 'snow', key: 'snow', phrase: 'snowy peaks', label: 'Snowy peaks' },
    ocean: { kind: 'biome', key: 'ocean', phrase: 'open ocean', label: 'Open ocean' },
    archipelago: { kind: 'biome', key: 'archipelago', phrase: 'the islands', label: 'Archipelago' },
    islands: { kind: 'biome', key: 'archipelago', phrase: 'the islands', label: 'Archipelago' },
    desert: { kind: 'biome', key: 'dunes', phrase: 'the Dune Sea', label: 'Dune Sea' },
    dunes: { kind: 'biome', key: 'dunes', phrase: 'the Dune Sea', label: 'Dune Sea' },
    forest: { kind: 'biome', key: 'pine', phrase: 'pine forest', label: 'Pine Valleys' },
    pine: { kind: 'biome', key: 'pine', phrase: 'pine forest', label: 'Pine Valleys' },
    meadows: { kind: 'biome', key: 'meadows', phrase: 'the flower meadows', label: 'Flower Meadows' },
    flowers: { kind: 'biome', key: 'meadows', phrase: 'the flower meadows', label: 'Flower Meadows' },
    landmark: { kind: 'landmark', type: null, phrase: 'a landmark' },
    arch: { kind: 'landmark', type: 'arch', phrase: 'a stone arch' },
    monoliths: { kind: 'landmark', type: 'monoliths', phrase: 'a stone circle' },
    lighthouse: { kind: 'landmark', type: 'lighthouse', phrase: 'a lighthouse' },
    balloons: { kind: 'landmark', type: 'balloons', phrase: 'the hot-air balloons' },
  };
  const LANDMARK_FALLBACK_NAMES = { arch: 'Stone arch', monoliths: 'Standing stones', lighthouse: 'Lighthouse', balloons: 'Hot-air balloons' };

  const succeed = (text, informative = false) => ({ ok: true, text, informative });
  const fail = (text) => ({ ok: false, text, informative: false });

  /** Where we are, as it actually looks from the cockpit (see Copilot.describePlace). */
  function currentPlace() {
    const player = state.player;
    return Copilot.describePlace(world, player.position.x, player.position.z, player.groundHeight, player.heading);
  }

  // The camera's last reported view (typed 'viewChanged'); serial counts the changes.
  let currentView = null;
  let viewSerial = 0;
  bus.onTyped('viewChanged', (payload) => {
    if (!payload || typeof payload.view !== 'string') return;
    viewSerial++;
    currentView = { view: payload.view, serial: viewSerial };
  });

  let flightFieldsFailed = false;
  /** The core snapshot plus the visually honest place phrase and the v2 flight fields, for both brains. */
  function flightSnapshot() {
    const snapshot = ctx.getFlightState ? ctx.getFlightState() : {};
    const place = currentPlace();
    snapshot.place = place.phrase;
    snapshot.overWater = place.overWater;
    try {
      Object.assign(snapshot, buildFlightFields(ctx, { view: currentView ? currentView.view : null, landingCount: flightChatter.landingCount }));
    } catch (error) {
      if (!flightFieldsFailed) {
        flightFieldsFailed = true;
        console.error('[DRIFTWING] WREN could not read the v2 flight state', error);
      }
    }
    return snapshot;
  }

  const snowClimate = { temperature: 0, moisture: 0 };
  const snowWeights = new Float64Array(5);

  /** Nearest ground that is actually drawn snow-white: above the local snow line in snow or pine country. */
  function findSnowyGround(originX, originZ, maxRadius) {
    for (let radius = 300; radius <= maxRadius; radius += 300) {
      const samples = Math.max(12, Math.ceil((2 * Math.PI * radius) / 300));
      for (let sample = 0; sample < samples; sample++) {
        const angle = (sample / samples) * Math.PI * 2;
        const x = originX + Math.sin(angle) * radius;
        const z = originZ - Math.cos(angle) * radius;
        world.climate(x, z, snowClimate);
        world.biomeWeights(snowClimate.temperature, snowClimate.moisture, snowWeights);
        if (snowWeights[0] + snowWeights[1] < 0.6) continue;
        if (world.heightAt(x, z) > Copilot.snowLineFor(snowClimate.temperature) + 25) return { x, z, distance: radius };
      }
    }
    return null;
  }

  function describeTarget(x, z) {
    const player = state.player;
    const distance = Math.hypot(x - player.position.x, z - player.position.z);
    const bearing = bearingTo(player.position.x, player.position.z, x, z);
    return { distance, bearing, phrase: `${Copilot.formatDistance(distance)} ${Copilot.directionPhrase(bearing, player.heading)}` };
  }

  function engageFollow() {
    const flight = ctx.systems.flight;
    if (!flight?.setAutopilot) return false;
    const player = state.player;
    flight.setAutopilot({
      enabled: true,
      followWaypoint: true,
      heading: player.heading,
      altitude: Math.round(Math.max(player.altitude, Math.max(player.groundHeight, CONFIG.WATER_LEVEL) + 150)),
    });
    return true;
  }

  /** After a followed target goes away, keep cruising straight instead of chasing a stale heading. */
  function holdCourseIfFollowing() {
    const autopilot = state.player.autopilot;
    if (!autopilot.enabled || !autopilot.followWaypoint || state.ringCourse.active) return;
    ctx.systems.flight?.setAutopilot?.({ enabled: true, followWaypoint: false, heading: state.player.heading, altitude: autopilot.altitude });
  }

  function placeWaypoint(x, z, label) {
    const waypoints = ctx.systems.waypoints;
    if (!waypoints?.set) return null;
    return waypoints.set({ x, z }, label);
  }

  function findLandmark(type) {
    const player = state.player.position;
    const landmarks = ctx.systems.landmarks;
    const nearby = landmarks?.getNearby?.(LANDMARK_SEARCH_RADIUS);
    if (Array.isArray(nearby) && nearby.length) {
      const matching = nearby.filter((site) => (!type || site.type === type) && Number.isFinite(site.x) && Number.isFinite(site.z) && site.distance > 300);
      const choice = matching.find((site) => !site.discovered) ?? matching[0];
      if (choice) return { x: choice.x, z: choice.z, name: choice.name || LANDMARK_FALLBACK_NAMES[choice.type] || 'Landmark', discovered: Boolean(choice.discovered) };
    }
    const nearest = landmarks?.findNearest?.(type ?? undefined);
    if (nearest && Number.isFinite(nearest.x) && Number.isFinite(nearest.z)) {
      return { x: nearest.x, z: nearest.z, name: nearest.name || LANDMARK_FALLBACK_NAMES[nearest.type] || 'Landmark', discovered: Boolean(nearest.discovered) };
    }
    let best = null;
    for (const site of world.landmarkSitesNear(player.x, player.z, LANDMARK_SEARCH_RADIUS)) {
      if (type && site.type !== type) continue;
      const distance = Math.hypot(site.x - player.x, site.z - player.z);
      if (distance < 300) continue;
      if (!best || distance < best.distance) best = { site, distance };
    }
    return best ? { x: best.site.x, z: best.site.z, name: LANDMARK_FALLBACK_NAMES[best.site.type], discovered: false } : null;
  }

  const handlers = {
    waypoint(action) {
      const player = state.player;
      let x = action.x;
      let z = action.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        const direction = vectorFromHeading(action.bearing ?? player.heading, scratchDirection);
        const distance = action.distance ?? 1500;
        x = player.position.x + direction.x * distance;
        z = player.position.z + direction.z * distance;
      }
      const placed = placeWaypoint(x, z, action.label || 'Waypoint');
      if (!placed) return fail("I couldn't place a waypoint there.");
      const target = describeTarget(x, z);
      let text;
      if (target.distance >= 200) text = placed.label === 'Waypoint' ? `Waypoint set, ${target.phrase}.` : `${placed.label} is ${target.phrase}.`;
      else if (placed.label === 'Waypoint' || placed.label === 'Marked spot') text = pick('waypointHere', ["Marked. I'll keep the beacon lit here.", 'Spot marked. The beacon will be waiting.']);
      else text = `${placed.label} is right below us.`;
      if (action.autopilot && engageFollow()) text += ' Autopilot engaged.';
      return succeed(text, true);
    },
    clearWaypoint() {
      if (!state.waypoint) return fail("There's no waypoint to clear.");
      ctx.systems.waypoints?.clear?.();
      holdCourseIfFollowing();
      return succeed('Waypoint cleared.');
    },
    autopilot(action) {
      const flight = ctx.systems.flight;
      if (!flight?.setAutopilot) return fail("The autopilot isn't responding right now.");
      const player = state.player;
      if (!action.enabled) {
        if (!player.autopilot.enabled) return succeed("Autopilot's already off. You have control.");
        flight.setAutopilot({ enabled: false });
        return succeed('Autopilot off. You have control.');
      }
      const hasTarget = Boolean(state.waypoint) || state.ringCourse.active;
      const follow = action.followWaypoint === true && hasTarget;
      const wasEnabled = player.autopilot.enabled;
      const options = { enabled: true, followWaypoint: follow };
      options.heading = action.heading ?? (wasEnabled && !player.autopilot.followWaypoint ? player.autopilot.heading : player.heading);
      options.altitude = Math.round(action.altitude ?? (wasEnabled ? player.autopilot.altitude : player.altitude));
      flight.setAutopilot(options);
      if (action.followWaypoint === true && !hasTarget) return succeed("There's nothing to follow yet, so I'll hold our course.");
      if (follow) {
        const destination = state.ringCourse.active ? 'the next ring' : Copilot.waypointName(state.waypoint.label);
        return succeed(`Autopilot on, heading for ${destination}.`);
      }
      return succeed(`Autopilot on, holding ${Math.round(options.heading)} degrees at ${options.altitude} metres.`);
    },
    time(action) {
      const sky = ctx.systems.sky;
      let changed = false;
      if (action.preset) {
        if (sky?.setPreset) changed = sky.setPreset(action.preset) !== false;
        else if (sky?.setDayTime) changed = sky.setDayTime(Copilot.dayTimeForPreset(action.preset)) !== false;
      } else if (sky?.setDayTime) {
        changed = sky.setDayTime(action.dayTime) !== false;
      }
      if (!changed) return fail("I can't move the clock right now.");
      const label = action.preset === 'golden' ? 'golden hour' : action.preset;
      return succeed(label ? `Moving on to ${label}.` : `Moving the clock to ${Copilot.clockFromDayTime(action.dayTime)}.`);
    },
    ringCourse(action) {
      const rings = ctx.systems.rings;
      if (!rings?.start) return fail("I can't set up a course right now.");
      const total = rings.start({ count: action.count ?? 10 });
      if (!total) return fail("I couldn't find room for a course here. Let's try again in a moment.");
      const first = state.ringCourse.nextRingDistance;
      const firstText = Number.isFinite(first) && first > 0 ? ` The first is ${Copilot.formatDistance(first)} ahead.` : '';
      return succeed(`${total} rings.${firstText} Fly through the gold one.`, true);
    },
    cancelRingCourse() {
      const rings = ctx.systems.rings;
      if (!rings?.isActive?.()) return fail("There's no ring course running.");
      rings.cancel();
      return succeed('Course cancelled.');
    },
    barrelRoll(action) {
      const flight = ctx.systems.flight;
      if (!flight?.barrelRoll) return fail("I can't roll us right now.");
      const direction = action.direction ?? (Math.random() < 0.5 ? 'left' : 'right');
      const rolled = flight.barrelRoll(direction === 'left' ? -1 : 1);
      if (rolled === false) return fail("Let's finish this roll first.");
      return succeed(`Rolling ${direction}.`);
    },
    boost() {
      const flight = ctx.systems.flight;
      if (!flight?.boost) return fail('Boost is offline.');
      const fired = flight.boost();
      if (fired === false) {
        const remaining = Math.ceil(state.player.boost?.cooldown ?? 0);
        return fail(remaining > 0 ? `Boost is recharging. About ${remaining} seconds.` : 'Boost is recharging.');
      }
      return succeed('Boost!');
    },
    find(action) {
      const spec = FIND_SPECS[action.target];
      const player = state.player.position;
      let location = null;
      let label = spec.label;
      let discovered = true;
      if (spec.kind === 'biome') {
        location = world.findNearest(player.x, player.z, spec.key, BIOME_SEARCH_RADIUS);
      } else if (spec.kind === 'snow') {
        location = findSnowyGround(player.x, player.z, BIOME_SEARCH_RADIUS);
      } else {
        const landmark = findLandmark(spec.type);
        if (landmark) {
          location = landmark;
          label = landmark.name;
          discovered = landmark.discovered;
        }
      }
      if (!location) {
        return fail(pick('findNone', [
          `I couldn't find ${spec.phrase} within ${spec.kind === 'landmark' ? 12 : 24} km. Let's explore a little and try again.`,
          `Nothing like ${spec.phrase} nearby, I'm afraid. Maybe further on.`,
        ]));
      }
      const placed = placeWaypoint(location.x, location.z, label);
      if (!placed) return fail("I found it, but couldn't place the beacon.");
      const target = describeTarget(location.x, location.z);
      const autopilot = action.autopilot === true && engageFollow();
      const subject = spec.kind === 'landmark' ? label : spec.phrase;
      const here = currentPlace();
      let alreadyThere = false;
      if (spec.kind === 'snow') alreadyThere = here.snowy;
      else if (spec.key === 'ocean') alreadyThere = here.overWater && state.player.groundHeight < CONFIG.WATER_LEVEL - 6;
      else if (spec.key === 'mountains') alreadyThere = here.key === 'snow' && state.player.groundHeight >= 320;
      else if (spec.kind === 'biome') alreadyThere = !here.overWater && here.key === spec.key && !here.foothills;
      let text = alreadyThere
        ? `We're already ${spec.kind === 'snow' ? 'among' : 'over'} ${subject}. I've marked a spot ${target.phrase}.`
        : pick('findFound', [`Found ${subject}, ${target.phrase}.`, `${subject.charAt(0).toUpperCase()}${subject.slice(1)}: ${target.phrase}.`]);
      if (spec.kind === 'landmark' && !discovered) text += " It's not in the journal yet.";
      text += autopilot ? ' Waypoint set, autopilot engaged.' : ' Waypoint set.';
      return succeed(text, true);
    },
    describe() {
      return succeed(Copilot.describe(flightSnapshot()), true);
    },
    photoMode(action) {
      if (!ctx.setPhotoMode) return fail('Photo mode is unavailable.');
      const enable = action.enabled ?? !state.photoMode;
      ctx.setPhotoMode(enable);
      return succeed(enable ? 'Photo mode.' : 'Back to flying.');
    },
    journal() {
      ctx.systems.ui?.showPanel?.('journal');
      const data = ctx.systems.journal?.getData?.();
      if (!data) return succeed('Journal open.', true);
      const landmarks = Array.isArray(data.landmarksFound) ? data.landmarksFound.length : 0;
      const biomes = Array.isArray(data.biomesVisited) ? data.biomesVisited.length : 0;
      const distance = Number.isFinite(data.distanceFlown) ? ` and ${Copilot.formatDistance(data.distanceFlown)} flown` : '';
      const landmarkText = landmarks === 1 ? '1 landmark' : `${landmarks} landmarks`;
      return succeed(`Journal's open: ${landmarkText}, ${biomes} of 5 biomes${distance}.`, true);
    },
    none() {
      return succeed('');
    },
  };

  // v2 aircraft actions (flightActions.js). Outcomes that land on a later frame resolve through the waiter.
  const outcomeWaiter = createOutcomeWaiter();
  Object.assign(handlers, createFlightActionHandlers(ctx, {
    succeed,
    fail,
    pick,
    waiter: outcomeWaiter,
    noteCopilotChange: (kind) => flightChatter.noteCopilotChange(kind),
    getView: () => currentView,
  }));

  const actionFailed = (type, error) => {
    console.error(`[DRIFTWING] WREN action "${type}" failed`, error);
    return fail('Something went wrong there. Try again?');
  };

  /** Validates and dispatches one action; returns { ok, text, informative } or a promise of it. */
  function runAction(rawAction) {
    const action = Copilot.sanitizeAction(rawAction);
    if (!action) return fail("I can't do that one, sorry.");
    try {
      const result = handlers[action.type](action);
      if (result && typeof result.then === 'function') return result.catch((error) => actionFailed(action.type, error));
      return result;
    } catch (error) {
      return actionFailed(action.type, error);
    }
  }

  ctx.executeAction = (action) => {
    const result = runAction(action);
    return result && typeof result.then === 'function' ? result.then((resolved) => resolved.text) : result.text;
  };

  function composeSpeech(brainSpeech, result) {
    if (!result) return brainSpeech;
    if (!result.ok) return result.text;
    if (result.informative) return [brainSpeech, result.text].filter(Boolean).join(' ');
    return brainSpeech || result.text;
  }

  // ---- Ask pipeline -------------------------------------------------------------------------------------------
  function noteRemoteResult(source, activeBrain) {
    if (source === 'remote') {
      remoteFailureNotified = false;
      return;
    }
    if (source !== 'local-fallback' || remoteFailureNotified) return;
    remoteFailureNotified = true;
    const reason = activeBrain.lastError ? ` (${activeBrain.lastError})` : '';
    bus.emit('notify', { text: `Remote copilot unavailable${reason}. WREN is answering locally.`, kind: 'warning' });
  }

  async function processAsk(rawText, inputSource) {
    const text = Copilot.cleanText(String(rawText ?? ''), 300);
    if (!text) return { speech: '', action: null, source: 'local', ok: false, result: '' };
    asksInFlight++;
    try {
      return await answerAsk(text, inputSource);
    } finally {
      asksInFlight--;
    }
  }

  async function answerAsk(text, inputSource) {
    const activeBrain = brain;
    const isRemote = activeBrain instanceof RemoteCopilot;
    if (isRemote || inputSource === 'voice') bus.emit('copilot:listening', { state: 'thinking' });
    const reply = await activeBrain.respond(flightSnapshot(), text);
    const source = reply.source || (isRemote ? 'remote' : 'local');
    noteRemoteResult(source, activeBrain);
    const result = reply.action ? await runAction(reply.action) : null;
    const speech = composeSpeech(reply.speech, result) || pick('fallbackLine', ["I'm here.", 'Listening.']);
    if (isRemote || inputSource === 'voice') bus.emit('copilot:listening', { state: 'idle' });
    say(speech, source);
    return { speech, action: reply.action, source, ok: result ? result.ok : true, result: result ? result.text : '' };
  }

  let queue = Promise.resolve();
  function ask(text, inputSource = 'text') {
    const job = queue.then(() => processAsk(text, inputSource)).catch((error) => {
      console.error('[DRIFTWING] WREN failed to answer', error);
      const speech = say('Sorry, I lost my train of thought. Could you say that again?', 'system');
      return { speech, action: null, source: 'system', ok: false, result: '' };
    });
    queue = job;
    return job;
  }

  // ---- Chatter --------------------------------------------------------------------------------------------------
  const chatter = {
    lastUnsolicitedAt: -Infinity,
    seenBiomes: new Set([state.player.biome?.key]),
    sawSunset: state.time.sunElevation <= 0,
    sawNight: state.time.nightFactor > 0.85,
    previousSunElevation: state.time.sunElevation,
    timePresetAt: -Infinity,
    pending: null,
  };
  const BIOME_LINES = {
    snow: ['Snow Peaks below. After dark, keep an eye out for the aurora.', 'Snow country. The ridges catch the light beautifully up here.'],
    snowFoothills: ['The Snow Peaks start here. Foothills for now; the snow lies higher up.', "Foothills of the Snow Peaks. We'll need more height to reach the snow."],
    snowFoothillsPeaks: ['Foothills of the Snow Peaks. You can see the snow on the ridges around us.', "We're in the Snow Peaks' foothills. Look at the snow on those ridges."],
    snowline: ["The Snow Peaks. We're right at the snowline.", 'Snow Peaks. The snow starts just about here.'],
    pine: ['Pine valleys below. Look at all that green.', 'Into the pine country. The valleys run on and on.'],
    pineSnowy: ['Snowy ridges above the Pine Valleys.', 'Pine country, high enough for snow on the ridges.'],
    dunes: ['The Dune Sea. Watch how the light moves over the sand.', 'Desert below. Those dunes go on forever.'],
    archipelago: ["Islands below. The water's clear enough to see the reefs.", 'The archipelago. Look at the colour of those shallows.'],
    meadows: ['Flower meadows. Pink, gold and lavender as far as you can see.', 'Meadow country. Soft hills and wildflowers.'],
  };

  // Replies in flight: unsolicited lines wait so they never talk over the pilot or the answer.
  let asksInFlight = 0;
  function chatterAllowed() {
    if (!settings.get('copilotChatter') || state.photoMode || !state.ready) return false;
    if (asksInFlight > 0 || voiceInput.isListening()) return false;
    const now = state.time.realElapsed;
    return now - chatter.lastUnsolicitedAt >= MIN_CHATTER_GAP && now - lastLineAt >= QUIET_AFTER_ANY_LINE;
  }

  /**
   * Speaks now if the chatter gap allows, otherwise keeps the line (priority-ordered) for ttl seconds.
   * Lines that only make sense right away (a landing, a soft crash) pass a short ttl.
   */
  function offerChatter(text, priority, ttl = PENDING_CHATTER_TTL) {
    if (!text) return;
    if (chatterAllowed()) {
      chatter.lastUnsolicitedAt = state.time.realElapsed;
      chatter.pending = null;
      say(text, 'local');
      return;
    }
    if (!settings.get('copilotChatter')) return;
    if (!chatter.pending || priority >= chatter.pending.priority) {
      chatter.pending = { text, priority, expiresAt: state.time.realElapsed + ttl };
    }
  }

  const flightChatter = createFlightChatter(ctx, { offerChatter, pick });
  const commandChips = createCommandChips(ctx);

  function flushPendingChatter() {
    const pending = chatter.pending;
    if (!pending) return;
    if (state.time.realElapsed > pending.expiresAt) {
      chatter.pending = null;
      return;
    }
    if (!chatterAllowed()) return;
    chatter.pending = null;
    chatter.lastUnsolicitedAt = state.time.realElapsed;
    say(pending.text, 'local');
  }

  function watchSky() {
    const elevation = state.time.sunElevation;
    const previous = chatter.previousSunElevation;
    chatter.previousSunElevation = elevation;
    const presetRecently = state.time.realElapsed - chatter.timePresetAt < 15;
    if (!chatter.sawSunset && previous > 0 && elevation <= 0 && state.time.dayTime > 0.5) {
      chatter.sawSunset = true;
      if (!presetRecently) offerChatter(pick('sunset', ["The sun's slipping under the horizon. This is my favourite part.", 'There goes the sun. The sky is putting on a show.']), 1);
    }
    if (!chatter.sawNight && state.time.nightFactor > 0.85) {
      chatter.sawNight = true;
      const overSnowCountry = (state.player.biome?.weights?.[0] ?? 0) > 0.45;
      const lines = overSnowCountry
        ? ['Stars are out. Watch the sky over the peaks for the aurora.', 'Night over the Snow Peaks. The aurora likes nights like this.']
        : ['Stars are out. If we find the Snow Peaks, the aurora might show.', 'Night flying. Follow the moonlight on the water.'];
      if (!presetRecently) offerChatter(pick(overSnowCountry ? 'nightSnow' : 'night', lines), 1);
    }
  }

  function greetingLine() {
    const label = state.time.label || 'golden hour';
    const place = currentPlace().phrase;
    const hour = state.time.dayTime * 24;
    const opener = hour < 4.5 ? 'Hello' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
    return pick('hello', [
      `${opener}, pilot. WREN here. It's ${label} over ${place}. ${commandHint()} whenever you want to talk.`,
      `WREN here. ${label.charAt(0).toUpperCase()}${label.slice(1)} over ${place}, and calm air. ${commandHint()} if you need me.`,
    ]);
  }

  function formatCourseTime(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    if (minutes > 0) return `${minutes}:${String(total % 60).padStart(2, '0')}`;
    return total === 1 ? '1 second' : `${total} seconds`;
  }

  bus.on('game:ready', () => {
    voiceInput.announceSupport();
    if (!settings.get('copilotChatter')) return;
    chatter.lastUnsolicitedAt = state.time.realElapsed;
    say(greetingLine(), 'local');
  });
  /** Biome welcome line that matches what the ground below actually looks like. */
  function biomeLineKey(key) {
    const place = currentPlace();
    if (key === 'snow' && place.foothills) return place.peaksNearby ? 'snowFoothillsPeaks' : 'snowFoothills';
    if (key === 'snow' && !place.snowy) return 'snowline';
    if (key === 'pine' && place.snowy) return 'pineSnowy';
    return key;
  }

  bus.on('biome:changed', ({ biome }) => {
    const key = biome?.key;
    if (!key || chatter.seenBiomes.has(key)) return;
    chatter.seenBiomes.add(key);
    const lineKey = biomeLineKey(key);
    const lines = BIOME_LINES[lineKey];
    if (lines) offerChatter(pick(`biome-${lineKey}`, lines), 1);
  });
  bus.on('landmark:discovered', ({ name }) => {
    if (!name) return;
    offerChatter(pick('discovered', [`That's ${name}. I've added it to the journal.`, `${name}, logged in the journal. Lovely.`, `New find: ${name}.`]), 2);
  });
  bus.on('landmark:threaded', ({ name }) => {
    offerChatter(pick('threaded', [`Right through ${name || 'the arch'}. Beautiful flying.`, 'Threaded it. Very smooth.']), 3);
  });
  bus.on('time:changed', ({ preset }) => {
    if (preset) chatter.timePresetAt = state.time.realElapsed;
  });
  bus.on('waypoint:reached', ({ label }) => {
    holdCourseIfFollowing();
    if (state.photoMode || !settings.get('copilotChatter')) return;
    const generic = !label || label === 'Waypoint';
    const lines = generic
      ? ["We've reached the waypoint.", 'Here we are. Lovely spot.', 'Waypoint reached.']
      : [`Here we are: ${label}.`, `${label}, right below us.`, `${label}. We made it.`];
    say(pick(generic ? 'reached' : 'reachedNamed', lines), 'local');
  });
  bus.on('rings:cancelled', () => {
    if (!state.waypoint) holdCourseIfFollowing();
  });
  bus.on('rings:finished', ({ time, passed, total, bestStreak }) => {
    if (!state.waypoint) holdCourseIfFollowing();
    if (!settings.get('copilotChatter')) return;
    const clock = formatCourseTime(time);
    const streak = bestStreak >= 2 && bestStreak < passed ? ` Best streak ${bestStreak}.` : '';
    let line;
    if (passed === 0) {
      line = pick('ringsNone', [
        "That's the course. The rings got away from us this time. Say 'ring course' for another go.",
        "Course over. No rings this time, but lovely flying. Want another try? Say 'ring course'.",
      ]);
    } else if (passed === total) {
      line = pick('ringsPerfect', [`A perfect run. All ${total} rings in ${clock}.`, `Every ring, ${total} for ${total}, in ${clock}. Beautiful.`]);
    } else {
      line = pick('ringsDone', [`Course complete: ${passed} of ${total} rings in ${clock}.${streak}`, `That's the course. ${passed} of ${total} in ${clock}.${streak}`]);
    }
    say(line, 'local');
  });

  // ---- UI hooks ---------------------------------------------------------------------------------------------------
  bus.on('ui:command', (payload) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (text.trim()) ask(text, 'text');
  });
  bus.on('ui:action', (payload) => {
    Promise.resolve(runAction(payload?.action)).then(
      (result) => say(result.text || pick('uiAck', ['Done.', 'All set.']), 'local'),
      (error) => console.error('[DRIFTWING] WREN ui action failed', error),
    );
  });
  bus.on('mic:toggle', () => voiceInput.toggle());
  // Hold-to-talk: copilotPTT (HOTAS trigger, ` on the keyboard) listens while held, answers on release.
  bus.on('input:action', (payload) => {
    if (!payload || payload.id !== 'copilotPTT') return;
    if (payload.phase === 'press') voiceInput.holdStart();
    else if (payload.phase === 'release') voiceInput.holdEnd();
  });
  bus.on('settings:changed', ({ key, value }) => {
    if (key === 'remoteCopilot' || key === 'remoteEndpoint') {
      brain = createBrain();
      remoteFailureNotified = false;
    }
    if (key === 'copilotVoice' && value === false) voiceOutput.cancel();
    if (key === 'copilotChatter' && value === false) chatter.pending = null;
  });
  window.addEventListener('pagehide', () => {
    voiceOutput.cancel();
    voiceInput.abort();
  });
  voiceInput.announceSupport();

  return {
    update(dt, realDt) {
      voiceInput.update(realDt);
      outcomeWaiter.update();
      if (!state.ready) return;
      watchSky();
      flightChatter.update(realDt);
      flushPendingChatter();
    },
    ask,
    toggleMic: () => voiceInput.toggle(),
    isListening: () => voiceInput.isListening(),
    /** Hold-to-talk, as the copilotPTT action drives it. */
    pushToTalk: (held) => (held ? voiceInput.holdStart() : voiceInput.holdEnd()),
    speak(text) {
      return say(text, 'system');
    },
    getBrainName: () => (brain instanceof RemoteCopilot ? 'remote' : 'local'),
    getStats() {
      return {
        brain: brain instanceof RemoteCopilot ? 'remote' : 'local',
        endpoint: brain instanceof RemoteCopilot ? brain.endpoint : null,
        lastRemoteError: brain instanceof RemoteCopilot ? brain.lastError : null,
        listening: voiceInput.isListening(),
        lastSpeechInputError: voiceInput.getLastError(),
        speechInput: voiceInput.supported,
        voice: voiceOutput.getVoiceName(),
        lastVoiceError: voiceOutput.getLastError(),
        chatterPending: chatter.pending ? chatter.pending.text : null,
        pushToTalk: voiceInput.isHolding(),
        view: currentView ? currentView.view : null,
        pendingOutcomes: outcomeWaiter.pending,
        flight: flightChatter.getStats(),
        quickChips: commandChips.getStats(),
      };
    },
  };
}
