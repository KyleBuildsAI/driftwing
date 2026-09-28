// The spawn presets: pure data, one file per preset in this directory (contract section 1). PRESETS
// is in spec order; PRESET_BY_ID looks one up. Pure data only: the terrain worker imports it too.
export const PRESETS = Object.freeze([]);

export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((preset) => [preset.id, preset])));
