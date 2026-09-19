/** Bounded survival material preparation. Caller owns the shared restock lock. */
const { Vec3 } = require('vec3');
const { getSharedChestAssignments, OVERFLOW_CHESTS, parseChestPositionKey } = require('./storageMemory');
const { smeltStorageStone } = require('./storageRoomSmelter');
const { chestResourceKey } = require('./storageRoomLock');
const { worldContext } = require('./sharedWorldObserver');

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const PLANKS = [...WOODS, 'crimson', 'warped', 'bamboo'].map(wood => `${wood}_planks`);
const LOG_PLANKS = Object.fromEntries(WOODS.flatMap(wood => ['log', 'wood'].flatMap(part =>
  ['', 'stripped_'].map(prefix => [`${prefix}${wood}_${part}`, `${wood}_planks`]))));
const FURNACE_WOOD_FUEL = [
  ...WOODS.flatMap(wood => [`${wood}_log`, `${wood}_wood`, `stripped_${wood}_log`, `stripped_${wood}_wood`]),
  ...PLANKS,
  'stick'
];

function furnaceFuelUnits(adapter) {
  const values = new Map([
    ['coal_block', 80], ['coal', 8], ['charcoal', 8], ['stick', 0.5],
    ...WOODS.flatMap(wood => [
      [`${wood}_log`, 12], [`${wood}_wood`, 12],
      [`stripped_${wood}_log`, 12], [`stripped_${wood}_wood`, 12],
      [`${wood}_planks`, 1.5]
    ]),
    ['crimson_planks', 1.5], ['warped_planks', 1.5], ['bamboo_planks', 1.5]
  ]);
  return [...values].reduce((sum, [name, value]) => sum + adapter.getItemCount(name) * value, 0);
}

function storageSources(names, assignments = getSharedChestAssignments()) {
  const roots = names.map(name => assignments[name] || assignments[
    name === 'torch' ? 'chest' : name === 'charcoal' ? 'coal' : name === 'stick' ? 'oak_planks' :
      name.endsWith('_planks') ? 'oak_planks' : LOG_PLANKS[name] ? 'oak_log' : name
  ]).filter(Boolean);
  const keys = new Set();
  for (let source of roots) {
    while (source && !keys.has(source)) {
      keys.add(source);
      source = OVERFLOW_CHESTS[source];
    }
  }
  return [...keys].map(parseChestPositionKey);
}

// Snapshot bersama bukan bukti isi terkini, tetapi berguna sebagai indeks
// kandidat ketika item berada di mirror/overflow yang belum tercatat sebagai
// assignment. Caller tetap melakukan withdraw live dan hanya menghitung item
// yang benar-benar masuk inventaris.
function snapshotSources(bot, adapter, names) {
  const db = adapter?.sharedWorldObserver?.memory?.db;
  const context = worldContext(bot);
  if (!db || !context?.world || !context?.dimension) return [];
  try {
    const rows = db.prepare(`
      SELECT c.x, c.y, c.z, i.itemJson
      FROM storage_containers c
      JOIN storage_container_items i
        ON i.world=c.world AND i.dimension=c.dimension
       AND i.x=c.x AND i.y=c.y AND i.z=c.z
      WHERE c.world=? AND c.dimension=?
      ORDER BY c.observedAt DESC
    `).all(context.world, context.dimension);
    const wanted = new Set(names);
    const positions = new Map();
    for (const row of rows) {
      let item;
      try { item = JSON.parse(row.itemJson); } catch { continue; }
      if (!wanted.has(item?.name)) continue;
      const key = `${row.x},${row.y},${row.z}`;
      positions.set(key, { x: row.x, y: row.y, z: row.z });
    }
    return [...positions.values()];
  } catch {
    // Database lama mungkin belum memiliki tabel snapshot; live scan tetap berjalan.
    return [];
  }
}

async function supplyStorageMaterial({ bot, adapter, name, required, log = () => {}, smelt = smeltStorageStone,
  withLock = null, allowProcessing = true, fallbackSearch = true, fallbackSearchCount = 96, fallbackMaxDistance = 48,
  waitForSmeltOutput = false, smeltTimeoutMs, smeltPollMs, withdrawExisting = true, allowCrafting = false,
  preferCobblestone = false }) {
  if (!Number.isInteger(required) || required < 0) throw new TypeError('Material target must be a nonnegative integer.');
  const count = names => names.reduce((sum, item) => sum + adapter.getItemCount(item), 0);
  const runExclusive = typeof withLock === 'function' ? withLock : async action => action();
  const before = count([name]);
  const take = async (names, target, { searchLive = fallbackSearch, searchCount = fallbackSearchCount } = {}) => {
    const mappedSources = [
      ...storageSources(names),
      ...snapshotSources(bot, adapter, names)
    ].filter((source, index, all) => all.findIndex(candidate =>
      candidate.x === source.x && candidate.y === source.y && candidate.z === source.z
    ) === index);
    const attempted = new Set(mappedSources.map(source => `${source.x},${source.y},${source.z}`));
    const takeFrom = async source => {
      // A withdrawal can contain one item type; revisit at most once per accepted type.
      for (let attempt = 0; attempt < names.length && count(names) < target; attempt += 1) {
        const prior = count(names);
        try {
          await runExclusive(
            () => adapter.withdrawFromChest(source, names, target - prior),
            { resourceKey: chestResourceKey(source, adapter) }
          );
        }
        catch (error) { log(`Supply ${names.join('/')} (${source.x},${source.y},${source.z}): ${error.message}`); }
        const added = count(names) - prior;
        if (added <= 0) break;
        log(`Supply terkonfirmasi ${added} ${names.join('/')} dari (${source.x},${source.y},${source.z}).`);
      }
    };
    for (const source of mappedSources) {
      await takeFrom(source);
      if (count(names) >= target) break;
    }
    // Assignment memory is a fast path, not a closed world. Re-scan live containers
    // when a player/miner added a source after the last shared-memory snapshot.
    if (searchLive && count(names) < target && typeof adapter.findMatchingChest === 'function') {
      let scans = 0;
      const boundedSearchCount = Math.max(1, Number(searchCount) || 1);
      while (count(names) < target && scans < boundedSearchCount) {
        const source = await adapter.findMatchingChest(names, {
          maxDistance: fallbackMaxDistance,
          count: boundedSearchCount,
          excludePositions: [...attempted].map(raw => {
            const [x, y, z] = raw.split(',').map(Number);
            return { x, y, z };
          })
        });
        scans += 1;
        if (!source) break;
        const sourceKey = `${source.x},${source.y},${source.z}`;
        if (attempted.has(sourceKey)) break;
        attempted.add(sourceKey);
        log(`Supply fallback live: chest baru (${source.x},${source.y},${source.z}) untuk ${names.join('/')}.`);
        await takeFrom(source);
      }
    }
    return count(names);
  };
  const craft = async (item, recipes) => {
    if (recipes <= 0) return 0;
    const prior = count([item]);
    try { await adapter.craftItem(item, recipes); }
    catch (error) { log(`Craft ${item}: ${error.message}`); }
    const added = Math.max(0, count([item]) - prior);
    log(`Craft terkonfirmasi: ${added} ${item}.`);
    return added;
  };
  const ensurePlanks = async target => {
    await take(PLANKS, target);
    if (count(PLANKS) >= target) return;
    const logs = Object.keys(LOG_PLANKS);
    await take(logs, Math.ceil((target - count(PLANKS)) / 4));
    for (const [input, output] of Object.entries(LOG_PLANKS)) {
      if (count(PLANKS) >= target) break;
      await craft(output, Math.min(adapter.getItemCount(input), Math.ceil((target - count(PLANKS)) / 4)));
    }
  };
  const ensureCraftingTableNear = async () => {
    const nearbyTable = typeof bot?.findBlock === 'function'
      ? bot.findBlock({ matching: block => block?.name === 'crafting_table', maxDistance: 16 })
      : null;
    if (nearbyTable) return true;
    if (count(['crafting_table']) <= 0) {
      await ensurePlanks(4);
      await craft('crafting_table', 1);
    }
    if (count(['crafting_table']) <= 0 || typeof adapter.placeBlockAt !== 'function' || !bot?.entity?.position) return false;
    const center = bot.entity.position;
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (const y of [Math.floor(center.y), Math.floor(center.y) - 1, Math.floor(center.y) + 1]) {
            const target = { x: Math.floor(center.x) + dx, y, z: Math.floor(center.z) + dz };
            const below = adapter.blockAt(target.y > -64 ? { ...target, y: target.y - 1 } : target);
            const current = adapter.blockAt(target);
            if (!below || below.boundingBox !== 'block' || !current || !['air', 'cave_air', 'void_air'].includes(current.name)) continue;
            if (!await adapter.navigateNear(below.position || below, 3)) continue;
            if (!await adapter.equipItem('crafting_table', 'hand')) continue;
            try { await adapter.placeBlockAt(target, below, new Vec3(0, 1, 0)); }
            catch (error) { log(`Crafting table placement: ${error.message}`); continue; }
            if (adapter.blockAt(target)?.name === 'crafting_table') {
              log(`CRAFTING_TABLE_BUILT ${JSON.stringify(target)}`);
              return true;
            }
          }
        }
      }
    }
    log('Crafting table belum bisa ditempatkan di pijakan aman sekitar worker.');
    return false;
  };
  // Production workers should not withdraw an already prepared output from the
  // builder's stock just to carry it around and deposit it again. Callers that
  // need to consume existing stock keep the historical default.
  if (withdrawExisting) await take([name], required);
  let missing = Math.max(0, required - count([name]));
  if ((!allowProcessing && !allowCrafting) || missing === 0) {
    const available = count([name]);
    return { available, added: Math.max(0, available - before), missing: Math.max(0, required - available) };
  }
  if (name === 'stone_bricks' && missing > 0 && allowProcessing) {
    const target = Math.ceil(missing / 4) * 4;
    // Untuk batch konstruksi, cobblestone adalah sumber utama yang memang
    // tersedia dalam jumlah besar. Jangan lebih dulu menyapu seluruh rantai
    // chest `stone` hanya demi beberapa output lama; ambil output yang sudah
    // berada di inventory, lalu langsung lebur kekurangannya dari cobble.
    if (!preferCobblestone) await take(['stone'], target, { searchLive: false });
    if (count(['stone']) < target) {
      const toSmelt = Math.min(768, target - count(['stone']));
      // The mapped cobblestone half may be empty while its adjacent live
      // overflow chest contains the miner output. Search the bounded storage
      // radius instead of treating the assignment as a closed world.
      await take(['cobblestone'], toSmelt, { searchLive: true, searchCount: 64 });
      // Fuel tersebar di beberapa container live dan tidak semuanya tercatat di assignment
      // canonical. Cari lebih luas khusus fuel agar furnace dapat mengisi batch penuh; scan
      // besar ini tidak dipakai untuk stone, cobble, brick, chest, atau torch.
      let fuelUnits = furnaceFuelUnits(adapter);
      if (fuelUnits < toSmelt) {
        // Prefer ordinary coal/charcoal. The live storage layout commonly has
        // coal in an overflow chest while the canonical assignment points at
        // another container. Looking for coal blocks first caused two bounded
        // chest scans before the furnace was even opened.
        await take(['coal', 'charcoal'], Math.ceil((toSmelt - fuelUnits) / 8), { searchLive: true, searchCount: 24 });
        fuelUnits = furnaceFuelUnits(adapter);
      }
      if (fuelUnits < toSmelt) {
        // A coal block is still a valid fallback, but only scan for it after
        // ordinary fuel has been exhausted.
        await take(['coal_block'], Math.ceil((toSmelt - fuelUnits) / 80), { searchLive: true, searchCount: 24 });
        fuelUnits = furnaceFuelUnits(adapter);
      }
      if (fuelUnits < toSmelt) {
        // Stick mempunyai assignment canonical sendiri dan cukup untuk membuka
        // batch pertama. Jangan mengembangkan pencarian ke seluruh chest kayu
        // sebelum sumber ini dicoba: pada gudang besar, daftar campuran fuel
        // membuat worker membuka puluhan container tanpa pernah sampai ke stick.
        const stickNeeded = Math.ceil((toSmelt - fuelUnits) / 0.5);
        await take(['stick'], stickNeeded, { searchLive: true, searchCount: 24 });
        fuelUnits = furnaceFuelUnits(adapter);
      }
      if (fuelUnits < toSmelt) {
        // Fallback terakhir tetap boleh memakai log/planks, tetapi dibatasi ke
        // beberapa jenis yang sudah dipetakan agar worker tidak terseret scan
        // seluruh kategori kayu.
        const fuelNeeded = Math.max(1, Math.ceil((toSmelt - fuelUnits) / 8));
        await take(FURNACE_WOOD_FUEL, fuelNeeded, { searchLive: true, searchCount: 24 });
      }
      try {
        await smelt({ bot, adapter, count: toSmelt, waitForOutput: waitForSmeltOutput, timeoutMs: smeltTimeoutMs, pollMs: smeltPollMs, log });
      }
      catch (error) { log(`Smelting: ${error.message}`); }
    }
    await craft('stone_bricks', Math.min(Math.ceil(missing / 4), Math.floor(count(['stone']) / 4)));
  } else if (name === 'chest' && missing > 0 && (allowProcessing || allowCrafting)) {
    // Bound intermediate planks to sixteen slots even for a whole-room request.
    missing = Math.min(128, missing);
    await ensurePlanks(missing * 8);
    await craft('chest', Math.min(missing, Math.floor(count(PLANKS) / 8)));
  } else if (/^[a-z]+_door$/.test(name) && missing > 0 && allowCrafting) {
    const recipes = Math.ceil(Math.min(32, missing) / 3);
    await ensurePlanks(recipes * 6);
    await craft(name, Math.min(recipes, Math.floor(count(PLANKS) / 6)));
  } else if (/^(stone|wooden)_axe$/.test(name) && missing > 0 && allowCrafting) {
    // Bootstrap forestry dari stok yang sudah ada: tanpa kapak, wood worker
    // tidak dapat menghasilkan log untuk fuel maupun pintu gudang.
    missing = Math.min(8, missing);
    if (name === 'stone_axe') await take(['cobblestone'], missing * 3);
    else await ensurePlanks(missing * 3);
    await take(['stick'], missing * 2);
    const material = name === 'stone_axe' ? ['cobblestone'] : PLANKS;
    await craft(name, Math.min(missing, Math.floor(count(material) / 3), Math.floor(count(['stick']) / 2)));
  } else if (name === 'furnace' && missing > 0 && allowProcessing) {
    missing = Math.min(32, missing);
    await take(['cobblestone'], missing * 8);
    if (count(['cobblestone']) >= 8 && await ensureCraftingTableNear()) {
      await craft('furnace', Math.min(missing, Math.floor(count(['cobblestone']) / 8)));
    }
  } else if (/^iron_(pickaxe|shovel|axe)$/.test(name) && missing > 0) {
    missing = Math.min(8, missing);
    const ingots = name.endsWith('shovel') ? 1 : 3;
    await take(['iron_ingot'], missing * ingots);
    await take(['stick'], missing * 2);
    if (count(['stick']) < missing * 2) {
      const recipes = Math.ceil((missing * 2 - count(['stick'])) / 4);
      await ensurePlanks(recipes * 2);
      await craft('stick', Math.min(recipes, Math.floor(count(PLANKS) / 2)));
    }
    await craft(name, Math.min(missing, Math.floor(count(['iron_ingot']) / ingots), Math.floor(count(['stick']) / 2)));
  } else if (name === 'torch' && missing > 0) {
    const recipes = Math.ceil(Math.min(256, missing) / 4);
    await take(['coal', 'charcoal'], recipes);
    await take(['stick'], recipes);
    if (count(['stick']) < recipes) {
      const stickRecipes = Math.ceil((recipes - count(['stick'])) / 4);
      await ensurePlanks(stickRecipes * 2);
      await craft('stick', Math.min(stickRecipes, Math.floor(count(PLANKS) / 2)));
    }
    await craft('torch', Math.min(recipes, count(['stick']), count(['coal', 'charcoal'])));
  }
  const available = count([name]);
  return { available, added: Math.max(0, available - before), missing: Math.max(0, required - available) };
}

module.exports = { storageSources, supplyStorageMaterial };
