/**
 * @file storageManagerEngine.js
 * @description Engine "kuartermaster" gudang: kumpulkan isi semua chest DI LUAR rumah lalu bawa
 * masuk ke chest gudang DI DALAM rumah (houseBounds), dan rapikan gudang dengan membuka tiap
 * chest di dalam rumah untuk memeriksa isinya. Permintaan nyata pemilik: "give me one worker for
 * managing storage so it collect all the chest outside the hose and bring it to the house storage
 * room and tidy up storage room by opening all the chest and check the item".
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { isInsideArea, isOutsideArea } = require('./farmerEngine');

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

class StorageManagerEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      scanRadius: 48,
      houseBounds: null,
      ...options
    };
    this.metrics = {
      collected: 0,
      itemsCollected: 0,
      delivered: 0,
      inspected: 0
    };
    // Posisi chest yang sudah DIKUNJUNGI sesi ini - dilacak supaya tidak mengambil/memeriksa chest
    // yang sama berulang-ulang tiap tick (mis. chest kosong tetap ditandai "sudah dikunjungi").
    this.collectedPositions = new Set();
    this.inspectedPositions = new Set();
    // Chest gudang yang diketahui PENUH (deposit ke sana gagal/ditolak) - dikecualikan dari
    // findDeliveryChest supaya tidak terus mengulang chest yang sama sampai bekukan progres
    // pengantaran - ditemukan dari bug live nyata: StorageWorker terjebak "destination full"
    // berulang-ulang tanpa kemajuan karena selalu memilih chest penuh yang sama persis.
    this.fullChestPositions = new Set();
  }

  getOutsideChestPositions() {
    return this.adapter.findChestPositions(this.options.scanRadius)
      .filter((pos) => isOutsideArea(pos, this.options.houseBounds));
  }

  getInsideChestPositions() {
    return this.adapter.findChestPositions(this.options.scanRadius)
      .filter((pos) => isInsideArea(pos, this.options.houseBounds));
  }

  // Cari chest gudang DI DALAM rumah yang isinya sudah cocok dengan nama item terbawa - supaya
  // barang masuk ke chest yang memang sudah terorganisir per jenis, bukan ditumpuk sembarangan.
  // Kalau tidak ada yang cocok, pakai chest dalam rumah PERTAMA sebagai tujuan cadangan.
  async findDeliveryChest(insideChests, carriedItemName) {
    const candidates = insideChests.filter((pos) => !this.fullChestPositions.has(posKey(pos)));
    for (const pos of candidates) {
      const items = await this.adapter.getChestContents(pos);
      if (items.some((it) => it.name === carriedItemName)) return pos;
    }
    return candidates[0];
  }

  async tick() {
    const carried = this.adapter.getInventoryItems();
    if (carried.length > 0) {
      const insideChests = this.getInsideChestPositions();
      if (insideChests.length === 0) return { action: 'idle', reason: 'no_house_chest' };
      const target = await this.findDeliveryChest(insideChests, carried[0].name);
      if (!target) {
        // Semua chest gudang diketahui penuh - reset catatan supaya dicoba lagi nanti (barangkali
        // sudah dikosongkan manual sejak dicatat) daripada macet permanen tanpa target sama sekali.
        this.fullChestPositions.clear();
        return { action: 'idle', reason: 'all_house_chests_full' };
      }
      await this.adapter.navigateNear(target, 3);
      try {
        const result = await this.adapter.depositToChest(target, () => true);
        this.metrics.delivered += result.deposited;
        this.emit('delivered', { position: target, count: result.deposited });
        return { action: 'deliver', position: target, count: result.deposited };
      } catch (e) {
        // Chest penuh (atau gagal lain) - ingat chest ini supaya tick BERIKUTNYA memilih chest
        // gudang LAIN, bukan mengulang chest yang sama tanpa kemajuan selamanya.
        this.fullChestPositions.add(posKey(target));
        this.emit('deliverFailed', { position: target, error: e.message });
        return { action: 'deliver_failed', position: target, error: e.message };
      }
    }

    const outsideChests = this.getOutsideChestPositions();
    const nextToCollect = outsideChests.find((pos) => !this.collectedPositions.has(posKey(pos)));
    if (nextToCollect) {
      await this.adapter.navigateNear(nextToCollect, 3);
      const result = await this.adapter.withdrawAllFromChest(nextToCollect);
      this.collectedPositions.add(posKey(nextToCollect));
      this.metrics.collected += 1;
      this.metrics.itemsCollected += result.totalCount;
      this.emit('collected', { position: nextToCollect, count: result.totalCount });
      return { action: 'collect', position: nextToCollect, count: result.totalCount };
    }

    const insideChests = this.getInsideChestPositions();
    const nextToInspect = insideChests.find((pos) => !this.inspectedPositions.has(posKey(pos)));
    if (nextToInspect) {
      await this.adapter.navigateNear(nextToInspect, 3);
      const items = await this.adapter.getChestContents(nextToInspect);
      this.inspectedPositions.add(posKey(nextToInspect));
      this.metrics.inspected += 1;
      this.emit('inspected', { position: nextToInspect, items });
      return { action: 'inspect', position: nextToInspect, items };
    }

    // Semua chest luar sudah dikumpulkan dan semua chest dalam sudah diperiksa - reset supaya
    // putaran berikutnya mengulang (chest baru bisa saja terisi lagi seiring waktu berjalan).
    if (this.collectedPositions.size > 0 || this.inspectedPositions.size > 0) {
      this.collectedPositions.clear();
      this.inspectedPositions.clear();
    }
    return { action: 'idle' };
  }
}

module.exports = { StorageManagerEngine };
