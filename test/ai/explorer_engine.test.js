/**
 * @file explorer_engine.test.js
 * @description Unit test ExplorerEngine - bot penjelajah yang menandai lokasi penting (peti, mob
 * spawner, lahan farming, sungai, area villager) ke memori landmark bersama (worldLandmarks.js).
 * Permintaan nyata pemilik: "mari kita buat bot explorer yang menandai akan mengeksplor map area
 * area dan tempat tempat penting dengan ruang 3d koordinat xyz...struktur yang saya bangun jadi
 * setiap peti setiap farming area setiap mob spawner yang sudah saya bangun sungai kadang juga
 * bisa villager trading hall villager farm semuanya dan misal itu satu titik tulis titiknya jika
 * area tulis batas batasnya sebagai vektor yang nantinya bisa di interpretasikan".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('ExplorerEngine', () => {
  let tmpFile;
  let ExplorerEngine;
  let worldLandmarks;

  class FakeExplorerAdapter {
    constructor({ blocks = [], entities = [] } = {}) {
      this.position = { x: 0, y: 64, z: 0 };
      this.blocks = blocks;
      this.entities = entities;
      this.actions = [];
    }
    getPosition() { return this.position; }
    async navigateNear(pos) {
      this.actions.push({ type: 'navigate', position: pos });
      this.position = { x: pos.x, y: pos.y, z: pos.z };
      return true;
    }
    findBlocksByNames(names) {
      const wanted = new Set(names);
      return this.blocks.filter((b) => wanted.has(b.name));
    }
    getEntities() { return this.entities; }
  }

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test_explorer_landmarks_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    process.env.WORLD_LANDMARKS_FILE = tmpFile;
    delete require.cache[require.resolve('../../src/ai/worldLandmarks')];
    delete require.cache[require.resolve('../../src/ai/explorerEngine')];
    worldLandmarks = require('../../src/ai/worldLandmarks');
    ExplorerEngine = require('../../src/ai/explorerEngine').ExplorerEngine;
  });

  afterEach(() => {
    delete process.env.WORLD_LANDMARKS_FILE;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('nextSpiralWaypoint() harus menghasilkan urutan titik yang MELEBAR keluar dari base (spiral), bukan acak - permintaan nyata pemilik: "spiral keluar dari base"', () => {
    const adapter = new FakeExplorerAdapter({});
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    const points = [engine.nextSpiralWaypoint(), engine.nextSpiralWaypoint(), engine.nextSpiralWaypoint(), engine.nextSpiralWaypoint()];

    // Titik-titik awal spiral harus mengelilingi base (0,0) dalam radius kecil dulu, bukan
    // langsung melompat jauh - dan tidak boleh ada titik yang berulang persis sama.
    const keys = points.map((p) => `${p.x},${p.z}`);
    assert.equal(new Set(keys).size, keys.length, 'tidak boleh ada titik spiral yang berulang persis sama di awal');
  });

  it('nextSpiralWaypoint() TIDAK BOLEH pernah melebihi maxExploreRadius dari base - permintaan nyata pemilik: "utamakan explore sekitar base saya ingin maping bangunan saya" - begitu spiral akan melompat lebih jauh dari radius itu, harus MENGULANG dari awal (memutar dekat base terus-menerus), bukan kabur menjelajah jauh ke alam liar', () => {
    const adapter = new FakeExplorerAdapter({});
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 }, maxExploreRadius: 40, spiralStepSize: 8 });

    const points = [];
    for (let i = 0; i < 60; i++) points.push(engine.nextSpiralWaypoint());

    for (const p of points) {
      const dist = Math.sqrt(p.x * p.x + p.z * p.z);
      assert.ok(dist <= 40, `titik (${p.x},${p.z}) berjarak ${dist.toFixed(1)} dari base, melebihi maxExploreRadius 40`);
    }
  });

  it('tick() harus mencatat CHEST yang ditemukan sebagai landmark titik baru ke memori bersama', async () => {
    const adapter = new FakeExplorerAdapter({
      blocks: [{ name: 'chest', position: { x: 5, y: 64, z: 5 } }]
    });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    const result = await engine.tick();

    assert.equal(result.action, 'explore');
    assert.ok(result.landmarksFound >= 1);
    const saved = worldLandmarks.loadLandmarks();
    const chestLandmark = saved.find((l) => l.category === 'chest');
    assert.ok(chestLandmark, 'chest yang ditemukan harus tersimpan sebagai landmark');
    assert.deepEqual(chestLandmark.position, { x: 5, y: 64, z: 5 });
    assert.equal(chestLandmark.shape, 'point');
  });

  it('tick() harus mencatat MOB SPAWNER yang ditemukan sebagai landmark titik baru', async () => {
    const adapter = new FakeExplorerAdapter({
      blocks: [{ name: 'spawner', position: { x: -10, y: 30, z: -10 } }]
    });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();

    const saved = worldLandmarks.loadLandmarks();
    const spawnerLandmark = saved.find((l) => l.category === 'mob_spawner');
    assert.ok(spawnerLandmark);
    assert.deepEqual(spawnerLandmark.position, { x: -10, y: 30, z: -10 });
  });

  it('chest/spawner yang SUDAH pernah tercatat (dekat landmark yang sudah ada) TIDAK BOLEH dicatat ulang sebagai landmark baru - jangan spam duplikat tiap kali lewat lagi', async () => {
    worldLandmarks.saveLandmarks([
      worldLandmarks.makePointLandmark({ name: 'Peti Lama', category: 'chest', position: { x: 5, y: 64, z: 5 } })
    ]);
    const adapter = new FakeExplorerAdapter({
      blocks: [{ name: 'chest', position: { x: 5, y: 64, z: 5 } }] // persis chest yang sama, ditemukan lagi
    });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();

    const saved = worldLandmarks.loadLandmarks();
    assert.equal(saved.filter((l) => l.category === 'chest').length, 1, 'tidak boleh ada duplikat - cuma landmark lama yang ada');
  });

  it('kumpulan blok FARMLAND yang ditemukan bersebelahan harus dicatat sebagai SATU landmark AREA (bukan satu landmark per blok) dengan batas berupa poligon (vektor)', async () => {
    const farmlandBlocks = [];
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        farmlandBlocks.push({ name: 'farmland', position: { x, y: 62, z } });
      }
    }
    const adapter = new FakeExplorerAdapter({ blocks: farmlandBlocks });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();

    const saved = worldLandmarks.loadLandmarks();
    const farmLandmarks = saved.filter((l) => l.category === 'farming_area');
    assert.equal(farmLandmarks.length, 1, 'harus jadi SATU landmark area, bukan 16 landmark titik terpisah');
    assert.equal(farmLandmarks[0].shape, 'area');
    assert.ok(Array.isArray(farmLandmarks[0].boundary) && farmLandmarks[0].boundary.length >= 3, 'batas area harus berupa poligon (vektor titik-titik)');
  });

  it('villager (entitas) yang ditemukan berkelompok harus dicatat sebagai landmark AREA berkategori villager_area', async () => {
    const villagers = [
      { name: 'villager', position: { x: 0, y: 65, z: 0 } },
      { name: 'villager', position: { x: 2, y: 65, z: 1 } },
      { name: 'villager', position: { x: 1, y: 65, z: 3 } }
    ];
    const adapter = new FakeExplorerAdapter({ entities: villagers });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();

    const saved = worldLandmarks.loadLandmarks();
    const villagerLandmark = saved.find((l) => l.category === 'villager_area');
    assert.ok(villagerLandmark, 'kelompok villager harus tercatat sebagai landmark area');
    assert.equal(villagerLandmark.shape, 'area');
  });

  it('kumpulan blok BAHAN BANGUNAN (planks, bricks, glass, dst) yang ditemukan bersebelahan harus dicatat sebagai SATU landmark AREA berkategori "structure" - permintaan nyata pemilik: "saya ingin maping bangunan saya"', async () => {
    const buildingBlocks = [];
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        buildingBlocks.push({ name: x % 2 === 0 ? 'oak_planks' : 'stone_bricks', position: { x, y: 65, z } });
      }
    }
    const adapter = new FakeExplorerAdapter({ blocks: buildingBlocks });
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();

    const saved = worldLandmarks.loadLandmarks();
    const structureLandmarks = saved.filter((l) => l.category === 'structure');
    assert.equal(structureLandmarks.length, 1, 'harus jadi SATU landmark bangunan, bukan terpisah per jenis blok (oak_planks vs stone_bricks)');
    assert.equal(structureLandmarks[0].shape, 'area');
    assert.ok(structureLandmarks[0].boundary.length >= 3);
  });

  it('metrics.waypointsVisited harus bertambah setiap tick, dan posisi bot harus benar-benar berpindah ke waypoint spiral berikutnya', async () => {
    const adapter = new FakeExplorerAdapter({});
    const engine = new ExplorerEngine({ adapter, basePosition: { x: 0, y: 64, z: 0 } });

    await engine.tick();
    await engine.tick();

    assert.equal(engine.metrics.waypointsVisited, 2);
    assert.equal(adapter.actions.filter((a) => a.type === 'navigate').length, 2);
  });
});
