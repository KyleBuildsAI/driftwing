// Registers every craft module with the craft registry. The catalog in registry.js lists all six
// craft; the ones without a registered module show as unavailable until their module lands here.
import { craftRegistry } from './registry.js';
import glider from './glider.js';
import bushplane from './bushplane.js';
import jet from './jet.js';

craftRegistry.register(glider);
craftRegistry.register(bushplane);
craftRegistry.register(jet);

export { craftRegistry };
