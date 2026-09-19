const { Vec3 } = require('vec3');
const { supplyStorageMaterial } = require('./storageRoomMaterials');
const { isStorageAccessPosition } = require('./storageAccessPolicy');

// Surveyed natural ground beside the base. Two-block aisles remain between rows.
const COLUMNS = [-338, -335, -332].flatMap(z => Array.from({ length: 8 }, (_, i) => ({ x: -176 + i, z })));
const FURNACE_GROUND_NAMES = new Set([
  'grass_block', 'dirt', 'stone', 'stone_bricks', 'cobblestone', 'cobbled_deepslate',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
  'crimson_planks', 'warped_planks', 'bamboo_planks'
]);

async function expandStorageFurnaces({ bot, adapter, execute = false, maxTargets = Infinity, log = () => {}, withLock = null }) {
  const targets = [];
  const blocked = [];
  for (const column of COLUMNS) {
    let found = false;
    for (let y = 66; y >= 61; y -= 1) {
      const ground = adapter.blockAt({ ...column, y });
      if (!ground || ground.name === 'furnace') { found = ground?.name === 'furnace'; break; }
      if (ground.name === 'air') continue;
      if (FURNACE_GROUND_NAMES.has(ground.name) &&
        [1, 2, 3].every(dy => adapter.blockAt({ ...column, y: y + dy })?.name === 'air')) {
        targets.push({ ...column, y: y + 1 });
        found = true;
      }
      break;
    }
    if (!found) blocked.push(column);
  }
  // Jika lahan preset berubah karena landscaping/base layout, cari pijakan natural
  // baru di sekitar bot. Ini menjaga smelting tidak bergantung pada koordinat tetap.
  // Kandidat dekat posisi live diprioritaskan. Static yard lama dapat berubah atau
  // terhalang bangunan; target yang berdiri di atas lantai stone_bricks tetap aman
  // selama blok atasnya kosong dan tidak mengubah blueprint storage.
  if (bot.entity?.position) {
    const center = bot.entity.position;
    const nearbyTargets = [];
    // Jangan memilih pijakan belasan blok di bawah bot. Target seperti itu
    // terlihat "natural" dari block scan, tetapi membuat worker logistik
    // masuk lubang dan menghabiskan satu siklus hanya untuk navigasi.
    const minGroundY = Math.max(60, Math.floor(center.y) - 4);
    const maxGroundY = Math.min(72, Math.floor(center.y) + 1);
    // Scan seluruh grid lokal, bukan hanya perimeter dengan langkah 2. Area base sering
    // memiliki chest/barrel yang memecah pola koordinat; pemindaian perimeter bisa melewati
    // satu-satunya sel solid+kosong yang aman dan membuat smelter berhenti sebelum produksi.
    for (let radius = 0; radius <= 8 && nearbyTargets.length < maxTargets; radius += radius === 0 ? 1 : 2) {
      const candidates = [];
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (dx * dx + dz * dz > radius * radius) continue;
          candidates.push({
            x: Math.floor(center.x + dx),
            z: Math.floor(center.z + dz),
            distance: Math.hypot(dx, dz)
          });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      for (const { x, z } of candidates) {
        if (nearbyTargets.length >= maxTargets) break;
        for (let y = maxGroundY; y >= minGroundY; y -= 1) {
          const below = adapter.blockAt({ x, y, z });
          const at = adapter.blockAt({ x, y: y + 1, z });
          if (!below || !FURNACE_GROUND_NAMES.has(below.name) || at?.name !== 'air') continue;
          if (isStorageAccessPosition({ x, y: y + 1, z })) continue;
          if (!nearbyTargets.some(target => target.x === x && target.y === y + 1 && target.z === z)) {
            nearbyTargets.push({ x, y: y + 1, z });
          }
          break;
        }
      }
    }
    targets.unshift(...nearbyTargets.filter(candidate => !targets.some(target => target.x === candidate.x && target.y === candidate.y && target.z === candidate.z)));
  }
  const reachableLevelTargets = bot.entity?.position
    ? targets.filter(target => Math.abs(target.y - Math.floor(bot.entity.position.y)) <= 4)
    : targets;
  const selectedTargets = Number.isFinite(maxTargets) ? reachableLevelTargets.slice(0, Math.max(0, Math.floor(maxTargets))) : reachableLevelTargets;
  log(`Peta furnace tambahan: ${JSON.stringify({ targets: selectedTargets, blocked, totalTargets: reachableLevelTargets.length })}`);
  if (selectedTargets.length === 0 && bot.entity?.position) {
    const center = bot.entity.position;
    const samples = [];
    for (const y of [Math.floor(center.y) - 1, Math.floor(center.y), Math.floor(center.y) + 1]) {
      const block = adapter.blockAt({ x: Math.floor(center.x), y, z: Math.floor(center.z) });
      samples.push({ y, name: block?.name || null, boundingBox: block?.boundingBox || null });
    }
    log(`FURNACE_SURVEY_EMPTY ${JSON.stringify({ center: { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }, samples })}`);
  }
  if (!execute || selectedTargets.length === 0) return { built: 0, targets: selectedTargets, blocked };
  // Furnace expansion is optional. Never launch an unbounded chest scan here:
  // the materials worker must keep producing and delivering builder stock.
  const furnaceSupply = await supplyStorageMaterial({
    bot,
    adapter,
    name: 'furnace',
    required: selectedTargets.length,
    log,
    withLock,
    fallbackSearch: false,
    // Craft from already mapped cobblestone when the yard has no furnace stock;
    // this stays bounded because fallback chest discovery remains disabled.
    allowProcessing: true,
  });
  if ((furnaceSupply.available || 0) <= 0 && (furnaceSupply.missing || 0) > 0) {
    log(`Furnace logistik ditunda: stock furnace tidak tersedia di source terdaftar (${JSON.stringify(furnaceSupply)}).`);
    return { built: 0, targets: selectedTargets, blocked };
  }
  let built = 0;
  for (const pos of selectedTargets) {
    if ((bot.health ?? 20) < 15 || (bot.food ?? 20) < 10) break;
    const below = adapter.blockAt({ ...pos, y: pos.y - 1 });
    if (adapter.blockAt(pos)?.name !== 'air' || !FURNACE_GROUND_NAMES.has(below?.name)) continue;
    if (!await adapter.navigateNear(below.position, 3) || !await adapter.equipItem('furnace', 'hand')) continue;
    try { await adapter.placeBlockAt(pos, below, new Vec3(0, 1, 0)); }
    catch (error) { log(`Furnace placement: ${error.message}`); continue; }
    if (adapter.blockAt(pos)?.name !== 'furnace') continue;
    built += 1;
    log(`FURNACE_BUILT ${JSON.stringify(pos)}`);
  }
  return { built, targets, blocked };
}

module.exports = { expandStorageFurnaces };
