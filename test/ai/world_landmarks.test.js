/**
 * @file world_landmarks.test.js
 * @description Unit test memori landmark dunia (worldLandmarks.js) - permintaan nyata pemilik:
 * "mari kita buat bot explorer yang menandai akan mengeksplor map area area dan tempat tempat
 * penting dengan ruang 3d koordinat xyz...struktur yang saya bangun jadi setiap peti setiap
 * farming area setiap mob spawner yang sudah saya bangun sungai kadang juga bisa villager trading
 * hall villager farm semuanya dan misal itu satu titik tulis titiknya jika area tulis batas
 * batasnya sebagai vektor yang nantinya bisa di interpretasikan". File JSON bersama, dipakai
 * SEMUA bot (permintaan nyata pemilik) - sama seperti pola storageMemory.js.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('worldLandmarks', () => {
  let tmpFile;
  let worldLandmarks;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test_world_landmarks_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    process.env.WORLD_LANDMARKS_FILE = tmpFile;
    delete require.cache[require.resolve('../../src/ai/worldLandmarks')];
    worldLandmarks = require('../../src/ai/worldLandmarks');
  });

  afterEach(() => {
    delete process.env.WORLD_LANDMARKS_FILE;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('loadLandmarks() harus mengembalikan array kosong kalau file belum ada sama sekali', () => {
    assert.deepEqual(worldLandmarks.loadLandmarks(), []);
  });

  it('makePointLandmark() harus membuat landmark bertipe "point" dengan posisi x,y,z persis', () => {
    const landmark = worldLandmarks.makePointLandmark({ name: 'Peti Buku Cadangan', category: 'chest', position: { x: -181, y: 73, z: -351 } });
    assert.equal(landmark.shape, 'point');
    assert.equal(landmark.name, 'Peti Buku Cadangan');
    assert.equal(landmark.category, 'chest');
    assert.deepEqual(landmark.position, { x: -181, y: 73, z: -351 });
    assert.ok(landmark.id, 'harus punya id unik');
    assert.ok(landmark.discoveredAt, 'harus punya timestamp');
  });

  it('makeAreaLandmark() harus membuat landmark bertipe "area" dengan batas berupa daftar titik (vektor)', () => {
    const boundary = [{ x: -211, z: -409 }, { x: -182, z: -409 }, { x: -182, z: -340 }, { x: -211, z: -340 }];
    const landmark = worldLandmarks.makeAreaLandmark({ name: 'Lahan Farming Utama', category: 'farming_area', boundary });
    assert.equal(landmark.shape, 'area');
    assert.deepEqual(landmark.boundary, boundary);
  });

  it('saveLandmarks() lalu loadLandmarks() harus mengembalikan persis data yang sama (round-trip)', () => {
    const point = worldLandmarks.makePointLandmark({ name: 'Mob Spawner Zombie', category: 'mob_spawner', position: { x: -256, y: -20, z: -432 } });
    worldLandmarks.saveLandmarks([point]);
    const loaded = worldLandmarks.loadLandmarks();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'Mob Spawner Zombie');
    assert.deepEqual(loaded[0].position, { x: -256, y: -20, z: -432 });
  });

  it('addLandmark() harus menambah landmark baru KE atas memori yang sudah ada di disk (bukan menimpa) - permintaan tersirat: bot explorer menemukan landmark satu-satu seiring berjalan, bukan sekaligus semua di akhir', () => {
    const first = worldLandmarks.makePointLandmark({ name: 'Peti A', category: 'chest', position: { x: 0, y: 64, z: 0 } });
    worldLandmarks.saveLandmarks([first]);

    const second = worldLandmarks.makePointLandmark({ name: 'Peti B', category: 'chest', position: { x: 1, y: 64, z: 1 } });
    worldLandmarks.addLandmark(second);

    const loaded = worldLandmarks.loadLandmarks();
    assert.equal(loaded.length, 2);
    assert.deepEqual(new Set(loaded.map((l) => l.name)), new Set(['Peti A', 'Peti B']));
  });

  it('isInsideAreaLandmark() harus mendeteksi titik yang BENAR-BENAR di dalam batas area (poligon x,z) - dipakai bot lain (mis. FarmerWorker) untuk menghindari area yang ditandai (mis. villager_farm)', () => {
    const boundary = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    const landmark = worldLandmarks.makeAreaLandmark({ name: 'Desa Villager', category: 'villager_farm', boundary });

    assert.equal(worldLandmarks.isInsideAreaLandmark(landmark, { x: 5, y: 64, z: 5 }), true, 'titik di tengah kotak harus terdeteksi di dalam');
    assert.equal(worldLandmarks.isInsideAreaLandmark(landmark, { x: 50, y: 64, z: 50 }), false, 'titik jauh di luar kotak harus terdeteksi di luar');
  });

  it('isInsideAreaLandmark() harus bekerja untuk poligon TIDAK BERATURAN (bukan cuma kotak) - sungai/area alami jarang berbentuk kotak sempurna', () => {
    // Bentuk L (poligon tidak cembung) - titik (8,8) ada di "lekukan" yang seharusnya DI LUAR.
    const boundary = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 10 }, { x: 0, z: 10 }];
    const landmark = worldLandmarks.makeAreaLandmark({ name: 'Sungai Berkelok', category: 'river', boundary });

    assert.equal(worldLandmarks.isInsideAreaLandmark(landmark, { x: 2, y: 64, z: 2 }), true, 'titik di bagian utama bentuk L harus di dalam');
    assert.equal(worldLandmarks.isInsideAreaLandmark(landmark, { x: 8, y: 64, z: 8 }), false, 'titik di lekukan bentuk L harus di LUAR, bukan di dalam');
  });

  it('findNearbyLandmarks() harus mengembalikan landmark titik dalam jarak tertentu, diurutkan dari yang terdekat', () => {
    const near = worldLandmarks.makePointLandmark({ name: 'Dekat', category: 'chest', position: { x: 2, y: 64, z: 0 } });
    const far = worldLandmarks.makePointLandmark({ name: 'Jauh', category: 'chest', position: { x: 100, y: 64, z: 0 } });
    worldLandmarks.saveLandmarks([far, near]);

    const results = worldLandmarks.findNearbyLandmarks({ x: 0, y: 64, z: 0 }, 10);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Dekat');
  });

  it('isInsideAnyLandmarkOfCategory() harus dipakai bot lain untuk cek "apakah posisi ini di dalam area berkategori X manapun" - permintaan nyata pemilik: hindari villager farm/trading hall otomatis', () => {
    const boundary = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    const villagerFarm = worldLandmarks.makeAreaLandmark({ name: 'Farm Villager', category: 'villager_farm', boundary });
    const ourFarm = worldLandmarks.makeAreaLandmark({ name: 'Farm Kita', category: 'farming_area', boundary: [{ x: 100, z: 100 }, { x: 110, z: 100 }, { x: 110, z: 110 }, { x: 100, z: 110 }] });
    worldLandmarks.saveLandmarks([villagerFarm, ourFarm]);

    assert.equal(worldLandmarks.isInsideAnyLandmarkOfCategory({ x: 5, y: 64, z: 5 }, ['villager_farm', 'villager_trading_hall']), true);
    assert.equal(worldLandmarks.isInsideAnyLandmarkOfCategory({ x: 105, y: 64, z: 105 }, ['villager_farm', 'villager_trading_hall']), false, 'farm kita sendiri tidak boleh ikut terdeteksi walau ada landmark lain di dekatnya');
  });
});
