const { Vec3 } = require('vec3');

const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const LOG_NAMES = WOOD_TYPES.flatMap(type => [`${type}_log`, `${type}_wood`]);
const LEAF_NAMES = WOOD_TYPES.map(type => `${type}_leaves`);
const SAPLING_NAMES = WOOD_TYPES.map(type => `${type}_sapling`);
const NATURAL_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE_PLANTS = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine']);
const GROWTH_SPACE = new Set([...AIR, ...REPLACEABLE_PLANTS]);
const LIQUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const BUILDING_BLOCK = /_planks$|_bricks$|glass|_door$|_bed$|chest|barrel|furnace|crafting_table|farmland|rail|redstone/;
const MIN_TREE_LOGS = 4;

const key = p => `${p.x},${p.y},${p.z}`;
const distance2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const stableHash = value => [...String(value)].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function insideProtected(position, structures = [], margin = 6) {
  return structures.some(area => position.x >= area.minX - margin && position.x < area.maxX + margin &&
    position.z >= area.minZ - margin && position.z < area.maxZ + margin);
}

function plantationGrid(center, { rows = 3, columns = 4, spacing = 4 } = {}) {
  const startX = center.x - Math.floor((columns - 1) * spacing / 2);
  const startZ = center.z - Math.floor((rows - 1) * spacing / 2);
  return Array.from({ length: rows * columns }, (_, index) => ({
    x: startX + (index % columns) * spacing,
    z: startZ + Math.floor(index / columns) * spacing
  }));
}

function plantationCandidateOffsets() {
  const preferred = [[-40, 0], [0, 40], [0, -40], [-48, 28], [-48, -28], [40, 32], [40, -32], [-60, 0]];
  const seen = new Set(preferred.map(([x, z]) => `${x},${z}`));
  const candidates = [...preferred];
  for (const radius of [56, 72, 88, 104]) {
    for (let step = 0; step < 16; step += 1) {
      const angle = (Math.PI * 2 * step) / 16;
      const offset = [Math.round((Math.cos(angle) * radius) / 4) * 4, Math.round((Math.sin(angle) * radius) / 4) * 4];
      const id = `${offset[0]},${offset[1]}`;
      if (!seen.has(id)) { seen.add(id); candidates.push(offset); }
    }
  }
  return candidates;
}

function findSurface(adapter, x, z, preferredY) {
  let observed = false;
  for (let y = preferredY + 16; y >= preferredY - 20; y -= 1) {
    const ground = adapter.blockAt({ x, y, z });
    const above = adapter.blockAt({ x, y: y + 1, z });
    if (ground || above) observed = true;
    if (ground && above && NATURAL_GROUND.has(ground.name) && GROWTH_SPACE.has(above.name)) return { x, y, z };
  }
  return observed ? null : { unknown: true, x, z };
}

function evaluatePlantationSite(adapter, center, { base, structures = [], minBaseDistance = 28 } = {}) {
  if (distance2d(center, base) < minBaseDistance || insideProtected(center, structures, 8)) {
    return { safe: false, reason: 'TOO_CLOSE_OR_PROTECTED', plots: [] };
  }
  const plots = [];
  for (const column of plantationGrid(center)) {
    const ground = findSurface(adapter, column.x, column.z, base.y - 1);
    if (ground?.unknown) return { safe: false, reason: 'UNKNOWN_TERRAIN', plots: [] };
    if (!ground || insideProtected(ground, structures, 5)) return { safe: false, reason: 'UNSAFE_GROUND', plots: [] };
    for (let dy = 1; dy <= 7; dy += 1) {
      const block = adapter.blockAt({ x: ground.x, y: ground.y + dy, z: ground.z });
      if (!block || !GROWTH_SPACE.has(block.name)) return { safe: false, reason: 'NO_GROWTH_SPACE', plots: [] };
    }
    for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) {
      const nearby = adapter.blockAt({ x: ground.x + dx, y: ground.y, z: ground.z + dz });
      if (nearby && BUILDING_BLOCK.test(nearby.name)) return { safe: false, reason: 'NEAR_BUILDING', plots: [] };
    }
    plots.push({ x: ground.x, y: ground.y + 1, z: ground.z });
  }
  const levels = plots.map(plot => plot.y);
  if (Math.max(...levels) - Math.min(...levels) > 2) return { safe: false, reason: 'TOO_STEEP', plots: [] };
  return { safe: true, center, plots };
}

function analyzeNaturalTree(adapter, block, structures = []) {
  if (!block?.position || !LOG_NAMES.includes(block.name) || insideProtected(block.position, structures, 5)) return null;
  const family = block.name.replace(/_(log|wood)$/, '');
  const isFamilyLog = candidate => candidate && [`${family}_log`, `${family}_wood`].includes(candidate.name);
  let bottom = { ...block.position };
  while (bottom.y > -63 && isFamilyLog(adapter.blockAt({ ...bottom, y: bottom.y - 1 }))) bottom.y -= 1;

  // Batang pohon besar dapat bercabang dan memakai *_wood di bagian cabang.
  // BFS dibatasi pada volume kecil di sekitar akar agar tidak berubah menjadi
  // pemindaian bangunan kayu, tetapi tetap menangkap seluruh komponen pohon.
  const queue = [bottom];
  const visited = new Set();
  const logs = [];
  while (queue.length && logs.length <= 64) {
    const currentPos = queue.shift();
    const currentKey = key(currentPos);
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    if (Math.abs(currentPos.x - bottom.x) > 4 || Math.abs(currentPos.z - bottom.z) > 4 ||
      currentPos.y < bottom.y || currentPos.y > bottom.y + 20) continue;
    const current = adapter.blockAt(currentPos);
    if (!isFamilyLog(current)) continue;
    if (insideProtected(current.position, structures, 5)) return null;
    logs.push(current);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      queue.push({ x: currentPos.x + dx, y: currentPos.y + dy, z: currentPos.z + dz });
    }
  }
  if (logs.length < MIN_TREE_LOGS || logs.length > 64) return null;
  logs.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.position.z - b.position.z);
  const top = logs.reduce((highest, current) => current.position.y > highest.position.y ? current : highest).position;
  const leaves = [];
  for (let dx = -3; dx <= 3; dx += 1) for (let dy = -2; dy <= 3; dy += 1) for (let dz = -3; dz <= 3; dz += 1) {
    const leaf = adapter.blockAt({ x: top.x + dx, y: top.y + dy, z: top.z + dz });
    if (leaf && LEAF_NAMES.includes(leaf.name)) leaves.push(leaf);
    if (leaf && BUILDING_BLOCK.test(leaf.name)) return null;
  }
  if (leaves.length < 6) return null;
  return { id: key(bottom), type: block.name.replace(/_(log|wood)$/, ''), bottom, logs, leaves };
}

class WoodGathererEngine {
  constructor({ adapter, base = { x: -185, y: 71, z: -352 }, structures = [], surveyNavigate = null,
    unreachableRetryMs = 60000, workerIndex = 0, workerCount = 1, minWorkY = 50, log = () => {} }) {
    this.adapter = adapter;
    this.base = base;
    this.structures = structures;
    this.surveyNavigate = surveyNavigate;
    this.log = log;
    this.plantation = null;
    this.harvested = new Set();
    this.unreachableRetryMs = Math.max(1000, Number(unreachableRetryMs) || 60000);
    this.workerIndex = Math.max(0, Number(workerIndex) || 0);
    this.workerCount = Math.max(1, Number(workerCount) || 1);
    this.minWorkY = Number.isFinite(Number(minWorkY)) ? Number(minWorkY) : 50;
    this.unreachableUntil = new Map();
    this.pendingTree = null;
    this.metrics = { trees: 0, logs: 0, leaves: 0, saplingsPlanted: 0, delivered: 0 };
  }

  async climbToTreeLog(block) {
    const target = block?.position;
    const bot = this.adapter.bot;
    // Lightweight engine adapters used by offline planners/tests do not expose
    // Mineflayer's visibility API. Their navigateNear/dig contract already
    // represents a validated stance, so preserve that contract.
    if (!bot) return true;
    const currentPosition = () => this.adapter.getPosition?.() || bot.entity.position;
    const canDigFromHere = () => bot.canDigBlock?.(block) && bot.canSeeBlock?.(block);
    if (canDigFromHere()) return true;
    if (!target || !bot?.entity?.position || typeof this.adapter.placeBlockAt !== 'function') return false;
    const clearVisibleLeafOccluders = async () => {
      let cleared = 0;
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
        if (!dx && !dy && !dz) continue;
        const leaf = this.adapter.blockAt({ x: target.x + dx, y: target.y + dy, z: target.z + dz });
        if (!leaf || !LEAF_NAMES.includes(leaf.name)) continue;
        if (!bot.canDigBlock?.(leaf) || !bot.canSeeBlock?.(leaf)) continue;
        if (await this.adapter.dig(leaf, { collectDrops: false, allowNavigation: false })) cleared += 1;
        if (cleared >= 4 || canDigFromHere()) return cleared;
      }
      return cleared;
    };
    // Leaves are transparent for movement but opaque to Mineflayer's raycast.
    // Remove only nearby, visible leaves; never scan or fell the canopy broadly.
    for (let attempt = 0; attempt < 2 && !canDigFromHere(); attempt += 1) {
      if (!await clearVisibleLeafOccluders()) break;
    }
    if (canDigFromHere()) return true;
    const tryDryStance = async () => {
      const before = currentPosition();
      const origin = { x: Math.floor(before.x), y: Math.floor(before.y), z: Math.floor(before.z) };
      for (let radius = 1; radius <= 3; radius += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (const dy of [-1, 0, 1]) {
            const foot = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
            const feet = this.adapter.blockAt(foot);
            const ground = this.adapter.blockAt({ x: foot.x, y: foot.y - 1, z: foot.z });
            const head = this.adapter.blockAt({ x: foot.x, y: foot.y + 1, z: foot.z });
            if (!feet || LIQUIDS.has(feet.name) || !AIR.has(feet.name) ||
              !ground || AIR.has(ground.name) || LIQUIDS.has(ground.name) || ground.boundingBox === 'empty' ||
              !head || (!AIR.has(head.name) && head.boundingBox !== 'empty')) continue;
            if (await this.adapter.navigateNear(foot, 1, { sharedRoute: true })) {
              this.log(`Worker keluar dari cairan menuju pijakan kering (${foot.x},${foot.y},${foot.z}).`);
              return true;
            }
          }
        }
      }
      return false;
    };
    const feetBlock = this.adapter.blockAt({
      x: Math.floor(currentPosition().x),
      y: Math.floor(currentPosition().y),
      z: Math.floor(currentPosition().z)
    });
    if (LIQUIDS.has(feetBlock?.name) && !await tryDryStance()) return false;
    const tryAdjacentStance = async () => {
      for (const offset of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) {
        const stance = { x: target.x + offset.x, y: target.y, z: target.z + offset.z };
        if (!await this.adapter.navigateNear?.(stance, 1, { sharedRoute: true })) continue;
        if (canDigFromHere()) return true;
      }
      return false;
    };
    // A worker can arrive above a lower trunk after another tree or a previous
    // partial attempt. In that case building upward is the wrong recovery: first
    // walk to a same-level stance beside the log.
    if (target.y <= currentPosition().y + 2 && await tryAdjacentStance()) return true;

    // A tree can be taller than the walkable terrain around its root. Build only
    // under the worker's feet, one block at a time, and only with carried natural
    // blocks. This keeps the route deterministic without turning tree harvesting
    // into unrestricted tower construction.
    const scaffolding = ['cobblestone', 'dirt', 'stone'].find(name =>
      typeof this.adapter.getItemCount === 'function' && this.adapter.getItemCount(name) > 0);
    if (!scaffolding) return false;
    const trySideStep = async (foot, before) => {
      const toward = { x: Math.sign(target.x - before.x), z: Math.sign(target.z - before.z) };
      const offsets = [
        toward,
        { x: toward.z, z: -toward.x },
        { x: -toward.z, z: toward.x },
        { x: -toward.x, z: -toward.z }
      ].filter(offset => offset.x || offset.z);
      for (const offset of offsets) {
        const side = { x: foot.x + offset.x, y: foot.y, z: foot.z + offset.z };
        const sideBlock = this.adapter.blockAt(side);
        if (sideBlock && !AIR.has(sideBlock.name) && sideBlock.boundingBox !== 'empty') continue;
        const sideReference = await this.adapter.findReference?.(side);
        if (!sideReference) continue;
        try {
          if (typeof this.adapter.equipItem === 'function' && !await this.adapter.equipItem(scaffolding, 'hand')) continue;
          await this.adapter.placeBlockAt(side, sideReference.reference, sideReference.face);
          await sleep(250);
          const placed = this.adapter.blockAt(side);
          if (!placed || AIR.has(placed.name) || placed.boundingBox === 'empty') continue;
          await this.adapter.navigateNear?.({ x: side.x, y: side.y + 1, z: side.z }, 1, { sharedRoute: true });
          await sleep(350);
          const after = currentPosition();
          if (after.y > before.y + 0.35 || canDigFromHere()) {
            this.log(`Pijakan samping pohon berhasil di (${side.x},${side.y},${side.z}).`);
            return true;
          }
        } catch {}
      }
      return false;
    };
    const maxSteps = Math.min(12, Math.max(0, Math.ceil(target.y - currentPosition().y - 1)));
    for (let step = 0; step < maxSteps && !canDigFromHere(); step += 1) {
      const before = currentPosition();
      const foot = { x: Math.floor(before.x), y: Math.floor(before.y), z: Math.floor(before.z) };
      const reference = await this.adapter.findReference?.(foot);
      if (!reference) break;
      try {
        if (typeof this.adapter.equipItem === 'function' && !await this.adapter.equipItem(scaffolding, 'hand')) break;
        await this.adapter.placeBlockAt(foot, reference.reference, reference.face);
      } catch (error) {
        // A leaf canopy or a low ceiling can make the required jump impossible.
        // Fall back to a one-block side step, then let the normal pathfinder
        // climb onto it. The worker never places into a non-air block.
        if (!await trySideStep(foot, before)) {
          this.log(`Pijakan pohon gagal di (${foot.x},${foot.y},${foot.z}): ${error.message}`);
          break;
        }
        continue;
      }
      let after = currentPosition();
      const settleDeadline = Date.now() + 1400;
      while (after.y <= before.y + 0.35 && Date.now() < settleDeadline) {
        await sleep(100);
        after = currentPosition();
      }
      if (after.y <= before.y + 0.35) {
        const stepped = await trySideStep(foot, before);
        if (stepped) continue;
        this.log(`Pijakan pohon belum menaikkan posisi dari Y=${before.y.toFixed(1)}; berhenti agar material tidak terbuang.`);
        break;
      }
      this.log(`Naik pijakan pohon ke Y=${after.y.toFixed(1)} untuk menjangkau batang atas.`);
    }
    if (canDigFromHere()) return true;

    // If the tower is beside the trunk, try a nearby stance rather than asking
    // the pathfinder to route into the log itself.
    return tryAdjacentStance();
  }

  async surveyPlantation({ maxCandidates = Infinity, timeBudgetMs = Infinity, warmUnknown = true } = {}) {
    const offsets = plantationCandidateOffsets();
    const startedAt = Date.now();
    let scanned = 0;
    for (const [dx, dz] of offsets) {
      if (scanned >= maxCandidates || Date.now() - startedAt >= timeBudgetMs) break;
      scanned += 1;
      const center = { x: this.base.x + dx, y: this.base.y, z: this.base.z + dz };
      if (insideProtected(center, this.structures, 8)) {
        this.log(`Kandidat kebun (${center.x},${center.z}) dilewati: berada dalam zona struktur terlindungi.`);
        continue;
      }
      let result = evaluatePlantationSite(this.adapter, center, { base: this.base, structures: this.structures });
      if (result.reason === 'UNKNOWN_TERRAIN' && warmUnknown && this.surveyNavigate) {
        this.log(`Kandidat kebun (${center.x},${center.z}) belum termuat; membuka chunk untuk survei 3D.`);
        if (!await this.surveyNavigate(center)) continue;
        result = evaluatePlantationSite(this.adapter, center, { base: this.base, structures: this.structures });
      }
      if (!result.safe) {
        this.log(`Kandidat kebun (${center.x},${center.z}) ditolak: ${result.reason}.`);
        continue;
      }
      // Penilaian voxel adalah operasi baca dan tidak perlu mengunci kandidat satu per satu.
      // Reservasi gerak baru dibutuhkan sesudah satu lokasi terbukti layak.
      if (!await this.adapter.navigateNear(center, 5)) {
        this.log(`Kandidat kebun (${center.x},${center.z}) aman tetapi belum terjangkau.`);
        continue;
      }
      this.plantation = result;
      this.log(`Area tanam dipilih di sekitar (${center.x},${center.z}) dengan ${result.plots.length} titik grid.`);
      return result;
    }
    return null;
  }

  findTrees(maxDistance = 128) {
    const candidates = this.adapter.findBlocksByNames(LOG_NAMES, { maxDistance, count: 256 });
    const trees = new Map();
    for (const block of candidates) {
      const tree = analyzeNaturalTree(this.adapter, block, this.structures);
      // A tree-like log below the surface is usually a cave remnant or an
      // unloaded/incorrect observation. Never send a forestry worker down a
      // shaft just because the block name matches a log.
      if (tree && tree.bottom.y < this.minWorkY) continue;
      const retryAt = this.unreachableUntil.get(tree?.id) || 0;
      if (tree && !this.harvested.has(tree.id) && retryAt <= Date.now()) trees.set(tree.id, tree);
    }
    const position = this.adapter.getPosition();
    const ordered = [...trees.values()].sort((a, b) => {
      // Small natural trees finish quickly and need fewer temporary steps. Do
      // those first so a giant mangrove cannot monopolize the whole fleet.
      const largeTreePenalty = Number(a.logs.length > 16) - Number(b.logs.length > 16);
      return largeTreePenalty || a.logs.length - b.logs.length ||
        distance2d(position, a.bottom) - distance2d(position, b.bottom);
    });
    // Pohon kecil didahulukan untuk semua worker. Mangrove besar tetap boleh
    // dipanen bila memang tidak ada kandidat lain, tetapi tidak boleh menjadi
    // target pertama dan membuat worker kehilangan pijakan setelah hanya
    // memotong sebagian batang.
    const manageable = ordered.filter(tree => tree.logs.length <= 16);
    const pool = manageable.length ? manageable : ordered;
    if (this.workerCount > 1) {
      // Pilih sektor deterministik lebih dulu agar empat worker tidak selalu
      // berebut pohon terdekat. Bila sektor ini kosong, rotasikan kandidat
      // secara deterministik supaya worker tidak kembali memilih pool[0].
      const assigned = pool.filter(tree => stableHash(tree.id) % this.workerCount === this.workerIndex % this.workerCount);
      if (assigned.length) return assigned;
      if (!pool.length) return [];
      const start = this.workerIndex % pool.length;
      return [...pool.slice(start), ...pool.slice(0, start)];
    }
    return pool;
  }

  findTree(maxDistance = 128) {
    return this.findTrees(maxDistance)[0] || null;
  }

  async harvest(tree) {
    if (!tree) return false;
    if (tree.bottom?.y < this.minWorkY) {
      this.log(`Pohon ${tree.type || 'unknown'} di Y=${tree.bottom.y} ditolak: di bawah batas kerja Y=${this.minWorkY}.`);
      return false;
    }
    // Setelah panen parsial, jangan mengklasifikasikan ulang pohon dari akar
    // yang baru saja hilang. Pertahankan klaim dan jumlah target asli; yang
    // berubah hanya daftar voxel batang yang masih ada.
    let currentTree = null;
    if (this.pendingTree?.logs?.length) {
      const remainingLogs = this.pendingTree.logs
        .map(item => this.adapter.blockAt(item.position))
        .filter(item => LOG_NAMES.includes(item?.name));
      if (remainingLogs.length) currentTree = { ...this.pendingTree, logs: remainingLogs };
    }
    // Re-scan tepat sebelum klaim untuk pohon baru. Ini membuang snapshot lama
    // jika worker lain sudah lebih dulu memotong bagian pohon tersebut.
    if (!currentTree) {
      const currentSeed = tree.logs.map(item => this.adapter.blockAt(item.position)).find(item => LOG_NAMES.includes(item?.name));
      currentTree = currentSeed ? analyzeNaturalTree(this.adapter, currentSeed, this.structures) : null;
    }
    if (currentTree?.bottom?.y < this.minWorkY) {
      this.pendingTree = null;
      this.log(`Pohon ${currentTree.type || 'unknown'} di Y=${currentTree.bottom.y} ditolak setelah rescan: di bawah batas kerja Y=${this.minWorkY}.`);
      return false;
    }
    if (!currentTree) {
      this.log(`Pohon ${tree.type} berubah sebelum diklaim; dilewati dan dicari ulang.`);
      return false;
    }
    // Navigasi ke area kerja harus selesai sebelum blok batang diklaim. Jika
    // reservasi dibuat lebih dulu, navigateNear melihat akar sebagai resource
    // milik worker lain (padahal itu reservasinya sendiri) dan selalu berhenti
    // dengan RESOURCE_RESERVED pada runtime multi-worker.
    let reservation = null;
    try {
      const requiredLogs = this.pendingTree?.id === currentTree.id
        ? this.pendingTree.requiredLogs
        : currentTree.logs.length;
      const priorCollected = this.pendingTree?.id === currentTree.id
        ? this.pendingTree.collected
        : 0;
      this.pendingTree = {
        ...currentTree,
        requiredLogs,
        collected: priorCollected,
        noProgressAttempts: this.pendingTree?.id === currentTree.id
          ? (this.pendingTree.noProgressAttempts || 0)
          : 0
      };
      this.log(`Klaim pohon ${currentTree.type} ${currentTree.id}: target ${requiredLogs} batang, sisa snapshot ${currentTree.logs.length}.`);
      const logNames = [`${currentTree.type}_log`, `${currentTree.type}_wood`];
      const inventoryBefore = typeof this.adapter.getItemCount === 'function'
        ? logNames.reduce((total, name) => total + (this.adapter.getItemCount(name) || 0), 0)
        : null;
      const canWorkFromCurrentStance = currentTree.logs.some(block =>
        this.adapter.bot?.canDigBlock?.(block) && this.adapter.bot?.canSeeBlock?.(block));
      const tryAdjacentTreeStance = async () => {
        const stanceOffsets = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
        for (const offset of stanceOffsets) {
          const stance = { x: currentTree.bottom.x + offset.x, y: currentTree.bottom.y, z: currentTree.bottom.z + offset.z };
          if (await this.adapter.navigateNear(stance, 1, { sharedRoute: true })) return true;
        }
        return false;
      };
      let reachable = canWorkFromCurrentStance || await this.adapter.navigateNear(currentTree.bottom, 3, { sharedRoute: true });
      if (!reachable) reachable = await tryAdjacentTreeStance();
      if (canWorkFromCurrentStance) {
        this.log(`Pohon ${currentTree.type} dapat ditebang dari pijakan saat ini; lewati navigasi ke blok batang.`);
      }
      // findBlocksByNames can see a log before pathfinder has a connected graph
      // for its chunk. Warm that area once with the read-only survey navigator,
      // then return to the coordinated movement path before touching the tree.
      if (!reachable && this.surveyNavigate) {
        const warmed = await this.surveyNavigate(currentTree.bottom);
        if (warmed) {
          // GoalNearXZ dapat sudah menempatkan worker di samping batang,
          // sementara planner terkoordinasi menolak tujuan yang berada di dalam
          // blok kayu atau akar mangrove. Terima posisi itu bila ada batang
          // yang terlihat dan dapat ditebang dari pijakan sekarang.
          const canWorkFromHere = currentTree.logs.some(block =>
            this.adapter.bot?.canDigBlock?.(block) && this.adapter.bot?.canSeeBlock?.(block));
          // GoalNearXZ dapat sudah menempatkan worker di dekat pohon; bila
          // belum cukup, coba lagi stance samping yang tidak berada di dalam
          // blok akar. Adapter tetap menjadi sumber kebenaran kedatangan.
          const closeToTree = await tryAdjacentTreeStance();
          const positionAfterSurvey = this.adapter.getPosition();
          const alreadyNearTree = positionAfterSurvey &&
            distance2d(positionAfterSurvey, currentTree.bottom) <= 2 &&
            Math.abs(positionAfterSurvey.y - currentTree.bottom.y) <= 2;
          if (alreadyNearTree) this.log(`Survei sudah menempatkan worker dekat akar pohon (${Math.round(distance2d(positionAfterSurvey, currentTree.bottom))} blok); lewati rute ulang yang berkonflik.`);
          reachable = canWorkFromHere || closeToTree || alreadyNearTree;
        }
      }
      if (!reachable) {
        this.unreachableUntil.set(currentTree.id, Date.now() + this.unreachableRetryMs);
        // Kandidat baru yang belum menghasilkan kayu tidak boleh mengunci
        // worker pada satu pohon yang tidak terjangkau. Pending tree hanya
        // dipertahankan bila memang ada hasil parsial yang harus diselesaikan.
        if (priorCollected <= 0) this.pendingTree = null;
        this.log(`Pohon ${currentTree.type} ditunda ${Math.ceil(this.unreachableRetryMs / 1000)}s: rute ke (${currentTree.bottom.x},${currentTree.bottom.y},${currentTree.bottom.z}) belum tersedia.`);
        return false;
      }
      reservation = this.adapter.acquireSharedReservation?.(currentTree.logs.map(item => item.position));
      if (reservation === null) {
        this.unreachableUntil.set(currentTree.id, Date.now() + 5000);
        if (priorCollected <= 0) this.pendingTree = null;
        this.log(`Pohon ${currentTree.type} ditunda 5s: sedang dipanen worker lain.`);
        return false;
      }
      let logs = 0;
      // Dua lintasan menangani satu tick server ketika posisi blok berubah tepat
      // setelah survei. Worker tetap memegang klaim pohon selama seluruh panen.
      for (let pass = 0; pass < 2 && logs < currentTree.logs.length; pass += 1) {
        for (const block of currentTree.logs) {
          const current = this.adapter.blockAt(block.position);
          if (!current || !LOG_NAMES.includes(current.name)) continue;
          if (!await this.climbToTreeLog(current)) continue;
          if (await this.adapter.dig(current, { collectDrops: true, allowNavigation: false })) logs += 1;
        }
      }
      const collectedForThisPass = logs;
      const collectedSoFar = priorCollected + collectedForThisPass;
      if (collectedSoFar < requiredLogs) {
        // Kegagalan 0/N biasanya berarti pijakan atau garis pandang belum
        // tersedia, bukan pohon boleh dianggap selesai. Beri jeda agar worker
        // tidak mengulang pohon yang sama setiap tick dan mengunci armada.
        const noProgressAttempts = collectedForThisPass > 0
          ? 0
          : (this.pendingTree.noProgressAttempts || 0) + 1;
        if (noProgressAttempts >= 3) {
          this.pendingTree = null;
          this.unreachableUntil.set(currentTree.id, Date.now() + Math.max(this.unreachableRetryMs, 120000));
          this.log(`Pohon ${currentTree.type} dilewati sementara setelah ${noProgressAttempts} siklus tanpa log; worker mencari pohon lain agar tidak stuck.`);
          return false;
        }
        this.pendingTree = { ...this.pendingTree, collected: collectedSoFar, noProgressAttempts };
        this.unreachableUntil.set(currentTree.id, Date.now() + this.unreachableRetryMs);
        this.log(`Pohon ${currentTree.type} baru terkumpul ${collectedSoFar}/${requiredLogs} batang; kayu parsial ditahan, worker tetap menyelesaikan pohon yang sama.`);
        return false;
      }

      // A tree is not finished when its blocks are gone: the drops still need a
      // physics tick to fall. Each trunk dig already requests pickup, then this
      // final sweep catches upper logs whose item entities settle a little later.
      await sleep(450);
      // Log drops fall to the ground. Only approach the base; upper trunk
      // coordinates are work targets, not walking targets.
      const pickupPositions = [currentTree.bottom];
      const seenPickupPositions = new Set();
      let pickupMoves = 0;
      for (const position of pickupPositions) {
        const pickupKey = key(position);
        if (seenPickupPositions.has(pickupKey)) continue;
        seenPickupPositions.add(pickupKey);
        if (await this.adapter.navigateNear(position, 1, { sharedRoute: true })) pickupMoves += 1;
      }
      await this.adapter.navigateNear(currentTree.bottom, 0, { sharedRoute: true });
      await sleep(250);
      const inventoryAfter = typeof this.adapter.getItemCount === 'function'
        ? logNames.reduce((total, name) => total + (this.adapter.getItemCount(name) || 0), 0)
        : null;
      const collected = inventoryBefore === null || inventoryAfter === null
        ? null
        : Math.max(0, inventoryAfter - inventoryBefore);
      if (collected !== null && collected < collectedForThisPass) {
        this.unreachableUntil.set(currentTree.id, Date.now() + this.unreachableRetryMs);
        this.pendingTree = { ...this.pendingTree, collected: priorCollected + collected };
        this.log(`Pohon ${currentTree.type} drop pass ini baru ${collected}/${collectedForThisPass} log terkumpul setelah ${pickupMoves} gerakan pickup; deposit ditahan.`);
        return false;
      }
      let leaves = 0;
      for (const block of currentTree.leaves.slice(0, 32)) {
        if (distance2d(this.adapter.getPosition(), block.position) <= 6 && await this.adapter.dig(block, { collectDrops: false })) leaves += 1;
      }
      this.harvested.add(currentTree.id);
      this.unreachableUntil.delete(currentTree.id);
      this.pendingTree = null;
      this.metrics.trees += 1;
      this.metrics.logs += requiredLogs;
      this.metrics.leaves += leaves;
      this.log(`Pohon ${currentTree.type} dipanen: ${logs} batang, ${leaves} daun untuk drop sapling.`);
      return true;
    } finally {
      reservation?.release?.();
    }
  }

  async plantSaplings() {
    if (!this.plantation && !await this.surveyPlantation({ maxCandidates: 8, timeBudgetMs: 12000, warmUnknown: false })) return 0;
    let planted = 0;
    let attempted = 0;
    let consecutiveUnreachable = 0;
    const maxAttemptsPerCycle = 4;
    for (const pos of this.plantation.plots) {
      if (attempted >= maxAttemptsPerCycle) break;
      const target = this.adapter.blockAt(pos);
      const ground = this.adapter.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (!target || !ground || !GROWTH_SPACE.has(target.name) || !NATURAL_GROUND.has(ground.name)) continue;
      let sapling = SAPLING_NAMES.find(name => this.adapter.getItemCount(name) > 0);
      if (!sapling) break;
      attempted += 1;
      if (!await this.adapter.navigateNear(ground.position || ground, 3, { sharedRoute: true })) {
        consecutiveUnreachable += 1;
        if (consecutiveUnreachable >= 3) {
          this.log('Penanaman dihentikan sementara: tiga titik plantation berturut-turut tidak terjangkau. Muatan lanjut diantar.');
          break;
        }
        continue;
      }
      consecutiveUnreachable = 0;
      try {
        if (REPLACEABLE_PLANTS.has(target.name) && !await this.adapter.dig(target)) continue;
        sapling = SAPLING_NAMES.find(name => this.adapter.getItemCount(name) > 0);
        if (!sapling || !await this.adapter.equipItem(sapling, 'hand')) continue;
        const freshGround = this.adapter.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
        if (!freshGround || !NATURAL_GROUND.has(freshGround.name)) continue;
        await this.adapter.placeBlockAt(pos, freshGround, new Vec3(0, 1, 0));
        if (this.adapter.blockAt(pos)?.name === sapling) planted += 1;
      } catch (error) { this.log(`Tanam sapling di (${pos.x},${pos.y},${pos.z}) gagal: ${error.message}`); }
    }
    this.metrics.saplingsPlanted += planted;
    return planted;
  }
}

module.exports = { WoodGathererEngine, LOG_NAMES, LEAF_NAMES, SAPLING_NAMES, MIN_TREE_LOGS, plantationGrid, plantationCandidateOffsets, evaluatePlantationSite, analyzeNaturalTree, insideProtected };
