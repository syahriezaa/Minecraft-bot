/**
 * @file richVoxelSpatialEngine.js
 * @description Mesin Analisis Spasial Voxel Kaya & Prediksi Tabrakan 3D Swept-AABB untuk Bot Minecraft.
 * 
 * Mengatasi masalah bot menabrak dinding/blok secara berulang karena kurangnya data lingkungan 3D.
 * Fitur:
 * 1. Volume Hitbox Nyata Pemain (0.6 x 1.8 x 0.6 meter).
 * 2. Validasi Clearance 2-Blok Vertikal (Kaki Y + Kepala Y+1).
 * 3. Matriks Sifat & Bentuk Blok (Pagar 1.5m, Slab 0.5m, Tangga, Air, Lava, Bahaya).
 * 4. Swept-AABB Continuous Collision Raycasting (Prediksi tabrakan sebelum bergerak).
 * 5. Tangent Wall-Sliding (Menggeser bot di sepanjang permukaan dinding alih-alih menabrak lurus).
 */

// Dimensi Hitbox Karakter Minecraft Standar
const PLAYER_HITBOX = Object.freeze({
  WIDTH: 0.6,
  HEIGHT: 1.8,
  HALF_WIDTH: 0.3,
  STEP_HEIGHT: 0.6, // Maksimal ketinggian pijakan otomatis tanpa lompat (slab/stairs)
  MAX_JUMP_UP: 1.25, // Maksimal lompatan vertikal
  MAX_SAFE_DROP: 3.0 // Batas aman jatuh tanpa cedera
});

// Kategori & Sifat Blok (Collision Types)
const BLOCK_COLLISION_TYPES = Object.freeze({
  AIR_PASSABLE: 0,      // Udara, rumput, bunga, obor, tanda (tidak ada tabrakan)
  SOLID_FULL: 1,        // Batu, tanah, kayu (1x1x1 solid)
  STEP_HALF: 2,         // Slab (0.5m tinggi)
  STAIRS: 3,            // Tangga (0.5m step-up)
  FENCE_TALL: 4,        // Pagar / Tembok batu (1.5m tinggi - TIDAK BISA dilompati 1 blok!)
  CLIMBABLE: 5,         // Tangga tali (ladder), sulur (vine), perancah (scaffolding)
  HAZARD_DEADLY: 6,     // Lava, api, kaktus, semak berduri (hindari!)
  WATER_SWIMMABLE: 7,   // Air (bisa berenang, meredam jatuh)
  DOOR_GATE: 8          // Pintu / Gerbang (bisa dibuka/ditutup)
});

// Database Ringkas Klasifikasi Blok Minecraft
const BLOCK_LOOKUP = new Map([
  ['air', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['cave_air', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['void_air', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['short_grass', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['tall_grass', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['torch', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['wall_torch', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['redstone_wire', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['oak_sign', BLOCK_COLLISION_TYPES.AIR_PASSABLE],

  ['glow_lichen', BLOCK_COLLISION_TYPES.AIR_PASSABLE],
  ['sculk_vein', BLOCK_COLLISION_TYPES.AIR_PASSABLE],

  ['water', BLOCK_COLLISION_TYPES.WATER_SWIMMABLE],
  ['ladder', BLOCK_COLLISION_TYPES.CLIMBABLE],
  ['vine', BLOCK_COLLISION_TYPES.CLIMBABLE],
  ['scaffolding', BLOCK_COLLISION_TYPES.CLIMBABLE],

  ['lava', BLOCK_COLLISION_TYPES.HAZARD_DEADLY],
  ['fire', BLOCK_COLLISION_TYPES.HAZARD_DEADLY],
  ['cactus', BLOCK_COLLISION_TYPES.HAZARD_DEADLY],
  ['sweet_berry_bush', BLOCK_COLLISION_TYPES.HAZARD_DEADLY],
  // Ditandai LiveProtocolClient lewat reactive hazard learning (lihat liveProtocolClient.js) -
  // blok yang terbukti membunuh bot berulang kali secara empiris, apapun nama aslinya.
  ['__reactive_hazard__', BLOCK_COLLISION_TYPES.HAZARD_DEADLY],

  ['oak_fence', BLOCK_COLLISION_TYPES.FENCE_TALL],
  ['spruce_fence', BLOCK_COLLISION_TYPES.FENCE_TALL],
  ['cobblestone_wall', BLOCK_COLLISION_TYPES.FENCE_TALL],
  ['stone_brick_wall', BLOCK_COLLISION_TYPES.FENCE_TALL],

  ['stone_slab', BLOCK_COLLISION_TYPES.STEP_HALF],
  ['oak_slab', BLOCK_COLLISION_TYPES.STEP_HALF],
  ['cobblestone_stairs', BLOCK_COLLISION_TYPES.STAIRS],
  ['oak_stairs', BLOCK_COLLISION_TYPES.STAIRS]
]);

/**
 * Mengidentifikasi tipe tabrakan dari nama/ID blok
 */
function getBlockCollisionType(blockName) {
  if (!blockName) return BLOCK_COLLISION_TYPES.AIR_PASSABLE;
  const cleanName = String(blockName).toLowerCase().replace('minecraft:', '');

  if (BLOCK_LOOKUP.has(cleanName)) {
    return BLOCK_LOOKUP.get(cleanName);
  }

  // Pola berbasis akhiran nama
  if (cleanName.includes('fence') || cleanName.includes('wall')) return BLOCK_COLLISION_TYPES.FENCE_TALL;
  if (cleanName.includes('slab')) return BLOCK_COLLISION_TYPES.STEP_HALF;
  if (cleanName.includes('stairs')) return BLOCK_COLLISION_TYPES.STAIRS;
  if (cleanName.includes('door') || cleanName.includes('gate')) return BLOCK_COLLISION_TYPES.DOOR_GATE;

  // Standar default blok padat (batu, tanah, dll)
  return BLOCK_COLLISION_TYPES.SOLID_FULL;
}

/**
 * Kelas Engine Spasial Voxel Kaya
 */
class RichVoxelSpatialEngine {
  constructor(worldAccessor = null) {
    // worldAccessor: fungsi (x, y, z) => blockName/blockState
    this.world = worldAccessor || this._defaultWorldProvider.bind(this);
  }

  _defaultWorldProvider(x, y, z) {
    if (y < 63) return 'stone';
    if (y === 63) return 'grass_block';
    return 'air';
  }

  /**
   * Mengambil sampel matriks voxel 3D lokal di sekitar bot (radius 5x5 horizontal x 4 vertikal)
   */
  sampleLocalVoxelVolume(botX, botY, botZ, radius = 2) {
    const minX = Math.floor(botX - radius);
    const maxX = Math.floor(botX + radius);
    const minY = Math.floor(botY - 1);
    const maxY = Math.floor(botY + 2);
    const minZ = Math.floor(botZ - radius);
    const maxZ = Math.floor(botZ + radius);

    const volume = [];

    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const block = this.world(x, y, z);
          const type = getBlockCollisionType(block);
          volume.push({ x, y, z, block, type, isSolid: type === BLOCK_COLLISION_TYPES.SOLID_FULL || type === BLOCK_COLLISION_TYPES.FENCE_TALL });
        }
      }
    }

    return volume;
  }

  /**
   * Memeriksa apakah suatu titik koordinat tujuan memiliki Clearance Vertikal 2-Blok Penuh
   */
  evaluateNodePassability(targetX, targetY, targetZ) {
    const bx = Math.floor(targetX);
    const by = Math.floor(targetY);
    const bz = Math.floor(targetZ);

    const footBlock = this.world(bx, by, bz);
    const headBlock = this.world(bx, by + 1, bz);
    const groundBlock = this.world(bx, by - 1, bz);

    const footType = getBlockCollisionType(footBlock);
    const headType = getBlockCollisionType(headBlock);
    const groundType = getBlockCollisionType(groundBlock);

    // Bahaya mematikan (lava) -> Tolak mutlak!
    if (footType === BLOCK_COLLISION_TYPES.HAZARD_DEADLY || groundType === BLOCK_COLLISION_TYPES.HAZARD_DEADLY) {
      return { passable: false, reason: 'HAZARD_LAVA_FIRE' };
    }

    // Pagar 1.5m di bawah kaki -> Tidak bisa dilompati normal
    if (groundType === BLOCK_COLLISION_TYPES.FENCE_TALL) {
      return { passable: false, reason: 'TALL_FENCE_IMPASSABLE' };
    }

    // Cek clearance kepala & kaki
    const footPassable = footType === BLOCK_COLLISION_TYPES.AIR_PASSABLE || footType === BLOCK_COLLISION_TYPES.WATER_SWIMMABLE || footType === BLOCK_COLLISION_TYPES.CLIMBABLE;
    const headPassable = headType === BLOCK_COLLISION_TYPES.AIR_PASSABLE || headType === BLOCK_COLLISION_TYPES.WATER_SWIMMABLE || headType === BLOCK_COLLISION_TYPES.CLIMBABLE;

    if (!footPassable) return { passable: false, reason: `FOOT_BLOCKED_BY_${footBlock}` };
    if (!headPassable) return { passable: false, reason: `HEAD_BLOCKED_BY_${headBlock}` };

    // Cek pijakan tanah (kecuali sedang berenang di air atau memanjat tangga)
    const hasSolidGround = groundType !== BLOCK_COLLISION_TYPES.AIR_PASSABLE && groundType !== BLOCK_COLLISION_TYPES.HAZARD_DEADLY;
    const isFloating = footType === BLOCK_COLLISION_TYPES.WATER_SWIMMABLE || footType === BLOCK_COLLISION_TYPES.CLIMBABLE;

    if (!hasSolidGround && !isFloating) {
      return { passable: false, reason: 'NO_GROUND_CLIFF_FALL' };
    }

    return { passable: true, reason: 'CLEAR_2_BLOCK_VOLUME' };
  }

  /**
   * Swept-AABB Continuous Collision Raycast
   */
  predictSweptCollision(currX, currY, currZ, targetX, targetY, targetZ) {
    const dx = targetX - currX;
    const dz = targetZ - currZ;
    const distance = Math.hypot(dx, dz);

    if (distance < 0.001) {
      return { canMove: true, adjustedTarget: { x: targetX, y: targetY, z: targetZ }, willCollide: false };
    }

    const steps = Math.ceil(distance / 0.2);
    const half = PLAYER_HITBOX.HALF_WIDTH;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sampleX = currX + dx * t;
      const sampleZ = currZ + dz * t;
      const sampleY = currY;

      const corners = [
        { x: sampleX - half, z: sampleZ - half },
        { x: sampleX + half, z: sampleZ - half },
        { x: sampleX - half, z: sampleZ + half },
        { x: sampleX + half, z: sampleZ + half }
      ];

      for (const corner of corners) {
        const check = this.evaluateNodePassability(corner.x, sampleY, corner.z);
        if (!check.passable) {
          const slideX = Math.abs(dx) > Math.abs(dz) ? 0 : dx;
          const slideZ = Math.abs(dz) > Math.abs(dx) ? 0 : dz;

          return {
            canMove: false,
            willCollide: true,
            collisionPoint: { x: sampleX, y: sampleY, z: sampleZ },
            reason: check.reason,
            suggestedAction: 'WALL_SLIDE',
            adjustedTarget: {
              x: currX + slideX * 0.5,
              y: currY,
              z: currZ + slideZ * 0.5
            }
          };
        }
      }
    }

    return {
      canMove: true,
      willCollide: false,
      adjustedTarget: { x: targetX, y: targetY, z: targetZ }
    };
  }

  /**
   * Menghitung Arah Langkah Optimal Bebas Tabrakan (Optimal Clearance Heading)
   */
  findOptimalClearanceStep(currPos, targetGoal, stuckStreak = 0) {
    const directDx = targetGoal.x - currPos.x;
    const directDz = targetGoal.z - currPos.z;
    const len = Math.hypot(directDx, directDz) || 1;
    const stepSize = Math.min(0.8, len);

    const candidateTarget = {
      x: currPos.x + (directDx / len) * stepSize,
      y: currPos.y,
      z: currPos.z + (directDz / len) * stepSize
    };

    const directSweep = this.predictSweptCollision(currPos.x, currPos.y, currPos.z, candidateTarget.x, candidateTarget.y, candidateTarget.z);
    if (directSweep.canMove) {
      return { x: candidateTarget.x, y: candidateTarget.y, z: candidateTarget.z, type: 'DIRECT_WALK' };
    }

    const baseAngle = Math.atan2(directDz, directDx);
    const candidateAngles = [-0.785, 0.785, -1.57, 1.57, -2.35, 2.35];

    for (const offsetAngle of candidateAngles) {
      const angle = baseAngle + offsetAngle;
      const altX = currPos.x + Math.cos(angle) * stepSize;
      const altZ = currPos.z + Math.sin(angle) * stepSize;

      for (const yOffset of [0, 0.5, 1.0]) {
        const altSweep = this.predictSweptCollision(currPos.x, currPos.y, currPos.z, altX, currPos.y + yOffset, altZ);
        if (altSweep.canMove) {
          return {
            x: altX,
            y: currPos.y + yOffset,
            z: altZ,
            type: yOffset > 0 ? 'STEP_UP_JUMP' : 'TANGENT_CORNER_SLIDE'
          };
        }
      }
    }

    // Batasi eskalasi: RECOVERY_MICRO_JUMP_REWIND menaikkan Y tanpa verifikasi ulang collision.
    // Kalau caller sudah beberapa kali berturut-turut menerima hasil "macet" dari titik yang sama
    // (stuckStreak) dan tetap macet, hentikan pendakian - diam di tempat alih-alih naik tanpa batas
    // (bug nyata: bot bisa "terbang" sampai Y>1000 kalau tidak dibatasi). Sebelum benar-benar
    // menyerah diam, coba dulu cari jalan keluar di radius yang lebih lebar (findWideEscapeRoute) -
    // kandidat di atas cuma menjangkau ~0.8m, cukup untuk menghindari tonjolan kecil tapi buntu
    // total kalau rintangannya besar (tebing/jurang/dinding panjang).
    const MAX_STUCK_CLIMB_ATTEMPTS = 2;
    if (stuckStreak >= MAX_STUCK_CLIMB_ATTEMPTS) {
      const escape = this.findWideEscapeRoute(currPos, targetGoal);
      if (escape) {
        const edx = escape.x - currPos.x;
        const edz = escape.z - currPos.z;
        const edist = Math.hypot(edx, edz) || 1;
        const moveDist = Math.min(stepSize, edist);
        const yDelta = Math.max(-1, Math.min(1, escape.y - currPos.y));
        return {
          x: currPos.x + (edx / edist) * moveDist,
          y: currPos.y + yDelta,
          z: currPos.z + (edz / edist) * moveDist,
          type: 'WIDE_ESCAPE_SEARCH'
        };
      }
      return { x: currPos.x, y: currPos.y, z: currPos.z, type: 'STUCK_HOLD' };
    }

    return {
      x: currPos.x - (directDx / len) * 0.4,
      y: currPos.y + 1.0,
      z: currPos.z - (directDz / len) * 0.4,
      type: 'RECOVERY_MICRO_JUMP_REWIND'
    };
  }

  /**
   * Pencarian titik pijakan yang bisa dilewati dalam radius lebih lebar (2-8 blok) di sekitar
   * posisi sekarang - dipakai saat findOptimalClearanceStep buntu total di radius lokalnya
   * (~0.8m). Menyapu beberapa cincin (ring) pada berbagai sudut, mengutamakan titik yang paling
   * searah goal dan paling dekat. Mengembalikan null kalau benar-benar tidak ada jalan keluar di
   * semua ring yang dicoba (terkurung total).
   */
  findWideEscapeRoute(currPos, targetGoal, options = {}) {
    // Batas bawah absolut (dunia, bukan relatif currPos) yang boleh dituju - tanpa ini, panggilan
    // BERULANG (tiap kali macet lagi) bisa terus menerima pijakan yang makin turun sedikit demi
    // sedikit, karena tiap panggilan cuma tahu currPos SEKARANG (sudah lebih rendah dari panggilan
    // sebelumnya) tanpa ingatan berapa total sudah turun - efeknya bot "menggali diri" turun ke
    // gua/jurang tak dikenal berblok-blok, ketemu di live test (turun dari Y=58 ke Y=25 lalu jatuh
    // katastropik, semuanya lewat serangkaian escape yang masing-masing "valid" secara lokal).
    // Caller (mis. walk_to_base_physics.js) yang menetapkan minY berdasarkan riwayat progres nyata.
    const minY = options.minY ?? -Infinity;
    // Kandidat yang sudah TERBUKTI gagal (mis. reward map persisten - lihat rewardMap.js) harus
    // dilewati di sini, bukan cuma ditolak setelah dikembalikan ke caller - tanpa ini, ring yang
    // sama akan terus mengembalikan kandidat "terbaik" itu-itu saja walau caller sudah menolaknya
    // berkali-kali, sehingga bot terjebak STUCK_PROBE selamanya walau ada kandidat LAIN yang valid
    // di ring yang sama (bug nyata: bot terjebak di gua, satu-satunya kandidat "terbaik" berulang
    // kali ditolak tanpa pernah mencoba alternatif searah lain).
    const isExcluded = options.isExcluded ?? (() => false);
    // Bisa diperluas caller (mis. saat macet berulang di lokasi sama & kandidat terdekat semua
    // ter-blacklist) - daripada diam menunggu cooldown habis, cari lebih jauh dulu.
    const RING_RADII = options.ringRadii ?? [2, 4, 6, 8];
    const DIRECTIONS_PER_RING = 12; // tiap 30 derajat
    // relatif currPos.y, diurutkan dari perubahan TERKECIL dulu - mencegah bias naik bertahap
    // (bug nyata: kalau dicek dari atas dulu, bot bisa berulang kali "naik sedikit" tiap kali
    // escape search dipanggil meski ada pijakan di ketinggian yang sama).
    const VERTICAL_SEARCH_RANGE = [0, 1, -1, 2, -2, 3, -3, 4, -4];

    const baseAngle = Math.atan2(targetGoal.z - currPos.z, targetGoal.x - currPos.x);

    for (const radius of RING_RADII) {
      let best = null;
      let bestScore = -Infinity;

      for (let i = 0; i < DIRECTIONS_PER_RING; i++) {
        const angle = (i * 2 * Math.PI) / DIRECTIONS_PER_RING;
        const x = currPos.x + Math.cos(angle) * radius;
        const z = currPos.z + Math.sin(angle) * radius;

        for (const dy of VERTICAL_SEARCH_RANGE) {
          const y = currPos.y + dy;
          if (y < minY) continue;
          const check = this.evaluateNodePassability(x, y, z);
          if (check.passable) {
            if (!isExcluded(x, y, z)) {
              const angleDiff = Math.abs(((angle - baseAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
              const score = -angleDiff; // makin searah goal makin diprioritaskan
              if (score > bestScore) {
                bestScore = score;
                best = { x, y, z };
              }
            }
            break; // sudah dapat titik passable pertama di kolom ini (dikecualikan atau tidak, tetap satu kolom = satu kandidat)
          }
        }
      }

      if (best) return best;
    }

    return null;
  }

  /**
   * Vektor navigasi jarak jauh beresolusi kasar - berbeda dari findOptimalClearanceStep yang
   * beresolusi penuh tapi hanya untuk satu langkah lokal (~0.8m). Dipakai saat goal berada jauh
   * di luar radius scan lokal (ratusan/ribuan blok), memanfaatkan world model chunk cache yang
   * sudah ada tanpa perlu pathfinding penuh: sampling jarang di sepanjang garis lurus ke goal,
   * membelokkan arah kalau ada bahaya mematikan (lava/api) terdeteksi, dan melaporkan `confidence`
   * (rasio sampel yang datanya sudah diketahui/di-cache vs total) agar caller tahu seberapa bisa
   * diandalkan arah tsb untuk area yang belum pernah dimuat.
   *
   * @param {{x:number,y:number,z:number}} fromPos
   * @param {{x:number,y:number,z:number}} toGoal
   * @param {{ sampleStep?: number, maxLookahead?: number }} [options]
   */
  computeNavigationVector(fromPos, toGoal, options = {}) {
    const sampleStep = options.sampleStep ?? 4;
    const maxLookahead = options.maxLookahead ?? 64;

    const dx = toGoal.x - fromPos.x;
    const dz = toGoal.z - fromPos.z;
    const distance = Math.hypot(dx, dz);

    if (distance < 0.01) {
      return { x: 0, z: 0, distance: 0, blocked: false, hazardAt: null, sampledBlocks: 0, knownBlocks: 0, confidence: 1 };
    }

    const dirX = dx / distance;
    const dirZ = dz / distance;
    const lookahead = Math.min(distance, maxLookahead);

    let sampledBlocks = 0;
    let knownBlocks = 0;
    let hazardAt = null;

    for (let d = sampleStep; d <= lookahead; d += sampleStep) {
      const sx = fromPos.x + dirX * d;
      const sz = fromPos.z + dirZ * d;
      const footBlock = this.world(Math.floor(sx), Math.floor(fromPos.y), Math.floor(sz));
      const groundBlock = this.world(Math.floor(sx), Math.floor(fromPos.y) - 1, Math.floor(sz));

      sampledBlocks++;
      if (footBlock !== null || groundBlock !== null) knownBlocks++;

      const footType = getBlockCollisionType(footBlock);
      const groundType = getBlockCollisionType(groundBlock);
      if (footType === BLOCK_COLLISION_TYPES.HAZARD_DEADLY || groundType === BLOCK_COLLISION_TYPES.HAZARD_DEADLY) {
        hazardAt = { x: sx, z: sz, distance: d };
        break;
      }
    }

    let outX = dirX;
    let outZ = dirZ;

    if (hazardAt) {
      // Geser arah menjauh dari garis lurus (campur dengan vektor tegak lurus) alih-alih berhenti total -
      // resolusi kasar, cukup untuk "jangan jalan ke arah situ", bukan rute presisi mengitari bahaya.
      const perpX = -dirZ;
      const perpZ = dirX;
      outX = dirX * 0.5 + perpX * 0.5;
      outZ = dirZ * 0.5 + perpZ * 0.5;
      const mag = Math.hypot(outX, outZ) || 1;
      outX /= mag;
      outZ /= mag;
    }

    return {
      x: outX,
      z: outZ,
      distance,
      blocked: Boolean(hazardAt),
      hazardAt,
      sampledBlocks,
      knownBlocks,
      confidence: sampledBlocks > 0 ? knownBlocks / sampledBlocks : 0
    };
  }
}

module.exports = {
  RichVoxelSpatialEngine,
  PLAYER_HITBOX,
  BLOCK_COLLISION_TYPES,
  getBlockCollisionType
};
