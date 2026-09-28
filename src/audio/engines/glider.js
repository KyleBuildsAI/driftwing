// 'glider' engine family: a sailplane has no engine, so this family makes no engine sound of its own.
// The glider is carried by the airflow beds (airflow.js) and the variometer (flightCues.js). It is
// also the fallback family when a craft names an unknown one or its own family fails to start.
import { createScaffold } from '../synthKit.js';

/** kit: { context, noise, destination }. */
export function createGliderSynth(kit) {
  const synth = createScaffold(kit.context, kit.destination);

  return {
    family: 'glider',
    /** Nothing to drive: the output stays silent. */
    update() {},
    stop(time) {
      synth.stop(time);
    },
    describe() {
      return {
        family: 'glider',
        target: { level: 0 },
        level: synth.output.gain.value,
        frequencies: [],
      };
    },
  };
}
