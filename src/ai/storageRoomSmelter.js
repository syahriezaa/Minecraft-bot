/** Produksi stone melalui furnace biasa; dipanggil saat lock logistik dipegang. */
const { Vec3 } = require('vec3');
const { isStorageAccessPosition } = require('./storageAccessPolicy');

const FUEL_VALUES = new Map([
  ['coal', 8], ['charcoal', 8],
  // Coal block is a valid furnace fuel and is already stored in the processed
  // ore chest. Treating it as an ordinary ore made the materials worker
  // schedule input without enough fuel, then leave the builder waiting.
  ['coal_block', 80],
  ['oak_log', 12], ['spruce_log', 12], ['birch_log', 12], ['jungle_log', 12],
  ['acacia_log', 12], ['dark_oak_log', 12], ['mangrove_log', 12], ['cherry_log', 12],
  ['pale_oak_log', 12], ['crimson_stem', 12], ['warped_stem', 12]
]);
// Coal tetap diprioritaskan, tetapi produksi tidak boleh berhenti hanya karena
// stok coal belum terpetakan. Planks, wood, dan stick adalah fuel furnace yang
// sah dan biasanya lebih mudah ditemukan di gudang daripada coal.
for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped']) {
  FUEL_VALUES.set(`${wood}_wood`, 12);
  FUEL_VALUES.set(`stripped_${wood}_log`, 12);
  FUEL_VALUES.set(`stripped_${wood}_wood`, 12);
  FUEL_VALUES.set(`${wood}_planks`, 1.5);
}
FUEL_VALUES.set('bamboo_planks', 1.5);
FUEL_VALUES.set('stick', 0.5);

async function smeltStorageStone({ bot, adapter, count = 32, maxFurnaces = 8,
  timeoutMs = 110000, pollMs = 5000, openTimeoutMs = 3500, waitForOutput = true,
  maxConsecutiveNavigationFailures = 2, log = () => {} }) {
  if (typeof bot.findBlocks !== 'function' || typeof bot.openFurnace !== 'function') {
    log('Smelting dilewati: API furnace Mineflayer belum tersedia.');
    return 0;
  }
  const positions = [];
  const seen = new Set();
  const addPosition = pos => {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    if (seen.has(key)) return;
    // Furnace yang telanjur ditempatkan di lorong/lantai gudang bukan workstation yang sah.
    // Jangan isi dengan cobblestone atau fuel baru; biarkan kosong agar dapat dibongkar aman.
    if (isStorageAccessPosition(pos)) return;
    const block = adapter?.blockAt?.({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    // Production adapters return a named block. Small unit-test adapters may
    // only echo the position, so validate when a block name is available and
    // preserve the findBlocks contract otherwise.
    if (!block || typeof block.name === 'string' && block.name !== 'furnace') return;
    seen.add(key);
    positions.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
  };
  // Mineflayer's findBlocks result can be stale or incomplete just after a
  // furnace is placed. Keep its result, but validate and merge it with the
  // worker-local voxel scan below instead of treating either source as final.
  for (const pos of bot.findBlocks({ matching: block => block?.name === 'furnace', maxDistance: 32, count: maxFurnaces }) || []) {
    addPosition(pos);
    if (positions.length >= maxFurnaces) break;
  }
  // Re-scan only the worker's nearby 17x17x9 volume so fresh smelters are
  // usable immediately without a world-wide container search. This also
  // handles a furnace known by the shared observer but omitted by findBlocks.
  if (adapter?.blockAt && bot.entity?.position && positions.length < maxFurnaces) {
    const center = bot.entity.position;
    for (let x = Math.floor(center.x) - 8; x <= Math.floor(center.x) + 8 && positions.length < maxFurnaces; x += 1) {
      for (let y = Math.floor(center.y) - 4; y <= Math.floor(center.y) + 4 && positions.length < maxFurnaces; y += 1) {
        for (let z = Math.floor(center.z) - 8; z <= Math.floor(center.z) + 8 && positions.length < maxFurnaces; z += 1) {
          const block = adapter.blockAt({ x, y, z });
          if (block?.name !== 'furnace') continue;
          addPosition({ x, y, z });
        }
      }
    }
  }
  if (!positions.length) { log('Smelting: furnace biasa belum ditemukan di sekitar base.'); return 0; }
  log(`Smelting: ${positions.length} furnace siap dipakai (${positions.slice(0, 8).map(pos => `${pos.x},${pos.y},${pos.z}`).join(' | ')}).`);
  if (bot.entity?.position) {
    const origin = bot.entity.position;
    positions.sort((a, b) => {
      const da = Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z);
      const db = Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z);
      return da - db;
    });
  }
  const perFurnace = Math.min(64, Math.max(8, Math.ceil(count / positions.length / 8) * 8));
  const jobs = [];
  const failedOpen = new Set();
  let consecutiveNavigationFailures = 0;
  const positionKey = pos => `${pos.x},${pos.y},${pos.z}`;
  const open = async pos => {
    const id = positionKey(pos);
    if (failedOpen.has(id)) return null;
    // openFurnace needs Mineflayer's live block instance. The shared observer
    // may return a structurally correct memory record, but that record is not
    // always accepted by the protocol window handler.
    const liveBlock = typeof bot.blockAt === 'function'
      ? bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      : null;
    const block = liveBlock?.name === 'furnace' ? liveBlock : adapter.blockAt(pos);
    if (!block) {
      log(`Smelting dilewati: furnace (${id}) tidak lagi tersedia di cache dunia.`);
      return null;
    }
    if (typeof block.name === 'string' && block.name !== 'furnace') {
      log(`Smelting dilewati: blok live (${id}) berubah menjadi ${block.name || 'unknown'}.`);
      return null;
    }
    let timer;
    const pending = Promise.resolve().then(() => bot.openFurnace(block));
    // Sebuah windowOpen yang tidak pernah datang tidak boleh menahan lock logistik selama 20 detik
    // atau membuat runner tidak pernah kembali ke pembangunan.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`furnace window timeout di (${id})`)), openTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      failedOpen.add(id);
      pending.then(furnace => furnace?.close?.()).catch(() => {});
      log(`Smelting dilewati: ${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  let collected = 0;
  let scheduled = 0;
  for (const pos of positions) {
    if (collected + scheduled >= count) break;
    if (!await adapter.navigateNear(pos, 3)) {
      consecutiveNavigationFailures += 1;
      if (consecutiveNavigationFailures >= Math.max(1, Number(maxConsecutiveNavigationFailures) || 2)) {
        log(`Smelting berhenti mencari furnace setelah ${consecutiveNavigationFailures} kegagalan akses beruntun.`);
        break;
      }
      continue;
    }
    consecutiveNavigationFailures = 0;
    const furnace = await open(pos);
    if (!furnace) continue;
    try {
      const input = furnace.inputItem();
      const output = furnace.outputItem();
      // Furnace dengan resep lain tetap menjadi milik pekerjaan semula.
      if (input && input.name !== 'cobblestone' || output && output.name !== 'stone') continue;
      if (output) { collected += (await furnace.takeOutput()).count; }
      if (collected >= count) break;
      let inputCount = input?.count || 0;
      const fuelInSlot = furnace.fuelItem();
      const fuelName = fuelInSlot?.name || [...FUEL_VALUES.keys()].find(name => adapter.getItemCount(name) > 0);
      const fuel = bot.inventory.items().find(item => item.name === fuelName);
      const cobble = bot.inventory.items().find(item => item.name === 'cobblestone');
      const fuelValue = FUEL_VALUES.get(fuelName) || 0;
      const storedFuel = fuelInSlot && fuelInSlot.name === fuelName ? fuelInSlot.count : 0;
      const fuelAvailable = fuelValue > 0 ? adapter.getItemCount(fuelName) : 0;
      const capacity = (storedFuel + fuelAvailable) * fuelValue;
      const desired = Math.min(perFurnace, count - collected - scheduled, inputCount + adapter.getItemCount('cobblestone'), capacity);
      if (desired <= 0) {
        log(`Smelting furnace (${pos.x},${pos.y},${pos.z}) belum bisa dijadwalkan: inventory cobblestone=${adapter.getItemCount('cobblestone')}, fuel=${fuelName || 'none'}:${fuelAvailable}, input=${inputCount}, capacity=${capacity}.`);
      }
      const addInput = Math.max(0, desired - inputCount);
      const neededFuel = fuelValue > 0
        ? Math.max(0, Math.ceil(Math.max(inputCount, desired) / fuelValue) - storedFuel)
        : 0;
      if (neededFuel > 0 && fuel) {
        await furnace.putFuel(fuel.type, fuel.metadata ?? null, Math.min(neededFuel, fuelAvailable));
        log(`Smelting fuel ${fuelName}x${Math.min(neededFuel, fuelAvailable)} di (${pos.x},${pos.y},${pos.z}).`);
      } else if (neededFuel > 0) {
        log(`Smelting menunggu fuel di (${pos.x},${pos.y},${pos.z}).`);
      }
      if (cobble && addInput > 0) {
        await furnace.putInput(cobble.type, cobble.metadata ?? null, addInput);
        inputCount += addInput;
        log(`Smelting ${inputCount} cobblestone di (${pos.x},${pos.y},${pos.z}).`);
      }
      log(`Smelting furnace state (${pos.x},${pos.y},${pos.z}): input=${furnace.inputItem()?.count || 0}, fuel=${furnace.fuelItem()?.name || 'none'}:${furnace.fuelItem()?.count || 0}.`);
      if (inputCount) { scheduled += inputCount; jobs.push(pos); }
    } finally { furnace.close(); }
  }
  if (!waitForOutput) {
    log(`Smelting dijadwalkan: ${jobs.length} furnace; output akan diambil pada retry berikutnya.`);
    return collected;
  }
  const deadline = Date.now() + timeoutMs;
  while (jobs.length && collected < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      const pos = jobs[i];
      if (!await adapter.navigateNear(pos, 3)) { jobs.splice(i, 1); continue; }
      const furnace = await open(pos);
      if (!furnace) { jobs.splice(i, 1); continue; }
      try {
        const output = furnace.outputItem();
        if (output?.name === 'stone') collected += (await furnace.takeOutput()).count;
        const input = furnace.inputItem();
        if (!input || input.name !== 'cobblestone') jobs.splice(i, 1);
      } finally { furnace.close(); }
    }
  }
  log(`Smelting selesai: ${collected} stone diambil; ${jobs.length} furnace masih diproses.`);
  return collected;
}

module.exports = { smeltStorageStone };
