// Icons and colours for discoveries: one per spawn category (src/spawns/schema.js PRESET_CATEGORIES)
// and one per Phase 1 landmark type. The journal and the discovery toast draw them as inline SVG; the
// world map draws the same path data on its canvas through Path2D. Every icon is stroked line art on a
// 24 x 24 grid, like the sprites in v2/index.html.

/** Category / landmark key -> { label, color (CSS), paths (SVG path data, stroked) }. */
export const DISCOVERY_ICONS = Object.freeze({
  weather: Object.freeze({
    label: 'Weather',
    color: '#a9c0e6',
    paths: Object.freeze([
      'M7.2 15.2h9.6a3.3 3.3 0 0 0 .4-6.57A5.2 5.2 0 0 0 7.3 7.8a3.7 3.7 0 0 0-.1 7.4z',
      'M12.7 13.4l-1.9 3.3h2.6l-1.8 3.5',
    ]),
  }),
  geo: Object.freeze({
    label: 'Volcanic and geo',
    color: '#f2a174',
    paths: Object.freeze([
      'M3.5 19.5l5.6-9.6h5.8l5.6 9.6z',
      'M10.8 7.2c-.9-1.5.1-2.9 1.5-3.1M13.3 6.7c.9-1 2.3-.9 3 .1',
    ]),
  }),
  ocean: Object.freeze({
    label: 'Ocean',
    color: '#7fd0d6',
    paths: Object.freeze([
      'M3 13.2c2 0 2-1.6 4-1.6s2 1.6 4 1.6 2-1.6 4-1.6 2 1.6 4 1.6',
      'M3 17.4c2 0 2-1.6 4-1.6s2 1.6 4 1.6 2-1.6 4-1.6 2 1.6 4 1.6',
      'M12 3.8c1.6 2 2.4 3.3 2.4 4.3a2.4 2.4 0 0 1-4.8 0c0-1 .8-2.3 2.4-4.3z',
    ]),
  }),
  wildlife: Object.freeze({
    label: 'Wildlife',
    color: '#b7d882',
    paths: Object.freeze([
      'M3 11.5c3.2 0 6 1.6 9 4.8 3-3.2 5.8-4.8 9-4.8',
      'M12.6 7.2c1.1 0 2 .5 3 1.6 1-1.1 1.9-1.6 3-1.6',
    ]),
  }),
  structure: Object.freeze({
    label: 'Structures',
    color: '#e6cb9c',
    paths: Object.freeze([
      'M12 10.6v9.9M9 20.5h6',
      'M12 10.6l-.7-7.1M12 10.6l6.2 3.2M12 10.6l-5.6 4.1',
    ]),
  }),
  celestial: Object.freeze({
    label: 'Night and celestial',
    color: '#bba9f2',
    paths: Object.freeze([
      'M13 3.8l1.7 4.1 4.4.4-3.3 2.9 1 4.3-3.8-2.3-3.8 2.3 1-4.3-3.3-2.9 4.4-.4z',
      'M4.2 20.2l4.3-4.3',
    ]),
  }),
  fantasy: Object.freeze({
    label: 'Fantasy',
    color: '#f2a9d8',
    paths: Object.freeze([
      'M4.5 11.2h15l-3.2 4.1-2.4.6-1.9 3.4-1.9-3.4-2.4-.6z',
      'M9 11.2V7.6M9 7.6l-1.8 1.5M9 7.6l1.8 1.5M15.4 11.2V9.4',
    ]),
  }),
  flightplay: Object.freeze({
    label: 'Flight play',
    color: '#f3c77a',
    paths: Object.freeze([
      'M3.5 9.4h11.2a2.9 2.9 0 1 0-2.9-2.9',
      'M3.5 13.8h14.6a2.9 2.9 0 1 1-2.9 2.9',
      'M3.5 18.2h6',
    ]),
  }),
  setpiece: Object.freeze({
    label: 'Legendary',
    color: '#ff9a82',
    paths: Object.freeze([
      'M4 5.2h16M6.2 8.8h11.6M8.4 12.4h7.8M10.2 16h4.6M11.6 19.6h1.8',
    ]),
  }),
  arch: Object.freeze({
    label: 'Stone arch',
    color: '#8fd3d6',
    paths: Object.freeze(['M4 20v-8.5a8 8 0 0 1 16 0V20M8.2 20v-8a3.8 3.8 0 0 1 7.6 0v8']),
  }),
  monoliths: Object.freeze({
    label: 'Standing stones',
    color: '#8fd3d6',
    paths: Object.freeze(['M5 20v-10M9.5 20V7M14.5 20V7M19 20v-10M8 6.5h8M3.5 20h17']),
  }),
  lighthouse: Object.freeze({
    label: 'Lighthouse',
    color: '#8fd3d6',
    paths: Object.freeze(['M9.4 20.5l1.2-11h2.8l1.2 11zM9.8 9.5h4.4M10.6 9.5V6.8h2.8v2.7M12 4.2v1.6M5.5 6.3l3.2 1.1M18.5 6.3l-3.2 1.1']),
  }),
  balloons: Object.freeze({
    label: 'Balloon meet',
    color: '#8fd3d6',
    paths: Object.freeze(['M12 3a5.6 5.6 0 0 0-5.6 5.6c0 3.3 3.2 6.1 4.4 7.4h2.4c1.2-1.3 4.4-4.1 4.4-7.4A5.6 5.6 0 0 0 12 3zM10.6 16l.5 3.2h1.8l.5-3.2']),
  }),
  achievement: Object.freeze({
    label: 'Achievement',
    color: '#f3c77a',
    paths: Object.freeze([
      'M12 3.5l2.4 5.6 6 .5-4.6 3.9 1.4 5.9L12 16.3l-5.2 3.1 1.4-5.9-4.6-3.9 6-.5z',
    ]),
  }),
});

/** The icon for a category or landmark type; unknown keys get the flight-play icon. */
export function discoveryIcon(key) {
  return DISCOVERY_ICONS[key] ?? DISCOVERY_ICONS.flightplay;
}

/** Inline SVG markup of an icon (stroked with currentColor). */
export function discoveryIconSvg(key, className = 'dw-icon') {
  const icon = discoveryIcon(key);
  const paths = icon.paths.map((data) => `<path d="${data}"/>`).join('');
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}
