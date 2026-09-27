// 'drone' engine family: a racing quad's brushless motors.
//
// One tone per motor (motors, default four), each slightly detuned so they beat against each
// other, tracking thrust (state.flight.rpm, or the throttle when the model leaves rpm at 0) from
// idleHz to maxHz. The flight controller's roll, pitch and yaw commands (ctx.controls) split the
// motors the way a real mixer does, so manoeuvres make the tones spread audibly. A band-passed
// prop-wash hiss rides on top.
import { clamp } from '../../core/util.js';
import { approach, createScaffold, glide } from '../synthKit.js';

/** Quad-X layout: pitch, roll and yaw signs for front-right, rear-left, front-left, rear-right. */
const MOTOR_MIX = [
  { pitch: 1, roll: -1, yaw: -1 },
  { pitch: -1, roll: 1, yaw: -1 },
  { pitch: 1, roll: 1, yaw: 1 },
  { pitch: -1, roll: -1, yaw: 1 },
];
const DETUNE = [-0.012, -0.004, 0.005, 0.013];

/** kit: { context, noise, destination }; profile: resolved audioProfile. */
export function createDroneSynth(kit, profile) {
  const { context, noise } = kit;
  const synth = createScaffold(context, kit.destination);
  const tone = synth.filter('lowpass', 2400, 1.2);
  const presence = synth.filter('peaking', 1800, 1.4);
  presence.gain.value = 5;
  tone.connect(presence);
  presence.connect(synth.output);

  const motorCount = clamp(Math.round(profile.motors), 3, 8);
  const motors = [];
  for (let index = 0; index < motorCount; index++) {
    const oscillator = synth.oscillator('sawtooth', profile.idleHz);
    const overtone = synth.oscillator('square', profile.idleHz * 2);
    const overtoneLevel = synth.gain(0.18);
    const level = synth.gain(0.25);
    oscillator.connect(level);
    overtone.connect(overtoneLevel);
    overtoneLevel.connect(level);
    level.connect(tone);
    motors.push({
      oscillator,
      overtone,
      mix: MOTOR_MIX[index % MOTOR_MIX.length],
      detune: DETUNE[index % DETUNE.length] * (index < MOTOR_MIX.length ? 1 : -0.7),
      wobble: 0,
      speed: 0,
    });
  }

  const washNoise = synth.noise(noise, 1.4);
  const washFilter = synth.filter('bandpass', 1500, 0.9);
  const washLevel = synth.gain(0);
  washNoise.connect(washFilter);
  washFilter.connect(washLevel);
  washLevel.connect(synth.output);

  synth.start(context.currentTime + 0.02);
  let thrust = 0;
  const readout = { thrust: 0, motorHz: [], level: 0 };

  return {
    family: 'drone',
    update(frame, pitch) {
      const { time, interval, flight, controls } = frame;
      const running = flight.engineOn !== false;
      const reported = Number.isFinite(flight.rpm) && flight.rpm > 0 ? flight.rpm : Number.isFinite(flight.throttle) ? flight.throttle : 0;
      thrust = approach(thrust, running ? clamp(reported, 0, 1) : 0, 0.05, interval);
      const command = {
        pitch: clamp(controls?.pitch ?? 0, -1, 1),
        roll: clamp(controls?.roll ?? 0, -1, 1),
        yaw: clamp(controls?.yaw ?? 0, -1, 1),
      };
      readout.motorHz.length = 0;
      for (const motor of motors) {
        const split = 0.09 * (motor.mix.pitch * command.pitch + motor.mix.roll * command.roll) + 0.05 * motor.mix.yaw * command.yaw;
        motor.wobble += ((Math.random() - 0.5) * 0.012 - motor.wobble) * 0.3;
        const share = clamp(thrust * (1 + split), 0, 1.2);
        motor.speed = profile.idleHz + (profile.maxHz - profile.idleHz) * Math.sqrt(share);
        const frequency = motor.speed * (1 + motor.detune + motor.wobble) * pitch;
        glide(motor.oscillator.frequency, frequency, time, 0.03);
        glide(motor.overtone.frequency, frequency * 2.003, time, 0.03);
        readout.motorHz.push(frequency);
      }
      glide(tone.frequency, (1400 + 3200 * thrust) * pitch, time, 0.06);
      glide(presence.frequency, (900 + 1600 * thrust) * pitch, time, 0.06);
      glide(washFilter.frequency, (900 + 1800 * thrust) * pitch, time, 0.08);
      glide(washLevel.gain, 0.35 * thrust, time, 0.08);
      const level = running ? (0.02 + 0.07 * Math.sqrt(thrust)) * profile.level : 0;
      glide(synth.output.gain, level, time, 0.06);
      readout.thrust = thrust;
      readout.level = level;
    },
    stop(time) {
      synth.stop(time, 0.25);
    },
    describe() {
      return {
        family: 'drone',
        target: { thrust: readout.thrust, motorHz: [...readout.motorHz], level: readout.level },
        level: synth.output.gain.value,
        frequencies: motors.map((motor) => motor.oscillator.frequency.value),
      };
    },
  };
}
