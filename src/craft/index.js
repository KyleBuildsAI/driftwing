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

craftRegistry.register(glider);
craftRegistry.register(bushplane);
craftRegistry.register(helicopter);
craftRegistry.register(wingsuit);
craftRegistry.register(fpv);
craftRegistry.register(jet);

export { craftRegistry };
