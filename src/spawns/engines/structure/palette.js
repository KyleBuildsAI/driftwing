// The structure recipes' colours: v1's warm, slightly desaturated palette (the landmarks' whites,
// stones and timbers), in linear RGBA with alpha as the emissive gain. Presets may override the main
// colours of each recipe through its params (sRGB hex numbers).
import { paint, shade } from './meshBuilder.js';

export const PALETTE = Object.freeze({
  towerWhite: paint(0xf2efe8),
  towerBand: paint(0xc9c4b8),
  concrete: paint(0xb3aca0),
  concreteDark: paint(0x8e887e),
  tarmac: Object.freeze([paint(0x5e5b58), paint(0x686460), paint(0x55524f)]),
  tarmacWeed: paint(0x5f6b45),
  gravel: paint(0x9a9082),
  marking: paint(0xefe9da),
  rust: Object.freeze([paint(0x9c5a3a), paint(0x86503a), paint(0xa86a44)]),
  corrugated: Object.freeze([paint(0x8e918c), paint(0x7d8079), paint(0x9aa097)]),
  hangarShadow: paint(0x2f2c2a),
  sockOrange: paint(0xe2662c),
  sockWhite: paint(0xf3eee4),
  metalDark: paint(0x3a3c42),
  timber: Object.freeze([paint(0x8a6a4a), paint(0x7a5c3f), paint(0x957453)]),
  timberDark: paint(0x4e3b2a),
  rope: paint(0x7c6546),
  stone: Object.freeze([paint(0x8d8a85), paint(0x7b7872), paint(0x9c978e)]),
  rock: Object.freeze([paint(0x857a6d), paint(0x74695d), paint(0x928676), paint(0x6a6158)]),
  rockDeep: paint(0x4f4944),
  grass: Object.freeze([paint(0x7fa052), paint(0x86a856), paint(0x769a4b)]),
  grassDry: paint(0xa3a060),
  pine: Object.freeze([paint(0x3f6b3a), paint(0x4a7640), paint(0x365f35)]),
  leaf: Object.freeze([paint(0x6e9a45), paint(0x7fa653), paint(0x5d8a3d)]),
  trunk: paint(0x5b4330),
  flagRed: paint(0xc0392b),
  flagWhite: paint(0xf1e4cf),
  window: paint(0x283038),
});

export { paint, shade };
