/**
 * @file worldAwarenessEngine.js
 * @description Cache awareness dunia berbasis chunk untuk block, area semantik, dan hazard.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { getBlockCollisionType, BLOCK_COLLISION_TYPES } = require('./richVoxelSpatialEngine');

const CHUNK_SIZE = 16;

const DEFAULT_WORLD_AWARENESS_CONFIG = Object.freeze({
  chunkRadius: 6,
  verticalRadius: 8,
  scanProfile: 'balanced',
  scanBudgetBlocksPerTick: 2048,
  maxCachedBlocks: 250000,
  trackAir: false,
  semanticAreas: []
});

const SCAN_PROFILES = Object.freeze({
  surface: Object.freeze({
    chunkRadius: 10,
    verticalBelow: 2,
    verticalAbove: 3,
    priority: 'directional'
  }),
  cave: Object.freeze({
    chunkRadius: 4,
    verticalBelow: 8,
    verticalAbove: 8,
    priority: 'nearest'
  }),
  mob_farm: Object.freeze({
    chunkRadius: 2,
    verticalBelow: 5,
    verticalAbove: 5,
    priority: 'area_first'
  }),
  farm: Object.freeze({
    chunkRadius: 3,
    verticalBelow: 2,
    verticalAbove: 2,
    priority: 'area_first'
  }),
  balanced: Object.freeze({
    chunkRadius: 6,
    verticalBelow: 8,
    verticalAbove: 8,
    priority: 'nearest'
  })
});

function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

function blockToChunkCoord(x, z) {
  return {
    cx: floorDiv(Math.floor(x), CHUNK_SIZE),
    cz: floorDiv(Math.floor(z), CHUNK_SIZE)
  };
}

function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

function blockKey(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

function parseBlockKey(key) {
  const [x, y, z] = key.split(',').map(Number);
  return { x, y, z };
}

function chunkRadiusToBlockRadius(chunkRadius) {
  return Math.max(0, Number(chunkRadius) || 0) * CHUNK_SIZE;
}

function estimateChunkScanCost(chunkRadius, verticalHeight) {
  const chunksPerSide = chunkRadius * 2 + 1;
  const chunks = chunksPerSide * chunksPerSide;
  return {
    chunks,
    horizontalBlocks: chunks * CHUNK_SIZE * CHUNK_SIZE,
    totalBlocks: chunks * CHUNK_SIZE * CHUNK_SIZE * Math.max(1, verticalHeight)
  };
}

function resolveScanProfile(profileNameOrOptions = 'balanced', overrides = {}) {
  const base = typeof profileNameOrOptions === 'string'
    ? (SCAN_PROFILES[profileNameOrOptions] || SCAN_PROFILES.balanced)
    : { ...SCAN_PROFILES.balanced, ...profileNameOrOptions };
  return { ...base, ...overrides };
}

function isInsideArea(pos, area) {
  if (!area || !pos) return true;
  const minX = Math.min(area.min.x, area.max.x);
  const maxX = Math.max(area.min.x, area.max.x);
  const minY = Math.min(area.min.y, area.max.y);
  const maxY = Math.max(area.min.y, area.max.y);
  const minZ = Math.min(area.min.z, area.max.z);
  const maxZ = Math.max(area.min.z, area.max.z);
  return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY && pos.z >= minZ && pos.z <= maxZ;
}

function normalizeBlock(block) {
  if (!block) return null;
  const position = block.position || block;
  const name = block.name || block.type || 'air';
  return {
    name,
    type: block.type,
    metadata: block.metadata,
    properties: block.properties || {},
    position: {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z)
    },
    raw: block,
    updatedAt: Date.now()
  };
}

class WorldAwarenessEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this._explicitOptions = new Set(Object.keys(options));
    this.options = { ...DEFAULT_WORLD_AWARENESS_CONFIG, ...options };
    this.bot = options.bot || null;
    this.blockAccessor = options.blockAccessor || this._mineflayerBlockAccessor.bind(this);
    this.blocks = new Map();
    this.chunkIndex = new Map();
    this.semanticAreas = new Map();

    for (const area of this.options.semanticAreas || []) {
      this.registerArea(area.name, area);
    }

    this._bindBotEvents();
  }

  _bindBotEvents() {
    if (!this.bot || typeof this.bot.on !== 'function') return;
    this.bot.on('blockUpdate', (oldBlock, newBlock) => {
      this.rememberBlock(newBlock || oldBlock);
    });
  }

  _mineflayerBlockAccessor(x, y, z) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;
    return this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  registerArea(name, area) {
    if (!name) throw new Error('Nama area semantik wajib diisi.');
    this.semanticAreas.set(name, { ...area, name });
  }

  rememberBlock(block) {
    const normalized = normalizeBlock(block);
    if (!normalized) return null;
    if (!this.options.trackAir && normalized.name === 'air') {
      this.blocks.delete(blockKey(normalized.position.x, normalized.position.y, normalized.position.z));
      return normalized;
    }

    const key = blockKey(normalized.position.x, normalized.position.y, normalized.position.z);
    this.blocks.set(key, normalized);

    const { cx, cz } = blockToChunkCoord(normalized.position.x, normalized.position.z);
    const cKey = chunkKey(cx, cz);
    if (!this.chunkIndex.has(cKey)) this.chunkIndex.set(cKey, new Set());
    this.chunkIndex.get(cKey).add(key);

    this._enforceCacheLimit();
    this.emit('block_remembered', normalized);
    return normalized;
  }

  getCachedBlock(x, y, z) {
    return this.blocks.get(blockKey(x, y, z)) || null;
  }

  getBlockAt(x, y, z, options = {}) {
    const cached = this.getCachedBlock(x, y, z);
    if (cached && !options.refresh) return cached;
    const liveBlock = this.blockAccessor(Math.floor(x), Math.floor(y), Math.floor(z));
    return this.rememberBlock(liveBlock || { name: 'air', position: { x, y, z } });
  }

  getChunksInRadius(center, chunkRadius = this.options.chunkRadius) {
    const { cx, cz } = blockToChunkCoord(center.x, center.z);
    const chunks = [];
    for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
      for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
        chunks.push({ cx: cx + dx, cz: cz + dz, key: chunkKey(cx + dx, cz + dz), distanceChunks: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    }
    return chunks.sort((a, b) => a.distanceChunks - b.distanceChunks);
  }

  getPrioritizedChunks(center, options = {}) {
    const profile = resolveScanProfile(options.profile || this.options.scanProfile, options.profileOverrides);
    const chunkRadius = options.chunkRadius ?? (this._explicitOptions.has('chunkRadius') ? this.options.chunkRadius : profile.chunkRadius) ?? this.options.chunkRadius;
    const chunks = this.getChunksInRadius(center, chunkRadius);
    const heading = options.heading || options.velocity || this._currentBotVelocity();
    const area = options.areaName ? this.semanticAreas.get(options.areaName) : options.area;

    return chunks.sort((a, b) => {
      const scoreA = this._scoreChunkPriority(a, center, heading, area, profile.priority);
      const scoreB = this._scoreChunkPriority(b, center, heading, area, profile.priority);
      return scoreB - scoreA;
    });
  }

  scanAround(center = this._currentBotPosition(), options = {}) {
    const profile = resolveScanProfile(options.profile || this.options.scanProfile, options.profileOverrides);
    const chunkRadius = options.chunkRadius ?? (this._explicitOptions.has('chunkRadius') ? this.options.chunkRadius : profile.chunkRadius) ?? this.options.chunkRadius;
    const configuredVerticalBelow = this._explicitOptions.has('verticalBelow') ? this.options.verticalBelow : undefined;
    const configuredVerticalAbove = this._explicitOptions.has('verticalAbove') ? this.options.verticalAbove : undefined;
    const configuredVerticalRadius = this._explicitOptions.has('verticalRadius') ? this.options.verticalRadius : undefined;
    const verticalBelow = options.verticalBelow ?? configuredVerticalBelow ?? configuredVerticalRadius ?? profile.verticalBelow ?? this.options.verticalRadius;
    const verticalAbove = options.verticalAbove ?? configuredVerticalAbove ?? configuredVerticalRadius ?? profile.verticalAbove ?? this.options.verticalRadius;
    const budget = options.budget ?? this.options.scanBudgetBlocksPerTick;
    const minY = Math.floor((options.minY ?? center.y - verticalBelow));
    const maxY = Math.floor((options.maxY ?? center.y + verticalAbove));
    const chunks = this.getPrioritizedChunks(center, { ...options, chunkRadius, profile });
    let scanned = 0;
    let remembered = 0;

    for (const chunk of chunks) {
      const startX = chunk.cx * CHUNK_SIZE;
      const startZ = chunk.cz * CHUNK_SIZE;
      for (let y = minY; y <= maxY; y++) {
        for (let z = startZ; z < startZ + CHUNK_SIZE; z++) {
          for (let x = startX; x < startX + CHUNK_SIZE; x++) {
            if (scanned >= budget) {
              return { scanned, remembered, complete: false, chunkRadius, verticalHeight: maxY - minY + 1, profile: options.profile || this.options.scanProfile };
            }
            scanned++;
            const block = this.blockAccessor(x, y, z);
            const normalized = this.rememberBlock(block || { name: 'air', position: { x, y, z } });
            if (normalized && normalized.name !== 'air') remembered++;
          }
        }
      }
    }

    return { scanned, remembered, complete: true, chunkRadius, verticalHeight: maxY - minY + 1, profile: options.profile || this.options.scanProfile };
  }

  findCachedBlocks(predicate, options = {}) {
    const area = options.areaName ? this.semanticAreas.get(options.areaName) : options.area;
    const center = options.center || this._currentBotPosition();
    const maxDistance = options.maxDistance ?? Infinity;
    const result = [];

    for (const block of this.blocks.values()) {
      if (area && !isInsideArea(block.position, area)) continue;
      if (maxDistance !== Infinity) {
        const d = Math.hypot(block.position.x - center.x, block.position.y - center.y, block.position.z - center.z);
        if (d > maxDistance) continue;
      }
      if (predicate(block)) result.push(block);
    }

    return result.sort((a, b) => {
      const da = Math.hypot(a.position.x - center.x, a.position.y - center.y, a.position.z - center.z);
      const db = Math.hypot(b.position.x - center.x, b.position.y - center.y, b.position.z - center.z);
      return da - db;
    });
  }

  findHazards(options = {}) {
    return this.findCachedBlocks(block => getBlockCollisionType(block.name) === BLOCK_COLLISION_TYPES.HAZARD_DEADLY, options);
  }

  findBlocksByNames(names, options = {}) {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    return this.findCachedBlocks(block => wanted.has(block.name), options);
  }

  isSafeStandingSpot(pos) {
    const foot = this.getBlockAt(pos.x, pos.y, pos.z);
    const head = this.getBlockAt(pos.x, pos.y + 1, pos.z);
    const ground = this.getBlockAt(pos.x, pos.y - 1, pos.z);
    const footType = getBlockCollisionType(foot?.name);
    const headType = getBlockCollisionType(head?.name);
    const groundType = getBlockCollisionType(ground?.name);

    const footClear = footType === BLOCK_COLLISION_TYPES.AIR_PASSABLE || footType === BLOCK_COLLISION_TYPES.WATER_SWIMMABLE;
    const headClear = headType === BLOCK_COLLISION_TYPES.AIR_PASSABLE || headType === BLOCK_COLLISION_TYPES.WATER_SWIMMABLE;
    const groundSafe = groundType !== BLOCK_COLLISION_TYPES.AIR_PASSABLE && groundType !== BLOCK_COLLISION_TYPES.HAZARD_DEADLY;
    return footClear && headClear && groundSafe;
  }

  _currentBotPosition() {
    return this.bot?.entity?.position || { x: 0, y: 64, z: 0 };
  }

  _currentBotVelocity() {
    return this.bot?.entity?.velocity || { x: 0, y: 0, z: 0 };
  }

  _scoreChunkPriority(chunk, center, heading, area, priority = 'nearest') {
    let score = 1000 - (chunk.distanceChunks * 50);
    const chunkCenter = {
      x: chunk.cx * CHUNK_SIZE + CHUNK_SIZE / 2,
      y: center.y,
      z: chunk.cz * CHUNK_SIZE + CHUNK_SIZE / 2
    };

    if (priority === 'directional' && heading && (Math.abs(heading.x || 0) + Math.abs(heading.z || 0)) > 0.001) {
      const dx = chunkCenter.x - center.x;
      const dz = chunkCenter.z - center.z;
      const len = Math.hypot(dx, dz) || 1;
      const hLen = Math.hypot(heading.x || 0, heading.z || 0) || 1;
      const dot = ((dx / len) * ((heading.x || 0) / hLen)) + ((dz / len) * ((heading.z || 0) / hLen));
      score += dot * 120;
    }

    if (priority === 'area_first' && area) {
      const chunkArea = {
        min: { x: chunk.cx * CHUNK_SIZE, y: area.min.y, z: chunk.cz * CHUNK_SIZE },
        max: { x: chunk.cx * CHUNK_SIZE + CHUNK_SIZE - 1, y: area.max.y, z: chunk.cz * CHUNK_SIZE + CHUNK_SIZE - 1 }
      };
      if (this._areasOverlap(chunkArea, area)) score += 500;
    }

    return score;
  }

  _areasOverlap(a, b) {
    return a.min.x <= b.max.x && a.max.x >= b.min.x &&
      a.min.y <= b.max.y && a.max.y >= b.min.y &&
      a.min.z <= b.max.z && a.max.z >= b.min.z;
  }

  _enforceCacheLimit() {
    const limit = this.options.maxCachedBlocks;
    if (!limit || this.blocks.size <= limit) return;
    const overflow = this.blocks.size - limit;
    const keys = this.blocks.keys();
    for (let i = 0; i < overflow; i++) {
      const next = keys.next();
      if (next.done) break;
      this.blocks.delete(next.value);
    }
  }
}

module.exports = {
  WorldAwarenessEngine,
  DEFAULT_WORLD_AWARENESS_CONFIG,
  SCAN_PROFILES,
  CHUNK_SIZE,
  blockToChunkCoord,
  chunkKey,
  blockKey,
  parseBlockKey,
  chunkRadiusToBlockRadius,
  estimateChunkScanCost,
  resolveScanProfile,
  isInsideArea
};
