// Registers every craft module with the craft registry. The catalog in registry.js lists all 14
// craft; the ones without a registered module show as unavailable (disabled in the picker, refused
// with a notice) until their module lands here. A new craft adds its import and its register line,
// in catalog order (docs/architecture.md, "How to add a craft").
import { craftRegistry } from './registry.js';
import glider from './glider.js';
import bushplane from './bushplane.js';
import helicopter from './helicopter.js';
import wingsuit from './wingsuit.js';
import fpv from './fpv.js';
import jet from './jet.js';
import aerobatic from './aerobatic.js';
import seaplane from './seaplane.js';
import tiltrotor from './tiltrotor.js';
import paraglider from './paraglider.js';
import balloon from './balloon.js';
import airship from './airship.js';
import eagle from './eagle.js';

craftRegistry.register(glider);
craftRegistry.register(bushplane);
craftRegistry.register(helicopter);
craftRegistry.register(wingsuit);
craftRegistry.register(fpv);
craftRegistry.register(jet);
craftRegistry.register(aerobatic);
craftRegistry.register(seaplane);
craftRegistry.register(tiltrotor);
craftRegistry.register(paraglider);
craftRegistry.register(balloon);
craftRegistry.register(airship);
craftRegistry.register(eagle);

export { craftRegistry };
