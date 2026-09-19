/**
 * Engine landscaping storage room.
 * Memetakan setiap kolom, meratakan ke satu elevasi, lalu memverifikasi setiap aksi.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { Vec3 } = require('vec3');

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_NAMES = new Set(['water', 'lava']);
const FILL_NAMES = new Set(['dirt', 'grass_block', 'coarse_dirt']);
const NATURAL_NAMES = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt',
  'sand', 'gravel', 'clay', 'snow', 'snow_block', 'stone', 'cobblestone',
  'deepslate', 'cobbled_deepslate', 'tuff', 'andesite', 'diorite', 'granite',
  'terracotta', 'netherrack', 'end_stone', 'short_grass', 'tall_grass', 'fern',
  'large_fern', 'dead_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium',
  'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'bush', 'sweet_berry_bush',
  'torch', 'soul_torch', 'wall_torch', 'soul_wall_torch'
]);

function key(pos) { return `${pos.x},${pos.y},${pos.z}`; }
function actionKey(kind, pos) { return `${kind}:${key(pos)}`; }
function isAir(block) { return Boolean(block && AIR_NAMES.has(block.name)); }
function isSolid(block) {
  return Boolean(block && !isAir(block) && !LIQUID_NAMES.has(block.name) && block.boundingBox !== 'empty');
}

function absolute(origin, relative) {
  return { x: origin.x + relative.x, y: origin.y + relative.y, z: origin.z + relative.z };
}

function createLandscapeBounds(blueprint, margin = 1) {
  if (!blueprint?.dimensions) throw new TypeError('Blueprint landscaping tidak valid.');
  return {
    minX: -margin,
    maxX: blueprint.dimensions.width - 1 + margin,
    minZ: -margin,
    maxZ: blueprint.dimensions.depth - 1 + margin
  };
}

/** Murni membaca voxel; tidak melakukan aksi dunia. */
function mapLandscape({ adapter, origin, blueprint, targetY = origin.y, minY = targetY - 16, maxY = targetY + 12, margin = 0 } = {}) {
  if (!adapter || typeof adapter.blockAt !== 'function') throw new TypeError('Landscaper membutuhkan adapter dengan blockAt().');
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isInteger)) throw new TypeError('Origin landscaping wajib integer.');
  const bounds = createLandscapeBounds(blueprint, margin);
  const columns = [];
  const summary = {
    columns: 0, clear: 0, fill: 0, flat: 0, clearColumns: 0, fillColumns: 0,
    unknown: 0, liquid: 0, blocked: 0, height_limit: 0,
    maxSurfaceY: null, minSurfaceY: null
  };
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      const clear = [];
      let surfaceY = null;
      let status = 'OK';
      for (let y = maxY; y >= minY; y -= 1) {
        const pos = absolute(origin, { x, y: y - origin.y, z });
        const actual = adapter.blockAt(pos);
        if (!actual) { status = 'UNKNOWN'; break; }
        if (isAir(actual)) continue;
        if (LIQUID_NAMES.has(actual.name)) { status = 'LIQUID'; break; }
        if (NATURAL_NAMES.has(actual.name) && (y >= targetY || actual.boundingBox === 'empty')) {
          if (y === maxY) { status = 'HEIGHT_LIMIT'; break; }
          clear.push(pos);
          continue;
        }
        if (y >= targetY && !NATURAL_NAMES.has(actual.name)) { status = 'BLOCKED'; break; }
        surfaceY = y;
        break;
      }
      if (status === 'OK' && surfaceY === null) status = 'UNKNOWN';
      const fill = [];
      if (status === 'OK' && surfaceY < targetY - 1) {
        for (let y = surfaceY + 1; y < targetY; y += 1) fill.push(absolute(origin, { x, y: y - origin.y, z }));
      }
      clear.sort((a, b) => b.y - a.y);
      fill.sort((a, b) => a.y - b.y);
      const column = { relative: { x, z }, status, surfaceY, clear, fill };
      columns.push(column);
      summary.columns += 1;
      const statusKey = status === 'OK' ? (fill.length ? 'fillColumns' : clear.length ? 'clearColumns' : 'flat') : status.toLowerCase();
      summary[statusKey] += 1;
      summary.clear += clear.length;
      summary.fill += fill.length;
      if (surfaceY !== null) {
        summary.maxSurfaceY = summary.maxSurfaceY === null ? surfaceY : Math.max(summary.maxSurfaceY, surfaceY);
        summary.minSurfaceY = summary.minSurfaceY === null ? surfaceY : Math.min(summary.minSurfaceY, surfaceY);
      }
    }
  }
  return { bounds, targetY, minY, maxY, margin, columns, summary };
}

async function readCheckpoint(file) {
  if (!file) return { completed: [], updatedAt: null };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return { completed: Array.isArray(parsed.completed) ? parsed.completed : [], updatedAt: parsed.updatedAt || null };
  } catch (error) {
    if (error.code === 'ENOENT') return { completed: [], updatedAt: null };
    throw new Error(`Checkpoint landscaping tidak bisa dibaca: ${error.message}`);
  }
}

async function writeCheckpoint(file, state) {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await fs.rename(temp, file);
}

class StorageRoomLandscaper {
  constructor({ bot, adapter, origin, blueprint, checkpointFile, options = {} }) {
    if (!bot) throw new TypeError('Landscaper membutuhkan bot Mineflayer.');
    if (!adapter || typeof adapter.blockAt !== 'function') throw new TypeError('Landscaper membutuhkan adapter.');
    if (!origin || ![origin.x, origin.y, origin.z].every(Number.isInteger)) throw new TypeError('Origin landscaping wajib integer.');
    this.bot = bot;
    this.adapter = adapter;
    this.origin = origin;
    this.blueprint = blueprint;
    this.checkpointFile = checkpointFile;
    this.options = {
      targetY: origin.y,
      minY: origin.y - 16,
      maxY: origin.y + 12,
      margin: 0,
      fillMaterial: 'dirt',
      placementVerifyTimeoutMs: 3000,
      placementAttempts: 3,
      placementRetryDelayMs: 500,
      placementBackoffMs: 750,
      log: () => {},
      ...options
    };
    this.state = { completed: new Set(), updatedAt: null };
    this.plan = null;
  }

  async loadCheckpoint() {
    const saved = await readCheckpoint(this.checkpointFile);
    this.state = { completed: new Set(saved.completed), updatedAt: saved.updatedAt };
    return this.state;
  }

  async saveCheckpoint() {
    const completed = [...this.state.completed].sort();
    this.state.updatedAt = new Date().toISOString();
    await writeCheckpoint(this.checkpointFile, { completed });
  }

  map() {
    this.plan = mapLandscape({ adapter: this.adapter, origin: this.origin, blueprint: this.blueprint, ...this.options });
    return this.plan;
  }

  async waitForBlock(pos, name) {
    const deadline = Date.now() + this.options.placementVerifyTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.adapter.blockAt(pos)?.name === name) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async waitForAir(pos) {
    const deadline = Date.now() + this.options.placementVerifyTimeoutMs;
    while (Date.now() <= deadline) {
      if (isAir(this.adapter.blockAt(pos))) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async clearOne(pos) {
    const actual = this.adapter.blockAt(pos);
    if (!actual) return false;
    if (isAir(actual)) return true;
    if (!actual || LIQUID_NAMES.has(actual.name) || !NATURAL_NAMES.has(actual.name)) return false;
    if (typeof this.adapter.dig !== 'function') return false;
    await this.adapter.dig(actual);
    return this.waitForAir(pos);
  }

  async fillOne(pos) {
    const actual = this.adapter.blockAt(pos);
    if (!actual) return false;
    if (FILL_NAMES.has(actual?.name) || isSolid(actual)) return true;
    if (!isAir(actual) || typeof this.adapter.equipItem !== 'function' || typeof this.bot.placeBlock !== 'function') return false;
    const references = typeof this.adapter.findReferences === 'function'
      ? await this.adapter.findReferences(pos)
      : (typeof this.adapter.findReference === 'function' ? [await this.adapter.findReference(pos)].filter(Boolean) : []);
    for (const reference of references) {
      const refPos = reference.reference?.position || reference.reference;
      if (!await this.adapter.navigateNear(refPos, 3)) continue;
      for (let attempt = 1; attempt <= this.options.placementAttempts; attempt += 1) {
        try {
          if (!await this.adapter.equipItem(this.options.fillMaterial, 'hand')) continue;
          const face = reference.face || new Vec3(0, 1, 0);
          if (typeof this.adapter.placeBlockAt === 'function') await this.adapter.placeBlockAt(pos, reference.reference, face);
          else await this.bot.placeBlock(reference.reference, face);
        } catch (error) {
          this.options.log(`Landscaping placement ${this.options.fillMaterial} gagal di (${key(pos)}): ${error.message}`);
        }
        if (await this.waitForBlock(pos, this.options.fillMaterial)) return true;
        if (attempt < this.options.placementAttempts) {
          const delay = this.options.placementRetryDelayMs + (this.options.placementBackoffMs * attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    return false;
  }

  async build() {
    if (!this.state.updatedAt && this.checkpointFile) await this.loadCheckpoint();
    const plan = this.map();
    if (plan.summary.unknown || plan.summary.liquid || plan.summary.blocked || plan.summary.height_limit) {
      return { status: 'BLOCKED', plan, reason: 'pemetaan menemukan chunk tidak diketahui, cairan, ketinggian di luar batas, atau blok non-natural.' };
    }
    const actions = [];
    // Gali dulu seluruh area agar dirt hasil excavate dapat dipakai mengisi kolom rendah.
    for (const column of plan.columns) for (const pos of column.clear) actions.push({ kind: 'clear', pos });
    const fillActions = [];
    for (const column of plan.columns) for (const pos of column.fill) fillActions.push({ kind: 'fill', pos });
    // Bangun lapisan terbawah lebih dulu. Titik yang belum punya referensi solid (mis. lubang
    // lebar di bawah lantai lama) ditunda ke putaran berikutnya sampai tetangganya menjadi pijakan.
    fillActions.sort((a, b) => a.pos.y - b.pos.y || a.pos.z - b.pos.z || a.pos.x - b.pos.x);
    actions.push(...fillActions);
    let completedNow = 0;
    let pending = actions;
    while (pending.length) {
      let progressed = false;
      const deferred = [];
      for (const action of pending) {
        if (action.kind === 'fill' && typeof this.adapter.getItemCount === 'function' && this.adapter.getItemCount(this.options.fillMaterial) === 0) {
          await this.saveCheckpoint();
          return { status: 'PAUSED', code: 'MATERIAL_SHORTAGE', completed: completedNow, reason: `${this.options.fillMaterial} habis`, plan };
        }
        const id = actionKey(action.kind, action.pos);
        if (this.state.completed.has(id)) {
          const live = this.adapter.blockAt(action.pos);
          if (action.kind === 'clear' ? isAir(live) : FILL_NAMES.has(live?.name) || isSolid(live)) continue;
          this.state.completed.delete(id);
        }
        const ok = action.kind === 'clear' ? await this.clearOne(action.pos) : await this.fillOne(action.pos);
        if (!ok) {
          deferred.push(action);
          continue;
        }
        this.state.completed.add(id);
        completedNow += 1;
        progressed = true;
        await this.saveCheckpoint();
        this.options.log(`${action.kind === 'clear' ? 'Gali' : 'Isi'} landscaping di (${key(action.pos)})`);
      }
      if (!deferred.length) {
        const verified = this.map();
        const remaining = verified.summary;
        if (remaining.clear || remaining.fill || remaining.unknown || remaining.liquid || remaining.blocked || remaining.height_limit) {
          return { status: 'PAUSED', code: 'VERIFY_REMAINING', completed: completedNow, plan: verified, reason: 'Pemetaan akhir masih menemukan pekerjaan tersisa.' };
        }
        return { status: 'COMPLETE', completed: completedNow, actions: actions.length, plan: verified };
      }
      if (!progressed) {
        const action = deferred[0];
        await this.saveCheckpoint();
        return { status: 'PAUSED', completed: completedNow, reason: `aksi ${action.kind} gagal di (${key(action.pos)})`, plan };
      }
      pending = deferred;
      await new Promise(resolve => setTimeout(resolve, this.options.placementRetryDelayMs));
    }
    return { status: 'COMPLETE', completed: completedNow, actions: actions.length, plan };
  }
}

module.exports = {
  StorageRoomLandscaper,
  mapLandscape,
  createLandscapeBounds,
  readCheckpoint,
  writeCheckpoint,
  key,
  actionKey,
  isAir,
  isSolid,
  NATURAL_NAMES,
  LIQUID_NAMES,
  FILL_NAMES
};
