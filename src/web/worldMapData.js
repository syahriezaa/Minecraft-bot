const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function pointOfLandmark(landmark) {
  if (landmark?.shape === 'point' && landmark.position) return landmark.position;
  const points = Array.isArray(landmark?.boundary) ? landmark.boundary : [];
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + Number(point.x || 0), 0) / points.length,
    z: points.reduce((sum, point) => sum + Number(point.z || 0), 0) / points.length
  };
}

function parseCellResource(resource) {
  const match = String(resource || '').match(/^cell:(-?\d+),(-?\d+),(-?\d+)$/);
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

class WorldMapData {
  constructor({ memory, loadLandmarks = () => [], bots = () => [], miningStatus = () => null } = {}) {
    if (!memory?.db) throw new Error('World map membutuhkan SharedWorldMemory.');
    this.db = memory.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,world TEXT NOT NULL,dimension TEXT NOT NULL,kind TEXT NOT NULL,
      label TEXT,revision INTEGER NOT NULL DEFAULT 1,updatedAt INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS structure_voxels (
      world TEXT NOT NULL,dimension TEXT NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,z INTEGER NOT NULL,
      id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(world,dimension,x,y,z)
    ); CREATE TABLE IF NOT EXISTS reservations (
      world TEXT NOT NULL,dimension TEXT NOT NULL,resource TEXT NOT NULL,
      owner TEXT NOT NULL,token TEXT NOT NULL,expiresAt INTEGER NOT NULL,
      PRIMARY KEY(world,dimension,resource,token)
    ); CREATE TABLE IF NOT EXISTS bot_occupancy (
      world TEXT NOT NULL,dimension TEXT NOT NULL,owner TEXT NOT NULL,
      resource TEXT NOT NULL,expiresAt INTEGER NOT NULL,
      PRIMARY KEY(world,dimension,owner,resource)
    );`);
    this.loadLandmarks = loadLandmarks;
    this.bots = bots;
    this.miningStatus = miningStatus;
  }

  worlds() {
    return this.db.prepare(`SELECT world,dimension,COUNT(*) AS blocks,MIN(x) AS minX,MAX(x) AS maxX,
      MIN(y) AS minY,MAX(y) AS maxY,MIN(z) AS minZ,MAX(z) AS maxZ,MAX(observedAt) AS lastObservedAt
      FROM blocks GROUP BY world,dimension ORDER BY lastObservedAt DESC`).all();
  }

  snapshot(options = {}) {
    const availableWorlds = this.worlds();
    const selected = availableWorlds.find(item => item.world === options.world && item.dimension === options.dimension) || availableWorlds[0];
    if (!selected) return { world: null, dimension: null, bounds: null, blocks: [], structures: [], landmarks: [], reservations: [], bots: [], miningRegions: [], stats: { knownBlocks: 0, columns: 0 } };
    const radius = Math.max(16, Math.min(160, integer(options.radius, 96)));
    const centerX = integer(options.centerX, Math.round((selected.minX + selected.maxX) / 2));
    const centerZ = integer(options.centerZ, Math.round((selected.minZ + selected.maxZ) / 2));
    const minX = centerX - radius;
    const maxX = centerX + radius;
    const minZ = centerZ - radius;
    const maxZ = centerZ + radius;
    const mode = options.mode === 'slice' ? 'slice' : 'surface';
    const y = Math.max(-64, Math.min(320, integer(options.y, 70)));
    let rows;
    if (mode === 'slice') {
      rows = this.db.prepare(`SELECT x,y,z,name,observedAt,conflict FROM blocks
        WHERE world=? AND dimension=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND y=?`)
        .all(selected.world, selected.dimension, minX, maxX, minZ, maxZ, y);
    } else {
      rows = this.db.prepare(`SELECT x,y,z,name,observedAt,conflict FROM (
        SELECT x,y,z,name,observedAt,conflict,
          ROW_NUMBER() OVER (PARTITION BY x,z ORDER BY CASE WHEN name IN ('air','cave_air','void_air') THEN 1 ELSE 0 END, y DESC) AS rank
        FROM blocks WHERE world=? AND dimension=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?
      ) WHERE rank=1`)
        .all(selected.world, selected.dimension, minX, maxX, minZ, maxZ);
    }
    const blocks = rows.map(row => ({ x: row.x, y: row.y, z: row.z, name: row.name, air: AIR_NAMES.has(row.name), conflict: Boolean(row.conflict) }));
    const structures = this.db.prepare(`SELECT s.id,s.kind,s.label,s.updatedAt,COUNT(v.id) AS observedVoxels,
      MIN(v.x) AS minX,MAX(v.x) AS maxX,MIN(v.y) AS minY,MAX(v.y) AS maxY,MIN(v.z) AS minZ,MAX(v.z) AS maxZ
      FROM structures s JOIN structure_voxels v ON v.id=s.id
      WHERE s.world=? AND s.dimension=? AND v.x BETWEEN ? AND ? AND v.z BETWEEN ? AND ?
      GROUP BY s.id ORDER BY s.updatedAt DESC LIMIT 500`)
      .all(selected.world, selected.dimension, minX, maxX, minZ, maxZ);
    const landmarks = this.loadLandmarks().filter(landmark => {
      if (landmark.world && landmark.world !== selected.world) return false;
      if (landmark.dimension && landmark.dimension !== selected.dimension) return false;
      const point = pointOfLandmark(landmark);
      return point && point.x >= minX && point.x <= maxX && point.z >= minZ && point.z <= maxZ;
    }).slice(0, 800).map(landmark => ({
      id: landmark.id,
      shape: landmark.shape,
      name: landmark.name,
      category: landmark.category,
      position: landmark.position || null,
      boundary: Array.isArray(landmark.boundary) ? landmark.boundary.map(point => ({ x: point.x, z: point.z })) : null,
      bounds: landmark.bounds || null,
      lastObservedAt: landmark.lastObservedAt || landmark.discoveredAt || null
    }));
    const now = Date.now();
    const reservations = this.db.prepare(`SELECT resource,owner,expiresAt FROM reservations
      WHERE world=? AND dimension=? AND expiresAt>? UNION ALL
      SELECT resource,owner,expiresAt FROM bot_occupancy WHERE world=? AND dimension=? AND expiresAt>?`)
      .all(selected.world, selected.dimension, now, selected.world, selected.dimension, now)
      .map(row => ({ ...row, position: parseCellResource(row.resource) }))
      .filter(row => !row.position || (row.position.x >= minX && row.position.x <= maxX && row.position.z >= minZ && row.position.z <= maxZ));
    let sharedBots = [];
    try {
      sharedBots = this.db.prepare(`SELECT id,status,position,snapshot,capabilities,metadata,lastSeen FROM swarm_agents
        WHERE world=? AND dimension=? AND position IS NOT NULL AND lastSeen>?`)
        .all(selected.world, selected.dimension, now - 15000)
        .map(row => {
          const position = parseJson(row.position);
          const snapshot = parseJson(row.snapshot, {});
          const capabilities = parseJson(row.capabilities, []);
          const metadata = parseJson(row.metadata, {});
          if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
          return {
            id: row.id,
            name: row.id,
            role: metadata.role || capabilities[0] || 'worker',
            x: position.x,
            y: position.y,
            z: position.z,
            status: row.status,
            health: snapshot.health ?? null,
            inventoryFreeSlots: snapshot.inventoryFreeSlots ?? null,
            lastSeen: row.lastSeen
          };
        }).filter(Boolean);
    } catch (error) {
      if (!String(error.message).includes('no such table')) throw error;
    }
    const mergedBots = new Map();
    for (const bot of this.bots()) mergedBots.set(bot.id || bot.name, bot);
    for (const bot of sharedBots) mergedBots.set(bot.id || bot.name, { ...mergedBots.get(bot.id || bot.name), ...bot });
    const liveBots = [...mergedBots.values()]
      .filter(bot => bot.x >= minX && bot.x <= maxX && bot.z >= minZ && bot.z <= maxZ);
    const miningRegions = (this.miningStatus()?.config?.regions || []).map((region, index) => {
      const [regionMinX, regionMaxX, regionMinZ, regionMaxZ, floorY, maxRegionY] = region.split(',').map(Number);
      return { worker: `ResourceW${index + 1}`, minX: regionMinX, maxX: regionMaxX, minZ: regionMinZ, maxZ: regionMaxZ, floorY, maxY: maxRegionY };
    });
    return {
      world: selected.world,
      dimension: selected.dimension,
      availableWorlds,
      mode,
      y,
      bounds: { centerX, centerZ, radius, minX, maxX, minZ, maxZ },
      blocks,
      structures,
      landmarks,
      reservations,
      bots: liveBots,
      miningRegions,
      stats: { knownBlocks: selected.blocks, columns: blocks.length, lastObservedAt: selected.lastObservedAt }
    };
  }
}

module.exports = { WorldMapData, parseCellResource, pointOfLandmark, parseJson };
