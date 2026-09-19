/**
 * @file farmerEngine.js
 * @description Engine pertanian untuk panen, tanam ulang, dan deposit hasil.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter, distance, HOE_NAMES } = require('./mineflayerRoleAdapter');
const { parseChestPositionKey } = require('./storageMemory');
const { isInsideAnyLandmarkOfCategory } = require('./worldLandmarks');

const CROP_RULES = Object.freeze({
  wheat: { maxAge: 7, seed: 'wheat_seeds', harvest: ['wheat'] },
  carrots: { maxAge: 7, seed: 'carrot', harvest: ['carrot'] },
  potatoes: { maxAge: 7, seed: 'potato', harvest: ['potato'] },
  beetroots: { maxAge: 3, seed: 'beetroot_seeds', harvest: ['beetroot'] },
  nether_wart: { maxAge: 3, seed: 'nether_wart', harvest: ['nether_wart'] }
});

// Blok tanah yang BISA dicangkul jadi farmland - dipakai findRepairCandidates untuk membedakan
// "belum dicangkul" (masih bisa diperbaiki) dari blok lain yang memang bukan bagian lahan farming
// sama sekali (batu, air/kanal irigasi, jalan setapak, dst - JANGAN pernah disentuh).
const TILLABLE_GROUND_NAMES = ['dirt', 'grass_block', 'coarse_dirt', 'podzol'];

function blockAge(block) {
  const raw = block?.properties?.age ?? block?.metadata;
  const age = Number(raw);
  return Number.isFinite(age) ? age : 0;
}

// Kebalikan dari isInsideArea - true kalau pos di LUAR area (atau tidak ada area sama sekali,
// artinya tidak ada yang dikecualikan). Dipakai avoidArea: kolom/entitas di dalam area terlarang
// (mis. area peternakan villager dekat base, sebagian terhalang tembok) dikecualikan sama sekali
// dari pertimbangan, bukan dicoba lalu gagal berulang-ulang.
function isOutsideArea(pos, area) {
  return !area || !isInsideArea(pos, area);
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

class FarmerEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      farmArea: null,
      avoidArea: null,
      scanRadius: 32,
      harvestBatchSize: 1,
      plantBatchSize: 1,
      depositChest: null,
      autoMatchStorage: false,
      // Memori sortir gudang DIBAGIKAN dari StorageWorker (lihat storageMemory.js) - permintaan
      // nyata pemilik: "share memory tentang peti ke semua bot agar dapat mencari barang barang
      // dan menaruh barang dengan tepat". Kalau jenis item yang mau disetor sudah dikenal di
      // sini, langsung antar ke posisi itu TANPA memindai chest satu-satu (findMatchingChest) -
      // lebih cepat DAN tidak mungkin salah pilih chest yang kebetulan sudah berisi barang nyasar.
      sharedChestAssignments: null,
      depositWhenSlotsFreeBelow: 4,
      // Sisakan sejumlah ini di inventaris untuk item yang JUGA dipakai sebagai benih (carrot,
      // potato - item hasil panen yang sama persis dipakai lagi untuk menanam) sebelum menyetor
      // sisanya ke gudang - jangan sampai kehabisan benih untuk tanam berikutnya karena sudah
      // disetor semua. Item yang benihnya BEDA (mis. wheat, benihnya wheat_seeds) bebas disetor
      // penuh tanpa batas.
      seedReserve: 32,
      autoEatFoodThreshold: 14,
      // Mundur SEGERA ke retreatPosition kalau health di bawah ambang ini, sebelum panen/tanam/
      // perbaikan apapun - ditemukan dari bug live nyata: "farmernya tenggelam terus", health
      // sempat 2.8/20 sambil FarmerEngine cuma cek food, sama sekali tidak cek health mentah, jadi
      // tidak pernah menyelamatkan diri walau nyaris mati. Pola sama seperti retreat MobFarmEngine.
      retreatHealth: 6,
      retreatPosition: null,
      // Buang kelebihan seed/kentang ke composter - permintaan nyata pemilik: "aku baru menaruh
      // komposer di gudang mungkin jika makanan terlalu banyak buat kompser saja". Default kosong
      // (fitur mati sampai posisi composter sungguhan diberikan lewat options) - poisonous_potato
      // SENGAJA masuk daftar (bukan makanan, bukan benih, murni sampah yang menumpuk di POTATO_CHEST).
      composterPositions: [],
      compostItemNames: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'potato', 'poisonous_potato'],
      compostThreshold: 128,
      // Perbaiki lahan farming yang rusak (dirt/grass yang belum dicangkul, atau lubang) di
      // PINGGIRAN farmland yang sudah ada - permintaan nyata pemilik: "farming bot harus bisa
      // memperbaiki tempat farming jadi bawa dirt dan hoe dari gudang". Cangkul & dirt diambil
      // dari gudang lewat sharedChestAssignments kalau belum dibawa - lihat fetchRepairSupplies.
      repairEnabled: true,
      repairBatchSize: 4,
      // Kategori landmark (worldLandmarks.js) yang OTOMATIS dihindari, di atas avoidArea manual -
      // permintaan nyata pemilik: "bot nya tidak tau dimana lokasi lahan pertanian dimana
      // villager farm" - dulu satu-satunya cara mengecualikan area villager adalah avoidArea
      // hardcode manual (dan terbukti ada village KEDUA yang tidak pernah ter-hardcode). Begitu
      // bot explorer menandai suatu area sebagai villager_area, SEMUA bot langsung menghindarinya
      // tanpa perlu update kode/koordinat manual lagi.
      avoidLandmarkCategories: ['villager_area'],
      // Chest UTAMA -> chest CADANGAN DARURAT (sama peta yang dipakai StorageManagerEngine,
      // lihat storageMemory.js OVERFLOW_CHESTS) - permintaan nyata pemilik: "kenapa dia tidak
      // bisa menaruh inventory nya sampai hampir kosong". Ditemukan lewat pemantauan live: chest
      // benih (SEEDS_CHEST) sungguhan sudah 54/54 slot penuh - overflow-nya sudah lama terdaftar
      // tapi FarmerEngine tidak pernah tahu soal itu sama sekali, cuma StorageManagerEngine yang
      // pakai peta ini - jadi begitu chest utama genuinely penuh, item itu tersangkut di tas
      // SELAMANYA walau ada tempat cadangan yang masih longgar.
      overflowChests: {},
      ...options
    };
    this.metrics = {
      harvested: 0,
      planted: 0,
      deposited: 0,
      eaten: 0,
      repaired: 0
    };
    // Ingat chest yang sudah ditemukan cocok untuk tiap jenis item, supaya tiap tick berikutnya
    // tidak perlu membuka ulang semua chest di gudang - gudang nyata pemilik bisa berisi puluhan
    // chest (lihat komentar autoMatchStorage), membukanya satu-satu tiap tick jelas mahal.
    this.depositChestCache = new Map();
    // Kunci string ASLI (mis. "-181,72,-350") per jenis item, dipakai untuk cari chest cadangan
    // di overflowChests - depositChestCache sendiri menyimpan posisi yang SUDAH di-parse jadi
    // objek {x,y,z}, tidak bisa dipakai langsung sebagai kunci lookup overflowChests.
    this.depositChestKeyCache = new Map();
    this.plantRotationIndex = 0;
    this.rowSeeds = new Map();
    this.repairRetryAt = new Map();
  }

  isMatureCrop(block) {
    const rule = CROP_RULES[block?.name];
    return Boolean(rule && blockAge(block) >= rule.maxAge);
  }

  // Gabungan avoidArea manual (satu kotak, diset lewat kode) DAN landmark dunia berkategori
  // avoidLandmarkCategories (ditandai bot explorer, bisa banyak & bentuk apa saja - lihat
  // worldLandmarks.js) - permintaan nyata pemilik: "bot nya tidak tau dimana lokasi lahan
  // pertanian dimana villager farm".
  isOutsideAllAvoidance(pos) {
    if (!isOutsideArea(pos, this.options.avoidArea)) return false;
    if (isInsideAnyLandmarkOfCategory(pos, this.options.avoidLandmarkCategories)) return false;
    return true;
  }

  findMatureCrops() {
    return this.adapter
      .findBlocksByNames(Object.keys(CROP_RULES), { maxDistance: this.options.scanRadius })
      .filter(block => this.isMatureCrop(block))
      .filter(block => isInsideArea(block.position, this.options.farmArea))
      .filter(block => this.isOutsideAllAvoidance(block.position))
      .sort((a, b) => distance(this.adapter.getPosition(), a.position) - distance(this.adapter.getPosition(), b.position));
  }

  findFarmlandBlocks() {
    return this.adapter
      .findBlocksByNames(['farmland', 'soul_sand'], { maxDistance: this.options.scanRadius })
      .filter(block => isInsideArea(block.position, this.options.farmArea))
      .filter(block => this.isOutsideAllAvoidance(block.position));
  }

  findPlantingSpots() {
    const farmland = this.findFarmlandBlocks();
    if (!this.rowAxis && farmland.length) this.rowAxis = new Set(farmland.map(b => b.position.x)).size >= new Set(farmland.map(b => b.position.z)).size ? 'x' : 'z';
    return this.groupSpotsByRow(farmland).flat().filter(block => {
      const above = this.adapter.blockAt({
        x: block.position.x,
        y: block.position.y + 1,
        z: block.position.z
      });
      return !above || above.name === 'air';
    });
  }

  // Kelompokkan spot yang mau ditanam jadi BARIS MEMANJANG - permintaan nyata pemilik: "tanam
  // dengan variasi per baris memanjang". Sumbu "memanjang" (arah baris) ditebak dari sebaran spot
  // itu sendiri: sumbu dengan LEBIH BANYAK koordinat berbeda dianggap arah memanjang (x kalau
  // baris berjajar sepanjang x, z kalau sepanjang z) - baris dikelompokkan oleh sumbu yang TETAP
  // (satu nilai per baris). Tidak butuh tahu bentuk lahan sesungguhnya di depan (tidak ada peta
  // tersimpan) - cukup dihitung ulang tiap kali dari spot yang sedang dilihat.
  groupSpotsByRow(spots) {
    if (spots.length === 0) return [];
    const distinctX = new Set(spots.map(s => s.position.x)).size;
    const distinctZ = new Set(spots.map(s => s.position.z)).size;
    const axis = this.rowAxis || (distinctX >= distinctZ ? 'x' : 'z');
    const cross = axis === 'x' ? 'z' : 'x';
    const rowKeyOf = (pos) => `${pos.y}:${pos[cross]}`;
    const rows = new Map();
    for (const spot of spots) {
      const key = rowKeyOf(spot.position);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(spot);
    }
    return [...rows.values()].sort((a, b) => a[0].position.y - b[0].position.y || a[0].position[cross] - b[0].position[cross])
      .map(row => row.sort((a, b) => a.position[axis] - b.position[axis]));
  }

  chooseSeedFor(referenceBlock) {
    if (referenceBlock?.name === 'soul_sand' && this.adapter.hasItem('nether_wart')) return 'nether_wart';
    // Bergantian di antara jenis benih yang SUNGGUH tersedia di inventaris - bukan selalu benih
    // pertama di CROP_RULES (wheat_seeds) - ditemukan dari permintaan nyata pemilik: kebun jadi
    // seragam wheat semua walau punya benih carrot/potato juga, karena benih pertama yang cocok
    // selalu dipakai duluan dan wheat_seeds biasanya paling melimpah. Dipanggil SEKALI PER BARIS
    // (bukan per spot individual) supaya satu baris memanjang jadi satu jenis benih yang rapi.
    if (referenceBlock?.name === 'soul_sand') return null;
    const pos = referenceBlock.position;
    const key = `${pos.y}:${this.rowAxis || 'x'}:${pos[this.rowAxis === 'z' ? 'x' : 'z']}`;
    if (this.rowSeeds.has(key)) {
      const seed = this.rowSeeds.get(key);
      return this.adapter.hasItem(seed) ? seed : null;
    }
    const available = Object.values(CROP_RULES).map(rule => rule.seed).filter(seed => seed !== 'nether_wart' && this.adapter.hasItem(seed));
    if (available.length === 0) return null;
    const seed = available[this.plantRotationIndex % available.length];
    this.plantRotationIndex++;
    this.rowSeeds.set(key, seed);
    return seed;
  }

  // Cari kandidat perbaikan lahan farming: petak TEPAT BERSEBELAHAN (4 arah, bukan diagonal)
  // dengan farmland/soul_sand yang SUDAH ADA, tapi belum ikut jadi bagian lahan yang bisa ditanami.
  // SENGAJA cuma menyentuh petak yang LANGSUNG bersebelahan dengan lahan yang sudah dikonfirmasi
  // (bukan seluruh kotak pembatas/bounding box) - kalau meng-crawl lebih jauh atau menganggap semua
  // sel di dalam bounding box sebagai "harus farmland", kanal air irigasi atau jalan setapak yang
  // memang sengaja bukan farmland bisa ikut "diperbaiki" jadi dirt/farmland, merusak tata letak
  // lahan yang sengaja dibuat pemilik. Dua jenis kandidat: 'till' (dirt/grass yang tinggal
  // dicangkul) dan 'fill' (lubang kosong, butuh dirt dulu sebelum bisa dicangkul).
  findRepairCandidates() {
    const farmland = this.findFarmlandBlocks();
    const knownKeys = new Set(farmland.map(b => `${b.position.x},${b.position.z}`));
    const seen = new Set();
    const candidates = [];
    const offsets = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    for (const block of farmland) {
      for (const off of offsets) {
        const pos = { x: block.position.x + off.x, y: block.position.y, z: block.position.z + off.z };
        const key = `${pos.x},${pos.z}`;
        if (knownKeys.has(key) || seen.has(key)) continue;
        if (!isInsideArea(pos, this.options.farmArea) || !this.isOutsideAllAvoidance(pos)) continue;
        seen.add(key);
        const ground = this.adapter.blockAt(pos);
        const above = this.adapter.blockAt({ x: pos.x, y: pos.y + 1, z: pos.z });
        const aboveClear = !above || above.name === 'air';
        if (ground && TILLABLE_GROUND_NAMES.includes(ground.name) && aboveClear) {
          candidates.push({ type: 'till', position: pos });
        } else if ((!ground || ground.name === 'air') && aboveClear) {
          candidates.push({ type: 'fill', position: pos });
        }
      }
    }
    return candidates.sort((a, b) => distance(this.adapter.getPosition(), a.position) - distance(this.adapter.getPosition(), b.position));
  }

  // Ambil cangkul dan/atau dirt dari gudang lewat memori bersama (sharedChestAssignments, lihat
  // storageMemory.js) - permintaan nyata pemilik: "bawa dirt dan hoe dari gudang". Cangkul dicari
  // lewat jenis APAPUN yang sudah dikenal memori bersama (semuanya mengarah ke chest perkakas yang
  // sama); tanpa memori bersama (belum di-set), tidak ada yang bisa diambil - repair menunggu
  // sampai bot kebetulan sudah membawa sendiri.
  //
  // Kalau inventaris BENAR-BENAR PENUH (0 slot bebas), JANGAN sekalipun mencoba withdraw - chest
  // sungguhan (mineflayer) MELEMPAR error "inventory is full", bukan gagal dengan tenang. Try/catch
  // di sini jaga-jaga TAMBAHAN (mis. penuh SETELAH cek awal, atau alasan gagal lain) supaya
  // exception ini TIDAK PERNAH merembet sampai ke tick() - ditemukan dari bug live nyata: "farmer
  // worker nya tidak click apa apa" - dulu exception ini melempar SEBELUM sempat sampai ke langkah
  // deposit (autoMatchStorage), jadi setiap tick gagal total dan bot macet PERMANEN: tidak pernah
  // menaruh apapun ke gudang padahal itu justru satu-satunya jalan keluar dari inventaris penuh.
  async fetchRepairSupplies(needHoe, needDirt) {
    if (this.adapter.getInventoryFreeSlotCount() <= 0) return false;
    if (needHoe) {
      const hoeKey = HOE_NAMES.find(name => this.options.sharedChestAssignments?.[name]);
      if (hoeKey) {
        const pos = parseChestPositionKey(this.options.sharedChestAssignments[hoeKey]);
        try {
          await this.adapter.withdrawFromChest(pos, HOE_NAMES, 1);
        } catch (e) {
          this.emit('repairError', { step: 'fetchHoe', error: e.message });
        }
      }
    }
    if (needDirt) {
      const dirtKey = this.options.sharedChestAssignments?.dirt;
      if (dirtKey) {
        const pos = parseChestPositionKey(dirtKey);
        try {
          await this.adapter.withdrawFromChest(pos, ['dirt'], 64);
        } catch (e) {
          this.emit('repairError', { step: 'fetchDirt', error: e.message });
        }
      }
    }
    const hoeOk = !needHoe || this.adapter.hasItem(HOE_NAMES);
    const dirtOk = !needDirt || this.adapter.hasItem('dirt');
    return hoeOk && dirtOk;
  }

  async attemptRepair() {
    if (!this.options.repairEnabled) return null;
    const candidates = this.findRepairCandidates().filter(c => (this.repairRetryAt.get(JSON.stringify(c.position)) || 0) <= Date.now()).slice(0, this.options.repairBatchSize);
    if (candidates.length === 0) return null;

    const needsFill = candidates.some(c => c.type === 'fill');
    const hasHoe = this.adapter.hasItem(HOE_NAMES);
    const hasDirt = this.adapter.hasItem('dirt');
    if (!hasHoe || (needsFill && !hasDirt)) {
      const ready = await this.fetchRepairSupplies(!hasHoe, needsFill && !hasDirt);
      if (!ready) return null; // tidak ada stok di gudang - jangan macet, lanjut ke langkah lain
    }

    let repaired = 0;
    for (const candidate of candidates) {
      const retryKey = JSON.stringify(candidate.position);
      this.repairRetryAt.set(retryKey, Date.now() + 30000);
      // Kandidat SATU-SATU dibungkus try/catch - pathfinder sungguhan (navigateNear di dalam
      // tillFarmland/placeDirtAt) MELEMPAR "No path to the goal!" kalau posisinya tidak
      // terjangkau, bukan gagal dengan tenang. Tanpa penjagaan ini SATU kandidat yang kebetulan
      // sulit dijangkau (lazim untuk lubang di pinggir lahan) menjatuhkan SELURUH tick sebelum
      // kandidat lain yang sebenarnya terjangkau sempat dicoba - ditemukan dari keluhan nyata
      // pemilik: "repair worker nya belum spawn" (repair terlihat "tidak pernah jalan" karena
      // exception ini merembet ke tick() dan tertangkap sebagai error generik, sebelum sempat
      // mencatat progres apapun).
      try {
        if (candidate.type === 'fill') {
          if (!this.adapter.hasItem('dirt')) break; // kehabisan dirt di tengah jalan
          const filled = await this.adapter.placeDirtAt(candidate.position);
          if (!filled) continue; // mis. lubang lebih dari satu blok dalam, coba lubang lain dulu
        }
        if (!this.adapter.hasItem(HOE_NAMES)) break; // kehabisan cangkul di tengah jalan
        const tilled = await this.adapter.tillFarmland(candidate.position);
        if (tilled) {
          this.repairRetryAt.delete(retryKey);
          repaired++;
          this.metrics.repaired++;
          this.emit('repaired', { position: candidate.position, type: candidate.type });
        }
      } catch (e) {
        this.emit('repairError', { step: 'repairCandidate', position: candidate.position, error: e.message });
      }
    }
    return repaired > 0 ? { action: 'repair', count: repaired } : null;
  }

  // Setor semua hasil panen yang sudah dikenal ke chest masing-masing (autoMatchStorage) - diambil
  // jadi method sendiri supaya bisa dipanggil LEBIH AWAL saat inventaris hampir penuh (lihat tick())
  // MAUPUN sebagai langkah terakhir seperti biasa, tanpa duplikasi logika.
  async runAutoMatchDeposit() {
    const outputItems = this.adapter.getInventoryItems().filter(item => this.isFarmOutput(item.name));
    const distinctNames = [...new Set(outputItems.map(item => item.name))];
    let totalDeposited = 0;
    for (const name of distinctNames) {
      let chestPos = this.depositChestCache.get(name);
      let sharedKey = this.depositChestKeyCache.get(name);
      if (!chestPos) {
        sharedKey = this.options.sharedChestAssignments?.[name];
        chestPos = sharedKey ? parseChestPositionKey(sharedKey) : await this.adapter.findMatchingChest([name]);
        if (chestPos) {
          this.depositChestCache.set(name, chestPos);
          if (sharedKey) this.depositChestKeyCache.set(name, sharedKey);
        }
      }
      if (!chestPos) continue;
      const isSeedItem = Object.values(CROP_RULES).some(rule => rule.seed === name);
      const maxPerItem = isSeedItem ? { [name]: this.options.seedReserve } : {};
      // Dibungkus try/catch PER JENIS ITEM - depositToChest sungguhan bisa MELEMPAR (mis.
      // "destination full") kalau chest tujuan jenis ini genuinely penuh. Tanpa penjagaan ini
      // SATU jenis yang kebetulan chest-nya penuh menjatuhkan SELURUH loop, membuat jenis lain
      // yang chest-nya masih longgar ikut tidak pernah disetor - ditemukan dari bug live nyata:
      // metrics.deposited tetap 0 selama bermenit-menit walau sudah panen ratusan item.
      try {
        const result = await this.adapter.depositToChest(chestPos, item => item.name === name, maxPerItem);
        totalDeposited += result.deposited || 0;
      } catch (e) {
        this.emit('depositError', { name, position: chestPos, error: e.message });
      }

      // Kalau ada chest CADANGAN terdaftar untuk chest utama ini (OVERFLOW_CHESTS - peta yang
      // SAMA dipakai StorageManagerEngine), coba setor SISANYA ke sana juga - permintaan nyata
      // pemilik: "kenapa dia tidak bisa menaruh inventory nya sampai hampir kosong". Ditemukan
      // lewat pemantauan live: chest benih genuinely sudah 54/54 slot penuh, overflow-nya sudah
      // lama terdaftar tapi FarmerEngine tidak pernah tahu soal itu - item tersangkut di tas
      // SELAMANYA walau tempat cadangan masih longgar. Selalu aman dicoba: kalau chest utama
      // sudah cukup menampung semuanya, sisa yang perlu disetor di sini otomatis 0 (tidak ada
      // efek apa-apa).
      const overflowKey = sharedKey && this.options.overflowChests[sharedKey];
      if (overflowKey) {
        const overflowPos = parseChestPositionKey(overflowKey);
        try {
          const overflowResult = await this.adapter.depositToChest(overflowPos, item => item.name === name, maxPerItem);
          totalDeposited += overflowResult.deposited || 0;
        } catch (e) {
          this.emit('depositError', { name, position: overflowPos, error: e.message });
        }
      }
    }
    this.metrics.deposited += totalDeposited;
    return totalDeposited > 0 ? { action: 'deposit', count: totalDeposited } : null;
  }

  async tick() {
    if (this.adapter.getHealth() <= this.options.retreatHealth) {
      // Mundur JUGA sambil coba makan, bukan salah satu saja - ditemukan dari bug live nyata:
      // "tetap berlubang" setelah versi pertama fix ini dipasang. Versi pertama return LANGSUNG
      // begitu retreatPosition ada, tidak pernah sampai ke langkah makan sama sekali - food tidak
      // pernah naik, health tidak pernah regenerasi alami (Minecraft butuh food tinggi untuk
      // regen), jadi bot macet SELAMANYA di status RETREAT tanpa pernah pulih untuk lanjut
      // memperbaiki lahan lagi.
      if (this.options.retreatPosition) {
        await this.adapter.navigateNear(this.options.retreatPosition, 1);
        this.metrics.retreats = (this.metrics.retreats || 0) + 1;
      }
      const foodBefore = this.adapter.getFood();
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        this.emit('ate', { foodBefore, foodAfter: this.adapter.getFood() });
        return { action: 'eat' };
      }
      return { action: 'retreat' };
    }

    if (this.adapter.getFood() <= this.options.autoEatFoodThreshold) {
      const foodBefore = this.adapter.getFood();
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        // Catat food SEBELUM dan SESUDAH - permintaan nyata pemilik: "kenapa farming workernya
        // tidak bisa menaruh barangnya di peti". Dulu aksi makan sama sekali tidak tercatat/
        // terlihat, jadi tidak mungkin membuktikan apakah bot benar-benar terjebak bolak-balik
        // makan terus-menerus (hunger tidak pernah naik cukup, sehingga tidak pernah sempat
        // panen/tanam/setor) atau cuma kebetulan makan sekali lalu lanjut kerja normal.
        this.emit('ate', { foodBefore, foodAfter: this.adapter.getFood() });
        return { action: 'eat' };
      }
    }

    // Kompos item yang benar-benar berlebihan (wheat_seeds/beetroot_seeds/potato dst) - permintaan
    // nyata pemilik: "aku baru menaruh komposer di gudang mungkin jika makanan terlalu banyak buat
    // kompser saja". SATU unit per tick (feedComposter cuma klik kanan sekali, persis composter
    // sungguhan yang naik satu level per klik) - dicek SEBELUM deposit-when-full supaya kelebihan
    // benar-benar terkuras pelan-pelan, bukan menumpuk terus di gudang yang sudah sesak.
    if (this.options.composterPositions?.length > 0) {
      const items = this.adapter.getInventoryItems();
      const excess = this.options.compostItemNames
        .map((name) => ({ name, count: items.filter((i) => i.name === name).reduce((s, i) => s + (i.count || 1), 0) }))
        .find((entry) => entry.count > this.options.compostThreshold);
      if (excess) {
        const fed = await this.adapter.feedComposter(this.options.composterPositions[0], [excess.name]);
        if (fed) {
          this.metrics.composted = (this.metrics.composted || 0) + 1;
          this.emit('composted', { item: excess.name });
          return { action: 'compost', item: excess.name };
        }
      }
    }

    // Setor DULUAN kalau inventaris sudah hampir penuh - permintaan nyata pemilik (SOP): "panen -
    // tanam sampai full lahan - ke storage room kosongkan tas". Tanpa ini, di lahan yang cukup
    // luas SELALU ada sesuatu untuk dipanen/ditanam di tick manapun, jadi giliran setor (dan
    // giliran perbaikan lahan di baris kode di bawahnya) tidak PERNAH datang sama sekali - ditemukan
    // dari bug live nyata: metrics.deposited tetap 0 walau sudah panen 60+ item dalam beberapa
    // menit berturut-turut, karena panen/tanam terus-menerus ada giliran tanpa henti. Mengabaikan
    // batas ini juga berisiko kehilangan hasil panen berikutnya (item jatuh tidak terambil kalau
    // inventaris benar-benar penuh saat menggali).
    if (this.options.autoMatchStorage) {
      const freeSlots = this.adapter.getInventoryFreeSlotCount();
      if (freeSlots < this.options.depositWhenSlotsFreeBelow) {
        const depositResult = await this.runAutoMatchDeposit();
        if (depositResult) return depositResult;
      }
    }

    const mature = this.findMatureCrops().slice(0, this.options.harvestBatchSize);
    if (mature.length > 0) {
      for (const crop of mature) {
        await this.adapter.dig(crop);
        this.metrics.harvested++;
        this.emit('harvested', { crop: crop.name, position: crop.position });
      }
      return { action: 'harvest', count: mature.length };
    }

    // Perbaiki lubang/dirt belum dicangkul SEBELUM menanam - permintaan nyata pemilik: "it full
    // of holes why not repairing". Dulu attemptRepair() cuma dipanggil kalau findPlantingSpots()
    // BENAR-BENAR kosong (nol spot sama sekali) - di lahan luas selalu ada SATU saja spot kosong
    // di tempat lain, jadi lubang di tempat lain tidak PERNAH kebagian giliran, walau bertahun-
    // tahun (kelaparan giliran, sama persis pola bug lama di StorageManagerEngine: koleksi chest
    // luar yang tidak berkesudahan membuat rapi-rapi gudang tidak pernah kebagian giliran). Aman
    // didahulukan karena lubang yang sudah diperbaiki TETAP jadi spot kosong yang bisa ditanam -
    // spot lain yang tertunda cuma mundur satu tick (2 detik), tidak pernah benar-benar hilang.
    const repairResult = await this.attemptRepair();
    if (repairResult) return repairResult;

    const spots = this.findPlantingSpots().slice(0, this.options.plantBatchSize);
    if (spots.length > 0) {
      let plantedCount = 0;
      let lastSeed = null;
      // Tanam per BARIS MEMANJANG (satu jenis benih untuk seluruh baris), bukan per spot
      // individual - permintaan nyata pemilik: "tanam dengan variasi per baris memanjang".
      // Variasi tetap ada, cuma sekarang ANTAR baris, bukan campur-campur di dalam satu baris.
      for (const row of this.groupSpotsByRow(spots)) {
        const seed = this.chooseSeedFor(row[0]);
        if (!seed) continue;
        for (const spot of row) {
          const planted = await this.adapter.placeSeed(spot, seed);
          if (planted) {
            plantedCount++;
            lastSeed = seed;
            this.metrics.planted++;
            this.emit('planted', { seed, position: spot.position });
          }
        }
      }
      if (plantedCount > 0) return { action: 'plant', seed: lastSeed, count: plantedCount };
    }

    // Gudang nyata pemilik sudah terorganisir per jenis item (mis. wheat dan carrot masing-masing
    // punya chest sendiri) - autoMatchStorage cari chest yang SUDAH berisi jenis item yang sama untuk
    // tiap jenis hasil panen di inventaris, alih-alih menumpuk semuanya ke satu chest sembarangan
    // (depositChest lama). Kalau tidak ada chest yang cocok untuk suatu item, item itu dibiarkan di
    // inventaris (bukan ditaruh di chest sembarangan) sampai chest yang cocok ditemukan.
    if (this.options.autoMatchStorage) {
      const depositResult = await this.runAutoMatchDeposit();
      return depositResult || { action: 'idle' };
    }

    if (this.options.depositChest) {
      const result = await this.adapter.depositToChest(this.options.depositChest, item => this.isFarmOutput(item.name));
      this.metrics.deposited += result.deposited || 0;
      if (result.deposited > 0) return { action: 'deposit', count: result.deposited };
    }

    return { action: 'idle' };
  }

  isFarmOutput(itemName) {
    return Object.values(CROP_RULES).some(rule => rule.harvest.includes(itemName) || rule.seed === itemName);
  }
}

module.exports = {
  FarmerEngine,
  CROP_RULES,
  blockAge,
  isInsideArea,
  isOutsideArea
};
