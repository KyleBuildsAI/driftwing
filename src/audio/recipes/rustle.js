// Rustle: wind in foliage, for the biome set pieces (cherry blossom, autumn forest, redwoods, bamboo).
// A bright, crumpling leaf hiss that surges slowly on its own, over a soft low canopy roar; with
// params, the hollow wooden knocks of bamboo culms striking each other (params.knocks), the slow groan
// of giant trunks (params.creaks) and the scattered chirps of small birds in the branches
// (params.chirps), each 0..1.
//
// setIntensity(0..1) is the wind in the leaves (the emitter that owns the voice follows the gusts, so
// the canopy swells with them); trigger('burst', { strength }) is a gust tearing through: the hiss
// surges, the roar swells and a cascade of knocks runs through the grove. The knocks, creaks and chirps
// are scheduled a little ahead from update() on nodes that already exist, so nothing is allocated
// while they play.
import { glide, holdAt } from '../synthKit.js';
import { noiseBand, option, strike, swell } from './recipeKit.js';

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** Knock voices: hollow culm resonances (Hz) and their decay (s). */
const KNOCKS = Object.freeze([
  Object.freeze({ frequency: 520, decay: 0.09 }),
  Object.freeze({ frequency: 740, decay: 0.07 }),
  Object.freeze({ frequency: 610, decay: 0.08 }),
]);
/** A chirp: a quick upward sweep (Hz) and its length (s). */
const CHIRP = Object.freeze({ from: 3600, to: 5400, seconds: 0.07 });

export default Object.freeze({
  name: 'rustle',
  summary: 'wind in the leaves, culm knocks, trunk creaks and birds',
  spatial: Object.freeze({ distanceModel: 'exponential', refDistance: 160, rolloffFactor: 1.3, panningModel: 'equalpower', size: 300, reverb: 0.3 }),
  level: 0.06,
  floor: 0.2,
  triggers: Object.freeze(['burst']),

  build(kit, params) {
    const { scaffold, out } = kit;
    const knockAmount = option(params, 'knocks', 0, 0, 1);
    const creakAmount = option(params, 'creaks', 0, 0, 1);
    const chirpAmount = option(params, 'chirps', 0, 0, 1);
    let intensity = 0;
    let gusts = 0;
    let knocks = 0;
    let creaks = 0;
    let chirps = 0;
    let nextKnock = -1;
    let nextCreak = -1;
    let nextChirp = -1;
    let cascadeLeft = 0;
    let knockIndex = 0;

    // The leaves: a crumpling band surging on a slow random envelope, and a crisp top.
    const surge = scaffold.gain(0.8);
    surge.connect(out);
    const surgeNoise = scaffold.noise(kit.noise, 0.07);
    const surgeFilter = scaffold.filter('lowpass', 0.6, 0.7);
    const surgeDepth = scaffold.gain(1.6);
    surgeNoise.connect(surgeFilter);
    surgeFilter.connect(surgeDepth);
    surgeDepth.connect(surge.gain);
    const leaves = noiseBand(kit, { rate: 1, type: 'bandpass', frequency: 3200, q: 0.6, destination: surge });
    const crisp = noiseBand(kit, { rate: 1.17, type: 'highpass', frequency: 6500, q: 0.5, destination: surge });
    const canopy = noiseBand(kit, { rate: 0.55, type: 'lowpass', frequency: 380, q: 0.6 });
    // A gust's own swell on top of the leaves.
    const gustGain = scaffold.gain(0);
    gustGain.connect(out);
    const gustBand = noiseBand(kit, { rate: 0.93, type: 'bandpass', frequency: 2400, q: 0.5, level: 1, destination: gustGain });

    // Knocks: a short noise click through three hollow resonances.
    const knockVoices = KNOCKS.map((knock) => {
      const envelope = scaffold.gain(0);
      envelope.connect(out);
      const body = kit.pitched(scaffold.filter('bandpass', knock.frequency, 14));
      body.connect(envelope);
      const click = noiseBand(kit, { rate: 1.3, type: 'highpass', frequency: 200, q: 0.5, level: 1, destination: body });
      return { ...knock, envelope, click };
    });
    // Creaks: a slow sawtooth groan through a woody band.
    const creakEnvelope = scaffold.gain(0);
    creakEnvelope.connect(out);
    const creakBand = kit.pitched(scaffold.filter('bandpass', 420, 6));
    creakBand.connect(creakEnvelope);
    const creakTone = kit.pitched(scaffold.oscillator('sawtooth', 70));
    creakTone.connect(creakBand);
    // Chirps: a pure tone sweeping up quickly.
    const chirpEnvelope = scaffold.gain(0);
    chirpEnvelope.connect(out);
    const chirpTone = kit.pitched(scaffold.oscillator('sine', CHIRP.from));
    chirpTone.connect(chirpEnvelope);

    function knock(time, strength) {
      const voice = knockVoices[knockIndex % knockVoices.length];
      knockIndex += 1 + Math.floor(Math.random() * 2);
      strike(voice.envelope.gain, time, 2.6 * strength * randomBetween(0.6, 1), 0.003, voice.decay * randomBetween(0.8, 1.3));
      knocks++;
    }
    function creak(time) {
      const seconds = randomBetween(0.8, 1.8);
      const from = randomBetween(55, 80);
      holdAt(creakTone.frequency, time);
      creakTone.frequency.setValueAtTime(from, time);
      creakTone.frequency.exponentialRampToValueAtTime(from * randomBetween(1.15, 1.5), time + seconds);
      swell(creakEnvelope.gain, time, 0.22 * creakAmount * (0.4 + 0.6 * intensity), seconds * 0.3, seconds * 0.4, seconds * 0.5);
      creaks++;
    }
    function chirp(time) {
      const notes = 2 + Math.floor(Math.random() * 3);
      let at = time;
      for (let note = 0; note < notes; note++) {
        const lift = randomBetween(0.9, 1.15);
        holdAt(chirpTone.frequency, at);
        chirpTone.frequency.setValueAtTime(CHIRP.from * lift, at);
        chirpTone.frequency.exponentialRampToValueAtTime(CHIRP.to * lift, at + CHIRP.seconds);
        strike(chirpEnvelope.gain, at, 0.18 * chirpAmount, 0.008, CHIRP.seconds * 1.4);
        at += CHIRP.seconds + randomBetween(0.04, 0.12);
      }
      chirps++;
    }

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.7;
        glide(leaves.gain.gain, 0.5 * (0.15 + 0.85 * value), time, timeConstant);
        glide(crisp.gain.gain, 0.12 * value, time, timeConstant);
        glide(canopy.gain.gain, 0.5 * (0.2 + 0.8 * value), time, timeConstant);
        glide(leaves.filter.frequency, 2400 + 1600 * value, time, timeConstant);
      },
      trigger(name, options, time) {
        if (name !== 'burst') return false;
        const strength = option(options, 'strength', 1, 0, 1.5);
        swell(gustGain.gain, time, 0.9 * strength, 0.8, 1.2, 2.5);
        gusts++;
        if (knockAmount > 0) {
          cascadeLeft = 6 + Math.floor(14 * knockAmount * strength);
          nextKnock = time + 0.05;
        }
        return true;
      },
      update(time, interval) {
        const horizon = time + Math.max(0.4, interval * 3);
        if (knockAmount > 0) {
          if (nextKnock < 0) nextKnock = time + randomBetween(0.5, 2);
          while (nextKnock <= horizon) {
            const inCascade = cascadeLeft > 0;
            knock(Math.max(nextKnock, time + 0.02), inCascade ? 1 : 0.5 + 0.5 * intensity);
            if (inCascade) cascadeLeft--;
            // Idle knocks come more often as the wind rises; a gust's cascade rattles quickly.
            nextKnock += inCascade ? randomBetween(0.04, 0.16) : randomBetween(0.6, 3.5) / (0.3 + knockAmount * intensity * 1.7);
          }
        }
        if (creakAmount > 0) {
          if (nextCreak < 0) nextCreak = time + randomBetween(2, 6);
          if (nextCreak <= horizon) {
            creak(Math.max(nextCreak, time + 0.02));
            nextCreak += randomBetween(5, 14) / (0.4 + 0.6 * intensity);
          }
        }
        if (chirpAmount > 0) {
          if (nextChirp < 0) nextChirp = time + randomBetween(1, 4);
          if (nextChirp <= horizon) {
            chirp(Math.max(nextChirp, time + 0.02));
            nextChirp += randomBetween(2.5, 9);
          }
        }
      },
      describe() {
        return { intensity, gusts, knocks, creaks, chirps };
      },
    };
  },
});
