/** Persiapan tool di base; caller memegang lock logistik selama seluruh pemanggilan. */
const { walkToBase } = require('./walkToBase');
const { getSharedChestAssignments, parseChestPositionKey, TOOLS_CHEST, OVERFLOW_CHESTS } = require('./storageMemory');
const { chestResourceKey } = require('./storageRoomLock');

const TOOL_BASE = Object.freeze({ x: -185, y: 71, z: -352 });
const KINDS = ['pickaxe', 'shovel'];
const TIERS = ['netherite', 'diamond', 'iron', 'stone'];
const LOG_PLANKS = Object.fromEntries([
  ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
    .flatMap(wood => ['log', 'wood'].flatMap(part => ['', 'stripped_'].map(prefix => [`${prefix}${wood}_${part}`, `${wood}_planks`]))),
  ...['crimson', 'warped'].flatMap(wood => ['stem', 'hyphae']
    .flatMap(part => ['', 'stripped_'].map(prefix => [`${prefix}${wood}_${part}`, `${wood}_planks`]))),
  ['bamboo_block', 'bamboo_planks'], ['stripped_bamboo_block', 'bamboo_planks']
]);
const PLANK_NAMES = [...new Set(Object.values(LOG_PLANKS))];
const key = pos => `${pos.x},${pos.y},${pos.z}`;
const validPosition = pos => pos && ['x', 'y', 'z'].every(axis => Number.isFinite(pos[axis]));
const distance = (a, b) => validPosition(a) && validPosition(b) ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
const isTool = name => KINDS.some(kind => TIERS.some(tier => name === `${tier}_${kind}`));
const isMaterial = name => ['iron_ingot', 'cobblestone', 'cobbled_deepslate', 'stick'].includes(name) || name.endsWith('_planks') || Object.hasOwn(LOG_PLANKS, name);

function counts(items) {
  const result = {};
  for (const item of items) {
    if (typeof item?.name !== 'string' || !Number.isInteger(item.count) || item.count <= 0) continue;
    if (isTool(item.name) || isMaterial(item.name)) result[item.name] = (result[item.name] || 0) + item.count;
  }
  return result;
}

/** execute=false hanya memeriksa inventaris. ready wajib diperiksa sebelum landscaping. */
async function prepareStorageRoomTools({ adapter, bot = adapter?.bot, execute = false, base = TOOL_BASE,
  sourceDistance = 128, sourceSearchCount = 32, allowTerrainWork = false, terrainBreakAllowlist = null,
  fallbackGoalYOffsets = [], stageDistance, walk = walkToBase, withLock = null, log = () => {} } = {}) {
  if (typeof adapter?.getInventoryItems !== 'function') throw new Error('Adapter tool wajib menyediakan getInventoryItems().');
  if (!validPosition(base)) throw new Error('Koordinat base tool tidak valid.');
  const limit = Number.isFinite(sourceSearchCount) ? Math.min(64, Math.max(0, Math.floor(sourceSearchCount))) : 32;
  const radius = Number.isFinite(sourceDistance) ? Math.min(128, Math.max(0, sourceDistance)) : 128;
  const inventory = () => counts(adapter.getInventoryItems());
  const count = name => inventory()[name] || 0;
  const selectedTool = kind => TIERS.map(tier => `${tier}_${kind}`).find(name => count(name) > 0);
  const evidence = { base: { goal: { ...base }, reached: false }, scan: { limit, positions: [], failed: [] }, withdrawals: [], crafts: [], failures: [] };
  const fail = (stage, message, details = {}) => {
    evidence.failures.push({ stage, ...details, message });
    log(`Persiapan tool ${stage}: ${message}`);
  };
  const finish = reason => {
    const items = inventory();
    const tools = Object.fromEntries(KINDS.map(kind => {
      const name = TIERS.map(tier => `${tier}_${kind}`).find(tool => items[tool] > 0);
      return [kind, name ? { name, count: items[name] } : null];
    }));
    const missing = KINDS.filter(kind => !tools[kind]);
    const ready = missing.length === 0;
    const result = { ready, status: ready ? 'READY' : 'BLOCKED', reason: ready ? null : reason || 'missing_tools', missing, tools, inventory: items, ...evidence };
    log(`Persiapan tool ${result.status}: ${JSON.stringify({ tools, missing, reason: result.reason })}`);
    return result;
  };
  if (KINDS.every(selectedTool)) return finish();
  if (!execute) return finish('preparation_not_authorized');

  const previousMovements = bot?.pathfinder?.movements;
  try {
    let arrival;
    try {
      arrival = await walk({ bot, goal: base, range: 4, maxGotoMs: 45000, minimumY: 58,
        allowTerrainWork, terrainBreakAllowlist, fallbackGoalYOffsets, stageDistance,
        allow1by1Towers: false, scaffoldingBlocks: [], log });
    } catch (error) { fail('base', error.message); }
    const position = bot?.entity?.position || adapter.getPosition?.();
    evidence.base.position = validPosition(position) ? { x: position.x, y: position.y, z: position.z } : null;
    evidence.base.reached = arrival?.success === true && distance(position, base) <= 5;
    if (!evidence.base.reached) {
      fail('base', arrival?.reason || 'Posisi belum terkonfirmasi dekat base.');
      return finish('base_unreachable');
    }

    // Satu indeks isi peti untuk semua resep. Pengambilan berikutnya hanya menuju sumber terindeks.
    const assignments = getSharedChestAssignments(log);
    const known = [TOOLS_CHEST, OVERFLOW_CHESTS[TOOLS_CHEST],
      ...['iron_ingot', 'cobblestone', 'cobbled_deepslate', 'stick', 'oak_planks', 'oak_log', 'stripped_oak_log'].map(name => assignments[name])];
    const primary = known.filter(Boolean);
    for (const source of primary) {
      let overflow = OVERFLOW_CHESTS[source];
      const seen = new Set(primary);
      while (overflow && !seen.has(overflow)) {
        known.push(overflow);
        seen.add(overflow);
        overflow = OVERFLOW_CHESTS[overflow];
      }
    }
    const visited = new Set();
    const sources = [];
    const sourceHasTool = kind => Boolean(selectedTool(kind)) || sources.some(source =>
      TIERS.some(tier => source.items[`${tier}_${kind}`] > 0));
    const readPosition = async (pos, { force = false } = {}) => {
      const positionKey = key(pos);
      if (evidence.scan.positions.length >= limit && !force) return;
      if (distance(pos, base) > radius || (visited.has(positionKey) && !force)) return;
      visited.add(positionKey);
      if (!evidence.scan.positions.some(item => key(item) === positionKey)) evidence.scan.positions.push({ ...pos });
      let chest;
      try {
        const readChest = async () => {
          try {
            chest = await adapter.openChestAt(pos);
            if (!chest || typeof chest.containerItems !== 'function') throw new Error('Isi peti tidak dapat dibaca.');
            const source = { position: { ...pos }, items: counts(chest.containerItems()) };
            const existing = sources.findIndex(item => key(item.position) === positionKey);
            if (existing >= 0) sources[existing] = source;
            else sources.push(source);
          } finally {
            // Tutup sebelum resource lock dilepas; operasi chest fisik selesai
            // secara atomik untuk worker lain.
            if (chest?.close) await chest.close();
          }
        };
        // Membaca double chest juga mengubah state UI/container server. Lindungi
        // seluruh buka-baca-tutup, bukan hanya withdraw, agar beberapa miner
        // tidak membuat satu sama lain menunggu sampai lock timeout.
        if (typeof withLock === 'function') {
          await withLock(readChest, { resourceKey: chestResourceKey(pos, adapter) });
        } else {
          await readChest();
        }
      } catch (error) {
        evidence.scan.failed.push({ ...pos });
        fail('baca_peti', error.message, { position: { ...pos } });
      }
    };
    const discoverMatchingSource = async names => {
      if (typeof adapter.findMatchingChest !== 'function') return false;
      try {
        const source = await adapter.findMatchingChest(names, {
          maxDistance: radius,
          count: Math.max(1, limit),
          excludePositions: sources.map(item => item.position)
        });
        if (!source) return false;
        await readPosition(source, { force: true });
        return true;
      } catch (error) {
        fail('pencarian_bahan', error.message, { names });
        return false;
      }
    };
    // Shared memory diprioritaskan. Discovery live hanya diperlukan bila sumber yang sudah
    // diketahui belum menyediakan kedua tool; ini mencegah worker baru membuka puluhan chest
    // yang tidak relevan sebelum mulai menuju quarry.
    for (const raw of known.filter(Boolean)) {
      if (evidence.scan.positions.length >= limit || KINDS.every(sourceHasTool)) break;
      await readPosition(parseChestPositionKey(raw));
    }
    if (!KINDS.every(sourceHasTool) && limit > evidence.scan.positions.length && radius > 0) {
      let discovered = [];
      try { discovered = await adapter.findChestPositions(radius, limit); }
      catch (error) { fail('pencarian', error.message); }
      for (const pos of discovered) {
        if (evidence.scan.positions.length >= limit || KINDS.every(sourceHasTool)) break;
        await readPosition(pos);
      }
    }

    const namesAvailable = predicate => [...new Set([...Object.keys(inventory()), ...sources.flatMap(source => Object.keys(source.items))])].filter(predicate);
    const acquire = async (name, target) => {
      for (const source of sources) {
        const before = count(name);
        if (before >= target) return true;
        if (!(source.items[name] > 0)) continue;
        const requested = Math.min(target - before, source.items[name]);
        let response;
        let errorMessage;
        try {
          const withdraw = () => adapter.withdrawFromChest(source.position, [name], requested);
          response = typeof withLock === 'function'
            ? await withLock(withdraw, { resourceKey: chestResourceKey(source.position, adapter) })
            : await withdraw();
        }
        catch (error) { errorMessage = error.message; }
        const after = count(name);
        const withdrawn = Math.max(0, after - before);
        evidence.withdrawals.push({ name, position: source.position, requested, before, after, withdrawn, reported: response?.withdrawn ?? null, error: errorMessage || null });
        // Tolak pengambilan semu dan jangan ulangi sumber gagal/berubah pada resep berikutnya.
        source.items[name] = errorMessage || withdrawn !== requested ? 0 : Math.max(0, source.items[name] - withdrawn);
        if (errorMessage || withdrawn !== requested) fail('ambil', errorMessage || `Inventaris ${name} bertambah ${withdrawn}, diminta ${requested}.`, { name, position: source.position });
      }
      return count(name) >= target;
    };
    const failedCrafts = new Set();
    const craft = async name => {
      if (failedCrafts.has(name)) return false;
      const before = count(name);
      let reported;
      let errorMessage;
      try { reported = await adapter.craftItem(name, 1); }
      catch (error) { errorMessage = error.message; }
      const after = count(name);
      const produced = Math.max(0, after - before);
      evidence.crafts.push({ name, recipes: 1, before, after, produced, reported: reported ?? null, error: errorMessage || null });
      if (errorMessage || produced === 0) fail('craft', errorMessage || `Tidak ada tambahan ${name} di inventaris.`, { name });
      if (produced === 0) failedCrafts.add(name);
      return produced > 0;
    };
    const ensureSticks = async () => {
      if (await acquire('stick', 2)) return true;
      await discoverMatchingSource(['stick']);
      if (await acquire('stick', 2)) return true;
      let planks = namesAvailable(name => name.endsWith('_planks'));
      const plankCount = () => Object.entries(inventory()).filter(([name]) => name.endsWith('_planks')).reduce((sum, [, n]) => sum + n, 0);
      for (const name of planks) {
        if (plankCount() >= 2) break;
        await acquire(name, count(name) + 2 - plankCount());
      }
      if (plankCount() < 2) {
        await discoverMatchingSource([...new Set([...PLANK_NAMES, ...Object.keys(LOG_PLANKS)])]);
        planks = namesAvailable(name => name.endsWith('_planks'));
        for (const name of namesAvailable(name => Object.hasOwn(LOG_PLANKS, name))) {
          if (!await acquire(name, 1)) continue;
          if (await craft(LOG_PLANKS[name]) && plankCount() >= 2) break;
        }
      }
      if (plankCount() >= 2 && await craft('stick')) return count('stick') >= 2;
      fail('bahan', 'Stick tidak cukup dan pembuatan dari papan/log belum berhasil.', { name: 'stick' });
      return false;
    };

    for (const kind of KINDS) {
      if (selectedTool(kind)) continue;
      for (const tier of ['iron', 'stone']) {
        const tool = `${tier}_${kind}`;
        if (await acquire(tool, 1)) break;
        const materials = tier === 'iron' ? ['iron_ingot'] : ['cobblestone', 'cobbled_deepslate'];
        const amount = kind === 'pickaxe' ? 3 : 1;
        // Pilih satu recipe material yang benar-benar cukup. Mengambil sebagian
        // cobblestone lalu mencampurnya dengan cobbled_deepslate membuat recipe
        // stone tool tidak valid dan menghabiskan stok tanpa menghasilkan tool.
        const availableFor = material => count(material) + sources.reduce((total, source) => total + (source.items[material] || 0), 0);
        let material = materials.find(candidate => availableFor(candidate) >= amount);
        if (!material && typeof adapter.findMatchingChest === 'function') {
          await discoverMatchingSource(materials);
          material = materials.find(candidate => availableFor(candidate) >= amount);
        }
        if (!material || !await acquire(material, amount)) {
          fail('bahan', `${tool} perlu ${amount} ${materials.join(' atau ')}; tersedia ${materials.map(item => `${item}=${availableFor(item)}`).join(', ')}.`, { name: materials[0], tool });
          continue;
        }
        if (await ensureSticks() && await craft(tool)) break;
      }
    }
    return finish();
  } finally {
    if (previousMovements && bot?.pathfinder?.setMovements) bot.pathfinder.setMovements(previousMovements);
  }
}

module.exports = { prepareStorageRoomTools, TOOL_BASE };
