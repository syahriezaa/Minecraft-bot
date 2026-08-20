/**
 * @file arenaBuilder.js
 * @description Pembangkit dunia arena prosedural untuk 4 tingkat tolak ukur (benchmark levels)
 * sistem autonomous companion Minecraft. Mendukung pembangkitan lintasan datar (Level 1),
 * rintangan & elevasi (Level 2), navigasi vertikal tangga, ladder & jembatan (Level 3),
 * serta koridor rute gua bawah tanah menuju spawner farm target [-256, -20, -432] (Level 4).
 */

// Konstanta batas koordinat vertikal dunia Minecraft (1.18+)
const MIN_WORLD_Y = -64;
const MAX_WORLD_Y = 320;

// Definisi konfigurasi spesifikasi setiap tingkat level arena
const LEVEL_ARENA_CONFIGS = Object.freeze({
  1: {
    id: 'level1',
    name: 'Flat Ground 30m Sprint',
    nameId: 'Medan Datar (30m)',
    startPos: { x: 0, y: 64, z: 0 },
    targetPos: { x: 30, y: 64, z: 0 }
  },
  2: {
    id: 'level2',
    name: 'Obstacles & Elevation 50m Course',
    nameId: 'Rintangan & Elevasi (50m)',
    startPos: { x: 0, y: 64, z: 0 },
    targetPos: { x: 50, y: 64, z: 0 }
  },
  3: {
    id: 'level3',
    name: 'Stairs, Ladders & Bridges Arena',
    nameId: 'Tangga, Ladder & Jembatan Sempit',
    startPos: { x: 0, y: 64, z: 0 },
    targetPos: { x: 10, y: 64, z: 15 }
  },
  4: {
    id: 'level4',
    name: 'Underground Spawner Farm Arena',
    nameId: 'Rute Bawah Tanah Farm Spawner',
    startPos: { x: 0, y: 64, z: 0 },
    targetPos: { x: -256, y: -20, z: -432 }
  }
});

/**
 * Memvalidasi apakah koordinat vertikal Y berada dalam rentang valid dunia Minecraft [-64, 320].
 * @param {number} y - Koordinat vertikal Y
 * @throws {Error} Jika Y berada di luar batas [-64, 320]
 */
function validateYCoordinate(y) {
  if (typeof y !== 'number' || Number.isNaN(y) || y < MIN_WORLD_Y || y > MAX_WORLD_Y) {
    throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [${MIN_WORLD_Y}, ${MAX_WORLD_Y}].`);
  }
}

/**
 * Memvalidasi instance server agar memiliki metode manipulasi blok yang valid.
 * @param {Object} server - Instance server Minecraft (TestServer atau MockArenaHarness)
 * @throws {Error} Jika server tidak valid
 */
function validateServerInstance(server) {
  if (!server || typeof server.setBlock !== 'function') {
    throw new Error('Instance server tidak valid atau tidak menyediakan metode setBlock.');
  }
}

/**
 * Menempatkan satu blok secara aman dengan validasi batas ketinggian Y.
 * Mendukung pemanggilan metode setBlock baik asinkron maupun sinkron.
 * @param {Object} server - Instance server
 * @param {number} x - Koordinat X
 * @param {number} y - Koordinat Y
 * @param {number} z - Koordinat Z
 * @param {string|number} blockType - Jenis blok
 * @param {Object} [properties={}] - Properti blok opsional
 * @returns {Promise<void>}
 */
async function safeSetBlock(server, x, y, z, blockType, properties = {}) {
  validateYCoordinate(y);
  const result = server.setBlock(Math.round(x), Math.round(y), Math.round(z), blockType, properties);
  if (result && typeof result.then === 'function') {
    await result;
  }
}

/**
 * Mengisi wilayah balok 3D (bounding box) dengan jenis blok tertentu.
 * @param {Object} server - Instance server
 * @param {number} minX - Koordinat X minimum
 * @param {number} minY - Koordinat Y minimum
 * @param {number} minZ - Koordinat Z minimum
 * @param {number} maxX - Koordinat X maksimum
 * @param {number} maxY - Koordinat Y maksimum
 * @param {number} maxZ - Koordinat Z maksimum
 * @param {string|number} blockType - Jenis blok
 * @param {Object} [properties={}] - Properti blok opsional
 * @returns {Promise<void>}
 */
async function fillRegion(server, minX, minY, minZ, maxX, maxY, maxZ, blockType, properties = {}) {
  const x0 = Math.min(minX, maxX);
  const x1 = Math.max(minX, maxX);
  const y0 = Math.min(minY, maxY);
  const y1 = Math.max(minY, maxY);
  const z0 = Math.min(minZ, maxZ);
  const z1 = Math.max(minZ, maxZ);

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      validateYCoordinate(y);
      for (let z = z0; z <= z1; z++) {
        await safeSetBlock(server, x, y, z, blockType, properties);
      }
    }
  }
}

/**
 * Pembangkit Arena Level 1: Flat Ground 30m Sprint ([0, 64, 0] ke [30, 64, 0]).
 * @param {Object} server - Instance server
 * @param {Object} [options={}] - Opsi tambahan
 * @returns {Promise<Object>} Metadata spesifikasi arena Level 1
 */
async function buildLevel1Arena(server, options = {}) {
  validateServerInstance(server);

  const minX = -5;
  const maxX = 35;
  const minZ = -3;
  const maxZ = 3;

  // 1. Bangun lantai dasar stone pada Y=63 dan bersihkan ruang udara Y=64..67
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      await safeSetBlock(server, x, 63, z, 'stone');
      for (let y = 64; y <= 67; y++) {
        await safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // 2. Bangun dinding pembatas samping (Z = minZ dan Z = maxZ)
  for (let x = minX; x <= maxX; x++) {
    for (let y = 64; y <= 65; y++) {
      await safeSetBlock(server, x, y, minZ, 'stone');
      await safeSetBlock(server, x, y, maxZ, 'stone');
    }
  }

  // 3. Bangun dinding penutup ujung (X = minX dan X = maxX)
  for (let z = minZ; z <= maxZ; z++) {
    for (let y = 64; y <= 65; y++) {
      await safeSetBlock(server, minX, y, z, 'stone');
      await safeSetBlock(server, maxX, y, z, 'stone');
    }
  }

  return {
    level: 1,
    startCoord: { x: 0, y: 64, z: 0 },
    startPos: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 30, y: 64, z: 0 },
    targetPos: { x: 30, y: 64, z: 0 },
    bounds: { minX, minY: 63, minZ, maxX, maxY: 67, maxZ }
  };
}

/**
 * Pembangkit Arena Level 2: Obstacles & Elevation 50m Course.
 * @param {Object} server - Instance server
 * @param {Object} [options={}] - Opsi tambahan
 * @returns {Promise<Object>} Metadata spesifikasi arena Level 2
 */
async function buildLevel2Arena(server, options = {}) {
  validateServerInstance(server);

  const minX = -5;
  const maxX = 55;
  const minZ = -4;
  const maxZ = 4;

  // 1. Bangun lantai dasar dengan elevasi naik 1 blok pada X=15..29
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      let yGround = 63;
      if (x >= 15 && x < 30) {
        yGround = 64; // Langkah elevasi naik 1 blok
      }
      await safeSetBlock(server, x, yGround, z, 'stone');

      // Bersihkan udara di atas lantai lokal
      for (let y = yGround + 1; y <= yGround + 4; y++) {
        await safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // 2. Bangun dinding pembatas samping (Z = minZ dan Z = maxZ)
  for (let x = minX; x <= maxX; x++) {
    const yGround = (x >= 15 && x < 30) ? 64 : 63;
    for (let y = yGround + 1; y <= yGround + 2; y++) {
      await safeSetBlock(server, x, y, minZ, 'stone');
      await safeSetBlock(server, x, y, maxZ, 'stone');
    }
  }

  // 3. Pasang rintangan dinding melintang (memaksa S-curves)
  // Dinding 1 pada X=20 (Y=65, 66) untuk Z = -3 s.d. 1 (celah di Z=2..3)
  for (let z = -3; z <= 1; z++) {
    await safeSetBlock(server, 20, 65, z, 'stone');
    await safeSetBlock(server, 20, 66, z, 'stone');
  }

  // Rintangan lompat 2 pada X=25 (Y=65) untuk Z = -1 s.d. 3 (celah di Z=-3..-2)
  for (let z = -1; z <= 3; z++) {
    await safeSetBlock(server, 25, 65, z, 'stone');
  }

  // Dinding 3 pada X=38 (Y=64, 65) untuk Z = -3 s.d. 0 (celah di Z=1..3)
  for (let z = -3; z <= 0; z++) {
    await safeSetBlock(server, 38, 64, z, 'stone');
    await safeSetBlock(server, 38, 65, z, 'stone');
  }

  return {
    level: 2,
    startCoord: { x: 0, y: 64, z: 0 },
    startPos: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 50, y: 64, z: 0 },
    targetPos: { x: 50, y: 64, z: 0 },
    obstacleCount: 6,
    bounds: { minX, minY: 63, minZ, maxX, maxY: 68, maxZ }
  };
}

/**
 * Pembangkit Arena Level 3: Vertical Navigation (Tangga Balok, Ladder & Jembatan Sempit 1-Blok).
 * @param {Object} server - Instance server
 * @param {Object} [options={}] - Opsi tambahan
 * @returns {Promise<Object>} Metadata spesifikasi arena Level 3
 */
async function buildLevel3Arena(server, options = {}) {
  validateServerInstance(server);

  // 1. Bersihkan area kerja utama Level 3
  await fillRegion(server, -2, 60, -5, 15, 80, 20, 'air');

  // 2. Bangun tangga balok menanjak (X = 0 s.d. 10, Z = 0)
  for (let i = 0; i <= 10; i++) {
    const yStep = 63 + i;
    // Pondasi solid di bawah tangga
    for (let y = 63; y < yStep; y++) {
      await safeSetBlock(server, i, y, 0, 'stone');
    }
    await safeSetBlock(server, i, yStep, 0, 'stone_stairs', { facing: 'east', half: 'bottom' });
    await safeSetBlock(server, i, yStep + 1, 0, 'air');
    await safeSetBlock(server, i, yStep + 2, 0, 'air');
  }

  // 3. Bangun jembatan sempit 1-blok (X = 10, Z = 0 s.d. 15 pada Y = 73)
  for (let z = 0; z <= 15; z++) {
    await safeSetBlock(server, 10, 73, z, 'stone');
    await safeSetBlock(server, 10, 74, z, 'air');
    await safeSetBlock(server, 10, 75, z, 'air');

    // Buat celah jurang/void di sisi kiri (X=9) dan kanan (X=11)
    if (z >= 1 && z <= 14) {
      for (let y = 63; y <= 73; y++) {
        await safeSetBlock(server, 9, y, z, 'air');
        await safeSetBlock(server, 11, y, z, 'air');
      }
    }
  }

  // 4. Bangun tiang penopang dan tiang tangga ladder vertikal (Y = 64 s.d. 74 pada X=10, Z=15)
  for (let y = 64; y <= 74; y++) {
    await safeSetBlock(server, 10, y, 16, 'stone');                   // Tiang solid pendukung
    await safeSetBlock(server, 10, y, 15, 'ladder', { facing: 'north' }); // Blok tangga ladder
    await safeSetBlock(server, 10, y, 14, 'air');                    // Ruang gerak bot
  }

  // Platform pendaratan bawah pada Y=63
  await safeSetBlock(server, 10, 63, 15, 'stone');
  await safeSetBlock(server, 10, 63, 14, 'stone');

  return {
    level: 3,
    startCoord: { x: 0, y: 64, z: 0 },
    startPos: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 10, y: 64, z: 15 },
    targetPos: { x: 10, y: 64, z: 15 },
    stairsCount: 11,
    ladderHeight: 11,
    bounds: { minX: 0, minY: 63, minZ: 0, maxX: 12, maxY: 76, maxZ: 17 }
  };
}

/**
 * Pembangkit Arena Level 4: Underground Spawner Farm Arena menuju [-256, -20, -432].
 * @param {Object} server - Instance server
 * @param {Object} [options={}] - Opsi tambahan
 * @returns {Promise<Object>} Metadata spesifikasi arena Level 4
 */
async function buildLevel4Arena(server, options = {}) {
  validateServerInstance(server);

  // 1. Pintu Masuk Permukaan
  await safeSetBlock(server, 0, 63, 0, 'stone');
  await safeSetBlock(server, 0, 64, 0, 'air');

  // 2. Daftar Waypoint Makro untuk Jalur Lorong Bawah Tanah
  const waypoints = [
    { x: 0, y: 64, z: 0 },
    { x: -50, y: 45, z: -80 },
    { x: -120, y: 25, z: -200 },
    { x: -190, y: 5, z: -320 },
    { x: -240, y: -15, z: -400 },
    { x: -256, y: -20, z: -432 }
  ];

  // 3. Pengerukan Jalur Lorong Gua Antar-Waypoint
  for (let k = 0; k < waypoints.length - 1; k++) {
    const p1 = waypoints[k];
    const p2 = waypoints[k + 1];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const steps = Math.ceil(dist);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = Math.round(p1.x + t * (p2.x - p1.x));
      const cy = Math.round(p1.y + t * (p2.y - p1.y));
      const cz = Math.round(p1.z + t * (p2.z - p1.z));
      const rockType = cy <= 0 ? 'deepslate' : 'stone';

      // Lantai dasar lorong
      await safeSetBlock(server, cx, cy - 1, cz, rockType);

      // Ruang udara lorong (3x3)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = 0; dy <= 2; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            await safeSetBlock(server, cx + dx, cy + dy, cz + dz, 'air');
          }
        }
      }
    }
  }

  // 4. Konstruksi Ruang Dungeon Spawner (Pusat: [-256, -20, -432])
  const roomMinX = -261;
  const roomMaxX = -251;
  const roomMinZ = -437;
  const roomMaxZ = -427;

  // Lantai dungeon deepslate pada Y = -21
  for (let x = roomMinX; x <= roomMaxX; x++) {
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      await safeSetBlock(server, x, -21, z, 'deepslate');
    }
  }

  // Ruang udara interior dungeon (Y = -20 s.d. -17)
  for (let x = roomMinX + 1; x <= roomMaxX - 1; x++) {
    for (let z = roomMinZ + 1; z <= roomMaxZ - 1; z++) {
      for (let y = -20; y <= -17; y++) {
        await safeSetBlock(server, x, y, z, 'air');
      }
    }
  }

  // Dinding dungeon (mossy cobblestone / cobblestone)
  for (let y = -21; y <= -16; y++) {
    for (let x = roomMinX; x <= roomMaxX; x++) {
      await safeSetBlock(server, x, y, roomMinZ, 'cobblestone');
      await safeSetBlock(server, x, y, roomMaxZ, 'mossy_cobblestone');
    }
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      await safeSetBlock(server, roomMinX, y, z, 'mossy_cobblestone');
      await safeSetBlock(server, roomMaxX, y, z, 'cobblestone');
    }
  }

  // Langit-langit ruangan pada Y = -16
  for (let x = roomMinX; x <= roomMaxX; x++) {
    for (let z = roomMinZ; z <= roomMaxZ; z++) {
      await safeSetBlock(server, x, -16, z, 'deepslate');
    }
  }

  // 5. Blok Spawner Zombie di Tengah Ruangan [-256, -19, -432]
  await safeSetBlock(server, -256, -19, -432, 'spawner');

  // 6. Penempatan 4 Unit Peti Terkategori
  const chestDefs = [
    {
      id: 'chest_weapons',
      coord: { x: -258, y: -20, z: -429 },
      items: [{ name: 'diamond_sword', count: 1 }, { name: 'iron_sword', count: 2 }, { name: 'iron_axe', count: 1 }]
    },
    {
      id: 'chest_drops',
      coord: { x: -256, y: -20, z: -429 },
      items: [{ name: 'rotten_flesh', count: 64 }, { name: 'bone', count: 16 }, { name: 'arrow', count: 32 }]
    },
    {
      id: 'chest_armor',
      coord: { x: -254, y: -20, z: -429 },
      items: [{ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 }, { name: 'iron_leggings', count: 1 }, { name: 'iron_boots', count: 1 }]
    },
    {
      id: 'chest_trash',
      coord: { x: -252, y: -20, z: -429 },
      items: [{ name: 'poisonous_potato', count: 5 }, { name: 'wooden_hoe', count: 1 }]
    }
  ];

  const chestCoords = [];
  for (const c of chestDefs) {
    chestCoords.push(c.coord);
    if (typeof server.setupChest === 'function') {
      server.setupChest(c.coord, c.id, c.items);
    } else {
      await safeSetBlock(server, c.coord.x, c.coord.y, c.coord.z, 'chest');
    }
  }

  // 7. Konstruksi Kolam Pembakaran Sampah Lava Aman (Safe Incinerator)
  const lavaCoord = { x: -259, y: -21, z: -435 };
  if (typeof server.setupHazardBlock === 'function') {
    server.setupHazardBlock(lavaCoord, 'lava');
  } else {
    await safeSetBlock(server, lavaCoord.x, lavaCoord.y, lavaCoord.z, 'lava');
  }

  // Lubang pembuangan sampah di atas lava
  await safeSetBlock(server, -259, -20, -435, 'air');

  // Pagar pengaman keliling kolam lava
  await safeSetBlock(server, -260, -20, -435, 'iron_bars');
  await safeSetBlock(server, -258, -20, -435, 'iron_bars');
  await safeSetBlock(server, -259, -20, -436, 'iron_bars');

  // Platform berdiri aman bot pada jarak 2 meter
  await safeSetBlock(server, -259, -21, -433, 'deepslate');
  await safeSetBlock(server, -259, -20, -433, 'air');

  return {
    level: 4,
    startCoord: { x: 0, y: 64, z: 0 },
    startPos: { x: 0, y: 64, z: 0 },
    targetCoord: { x: -256, y: -20, z: -432 },
    targetPos: { x: -256, y: -20, z: -432 },
    spawnerCoord: { x: -256, y: -19, z: -432 },
    chestCoords,
    chestDefinitions: chestDefs,
    hazardCoord: lavaCoord,
    hazardLocation: lavaCoord,
    waypoints,
    bounds: { minX: -261, minY: -22, minZ: -437, maxX: 0, maxY: 68, maxZ: 0 }
  };
}

/**
 * Dispatcher utama untuk membangun arena berdasarkan nomor tingkat kesulitan (Level 1-4).
 * @param {number|string} level - Tingkat level arena (1, 2, 3, atau 4)
 * @param {Object} server - Instance server Minecraft
 * @param {Object} [options={}] - Opsi tambahan
 * @returns {Promise<Object>} Metadata arena yang dibangun
 */
async function buildArena(level, server, options = {}) {
  const numLevel = Number(level);
  if (![1, 2, 3, 4].includes(numLevel)) {
    throw new Error('Tingkat level arena tidak valid! Harus bernilai antara 1 hingga 4.');
  }

  switch (numLevel) {
    case 1:
      return await buildLevel1Arena(server, options);
    case 2:
      return await buildLevel2Arena(server, options);
    case 3:
      return await buildLevel3Arena(server, options);
    case 4:
      return await buildLevel4Arena(server, options);
    default:
      throw new Error(`Tingkat level arena ${level} tidak didukung.`);
  }
}

/**
 * Membersihkan seluruh blok di dalam batasan arena menjadi udara.
 * @param {Object} server - Instance server Minecraft
 * @param {Object} bounds - Batasan wilayah { minX, minY, minZ, maxX, maxY, maxZ }
 * @returns {Promise<void>}
 */
async function clearArena(server, bounds) {
  validateServerInstance(server);
  if (!bounds) return;

  const { minX = 0, minY = 63, minZ = 0, maxX = 30, maxY = 70, maxZ = 0 } = bounds;
  await fillRegion(server, minX, minY, minZ, maxX, maxY, maxZ, 'air');
}

module.exports = {
  MIN_WORLD_Y,
  MAX_WORLD_Y,
  LEVEL_ARENA_CONFIGS,
  validateYCoordinate,
  validateServerInstance,
  safeSetBlock,
  fillRegion,
  buildLevel1Arena,
  buildLevel2Arena,
  buildLevel3Arena,
  buildLevel4Arena,
  buildArena,
  clearArena
};
