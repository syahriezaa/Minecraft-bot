/**
 * @file explorerEngine.js
 * @description Engine bot penjelajah - menjelajah spiral keluar dari base, menandai tempat penting
 * (peti, mob spawner, lahan farming, sungai, area villager) ke memori landmark bersama
 * (worldLandmarks.js) yang bisa dipakai bot lain. Permintaan nyata pemilik: "mari kita buat bot
 * explorer yang menandai akan mengeksplor map area area dan tempat tempat penting dengan ruang 3d
 * koordinat xyz...jika itu satu titik tulis titiknya, jika area tulis batas batasnya sebagai
 * vektor yang nantinya bisa di interpretasikan".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const {
  addLandmark,
  findNearbyLandmarks,
  makePointLandmark,
  makeAreaLandmark,
  loadLandmarks
} = require('./worldLandmarks');

// Kategori blok TITIK (satu landmark per blok) - struktur yang dibangun pemilik ("setiap peti
// setiap...mob spawner yang sudah saya bangun").
const POINT_BLOCK_CATEGORIES = {
  chest: 'chest',
  barrel: 'chest',
  spawner: 'mob_spawner'
};

// Kategori blok AREA (dikelompokkan jadi satu landmark per kluster bersebelahan, bukan satu per
// blok - "setiap farming area...sungai"). Satu kategori bisa terdiri dari BANYAK jenis blok
// (mis. "structure" - bangunan biasanya campuran planks+bricks+glass+dst dalam satu struktur yang
// sama), makanya berbentuk daftar grup, bukan pemetaan 1 blok -> 1 kategori.
const AREA_BLOCK_GROUPS = [
  { blockNames: ['farmland'], category: 'farming_area' },
  { blockNames: ['water'], category: 'river' },
  // Bahan bangunan umum - permintaan nyata pemilik: "saya ingin maping bangunan saya". SENGAJA
  // tidak menyertakan blok alami murni (stone/dirt/cobblestone polos dsb, yang juga muncul lewat
  // gua/medan alami) - cuma bentuk yang jelas hasil OLAHAN/konstruksi (planks, bricks, kaca,
  // pintu, tangga buatan, pagar) yang hampir pasti bagian dari bangunan sungguhan, bukan medan.
  {
    blockNames: [
      'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
      'bricks', 'stone_bricks', 'chiseled_stone_bricks', 'cracked_stone_bricks', 'mossy_stone_bricks', 'smooth_stone', 'polished_andesite', 'polished_diorite', 'polished_granite',
      'glass', 'glass_pane', 'white_stained_glass', 'quartz_block', 'smooth_quartz',
      'oak_door', 'spruce_door', 'birch_door', 'iron_door',
      'oak_stairs', 'stone_stairs', 'brick_stairs', 'cobblestone_stairs',
      'oak_fence', 'oak_fence_gate', 'iron_bars',
      'oak_slab', 'stone_slab', 'cobblestone_slab',
      'bookshelf', 'crafting_table', 'furnace', 'ladder'
    ],
    category: 'structure'
  }
];

const NAME_TEMPLATES = {
  chest: 'Peti',
  mob_spawner: 'Mob Spawner',
  farming_area: 'Lahan Farming',
  river: 'Sungai/Air',
  villager_area: 'Area Villager',
  structure: 'Bangunan'
};

// Convex hull (monotone chain) - "vektor batas" area yang bisa diinterpretasikan lewat
// point-in-polygon (lihat worldLandmarks.isInsideAreaLandmark). Convex hull cukup untuk menandai
// JANGKAUAN kasar sebuah kluster tanpa perlu melacak setiap lekukan tepi blok satu-satu.
function convexHull(points) {
  const pts = [...new Map(points.map((p) => [`${p.x},${p.z}`, p])).values()].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function centroidOf(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, z: acc.z + (p.z ?? 0) }), { x: 0, z: 0 });
  return { x: sum.x / points.length, z: sum.z / points.length };
}

class ExplorerEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      basePosition: { x: 0, y: 64, z: 0 },
      // Langkah lebih rapat (dulu 16) + radius maksimal dibatasi (permintaan nyata pemilik:
      // "utamakan explore sekitar base saya ingin maping bangunan saya") - liputan padat di
      // sekitar base untuk menemukan bangunan kecil, bukan langkah lebar yang melompati detail.
      spiralStepSize: 8,
      // Begitu spiral akan melompat lebih jauh dari radius ini, MENGULANG dari titik dekat base
      // lagi (bukan terus kabur menjelajah jauh) - landmark yang sudah dikenal otomatis dilewati
      // (isAlreadyKnown/isAreaAlreadyKnown), jadi mengulang aman, tidak spam duplikat.
      // 64, bukan 48 - permintaan nyata pemilik: "map area farming nya". Lahan farming
      // sungguhan (dikonfirmasi lewat probe live sebelumnya) meluas sampai ~57 blok dari base ke
      // arah selatan - radius 48 akan memotong ujung lahan itu sebelum sempat terpetakan.
      maxExploreRadius: 64,
      scanRadius: 24,
      dedupeDistance: 12,
      // Keselamatan diri - ditemukan dari bug live nyata: ExplorerWorker sempat health 0.5/20
      // sambil TETAP terus menjelajah tanpa henti, karena engine ini TIDAK PUNYA sama sekali
      // mekanisme menyelamatkan diri (beda dari FarmerEngine yang setidaknya makan saat lapar) -
      // penjelajah justru yang PALING berisiko karena sengaja masuk area yang belum dikenal.
      retreatHealth: 6,
      eatFoodThreshold: 14,
      llmClient: null,
      log: () => {},
      ...options
    };
    this.spiralIndex = 0;
    this.metrics = { waypointsVisited: 0, landmarksFound: 0 };
  }

  // Titik spiral MENTAH (dalam satuan langkah, belum dikali step) untuk index tertentu - dipisah
  // dari nextSpiralWaypoint() supaya bisa dicoba beberapa index tanpa efek samping (menaikkan
  // spiralIndex) saat mengecek apakah suatu titik masih dalam maxExploreRadius.
  computeSpiralPoint(index) {
    let x = 0, z = 0;
    let dx = 1, dz = 0;
    let segmentLength = 1;
    let segmentPassed = 0;
    let turnsInSegment = 0;
    for (let i = 0; i < index; i++) {
      x += dx; z += dz;
      segmentPassed++;
      if (segmentPassed === segmentLength) {
        segmentPassed = 0;
        [dx, dz] = [-dz, dx]; // putar 90 derajat
        turnsInSegment++;
        if (turnsInSegment === 2) {
          turnsInSegment = 0;
          segmentLength++;
        }
      }
    }
    return { x, z };
  }

  // Spiral kotak keluar dari base (0,0 relatif) - permintaan nyata pemilik: "spiral keluar dari
  // base". Algoritma standar: melangkah dalam pola kanan-atas-kiri-bawah dengan panjang lengan
  // yang membesar setiap 2 belokan, membentuk kotak yang melebar. Begitu titik berikutnya akan
  // melewati maxExploreRadius dari base, ULANG dari awal (index 0) - permintaan nyata pemilik:
  // "utamakan explore sekitar base saya ingin maping bangunan saya", jangan sampai spiral kabur
  // ke alam liar jauh dari base.
  nextSpiralWaypoint() {
    const step = this.options.spiralStepSize;
    const raw = this.computeSpiralPoint(this.spiralIndex);
    const dist = Math.sqrt((raw.x * step) ** 2 + (raw.z * step) ** 2);
    if (dist > this.options.maxExploreRadius) {
      this.spiralIndex = 0;
      const wrapped = this.computeSpiralPoint(0);
      this.spiralIndex++;
      return { x: wrapped.x * step, z: wrapped.z * step };
    }
    this.spiralIndex++;
    return { x: raw.x * step, z: raw.z * step };
  }

  isAlreadyKnown(pos) {
    return findNearbyLandmarks(pos, this.options.dedupeDistance, this.options.log).length > 0;
  }

  isAreaAlreadyKnown(category, centroid) {
    return loadLandmarks(this.options.log)
      .filter((l) => l.shape === 'area' && l.category === category)
      .some((l) => {
        const c = centroidOf(l.boundary);
        const dx = c.x - centroid.x, dz = c.z - centroid.z;
        return Math.sqrt(dx * dx + dz * dz) <= this.options.dedupeDistance;
      });
  }

  async nameFor(category, sample) {
    const fallback = NAME_TEMPLATES[category] || category;
    if (!this.options.llmClient) return fallback;
    try {
      const prompt = `Beri nama singkat (maksimal 4 kata, Bahasa Indonesia) untuk lokasi Minecraft berkategori "${category}" dengan sampel blok/entitas: ${JSON.stringify(sample).slice(0, 300)}. Jawab HANYA nama singkatnya, tanpa penjelasan.`;
      const result = await this.options.llmClient.chat(prompt);
      const name = (result?.message || '').trim().split('\n')[0].slice(0, 60);
      return name || fallback;
    } catch (e) {
      this.options.log(`PERINGATAN: gagal minta nama dari LLM untuk landmark "${category}" (${e.message}) - pakai nama baku.`);
      return fallback;
    }
  }

  async recordPointLandmarks() {
    const created = [];
    const names = Object.keys(POINT_BLOCK_CATEGORIES);
    const blocks = this.adapter.findBlocksByNames(names, { maxDistance: this.options.scanRadius });
    for (const block of blocks) {
      if (this.isAlreadyKnown(block.position)) continue;
      const category = POINT_BLOCK_CATEGORIES[block.name];
      const name = await this.nameFor(category, { blockName: block.name, position: block.position });
      const landmark = makePointLandmark({ name, category, position: block.position });
      addLandmark(landmark, this.options.log);
      this.options.log(`[Explorer] Landmark baru: ${name} (${category}) di (${block.position.x},${block.position.y},${block.position.z})`);
      created.push(landmark);
    }
    return created;
  }

  async recordAreaLandmarks() {
    const created = [];
    for (const { blockNames, category } of AREA_BLOCK_GROUPS) {
      const blocks = this.adapter.findBlocksByNames(blockNames, { maxDistance: this.options.scanRadius });
      if (blocks.length === 0) continue;
      const points = blocks.map((b) => ({ x: b.position.x, z: b.position.z }));
      const centroid = centroidOf(points);
      if (this.isAreaAlreadyKnown(category, centroid)) continue;
      const boundary = convexHull(points);
      if (boundary.length < 3) continue; // terlalu sedikit blok untuk membentuk area sungguhan
      const name = await this.nameFor(category, { blockNames: [...new Set(blocks.map((b) => b.name))], count: blocks.length, centroid });
      const landmark = makeAreaLandmark({ name, category, boundary });
      addLandmark(landmark, this.options.log);
      this.options.log(`[Explorer] Landmark area baru: ${name} (${category}) - ${blocks.length} blok, ${boundary.length} titik batas`);
      created.push(landmark);
    }
    return created;
  }

  async recordVillagerAreaLandmark() {
    const villagers = this.adapter.getEntities().filter((e) => e.name === 'villager' || e.type === 'villager');
    if (villagers.length === 0) return [];
    const points = villagers.map((v) => ({ x: v.position.x, z: v.position.z }));
    const centroid = centroidOf(points);
    if (this.isAreaAlreadyKnown('villager_area', centroid)) return [];
    let boundary = convexHull(points);
    if (boundary.length < 3) {
      // Terlalu sedikit villager untuk membentuk poligon sungguhan - buat kotak kecil di
      // sekeliling titik-titik yang ada supaya tetap tercatat sebagai area yang bisa dihindari.
      const xs = points.map((p) => p.x), zs = points.map((p) => p.z);
      const pad = 4;
      boundary = [
        { x: Math.min(...xs) - pad, z: Math.min(...zs) - pad },
        { x: Math.max(...xs) + pad, z: Math.min(...zs) - pad },
        { x: Math.max(...xs) + pad, z: Math.max(...zs) + pad },
        { x: Math.min(...xs) - pad, z: Math.max(...zs) + pad }
      ];
    }
    const name = await this.nameFor('villager_area', { villagerCount: villagers.length, centroid });
    const landmark = makeAreaLandmark({ name, category: 'villager_area', boundary });
    addLandmark(landmark, this.options.log);
    this.options.log(`[Explorer] Landmark area baru: ${name} (villager_area) - ${villagers.length} villager terdeteksi`);
    return [landmark];
  }

  async tick() {
    // Mundur SEGERA kalau health sudah kritis - JANGAN maju spiralIndex sama sekali (belum
    // sempat menjelajah waypoint ini, jadi jangan dianggap sudah selesai) supaya begitu health
    // pulih, penjelajahan lanjut dari titik yang sama, bukan melompati bagian yang tertunda.
    if (this.adapter.getHealth() <= this.options.retreatHealth) {
      await this.adapter.navigateNear(this.options.basePosition, 1);
      this.metrics.retreats = (this.metrics.retreats || 0) + 1;
      return { action: 'retreat' };
    }
    if (this.adapter.getFood() <= this.options.eatFoodThreshold) {
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten = (this.metrics.eaten || 0) + 1;
        return { action: 'eat' };
      }
    }

    const waypoint = this.nextSpiralWaypoint();
    const target = {
      x: this.options.basePosition.x + waypoint.x,
      y: this.options.basePosition.y,
      z: this.options.basePosition.z + waypoint.z
    };
    await this.adapter.navigateNear(target, 3);
    this.metrics.waypointsVisited++;

    const pointLandmarks = await this.recordPointLandmarks();
    const areaLandmarks = await this.recordAreaLandmarks();
    const villagerLandmarks = await this.recordVillagerAreaLandmark();
    const allNew = [...pointLandmarks, ...areaLandmarks, ...villagerLandmarks];
    this.metrics.landmarksFound += allNew.length;
    for (const landmark of allNew) this.emit('landmarkFound', landmark);

    return { action: 'explore', waypoint: target, landmarksFound: allNew.length };
  }
}

module.exports = { ExplorerEngine, convexHull };
