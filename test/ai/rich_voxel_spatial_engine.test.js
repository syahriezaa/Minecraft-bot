/**
 * @file rich_voxel_spatial_engine.test.js
 * @description Uji unit RichVoxelSpatialEngine, terutama computeNavigationVector - lapisan navigasi
 * jarak jauh beresolusi kasar di atas world model chunk cache nyata (bisa berisi ribuan blok),
 * berbeda dari findOptimalClearanceStep yang beresolusi penuh tapi hanya untuk langkah lokal.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RichVoxelSpatialEngine } = require('../../src/ai/richVoxelSpatialEngine');

describe('RichVoxelSpatialEngine.computeNavigationVector', () => {
  it('harus menunjuk lurus ke arah goal ketika seluruh jalur diketahui & bebas bahaya', () => {
    const world = (x, y, z) => (y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air'));
    const engine = new RichVoxelSpatialEngine(world);

    const from = { x: 0, y: 64, z: 0 };
    const goal = { x: 100, y: 64, z: 0 };

    const result = engine.computeNavigationVector(from, goal);

    assert.ok(Math.abs(result.x - 1) < 0.001, `x harus ~1 (arah lurus ke +X), dapat ${result.x}`);
    assert.ok(Math.abs(result.z) < 0.001, `z harus ~0, dapat ${result.z}`);
    assert.equal(result.blocked, false);
    assert.equal(result.confidence, 1, 'seluruh sampel di jalur diketahui -> confidence penuh');
    assert.equal(result.distance, 100);
  });

  it('harus membelokkan vektor menjauhi bahaya (lava) yang terdeteksi di sepanjang jalur', () => {
    const world = (x, y, z) => {
      if (x === 20 && y === 63) return 'lava'; // rintangan mematikan tepat di jalur lurus
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);

    const from = { x: 0, y: 64, z: 0 };
    const goal = { x: 100, y: 64, z: 0 };

    const result = engine.computeNavigationVector(from, goal, { sampleStep: 4 });

    assert.equal(result.blocked, true);
    assert.ok(result.hazardAt, 'harus melaporkan titik bahaya yang terdeteksi');
    assert.notEqual(result.z, 0, 'vektor harus punya komponen Z (membelok), tidak lurus lagi ke +X murni');
  });

  it('confidence harus turun ketika sebagian jalur berada di luar chunk yang sudah dimuat (worldAccessor null)', () => {
    const KNOWN_LIMIT = 20; // hanya x < 20 yang "dimuat"
    const world = (x, y, z) => {
      if (x >= KNOWN_LIMIT) return null; // chunk belum dimuat
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);

    const from = { x: 0, y: 64, z: 0 };
    const goal = { x: 100, y: 64, z: 0 };

    const result = engine.computeNavigationVector(from, goal, { sampleStep: 4, maxLookahead: 100 });

    assert.ok(result.confidence > 0 && result.confidence < 1, `confidence harus parsial (0<c<1), dapat ${result.confidence}`);
    assert.ok(result.knownBlocks < result.sampledBlocks);
  });

  it('harus mengembalikan vektor nol ketika posisi sekarang sudah persis di goal', () => {
    const world = () => 'air';
    const engine = new RichVoxelSpatialEngine(world);

    const pos = { x: 5, y: 64, z: 5 };
    const result = engine.computeNavigationVector(pos, { ...pos });

    assert.equal(result.x, 0);
    assert.equal(result.z, 0);
    assert.equal(result.distance, 0);
    assert.equal(result.blocked, false);
  });

  it('lookahead harus dibatasi maxLookahead walau goal jauh lebih jauh (navigasi jarak jauh tidak scan seluruh jarak)', () => {
    let maxSampledX = 0;
    const world = (x, y, z) => {
      maxSampledX = Math.max(maxSampledX, x);
      return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
    };
    const engine = new RichVoxelSpatialEngine(world);

    const from = { x: 0, y: 64, z: 0 };
    const goal = { x: 5000, y: 64, z: 0 }; // jarak sangat jauh, ribuan blok

    engine.computeNavigationVector(from, goal, { sampleStep: 8, maxLookahead: 64 });

    assert.ok(maxSampledX <= 64 + 1, `sampling tidak boleh jauh melewati maxLookahead, tersampling sampai x=${maxSampledX}`);
  });
});

describe('RichVoxelSpatialEngine - klasifikasi blok dekoratif non-solid', () => {
  it('glow_lichen di posisi kaki (foot block) harus dianggap bisa dilewati, bukan solid - reproduksi bug live: FOOT_BLOCKED_BY_glow_lichen di posisi bot sendiri berdiri', () => {
    const world = (x, y, z) => {
      if (y === 64) return 'glow_lichen'; // persis di posisi target (foot), seperti kasus nyata di server live
      return y < 64 ? 'stone' : 'air';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.evaluateNodePassability(0, 64, 0);

    assert.equal(result.passable, true, `seharusnya passable, dapat: ${result.reason}`);
  });

  it('sculk_vein di posisi kaki harus dianggap bisa dilewati, bukan solid', () => {
    const world = (x, y, z) => {
      if (y === 64) return 'sculk_vein';
      return y < 64 ? 'stone' : 'air';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.evaluateNodePassability(0, 64, 0);

    assert.equal(result.passable, true, `seharusnya passable, dapat: ${result.reason}`);
  });
});

describe('RichVoxelSpatialEngine.findOptimalClearanceStep - batas eskalasi saat macet', () => {
  it('harus terus mencoba RECOVERY_MICRO_JUMP_REWIND selama belum melewati batas macet', () => {
    const world = () => 'stone'; // padat total di semua arah -> selalu macet
    const engine = new RichVoxelSpatialEngine(world);
    const currPos = { x: 0, y: 64, z: 0 };
    const targetGoal = { x: 10, y: 64, z: 0 };

    const first = engine.findOptimalClearanceStep(currPos, targetGoal, 0);
    assert.equal(first.type, 'RECOVERY_MICRO_JUMP_REWIND');

    const second = engine.findOptimalClearanceStep(currPos, targetGoal, 1);
    assert.equal(second.type, 'RECOVERY_MICRO_JUMP_REWIND');
  });

  it('harus berhenti eskalasi ketinggian (STUCK_HOLD) setelah stuckStreak melewati batas, bukan naik Y tanpa akhir', () => {
    const world = () => 'stone';
    const engine = new RichVoxelSpatialEngine(world);
    const currPos = { x: 0, y: 64, z: 0 };
    const targetGoal = { x: 10, y: 64, z: 0 };

    const result = engine.findOptimalClearanceStep(currPos, targetGoal, 5);

    assert.equal(result.type, 'STUCK_HOLD');
    assert.equal(result.y, currPos.y, 'tidak boleh menaikkan Y lagi setelah macet melewati batas');
    assert.equal(result.x, currPos.x);
    assert.equal(result.z, currPos.z);
  });

  it('setelah macet melewati batas, harus mencoba pencarian lateral lebih lebar (WIDE_ESCAPE_SEARCH) sebelum menyerah diam - bukan langsung STUCK_HOLD kalau sebenarnya ada jalan keluar tak jauh dari situ', () => {
    // Terkurung padat di sekitar (radius <3), tapi ada area lolos mulai x>=3.
    const world = (x, y, z) => {
      if (x >= 3 && y === 63) return 'grass_block';
      if (x >= 3 && y > 63) return 'air';
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);
    const currPos = { x: 0, y: 64, z: 0 };
    const targetGoal = { x: 10, y: 64, z: 0 };

    const result = engine.findOptimalClearanceStep(currPos, targetGoal, 5);

    assert.equal(result.type, 'WIDE_ESCAPE_SEARCH');
    assert.ok(result.x > currPos.x, 'harus bergerak ke arah area lolos (x>=3), bukan diam di tempat');
  });

  it('kalau benar-benar terkurung total tanpa jalan keluar di radius manapun, tetap jatuh ke STUCK_HOLD', () => {
    const world = () => 'stone'; // padat total, tidak ada jalan keluar di manapun
    const engine = new RichVoxelSpatialEngine(world);
    const currPos = { x: 0, y: 64, z: 0 };
    const targetGoal = { x: 10, y: 64, z: 0 };

    const result = engine.findOptimalClearanceStep(currPos, targetGoal, 5);

    assert.equal(result.type, 'STUCK_HOLD');
  });

  it('findWideEscapeRoute harus mengembalikan null kalau tidak ada titik passable di semua ring yang dicoba', () => {
    const world = () => 'stone';
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });

    assert.equal(result, null);
  });

  it('findWideEscapeRoute harus memilih titik dengan perubahan Y paling sedikit, bukan yang paling tinggi - mencegah bot naik bertahap tanpa perlu', () => {
    // Passable di 2 ketinggian berbeda pada arah & radius yang sama: y+0 (level sama, clearance 64-65)
    // dan y+4 (lebih tinggi, clearance 68-69). Harus pilih level sama (tidak perlu naik sama sekali).
    const world = (x, y, z) => {
      if (x >= 3) {
        if (y === 63 || y === 67) return 'grass_block'; // pijakan di dua level
        if (y === 64 || y === 65 || y === 68 || y === 69) return 'air'; // clearance 2 blok tiap level
        return 'stone';
      }
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });

    assert.ok(result, 'harus menemukan titik escape');
    assert.equal(result.y, 64, `harus pilih Y yang sama dengan posisi sekarang (64) kalau tersedia, bukan naik ke ${result.y}`);
  });

  it('findWideEscapeRoute harus menemukan titik passable terdekat searah goal', () => {
    const world = (x, y, z) => {
      if (x >= 3 && y === 63) return 'grass_block';
      if (x >= 3 && y > 63) return 'air';
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });

    assert.ok(result, 'harus menemukan titik escape');
    assert.ok(result.x >= 3, `titik escape harus di area yang bisa dilewati (x>=3), dapat x=${result.x}`);
  });

  it('findWideEscapeRoute harus menolak turun melebihi options.minY, walau ada pijakan valid di bawahnya - cegah "menggali diri" turun ke jurang/gua tanpa sadar lewat panggilan berulang', () => {
    // Satu-satunya pijakan yang "passable" di seluruh area jangkauan (radius 2-8, semua arah) ada
    // jauh di bawah (standing y=56) - mensimulasikan gua/jurang dalam yang baru terungkap sedikit
    // demi sedikit tiap escape dipanggil ulang. Tanpa batas minY, fungsi ini akan menerimanya begitu
    // saja (bug nyata: bot turun >30 blok ke gua tak dikenal lewat serangkaian panggilan yang
    // masing-masing "valid" secara lokal).
    const world = (x, y, z) => {
      if (x >= 3) {
        if (y === 55) return 'grass_block'; // ground - berdiri di y=56, jauh di bawah minY=60
        if (y === 56 || y === 57) return 'air';
        return 'stone';
      }
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, { minY: 60 });

    assert.equal(result, null, 'harus menolak satu-satunya kandidat karena di bawah minY, bukan diam-diam turun ke sana');
  });

  it('findWideEscapeRoute tetap boleh turun kalau masih di atas atau sama dengan options.minY', () => {
    const world = (x, y, z) => {
      if (x >= 3 && y === 59) return 'grass_block'; // ground - berdiri di y=60 (satu di atasnya)
      if (x >= 3 && (y === 60 || y === 61)) return 'air';
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const result = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, { minY: 60 });

    assert.ok(result, 'harus tetap menemukan titik escape di y=60 (persis di batas minY)');
    assert.equal(result.y, 60);
  });

  it('findWideEscapeRoute harus mendukung options.ringRadii untuk mencari lebih jauh dari default (2,4,6,8) - untuk kasus macet berulang di area sempit', () => {
    // Satu-satunya pijakan valid ada di radius 12 (di luar jangkauan default) - default harus null,
    // tapi dengan ringRadii diperluas harus ketemu. Dipakai saat macet berulang di lokasi sama
    // (blacklist escape terdekat penuh) - daripada diam menunggu cooldown, cari lebih jauh dulu.
    const world = (x, y, z) => {
      const d = Math.hypot(x, z);
      if (d >= 11.5 && d <= 12.5 && y === 63) return 'grass_block';
      if (d >= 11.5 && d <= 12.5 && y > 63) return 'air';
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);

    const defaultResult = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 });
    assert.equal(defaultResult, null, 'default (radius maks 8) tidak boleh menjangkau titik di radius 12');

    const widerResult = engine.findWideEscapeRoute({ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }, { ringRadii: [2, 4, 6, 8, 12, 16] });
    assert.ok(widerResult, 'dengan ringRadii diperluas harus menemukan titik di radius 12');
  });

  it('findWideEscapeRoute harus melewati kandidat yang options.isExcluded tolak, bukan berhenti di kandidat "terbaik" itu-itu saja - ditemukan dari bug live nyata: bot terjebak di gua, satu-satunya kandidat "terbaik" (paling searah goal) berulang kali ditolak reward map (sudah terbukti gagal), tapi findWideEscapeRoute tetap terus mengusulkan titik yang SAMA setiap kali karena tidak tahu kandidat itu sudah pernah gagal - efeknya bot berputar di STUCK_PROBE tanpa henti walau ada jalan keluar LAIN yang valid di ring yang sama', () => {
    // Dua titik passable di radius yang sama (4): x=4 (paling searah goal di x=10,z=0 - "terbaik") dan
    // z=4 (menyamping, skor lebih rendah tapi tetap valid). Kalau x=4 di-exclude, harus jatuh ke z=4,
    // bukan mengembalikan null atau tetap x=4.
    const world = (x, y, z) => {
      if (y === 63 && ((x === 4 && z === 0) || (x === 0 && z === 4))) return 'grass_block';
      if (y > 63 && y <= 65 && ((x === 4 && z === 0) || (x === 0 && z === 4))) return 'air';
      return 'stone';
    };
    const engine = new RichVoxelSpatialEngine(world);
    const currPos = { x: 0, y: 64, z: 0 };
    const targetGoal = { x: 10, y: 64, z: 0 };

    const withoutExclusion = engine.findWideEscapeRoute(currPos, targetGoal);
    assert.ok(withoutExclusion, 'harus menemukan kandidat "terbaik" (x=4) tanpa exclusion');
    assert.equal(withoutExclusion.x, 4);

    const withExclusion = engine.findWideEscapeRoute(currPos, targetGoal, {
      isExcluded: (x, y, z) => x === 4 && z === 0
    });
    assert.ok(withExclusion, 'harus tetap menemukan kandidat LAIN (z=4), bukan null');
    assert.equal(withExclusion.z, 4, `harus jatuh ke kandidat alternatif (z=4), dapat (${withExclusion.x},${withExclusion.y},${withExclusion.z})`);
  });
});
