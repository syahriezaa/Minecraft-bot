/**
 * @file pathfinder.test.js
 * @description Uji unit A* pathfinding di atas world model RichVoxelSpatialEngine. Berbeda dari
 * findOptimalClearanceStep (greedy, 1 langkah, gampang macet di rintangan besar) - ini benar-benar
 * mencari rute lengkap sebelum bergerak, sehingga bisa memutar mengelilingi dinding/jurang besar.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RichVoxelSpatialEngine } = require('../../src/ai/richVoxelSpatialEngine');
const { findPath, findGroundY } = require('../../src/ai/pathfinder');

function flatWorld(holes = []) {
  return (x, y, z) => {
    for (const h of holes) if (h.x === x && h.z === z && (h.yMin === undefined || (y >= h.yMin && y <= h.yMax))) return h.block;
    return y < 63 ? 'stone' : (y === 63 ? 'grass_block' : 'air');
  };
}

describe('findPath - jalur terbuka', () => {
  it('harus menemukan jalur langsung di dataran terbuka tanpa rintangan', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });

    assert.ok(Array.isArray(path), 'harus mengembalikan array jalur');
    assert.ok(path.length >= 2);
    assert.equal(path[0].x, 0);
    assert.equal(path[0].z, 0);
    const last = path[path.length - 1];
    assert.equal(last.x, 8);
    assert.equal(last.z, 0);
  });

  it('harus mengembalikan jalur kosong/1 titik kalau start sudah di goal', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());
    const path = findPath(engine, { x: 5, y: 64, z: 5 }, { x: 5, y: 64, z: 5 });

    assert.ok(Array.isArray(path));
    assert.ok(path.length <= 1);
  });
});

describe('findPath - memutar rintangan', () => {
  it('harus memutar dinding panjang yang menghalangi jalur lurus, bukan menyerah', () => {
    // Dinding solid penuh sepanjang x=4 dari z=-10 s/d z=10 (kecuali tidak ada celah) -
    // harus muter lewat ujung dinding (z jauh di luar rentang tsb).
    const wallHoles = [];
    for (let z = -10; z <= 10; z++) {
      wallHoles.push({ x: 4, z, block: 'stone', yMin: 63, yMax: 65 }); // dinding tinggi 3 blok
    }
    const engine = new RichVoxelSpatialEngine(flatWorld(wallHoles));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { maxNodes: 6000 });

    assert.ok(path, 'harus menemukan jalur memutar, bukan null');
    const last = path[path.length - 1];
    assert.equal(last.x, 8);
    assert.equal(last.z, 0);
    // Jalur harus benar-benar memutar (ada titik dengan |z| > 10, keluar dari rentang dinding)
    assert.ok(path.some((p) => Math.abs(p.z) > 10), 'jalur harus melewati ujung dinding (|z|>10)');
  });

  it('harus mengembalikan null kalau benar-benar tidak ada jalur (terkurung total) dalam anggaran node', () => {
    // Kotak solid penuh mengelilingi start di semua sisi horizontal (termasuk atas tembok tinggi).
    const box = [];
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (x === -2 || x === 2 || z === -2 || z === 2) {
          for (let y = 63; y <= 70; y++) box.push({ x, z, block: 'stone', yMin: y, yMax: y });
        }
      }
    }
    const engine = new RichVoxelSpatialEngine(flatWorld(box));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 20 }, { maxNodes: 2000 });

    assert.equal(path, null);
  });
});

describe('findPath - naik/turun ketinggian', () => {
  it('harus bisa naik 1 blok (step-up) ketika ada tangga level di jalur', () => {
    // Plateau naik 1 level (y=64 jadi tanah, bukan lagi y=63) mulai x=3 sampai x=6, tempat goal berada.
    const step = [];
    for (let x = 3; x <= 6; x++) step.push({ x, z: 0, block: 'stone', yMin: 63, yMax: 64 });
    const engine = new RichVoxelSpatialEngine(flatWorld(step));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 6, y: 65, z: 0 });

    assert.ok(path, 'harus menemukan jalur naik 1 blok');
    const last = path[path.length - 1];
    assert.equal(last.y, 65);
  });
});

describe('findPath - jalur parsial (flood-fill) ketika anggaran node habis sebelum sampai goal', () => {
  it('harus mengembalikan jalur PARSIAL menuju titik tereksplorasi terdekat ke goal, bukan null, saat anggaran node habis', () => {
    // Goal sangat jauh (1000 blok) - dengan anggaran node kecil pasti tidak akan pernah sampai.
    // Sebelumnya findPath cuma buang semua hasil eksplorasi dan balikin null total; sekarang harus
    // tetap memberi progres nyata sejauh yang berhasil "disapu" (flood-fill) dalam anggaran itu.
    const engine = new RichVoxelSpatialEngine(flatWorld());

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 1000, y: 64, z: 0 }, { maxNodes: 50 });

    assert.ok(path, 'harus tetap mengembalikan jalur parsial, bukan null');
    const last = path[path.length - 1];
    const distFromStart = Math.hypot(last.x - 0, last.z - 0);
    assert.ok(distFromStart > 5, `jalur parsial harus benar-benar maju dari start, dapat jarak ${distFromStart}`);
    assert.ok(last.x < 1000, 'jalur parsial jelas belum sampai goal (anggaran terlalu kecil untuk itu)');
  });

  it('harus tetap mengembalikan null kalau start benar-benar terkurung total (bukan cuma kehabisan anggaran)', () => {
    const box = [];
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (x === -2 || x === 2 || z === -2 || z === 2) {
          for (let y = 63; y <= 70; y++) box.push({ x, z, block: 'stone', yMin: y, yMax: y });
        }
      }
    }
    const engine = new RichVoxelSpatialEngine(flatWorld(box));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 20 }, { maxNodes: 2000 });

    assert.equal(path, null, 'terkurung total (nol tetangga valid) tetap harus null, bukan jalur parsial semu');
  });

  it('jalur parsial harus tetap jalur A* yang valid (waypoint berurutan tersambung), bukan cuma titik acak terdekat', () => {
    const engine = new RichVoxelSpatialEngine(flatWorld());

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 1000, y: 64, z: 0 }, { maxNodes: 50 });

    assert.ok(path.length >= 2);
    for (let i = 1; i < path.length; i++) {
      const d = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z, path[i].y - path[i - 1].y);
      assert.ok(d <= Math.sqrt(2) + 0.01, `tiap langkah waypoint parsial harus tetangga langsung, dapat jarak ${d}`);
    }
  });
});

describe('findPath - biaya lompatan harus lebih mahal dari jalan turun/datar', () => {
  it('harus memilih ceruk di bawah (jalan turun) daripada ledge di atas (lompat) kalau keduanya bisa dilewati di kolom yang sama', () => {
    // Kolom x=1,z=0 punya DUA pijakan valid: ceruk di bawah (y=62, tinggal turun) dan ledge di
    // atas (y=65, harus lompat), dipisahkan tembok solid di y=64. Sisi z lain diblokir total
    // supaya bot wajib lewat kolom ini - satu-satunya pertanyaan adalah lewat atas atau bawah.
    // Bug lama: getNeighbors cuma mengambil kandidat vertikal PERTAMA yang cocok (urutan dicek
    // [0,1,-1,-2,-3]) lalu berhenti - jadi begitu lompatan (+1) ketemu duluan, ceruk di bawah (-2)
    // tidak akan PERNAH dipertimbangkan sama sekali, apapun biayanya.
    const holes = [
      { x: 1, z: 0, block: 'air', yMin: 62, yMax: 63 },
      { x: 1, z: 0, block: 'stone', yMin: 64, yMax: 64 },
      { x: 2, z: 0, block: 'air', yMin: 63, yMax: 63 },
      { x: 3, z: 0, block: 'air', yMin: 63, yMax: 63 },
    ];
    for (const z of [-3, -2, -1, 1, 2, 3]) {
      for (let y = 61; y <= 66; y++) holes.push({ x: 1, z, block: 'stone', yMin: y, yMax: y });
    }
    const engine = new RichVoxelSpatialEngine(flatWorld(holes));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 3, y: 63, z: 0 }, { maxNodes: 2000 });

    assert.ok(path, 'harus menemukan jalur');
    const usedLowerPocket = path.some((p) => p.x === 1 && p.z === 0 && p.y === 62);
    const usedUpperLedge = path.some((p) => p.x === 1 && p.z === 0 && p.y === 65);
    assert.ok(usedLowerPocket, 'jalur harus lewat ceruk bawah (y=62) yang tidak perlu lompat');
    assert.ok(!usedUpperLedge, 'jalur TIDAK boleh lewat ledge atas (y=65) kalau ceruk bawah tersedia');
  });

  it('tetap harus lompat kalau memang satu-satunya cara (tidak ada jalur turun/datar sama sekali)', () => {
    // Tonjolan 1-blok, tanpa ceruk alternatif di bawah, dan sisi z lain diblokir - lompat wajib.
    const holes = [{ x: 1, z: 0, block: 'stone', yMin: 64, yMax: 64 }];
    for (let z = -3; z <= 3; z++) {
      if (z === 0) continue;
      for (let y = 63; y <= 66; y++) holes.push({ x: 1, z, block: 'stone', yMin: y, yMax: y });
    }
    const engine = new RichVoxelSpatialEngine(flatWorld(holes));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { maxNodes: 2000 });

    assert.ok(path, 'harus tetap menemukan jalur lewat lompatan kalau itu satu-satunya opsi');
    const jumpedAtDirectColumn = path.some((p) => p.x === 1 && p.z === 0 && p.y === 65);
    assert.ok(jumpedAtDirectColumn, 'lompatan wajib dipakai kalau tidak ada alternatif lain');
  });
});

describe('findPath - tebing curam lebih dari 3 blok', () => {
  it('harus tetap menemukan jalur turun tebing curam >3 blok, bukan menyerah "terkurung total" - ditemukan dari bug live nyata: bot berdiri di tepi tebing gua, satu-satunya pijakan valid ada 6 blok di bawah (masih dalam batas MAX_DESCENT_BUDGET=8 di runWalkToBaseBot.js), tapi getNeighbors cuma mencari turun sampai 3 blok (VERTICAL_OFFSETS lama: [0,1,-1,-2,-3]) - jadi seluruh kolom itu dianggap tidak ada tetangga valid sama sekali, padahal jalur turunnya sah dan dalam anggaran turun yang diizinkan.', () => {
    // Berdiri di (0,64,0) di tepi tebing solid. Kolom x=1,z=0 kosong total (udara) dari y=58 sampai
    // y=63, dengan pijakan pertama di y=57 - turun 7 blok dari posisi sekarang (64), masih di dalam
    // MAX_DESCENT_BUDGET=8 tapi di luar jangkauan VERTICAL_OFFSETS lama (maks -3 = y=61).
    const holes = [];
    for (let y = 58; y <= 63; y++) holes.push({ x: 1, z: 0, block: 'air', yMin: y, yMax: y });
    holes.push({ x: 1, z: 0, block: 'grass_block', yMin: 57, yMax: 57 });
    const engine = new RichVoxelSpatialEngine(flatWorld(holes));

    const path = findPath(engine, { x: 0, y: 64, z: 0 }, { x: 1, y: 58, z: 0 }, { maxNodes: 2000 });

    assert.ok(path, 'harus menemukan jalur turun ke tebing curam >3 blok, bukan mengembalikan null (terkurung total palsu)');
    const landedOnLedge = path.some((p) => p.x === 1 && p.z === 0 && p.y === 58);
    assert.ok(landedOnLedge, 'jalur harus benar-benar mendarat di pijakan y=58 di dasar tebing');
  });
});

describe('findGroundY', () => {
  it('harus menemukan Y yang bisa dipijak walau tebakan awal (hintY) meleset dari permukaan sebenarnya', () => {
    // Permukaan sebenarnya ada di y=64 (ground y=63), tapi hintY sengaja jauh (y=70, melayang di udara).
    const engine = new RichVoxelSpatialEngine(flatWorld());

    const groundY = findGroundY(engine, 5, 5, 70);

    assert.equal(groundY, 64);
  });

  it('harus mengembalikan null kalau tidak ada permukaan yang bisa dipijak dalam batas pencarian', () => {
    const engine = new RichVoxelSpatialEngine(() => 'stone'); // padat total di semua ketinggian
    const groundY = findGroundY(engine, 5, 5, 64, 8);

    assert.equal(groundY, null);
  });
});
