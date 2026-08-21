/**
 * @file farmerEngine.js
 * @description Engine pertanian untuk panen, tanam ulang, dan deposit hasil.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter, distance } = require('./mineflayerRoleAdapter');
const { parseChestPositionKey } = require('./storageMemory');

const CROP_RULES = Object.freeze({
  wheat: { maxAge: 7, seed: 'wheat_seeds', harvest: ['wheat'] },
  carrots: { maxAge: 7, seed: 'carrot', harvest: ['carrot'] },
  potatoes: { maxAge: 7, seed: 'potato', harvest: ['potato'] },
  beetroots: { maxAge: 3, seed: 'beetroot_seeds', harvest: ['beetroot'] },
  nether_wart: { maxAge: 3, seed: 'nether_wart', harvest: ['nether_wart'] }
});

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
      ...options
    };
    this.metrics = {
      harvested: 0,
      planted: 0,
      deposited: 0,
      eaten: 0
    };
    // Ingat chest yang sudah ditemukan cocok untuk tiap jenis item, supaya tiap tick berikutnya
    // tidak perlu membuka ulang semua chest di gudang - gudang nyata pemilik bisa berisi puluhan
    // chest (lihat komentar autoMatchStorage), membukanya satu-satu tiap tick jelas mahal.
    this.depositChestCache = new Map();
    this.plantRotationIndex = 0;
  }

  isMatureCrop(block) {
    const rule = CROP_RULES[block?.name];
    return Boolean(rule && blockAge(block) >= rule.maxAge);
  }

  findMatureCrops() {
    return this.adapter
      .findBlocksByNames(Object.keys(CROP_RULES), { maxDistance: this.options.scanRadius })
      .filter(block => this.isMatureCrop(block))
      .filter(block => isInsideArea(block.position, this.options.farmArea))
      .filter(block => isOutsideArea(block.position, this.options.avoidArea))
      .sort((a, b) => distance(this.adapter.getPosition(), a.position) - distance(this.adapter.getPosition(), b.position));
  }

  findPlantingSpots() {
    const farmland = this.adapter
      .findBlocksByNames(['farmland', 'soul_sand'], { maxDistance: this.options.scanRadius })
      .filter(block => isInsideArea(block.position, this.options.farmArea))
      .filter(block => isOutsideArea(block.position, this.options.avoidArea));

    return farmland.filter(block => {
      const above = this.adapter.blockAt({
        x: block.position.x,
        y: block.position.y + 1,
        z: block.position.z
      });
      return !above || above.name === 'air';
    });
  }

  chooseSeedFor(referenceBlock) {
    if (referenceBlock?.name === 'soul_sand' && this.adapter.hasItem('nether_wart')) return 'nether_wart';
    // Bergantian di antara jenis benih yang SUNGGUH tersedia di inventaris - bukan selalu benih
    // pertama di CROP_RULES (wheat_seeds) - ditemukan dari permintaan nyata pemilik: kebun jadi
    // seragam wheat semua walau punya benih carrot/potato juga, karena benih pertama yang cocok
    // selalu dipakai duluan dan wheat_seeds biasanya paling melimpah.
    const available = Object.values(CROP_RULES).map(rule => rule.seed).filter(seed => this.adapter.hasItem(seed));
    if (available.length === 0) return null;
    const seed = available[this.plantRotationIndex % available.length];
    this.plantRotationIndex++;
    return seed;
  }

  async tick() {
    if (this.adapter.getFood() <= this.options.autoEatFoodThreshold) {
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        return { action: 'eat' };
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

    const spots = this.findPlantingSpots().slice(0, this.options.plantBatchSize);
    if (spots.length > 0) {
      let plantedCount = 0;
      let lastSeed = null;
      for (const spot of spots) {
        const seed = this.chooseSeedFor(spot);
        if (!seed) break; // kehabisan semua jenis benih - tidak ada lagi yang bisa ditanam
        const planted = await this.adapter.placeSeed(spot, seed);
        if (planted) {
          plantedCount++;
          lastSeed = seed;
          this.metrics.planted++;
          this.emit('planted', { seed, position: spot.position });
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
      const outputItems = this.adapter.getInventoryItems().filter(item => this.isFarmOutput(item.name));
      const distinctNames = [...new Set(outputItems.map(item => item.name))];
      let totalDeposited = 0;
      for (const name of distinctNames) {
        let chestPos = this.depositChestCache.get(name);
        if (!chestPos) {
          const sharedKey = this.options.sharedChestAssignments?.[name];
          chestPos = sharedKey ? parseChestPositionKey(sharedKey) : await this.adapter.findMatchingChest([name]);
          if (chestPos) this.depositChestCache.set(name, chestPos);
        }
        if (!chestPos) continue;
        const isSeedItem = Object.values(CROP_RULES).some(rule => rule.seed === name);
        const maxPerItem = isSeedItem ? { [name]: this.options.seedReserve } : {};
        const result = await this.adapter.depositToChest(chestPos, item => item.name === name, maxPerItem);
        totalDeposited += result.deposited || 0;
      }
      this.metrics.deposited += totalDeposited;
      if (totalDeposited > 0) return { action: 'deposit', count: totalDeposited };
      return { action: 'idle' };
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
