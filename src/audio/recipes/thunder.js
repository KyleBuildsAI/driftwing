// Thunder: the strike one-shot (a crack and a rolling rumble) and the storm voice.
//
// playThunderStrike() is what audio.thunder() plays once the sound front reaches the listener
// (spawnVoices.js schedules it at distance / 343 m/s, following a moving listener). Close strikes
// open with a tearing crack and a boom; far ones arrive as a long, low roll only, because the air
// absorbs the highs (the absorption filter) and the lightning channel's far end is further away
// than its near end (the rumble lasts longer the further the strike).
//
// The 'thunder' recipe is a storm's voice: a faint, irregular distant grumble whose level follows
// setIntensity, and trigger('strike', { intensity, position? }) sends a strike from the storm
// (from position, or from a random point within the storm's size around the voice).
import { glide } from '../synthKit.js';
import { crackleBand, noiseBand, strike, sweep } from './recipeKit.js';

/** Spatial tuning of a strike (the storm voice's own tuning is in the recipe below). */
export const THUNDER_SPATIAL = Object.freeze({ distanceModel: 'inverse', refDistance: 600, rolloffFactor: 1, panningModel: 'equalpower', size: 0, reverb: 0.5 });
/** Approximate peak RMS of a strike at the reference distance with intensity 1. */
export const THUNDER_LEVEL = 0.3;
const CRACK_RANGE = 3500;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Plays one strike. env: { context, noise, destination, send, cutoff (absorption, Hz), trackOneShot };
 * strike: { time, x, y, z, distance, intensity }. Returns { output, level, stopTime }.
 */
export function playThunderStrike(env, strikeInfo) {
  const { context, noise } = env;
  const { time, distance, intensity } = strikeInfo;
  const nodes = [];
  const sources = [];
  const node = (created) => {
    nodes.push(created);
    return created;
  };
  const noiseTap = (rate) => {
    const source = node(context.createBufferSource());
    source.buffer = noise;
    source.loop = true;
    source.playbackRate.value = rate;
    sources.push(source);
    return source;
  };
  const filter = (type, frequency, q) => node(new BiquadFilterNode(context, { type, frequency, Q: q }));
  const gain = (value) => node(new GainNode(context, { gain: value }));

  const panner = node(new PannerNode(context, {
    panningModel: THUNDER_SPATIAL.panningModel,
    distanceModel: THUNDER_SPATIAL.distanceModel,
    refDistance: THUNDER_SPATIAL.refDistance,
    rolloffFactor: THUNDER_SPATIAL.rolloffFactor,
    maxDistance: 100000,
    positionX: strikeInfo.x,
    positionY: strikeInfo.y,
    positionZ: strikeInfo.z,
  }));
  panner.connect(env.destination);
  const air = filter('lowpass', env.cutoff, 0.5);
  air.connect(panner);
  if (env.send) {
    const send = gain(THUNDER_SPATIAL.reverb * Math.min(1, 0.4 + distance / 6000));
    air.connect(send);
    send.connect(env.send);
  }
  const output = gain(intensity);
  output.connect(air);

  const nearness = Math.max(0, 1 - distance / CRACK_RANGE);
  const rumbleSeconds = 2.6 + 8 * Math.min(distance / 9000, 1) + Math.random() * 1.8;
  const stopTime = time + rumbleSeconds + 4;

  // Crack: a few tearing spikes of bright noise, only for close strikes.
  if (nearness > 0) {
    const crackGain = gain(0);
    crackGain.connect(output);
    const crackTap = noiseTap(1.1);
    const crackFilter = filter('highpass', 1400, 0.6);
    const ripFilter = filter('bandpass', 3100, 0.8);
    crackTap.connect(crackFilter);
    crackTap.connect(ripFilter);
    crackFilter.connect(crackGain);
    ripFilter.connect(crackGain);
    const level = 1.5 * nearness * nearness;
    let spikeTime = time;
    const spikes = 3 + Math.floor(Math.random() * 4);
    for (let spike = 0; spike < spikes; spike++) {
      const peak = level * (spike === 0 ? 1 : randomBetween(0.35, 0.9));
      strike(crackGain.gain, spikeTime, peak, 0.002, spike === spikes - 1 ? 0.7 : randomBetween(0.05, 0.14));
      spikeTime += randomBetween(0.025, 0.08);
    }
  }

  // Boom: a low thump with a falling pitch, strongest close by.
  const boomGain = gain(0);
  boomGain.connect(output);
  const boomTap = noiseTap(0.6);
  const boomFilter = filter('lowpass', 320, 0.9);
  boomTap.connect(boomFilter);
  boomFilter.connect(boomGain);
  const boomOscillator = node(new OscillatorNode(context, { type: 'sine', frequency: 70 }));
  sources.push(boomOscillator);
  const boomTone = gain(0);
  boomOscillator.connect(boomTone);
  boomTone.connect(output);
  const boomAt = time + 0.02 + 0.03 * (1 - nearness);
  strike(boomGain.gain, boomAt, 0.9 * (0.35 + 0.65 * nearness), 0.03 + 0.2 * (1 - nearness), 1.6 + 1.4 * (1 - nearness));
  strike(boomTone.gain, boomAt, 0.35 * (0.3 + 0.7 * nearness), 0.02, 1.4);
  sweep(boomOscillator.frequency, boomAt, 72, 27, 1.3);

  // Rumble: a deep roll of successive swells, longer for far strikes.
  const rumbleGain = gain(0);
  rumbleGain.connect(output);
  const rumbleTap = noiseTap(0.55);
  const rumbleFilter = filter('lowpass', 170 + 520 * nearness, 0.7);
  const deepTap = noiseTap(0.3);
  const deepFilter = filter('lowpass', 85, 0.9);
  rumbleTap.connect(rumbleFilter);
  deepTap.connect(deepFilter);
  rumbleFilter.connect(rumbleGain);
  deepFilter.connect(rumbleGain);
  let onset = time + 0.1 + 0.25 * (1 - nearness);
  const rumbleEnd = time + rumbleSeconds;
  let swellIndex = 0;
  while (onset < rumbleEnd) {
    const progress = (onset - time) / rumbleSeconds;
    const peak = randomBetween(0.45, 1) * (1 - 0.65 * progress) * (swellIndex === 0 ? 1 : 0.85);
    const rise = randomBetween(0.2, 0.65);
    const fall = randomBetween(0.7, 1.6);
    rumbleGain.gain.setTargetAtTime(peak, onset, rise / 3);
    rumbleGain.gain.setTargetAtTime(peak * randomBetween(0.15, 0.4), onset + rise, fall / 3);
    onset += rise + randomBetween(0.15, 1.1);
    swellIndex++;
  }
  rumbleGain.gain.setTargetAtTime(0, rumbleEnd, 0.7);

  for (const source of sources) {
    if (source.buffer) source.start(time, Math.random() * noise.duration * 0.9);
    else source.start(time);
    source.stop(stopTime);
  }
  env.trackOneShot(nodes, sources[sources.length - 1]);
  return { output, level: THUNDER_LEVEL * intensity, stopTime };
}

export default Object.freeze({
  name: 'thunder',
  summary: 'distant storm grumble; strikes crack and roll, delayed by distance / 343 m/s',
  spatial: Object.freeze({ distanceModel: 'inverse', refDistance: 900, rolloffFactor: 1, panningModel: 'equalpower', size: 2500, reverb: 0.45 }),
  level: 0.05,
  floor: 0.2,
  triggers: Object.freeze(['strike']),
  // trigger('strike') is sent through audio.thunder() by the voice (see spawnVoices.js), so it
  // works whether or not the storm's own grumble is audible.
  strikes: true,

  build(kit) {
    let intensity = 0;
    // An irregular grumble of distant strikes, over a steady low bed of the storm's rain and wind.
    const grumble = crackleBand(kit, { rate: 0.32, type: 'lowpass', frequency: 120, q: 0.7, crackleRate: 0.02, cutoff: 0.9, drive: 1.7 });
    const bed = noiseBand(kit, { rate: 0.45, type: 'lowpass', frequency: 220, q: 0.5 });

    return {
      setIntensity(value, time, immediate = false) {
        intensity = value;
        const timeConstant = immediate ? 0.01 : 0.6;
        glide(grumble.level.gain, 2.4 * value, time, timeConstant);
        glide(grumble.crackle.drive.gain, 1.4 + 0.9 * value, time, timeConstant);
        glide(bed.gain.gain, 0.12 * value, time, timeConstant);
      },
      trigger() {
        return false;
      },
      describe() {
        return { intensity };
      },
    };
  },
});

