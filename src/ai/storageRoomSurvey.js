/** Survei kandidat lokasi storage room tanpa menggali atau memasang blok. */

const { createStorageRoomBlueprint } = require('./storageRoomBlueprint');
const { LIQUID_NAMES, REPLACEABLE_FLOOR_NAMES, NATURAL_EXCAVATION_NAMES } = require('./storageRoomBuilder');

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

function position(origin, block) {
  return { x: origin.x + block.x, y: origin.y + block.y, z: origin.z + block.z };
}

function isAir(block) {
  return !block || AIR_NAMES.has(block.name) || block.boundingBox === 'empty';
}

function scoreStorageSite({ adapter, blueprint, origin, allowFloorReplacement = true, allowFoundationFill = false, allowExcavation = false }) {
  const counts = { clear: 0, existing: 0, unknown: 0, liquid: 0, blocked: 0, unsafeFoundation: 0, foundationFill: 0, excavation: 0 };
  const examples = [];
  for (const block of blueprint.blocks) {
    const pos = position(origin, block);
    const actual = adapter.blockAt(pos);
    if (!actual) { counts.unknown += 1; if (examples.length < 12) examples.push({ code: 'UNKNOWN', pos }); continue; }
    if (actual.name === block.name) { counts.existing += 1; continue; }
    if (LIQUID_NAMES.has(actual.name)) { counts.liquid += 1; if (examples.length < 12) examples.push({ code: 'LIQUID', name: actual.name, pos }); continue; }
    const replaceableFloor = block.phase === 'floor' && allowFloorReplacement && REPLACEABLE_FLOOR_NAMES.has(actual.name);
    const excavatable = allowExcavation && NATURAL_EXCAVATION_NAMES.has(actual.name);
    if (!isAir(actual) && !replaceableFloor && !excavatable) { counts.blocked += 1; if (examples.length < 12) examples.push({ code: 'BLOCKED', name: actual.name, pos }); continue; }
    if (excavatable) counts.excavation += 1;
    if (block.phase === 'floor') {
      const below = adapter.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (!below || LIQUID_NAMES.has(below.name) || isAir(below)) {
        if (allowFoundationFill && below && isAir(below)) counts.foundationFill += 1;
        else counts.unsafeFoundation += 1;
        if (examples.length < 12) examples.push({ code: allowFoundationFill && below && isAir(below) ? 'FOUNDATION_FILL' : 'UNSAFE_FOUNDATION', pos });
        if (!(allowFoundationFill && below && isAir(below))) continue;
      }
    }
    counts.clear += 1;
  }
  const penalty = counts.unknown * 100 + counts.liquid * 100 + counts.blocked * 10 + counts.unsafeFoundation * 5 + counts.foundationFill + counts.excavation * 2;
  const safe = counts.unknown === 0 && counts.liquid === 0 && counts.blocked === 0 && counts.unsafeFoundation === 0;
  return { origin, counts, score: penalty, safe, examples };
}

function generateCandidateOrigins({ center, radius = 64, step = 16, y }) {
  if (!center || ![center.x, center.y, center.z].every(Number.isInteger)) throw new TypeError('Center survei wajib berupa koordinat integer.');
  const origins = [];
  for (let x = center.x - radius; x <= center.x + radius; x += step) {
    for (let z = center.z - radius; z <= center.z + radius; z += step) origins.push({ x, y: y ?? center.y, z });
  }
  return origins;
}

function rankStorageSites({ adapter, center, blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' }), radius = 64, step = 16, y, limit = 10, allowFloorReplacement = true, allowFoundationFill = false, allowExcavation = false }) {
  return generateCandidateOrigins({ center, radius, step, y })
    .map(origin => scoreStorageSite({ adapter, blueprint, origin, allowFloorReplacement, allowFoundationFill, allowExcavation }))
    .sort((a, b) => a.score - b.score || a.counts.unknown - b.counts.unknown)
    .slice(0, limit);
}

module.exports = { scoreStorageSite, generateCandidateOrigins, rankStorageSites };
