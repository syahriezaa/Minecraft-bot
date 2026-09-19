/**
 * Builder survival untuk blueprint storage room.
 * Tidak memakai perintah server: semua blok dipasang lewat aksi Mineflayer.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { MineflayerRoleAdapter, asVec3 } = require('./mineflayerRoleAdapter');

// Entry harus tersedia segera setelah lantai siap. Dengan begitu builder tetap
// menghasilkan akses yang bisa dipakai walau pekerjaan dinding/atap tertunda.
const PHASE_ORDER = Object.freeze({ foundation: 0, floor: 1, entry: 2, walls: 3, storage: 4, lighting: 5, roof: 6 });
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_NAMES = new Set(['water', 'lava']);
const REPLACEABLE_FLOOR_NAMES = new Set([
  'dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow', 'snow_block',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'bush', 'sweet_berry_bush',
  'torch', 'soul_torch', 'wall_torch', 'soul_wall_torch',
  'oak_log', 'oak_wood', 'oak_leaves',
  'spruce_log', 'spruce_wood', 'spruce_leaves',
  'birch_log', 'birch_wood', 'birch_leaves',
  'jungle_log', 'jungle_wood', 'jungle_leaves',
  'acacia_log', 'acacia_wood', 'acacia_leaves',
  'dark_oak_log', 'dark_oak_wood', 'dark_oak_leaves',
  'mangrove_log', 'mangrove_wood', 'mangrove_leaves',
  'cherry_log', 'cherry_wood', 'cherry_leaves',
  'pale_oak_log', 'pale_oak_wood', 'pale_oak_leaves',
  'crimson_stem', 'crimson_hyphae', 'warped_stem', 'warped_hyphae'
]);
const NATURAL_EXCAVATION_NAMES = new Set([
  'dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow', 'snow_block',
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff',
  'andesite', 'diorite', 'granite', 'terracotta', 'netherrack', 'end_stone',
  // Pohon di footprint adalah obstacle natural, bukan bagian bangunan. Tetap dibatasi
  // configureBuilderMovements() ke wing worker sendiri dan y >= origin.y.
  'oak_log', 'oak_wood', 'oak_leaves',
  'spruce_log', 'spruce_wood', 'spruce_leaves',
  'birch_log', 'birch_wood', 'birch_leaves',
  'jungle_log', 'jungle_wood', 'jungle_leaves',
  'acacia_log', 'acacia_wood', 'acacia_leaves',
  'dark_oak_log', 'dark_oak_wood', 'dark_oak_leaves',
  'mangrove_log', 'mangrove_wood', 'mangrove_leaves',
  'cherry_log', 'cherry_wood', 'cherry_leaves',
  'pale_oak_log', 'pale_oak_wood', 'pale_oak_leaves',
  'crimson_stem', 'crimson_hyphae', 'warped_stem', 'warped_hyphae',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'bush', 'sweet_berry_bush',
  'torch', 'soul_torch', 'wall_torch', 'soul_wall_torch'
]);
const HOSTILE_NAMES = new Set([
  'creeper', 'zombie', 'skeleton', 'spider', 'cave_spider', 'witch', 'enderman',
  'drowned', 'husk', 'pillager', 'vindicator', 'evoker', 'phantom', 'blaze'
]);

function key(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function isAir(block) {
  // Flora seperti dandelion memiliki boundingBox "empty", tetapi tetap menempati target block
  // dan harus digali sebelum placement. Passability untuk navigasi boleh memakai boundingBox;
  // klasifikasi target builder harus berbasis nama udara yang sebenarnya.
  return Boolean(block && AIR_NAMES.has(block.name));
}

function isPassable(block) {
  return Boolean(block && (isAir(block) || block.boundingBox === 'empty'));
}

function isSolid(block) {
  return Boolean(block && !isAir(block) && !LIQUID_NAMES.has(block.name) && block.boundingBox !== 'empty');
}

function blockProperties(block) {
  return typeof block?.getProperties === 'function'
    ? block.getProperties() || {}
    : block?.properties || block?._properties || {};
}

function orderedBlocks(blocks) {
  return [...blocks].sort((a, b) => {
    const phase = (PHASE_ORDER[a.phase] ?? 99) - (PHASE_ORDER[b.phase] ?? 99);
    if (phase !== 0) return phase;
    if (a.y !== b.y) return a.y - b.y;
    if (a.z !== b.z) return a.z - b.z;
    return a.x - b.x;
  });
}

async function readCheckpoint(file) {
  if (!file) return { completed: [], phase: 'floor', updatedAt: null };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed : [],
      phase: parsed.phase || 'floor',
      updatedAt: parsed.updatedAt || null
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { completed: [], phase: 'floor', updatedAt: null };
    throw new Error(`Checkpoint builder tidak bisa dibaca: ${error.message}`);
  }
}

async function writeCheckpoint(file, state) {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await fs.rename(temp, file);
}

class StorageRoomBuilder {
  constructor({ bot, adapter, blueprint, origin, checkpointFile, options = {} }) {
    if (!bot) throw new TypeError('Builder membutuhkan bot Mineflayer.');
    if (!blueprint || !Array.isArray(blueprint.blocks)) throw new TypeError('Blueprint storage room tidak valid.');
    if (!origin || ![origin.x, origin.y, origin.z].every(Number.isInteger)) {
      throw new TypeError('Origin storage room wajib berupa koordinat integer yang sudah diverifikasi.');
    }
    this.bot = bot;
    this.adapter = adapter || new MineflayerRoleAdapter(bot);
    this.blueprint = blueprint;
    this.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.checkpointFile = checkpointFile;
    this.options = {
      minHealth: 12,
      minFood: 8,
      hazardRadius: 10,
      hazardVerticalRadius: 3,
      placementVerifyTimeoutMs: 3000,
      placementAttempts: 2,
      placementRetryDelayMs: 500,
      maxBlocksPerRun: Infinity,
      allowFloorReplacement: true,
      replaceableFloorNames: REPLACEABLE_FLOOR_NAMES,
      allowFoundationFill: false,
      allowExcavation: false,
      foundationMaterial: 'stone_bricks',
      excavationNames: NATURAL_EXCAVATION_NAMES,
      maxFoundationDepth: 16,
      checkpointReconcileDelayMs: 1500,
      repairExistingChests: false,
      requiresScaffolding: false,
      restockMaterials: null,
      log: () => {},
      ...options
    };
    this.blocks = orderedBlocks(blueprint.blocks);
    this.foundationBlocks = [];
    this.state = { completed: new Set(), phase: 'floor', updatedAt: null };
    this.preflightResult = null;
    this.checkpointReconciled = false;
  }

  absolute(block) {
    return { x: this.origin.x + block.x, y: this.origin.y + block.y, z: this.origin.z + block.z };
  }

  remainingBlocks() {
    return this.blocks.filter(block => !this.state.completed.has(key(this.absolute(block))));
  }

  remainingMaterials() {
    const materials = {};
    for (const block of this.remainingBlocks()) {
      if (AIR_NAMES.has(block.name)) continue;
      materials[block.name] = (materials[block.name] || 0) + 1;
    }
    return materials;
  }

  getBlock(pos) {
    return this.adapter.blockAt(pos);
  }

  async ensureFoundationPlan() {
    if (!this.options.allowFoundationFill || this.foundationBlocks.length > 0) return;
    const supports = [];
    const supportKeys = new Set();
    for (const block of this.blueprint.blocks.filter(item => item.phase === 'floor')) {
      const floor = this.absolute(block);
      for (let depth = 1; depth <= this.options.maxFoundationDepth; depth += 1) {
        const pos = { x: floor.x, y: floor.y - depth, z: floor.z };
        const actual = this.getBlock(pos);
        if (!actual) throw new Error(`blok fondasi belum diketahui di (${key(pos)})`);
        if (LIQUID_NAMES.has(actual.name)) throw new Error(`cairan ${actual.name} di bawah fondasi (${key(pos)})`);
        if (isSolid(actual)) break;
        const relative = { x: pos.x - this.origin.x, y: pos.y - this.origin.y, z: pos.z - this.origin.z };
        if (!supportKeys.has(key(relative))) {
          supportKeys.add(key(relative));
          supports.push({ ...relative, name: this.options.foundationMaterial, phase: 'foundation' });
        }
        if (depth === this.options.maxFoundationDepth) {
          throw new Error(`fondasi terlalu dalam di (${key(pos)})`);
        }
      }
    }
    this.foundationBlocks = supports;
    this.blocks = orderedBlocks([...supports, ...this.blueprint.blocks]);
  }

  hasHazard() {
    if ((this.bot.health ?? 20) < this.options.minHealth) return `health rendah (${this.bot.health})`;
    if ((this.bot.food ?? 20) < this.options.minFood) return `food rendah (${this.bot.food})`;
    const entities = typeof this.adapter.getEntities === 'function' ? this.adapter.getEntities() : [];
    const position = this.adapter.getPosition();
    const hostile = entities.find(entity => HOSTILE_NAMES.has(entity.name) && entity.position &&
      Math.abs(entity.position.y - position.y) <= this.options.hazardVerticalRadius &&
      Math.hypot(entity.position.x - position.x, entity.position.z - position.z) <= this.options.hazardRadius);
    return hostile ? `mob berbahaya terlalu dekat (${hostile.name})` : null;
  }

  nearbyHostile() {
    const position = this.adapter.getPosition();
    const entities = typeof this.adapter.getEntities === 'function' ? this.adapter.getEntities() : [];
    return entities.find(entity => HOSTILE_NAMES.has(entity.name) && entity.position &&
      Math.abs(entity.position.y - position.y) <= this.options.hazardVerticalRadius &&
      Math.hypot(entity.position.x - position.x, entity.position.z - position.z) <= this.options.hazardRadius) || null;
  }

  async clearNearbyHostile() {
    const hostile = this.nearbyHostile();
    if (!hostile || hostile.name === 'creeper' || typeof this.adapter.attack !== 'function') return false;
    if ((this.bot.health ?? 20) < this.options.minHealth + 3 || typeof this.adapter.navigateNear !== 'function') return false;
    if (!await this.adapter.navigateNear(hostile.position, 3)) return false;
    if (typeof this.adapter.equipItem === 'function') {
      const weapons = ['diamond_sword', 'netherite_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
      for (const weapon of weapons) {
        if (typeof this.adapter.getItemCount === 'function' && this.adapter.getItemCount(weapon) <= 0) continue;
        if (await this.adapter.equipItem(weapon, 'hand')) break;
      }
    }
    this.options.log(`Mob ${hostile.name} dekat; bot melakukan pertahanan terbatas sebelum melanjutkan.`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if ((this.bot.health ?? 20) < this.options.minHealth + 2) return false;
      const current = this.nearbyHostile();
      if (!current || current.name === 'creeper') return !current;
      if (!await this.adapter.attack(current)) return false;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    return !this.nearbyHostile();
  }

  checkTarget(block) {
    const pos = this.absolute(block);
    const actual = this.getBlock(pos);
    if (!actual) return { ok: false, reason: `blok belum diketahui di (${key(pos)})`, code: 'UNKNOWN' };
    if (AIR_NAMES.has(block.name) && isAir(actual)) return { ok: true, already: true, pos, actual };
    if (actual.name === block.name) {
      const expected = block.properties || {};
      const actualProps = blockProperties(actual);
      const needsDoorState = block.name.endsWith('_door') && expected.half === 'lower' &&
        typeof expected.open === 'boolean' && actualProps.open !== expected.open;
      if (needsDoorState) return { ok: true, already: false, needsDoorState: true, pos, actual };
      const stateMatches = block.name !== 'chest' ||
        (!expected.facing || actualProps.facing === expected.facing) &&
        (!expected.type || actualProps.type === expected.type || actualProps.type === 'single' && expected.type === 'single');
      if (!stateMatches && block.name === 'chest' && this.options.repairExistingChests) {
        return { ok: true, already: false, needsRepair: true, pos, actual };
      }
      return { ok: true, already: true, pos, actual };
    }
    if (LIQUID_NAMES.has(actual.name)) return { ok: false, reason: `cairan ${actual.name} di (${key(pos)})`, code: 'LIQUID' };
    const explicitlyReplaceable = Array.isArray(block.replaceNames) && block.replaceNames.includes(actual.name);
    if (AIR_NAMES.has(block.name)) {
      if (explicitlyReplaceable) return { ok: true, already: false, pos, actual, requiresDig: true, clearOnly: true };
      return { ok: false, reason: `bukaan terhalang ${actual.name} di (${key(pos)})`, code: 'BLOCKED' };
    }
    const replaceableFloor = block.phase === 'floor' && this.options.allowFloorReplacement && this.options.replaceableFloorNames.has(actual.name);
    const excavatable = this.options.allowExcavation && this.options.excavationNames.has(actual.name);
    if (!isAir(actual) && !replaceableFloor && !excavatable && !explicitlyReplaceable) {
      return { ok: false, reason: `target terhalang ${actual.name} di (${key(pos)})`, code: 'BLOCKED' };
    }
    if (block.phase === 'floor') {
      const below = this.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (!below || LIQUID_NAMES.has(below.name) || (!this.options.allowFoundationFill && !isSolid(below))) {
        return { ok: false, reason: `fondasi bawah tidak solid di (${key(pos)})`, code: 'UNSAFE_FOUNDATION' };
      }
    }
    return { ok: true, already: false, pos, actual, requiresDig: !isAir(actual) };
  }

  async loadCheckpoint() {
    const saved = await readCheckpoint(this.checkpointFile);
    this.state = { completed: new Set(saved.completed), phase: saved.phase, updatedAt: saved.updatedAt };
    this.checkpointReconciled = false;
    return this.state;
  }

  async reconcileCheckpoint() {
    if (this.checkpointReconciled) return 0;
    const blocksByKey = new Map(this.blocks.map(block => [key(this.absolute(block)), block]));
    let repaired = 0;
    if (this.options.checkpointReconcileDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.options.checkpointReconcileDelayMs));
    }
    for (const completedKey of [...this.state.completed]) {
      const block = blocksByKey.get(completedKey);
      // Key dari blueprint lama/partisi lain tidak memengaruhi antrean saat ini. Pertahankan agar
      // cache/checkpoint tidak kehilangan progres hanya karena konfigurasi worker berubah.
      if (!block) continue;
      const actual = this.getBlock(this.absolute(block));
      // Null berarti chunk belum diketahui. Jangan menghapus progres hanya karena cache belum
      // menerima chunk; target yang benar-benar terlihat tetapi salah akan dibangun ulang.
      if (actual && actual.name !== block.name) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const confirmed = this.getBlock(this.absolute(block));
        if (!confirmed || confirmed.name === block.name) continue;
        this.state.completed.delete(completedKey);
        repaired += 1;
      }
      // Door block dapat tetap tercatat selesai tetapi berubah menjadi terbuka
      // setelah bot/pemain melewatinya. Tutup kembali hanya jika state live
      // memang open; jangan men-toggle pintu tertutup secara membabi buta.
      if (block.name.endsWith('_door') && typeof block.properties?.open === 'boolean' &&
          block.properties?.half === 'lower' && actual?.name === block.name &&
          blockProperties(actual).open !== block.properties.open && typeof this.adapter.toggleDoor === 'function') {
        const toggled = await this.adapter.toggleDoor(this.absolute(block));
        if (toggled) this.options.log(`State pintu entry diperbaiki di (${completedKey}).`);
      }
    }
    this.checkpointReconciled = true;
    if (repaired > 0) {
      this.options.log(`Checkpoint direkonsiliasi: ${repaired} blok akan diverifikasi/diperbaiki ulang.`);
      await this.saveCheckpoint();
    }
    return repaired;
  }

  async saveCheckpoint() {
    const completed = [...this.state.completed].sort();
    this.state.updatedAt = new Date().toISOString();
    await writeCheckpoint(this.checkpointFile, { completed, phase: this.state.phase });
  }

  async preflight({ maxBlocks = Infinity } = {}) {
    try {
      await this.ensureFoundationPlan();
      await this.reconcileCheckpoint();
    } catch (error) {
      this.preflightResult = {
        ok: false,
        remainingBlocks: this.remainingBlocks().length,
        batchBlocks: 0,
        requiredMaterials: {},
        remainingMaterials: this.remainingMaterials(),
        missingMaterials: {},
        blocked: [{ code: 'FOUNDATION_PLAN', reason: error.message }],
        blockedCount: 1,
        hazard: this.hasHazard()
      };
      return this.preflightResult;
    }
    const batch = this.remainingBlocks().slice(0, maxBlocks);
    const missing = {};
    const requiredMaterials = {};
    for (const block of batch) {
      const target = this.checkTarget(block);
      if (target.ok && !target.already && !target.clearOnly && !target.needsDoorState) {
        requiredMaterials[block.name] = (requiredMaterials[block.name] || 0) + 1;
      }
    }
    for (const [name, count] of Object.entries(requiredMaterials)) {
      const available = typeof this.adapter.getItemCount === 'function' ? this.adapter.getItemCount(name) : 0;
      if (available < count) missing[name] = { required: count, available };
    }
    const blocked = [];
    for (const block of this.remainingBlocks()) {
      const result = this.checkTarget(block);
      if (!result.ok) blocked.push({ block, ...result });
    }
    const hazard = this.hasHazard();
    this.preflightResult = {
      ok: Object.keys(missing).length === 0 && blocked.length === 0 && !hazard,
      remainingBlocks: this.remainingBlocks().length,
      batchBlocks: batch.length,
      requiredMaterials,
      remainingMaterials: this.remainingMaterials(),
      missingMaterials: missing,
      blocked: blocked.slice(0, 20),
      blockedCount: blocked.length,
      hazard
    };
    return this.preflightResult;
  }

  async findReferences(pos) {
    const offsets = [
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
      { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }
    ];
    const references = [];
    for (const offset of offsets) {
      const reference = this.getBlock({ x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z });
      if (isSolid(reference)) references.push({ reference, face: new Vec3(-offset.x, -offset.y, -offset.z) });
    }
    return references;
  }

  async findReference(pos) {
    return (await this.findReferences(pos))[0] || null;
  }

  async waitForPlacedBlock(pos, name) {
    const deadline = Date.now() + this.options.placementVerifyTimeoutMs;
    while (Date.now() <= deadline) {
      const placed = this.getBlock(pos);
      if (placed && placed.name === name) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async waitForAir(pos) {
    const deadline = Date.now() + this.options.placementVerifyTimeoutMs;
    let stableChecks = 0;
    while (Date.now() <= deadline) {
      if (isAir(this.getBlock(pos))) {
        stableChecks += 1;
        if (stableChecks >= 3) return true;
      } else {
        stableChecks = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async waitForDoorState(pos, open) {
    const deadline = Date.now() + this.options.placementVerifyTimeoutMs;
    while (Date.now() <= deadline) {
      const door = this.getBlock(pos);
      if (door?.name?.endsWith('_door') && blockProperties(door).open === open) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async moveToSafePlacementPosition(targetPos, referencePos) {
    const position = this.bot.entity?.position;
    if (!position || Math.floor(position.x) !== targetPos.x || Math.floor(position.y) !== targetPos.y || Math.floor(position.z) !== targetPos.z) {
      return true;
    }
    if (typeof this.adapter.navigateNear !== 'function') return false;

    // Jangan berdiri di dalam blok yang sedang hendak dipasang. Ini sering terjadi saat
    // membangun fondasi setinggi kaki: Mineflayer menganggap jarak ke referensi masih aman,
    // tetapi server menolak placement karena volume target ditempati entity bot.
    const towardReference = {
      x: Math.sign(referencePos.x - targetPos.x),
      z: Math.sign(referencePos.z - targetPos.z)
    };
    const preferred = towardReference.x !== 0 || towardReference.z !== 0
      ? { x: -towardReference.x, z: -towardReference.z }
      : null;
    const directions = [preferred, { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
      .filter(Boolean)
      .filter((direction, index, all) => all.findIndex(item => item.x === direction.x && item.z === direction.z) === index);
    for (const direction of directions) {
      for (const y of [targetPos.y, targetPos.y + 1]) {
        const candidate = { x: targetPos.x + direction.x * 2, y, z: targetPos.z + direction.z * 2 };
        const feet = this.getBlock(candidate);
        const below = this.getBlock({ x: candidate.x, y: candidate.y - 1, z: candidate.z });
        if (!isPassable(feet) || !isSolid(below)) continue;
        if (await this.adapter.navigateNear(candidate, 1)) return true;
      }
    }
    return false;
  }

  async placeOne(block) {
    const target = this.checkTarget(block);
    if (!target.ok) return { ok: false, reason: target.reason, code: target.code };
    if (target.already) return { ok: true, skipped: true };
    let hazard = this.hasHazard();
    if (this.options.defendAgainstHostiles && hazard && !hazard.includes('(creeper)')) {
      await this.clearNearbyHostile();
      hazard = this.hasHazard();
    }
    if (hazard) return { ok: false, reason: hazard, code: 'HAZARD' };
    if (target.needsRepair) {
      const contents = typeof this.adapter.getChestContents === 'function'
        ? await this.adapter.getChestContents(target.pos, { verify: false })
        : null;
      if (Array.isArray(contents) && contents.length > 0) {
        return { ok: false, reason: `chest lama berisi item di (${key(target.pos)}); repair dilewati demi keamanan`, code: 'CHEST_OCCUPIED' };
      }
      if (typeof this.adapter.dig !== 'function' || !await this.adapter.dig(target.actual, { collectDrops: true }) || !await this.waitForAir(target.pos)) {
        return { ok: false, reason: `chest lama tidak berhasil dibongkar di (${key(target.pos)})`, code: 'CHEST_REPAIR' };
      }
      this.options.log(`Chest kosong dengan state salah dibongkar untuk dipasang ulang di (${key(target.pos)}).`);
    }
    if (target.clearOnly) {
      const dug = typeof this.adapter.dig === 'function'
        ? await this.adapter.dig(target.actual, { collectDrops: true })
        : false;
      if (dug === false || !await this.waitForAir(target.pos)) {
        return { ok: false, reason: `bukaan tidak berhasil dibersihkan di (${key(target.pos)})`, code: 'CLEARANCE' };
      }
      this.options.log(`Bukaan masuk dibersihkan di (${key(target.pos)}).`);
      return { ok: true, skipped: false };
    }
    if (target.needsDoorState) {
      if (typeof this.adapter.toggleDoor !== 'function' || !await this.adapter.toggleDoor(target.pos) ||
          !await this.waitForDoorState(target.pos, block.properties.open)) {
        return { ok: false, reason: `state pintu gagal diverifikasi di (${key(target.pos)})`, code: 'DOOR_STATE' };
      }
      this.options.log('Pintu entry dibuka agar akses gudang terlihat dan tidak menghalangi lorong.');
      return { ok: true, skipped: false };
    }
    if (typeof this.adapter.equipItem !== 'function' || !await this.adapter.equipItem(block.name, 'hand')) {
      return { ok: false, reason: `material ${block.name} tidak ada di tangan/inventaris`, code: 'MATERIAL_SHORTAGE' };
    }
    if (target.requiresDig) {
      const allowed = block.phase === 'floor'
        ? (this.options.allowFloorReplacement && this.options.replaceableFloorNames.has(target.actual.name)) ||
          (this.options.allowExcavation && this.options.excavationNames.has(target.actual.name)) ||
          (Array.isArray(block.replaceNames) && block.replaceNames.includes(target.actual.name))
        : (this.options.allowExcavation && this.options.excavationNames.has(target.actual.name)) ||
          (Array.isArray(block.replaceNames) && block.replaceNames.includes(target.actual.name));
      if (!allowed || typeof this.adapter.dig !== 'function') return { ok: false, reason: `blok ${target.actual.name} perlu digali`, code: 'EXCAVATION_DISABLED' };
      await this.adapter.dig(target.actual);
      if (!await this.waitForAir(target.pos)) {
        return { ok: false, reason: `penggalian ${target.actual.name} tidak dikonfirmasi server di (${key(target.pos)})`, code: 'EXCAVATION' };
      }
    }
    const references = await this.findReferences(target.pos);
    if (references.length === 0 || typeof this.bot.placeBlock !== 'function') return { ok: false, reason: `tidak ada blok referensi aman di (${key(target.pos)})`, code: 'NO_REFERENCE' };
    let lastError = null;
    for (const reference of references) {
      // Both the legacy bot.placeBlock path and the modern placement adapter
      // can leave the entity standing inside the target after navigateNear.
      // The modern adapter also performs a jump-before-placement, but that
      // jump cannot free a target when a ceiling or neighbouring wall blocks
      // the first physics tick. Always move to a verified adjacent stance;
      // this prevents the live builder from retrying the same underfoot block
      // forever while still keeping server-side placement verification.
      if (!await this.moveToSafePlacementPosition(target.pos, reference.reference.position || reference.reference)) {
        lastError = new Error(`gagal pindah keluar dari target (${key(target.pos)})`);
        continue;
      }
      // Radius 3 cukup untuk membuka peti, tetapi terlalu longgar untuk placement
      // bertingkat: bot dapat tetap berada di lantai bawah sementara target ada di
      // atas atap. Ambil stance yang benar-benar dekat dengan blok referensi agar
      // jump-before-placement dan reach server memakai voxel yang sama.
      const directPathfinder = block.phase === 'roof';
      if (typeof this.adapter.navigateNear === 'function' && !await this.adapter.navigateNear(reference.reference.position || reference.reference, 1, { directPathfinder })) {
        lastError = new Error(`gagal mendekati referensi (${key(reference.reference.position || reference.reference)})`);
        continue;
      }
      if (!await this.moveToSafePlacementPosition(target.pos, reference.reference.position || reference.reference)) {
        lastError = new Error(`posisi bot kembali menutup target (${key(target.pos)})`);
        continue;
      }
      for (let attempt = 1; attempt <= this.options.placementAttempts; attempt += 1) {
        try {
          // Inventory movement and held-item updates are separate packets on protocol 775. Re-equip
          // for every retry so a transient stale hand state cannot send cooked food or an empty hand
          // to the placement packet after the previous attempt consumed a stack.
          if (!await this.adapter.equipItem(block.name, 'hand')) {
            lastError = new Error(`material ${block.name} tidak lagi siap di tangan`);
            continue;
          }
          if (typeof this.adapter.placeBlockAt === 'function') {
            // Chest harus menghadap sumbu yang sama agar dua blok bersebelahan
            // tersambung menjadi satu double chest. Tanpa ini, arah pandangan
            // terhadap blok referensi dapat membuat pasangan menjadi single.
            await this.adapter.placeBlockAt(target.pos, reference.reference, reference.face, {
              facing: block.properties?.facing
            });
          } else {
            await this.bot.placeBlock(reference.reference, reference.face);
          }
        } catch (error) {
          lastError = error;
        }
        if (await this.waitForPlacedBlock(target.pos, block.name)) return { ok: true, skipped: false };
        if (attempt < this.options.placementAttempts && this.options.placementRetryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.options.placementRetryDelayMs));
        }
      }
    }
    const detail = lastError ? ` (${lastError.message})` : '';
    return { ok: false, reason: `placement ${block.name} gagal diverifikasi di (${key(target.pos)})${detail}`, code: 'PLACEMENT' };
  }

  affordableBlockLimit(maxBlocks) {
    const limit = Number.isFinite(maxBlocks) ? maxBlocks : this.remainingBlocks().length;
    const available = new Map();
    let affordable = 0;
    for (const block of this.remainingBlocks()) {
      if (affordable >= limit) break;
      const target = this.checkTarget(block);
      if (!target.ok) break;
      if (!target.already && !target.clearOnly && !target.needsDoorState) {
        const count = available.has(block.name) ? available.get(block.name) :
          (typeof this.adapter.getItemCount === 'function' ? this.adapter.getItemCount(block.name) : 0);
        if (count <= 0) break;
        available.set(block.name, count - 1);
      }
      affordable += 1;
    }
    return affordable;
  }

  async build({ maxBlocks = this.options.maxBlocksPerRun } = {}) {
    if (!this.state.updatedAt && this.checkpointFile) await this.loadCheckpoint();
    let preflight = await this.preflight({ maxBlocks });
    const needsSurvivalRestock = (this.bot.health ?? 20) < this.options.minHealth + 3 ||
      (this.bot.food ?? 20) < this.options.minFood;
    const needsScaffolding = this.options.requiresScaffolding &&
      typeof this.adapter.getItemCount === 'function' && this.adapter.getItemCount('cobblestone') < 8;
    const availablePrefix = preflight.blockedCount === 0 && !preflight.hazard ? this.affordableBlockLimit(maxBlocks) : 0;
    const hasAffordablePlacement = availablePrefix > 0 && this.remainingBlocks().slice(0, availablePrefix).some(block => {
      const target = this.checkTarget(block);
      return target.ok && !target.already;
    });
    // Kekurangan parsial tetap perlu direstock. Jika hanya menunggu sampai stok
    // nol, builder dapat mencoba target bertingkat tanpa bekal pijakan dan
    // berulang kali gagal sebelum pernah menjalankan callback restock.
    const needsMaterialRestock = Object.keys(preflight.missingMaterials).length > 0 && !hasAffordablePlacement;
    if ((!preflight.ok && (needsMaterialRestock || needsSurvivalRestock) || needsScaffolding) && typeof this.options.restockMaterials === 'function') {
      await this.options.restockMaterials(preflight.requiredMaterials, this);
      preflight = await this.preflight({ maxBlocks });
    }
    let buildLimit = maxBlocks;
    if (!preflight.ok && preflight.blockedCount === 0 && !preflight.hazard && Object.keys(preflight.missingMaterials).length > 0) {
      buildLimit = this.affordableBlockLimit(maxBlocks);
      if (buildLimit > 0) {
        this.options.log(`Material hanya cukup untuk ${buildLimit}/${Number.isFinite(maxBlocks) ? maxBlocks : 'batch'} blok; lanjutkan prefix yang tersedia.`);
        preflight = await this.preflight({ maxBlocks: buildLimit });
      }
    }
    if (!preflight.ok) return { status: 'BLOCKED', ...preflight };
    let built = 0;
    const queue = this.remainingBlocks();
    let stalled = 0;
    while (queue.length > 0 && built < buildLimit) {
      const block = queue.shift();
      const result = await this.placeOne(block);
      if (!result.ok) {
        // Fondasi yang berdiri di atas void kadang menunggu tetangga fondasi selesai lebih dulu.
        // Tunda target itu satu putaran agar blok tetangga yang bisa menjadi referensi tetap maju;
        // kalau seluruh antrean buntu, kembalikan PAUSED dan lanjutkan lewat checkpoint.
        const nextPhaseIndex = queue.findIndex(item => item.phase !== block.phase);
        const samePhaseRemaining = nextPhaseIndex === -1 ? queue.length : nextPhaseIndex;
        if (result.code === 'NO_REFERENCE' && samePhaseRemaining > 0 && stalled < samePhaseRemaining) {
          queue.splice(nextPhaseIndex === -1 ? queue.length : nextPhaseIndex, 0, block);
          stalled += 1;
          continue;
        }
        await this.saveCheckpoint();
        return { status: 'PAUSED', built, reason: result.reason, code: result.code, remainingBlocks: this.remainingBlocks().length };
      }
      this.state.completed.add(key(this.absolute(block)));
      this.state.phase = block.phase;
      built += result.skipped ? 0 : 1;
      stalled = 0;
      await this.saveCheckpoint();
      this.options.log(`${result.skipped ? 'Lewati' : 'Pasang'} ${block.name} fase ${block.phase} di (${key(this.absolute(block))})`);
    }
    const remaining = this.remainingBlocks().length;
    return { status: remaining === 0 ? 'COMPLETE' : 'PAUSED', built, remainingBlocks: remaining, phase: this.state.phase };
  }
}

module.exports = {
  StorageRoomBuilder,
  orderedBlocks,
  readCheckpoint,
  writeCheckpoint,
  key,
  AIR_NAMES,
  LIQUID_NAMES,
  REPLACEABLE_FLOOR_NAMES,
  NATURAL_EXCAVATION_NAMES
};
