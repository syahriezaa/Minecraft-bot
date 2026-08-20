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

// Titik dekat SISI BARAT sebuah chest (x lebih kecil) - pemilik mengonfirmasi live: akses ruang
// penyimpanan lega dari sisi barat, jadi navigasi ke chest gudang SENGAJA diarahkan ke sana dulu
// (bukan biarkan pathfinder pilih sisi sembarangan yang kebetulan terdekat).
function westOf(pos, distance = 2) {
  return { x: pos.x - distance, y: pos.y, z: pos.z };
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
    // resolveChestForItem supaya tidak terus mengulang chest yang sama sampai bekukan progres
    // pengantaran - ditemukan dari bug live nyata: StorageWorker terjebak "destination full"
    // berulang-ulang tanpa kemajuan karena selalu memilih chest penuh yang sama persis.
    this.fullChestPositions = new Set();
    // Memori "jenis item ini pergi ke chest itu" (posKey string) - dipertahankan SELAMA proses ini
    // berjalan, dan bisa dimuat ulang lewat initialAssignments (disimpan/dipulihkan pemanggil lewat
    // getChestAssignments()) supaya sortir tetap KONSISTEN lintas restart worker, bukan pilih
    // sembarangan tiap kali chest kebetulan sedang kosong saat dicek isinya - ditemukan dari
    // keluhan nyata pemilik: kuartermaster "does not have any memory about storage chest" dan
    // "did not short the item well" (barang tercampur karena semua jenis ditumpuk ke satu chest).
    this.chestAssignments = new Map(Object.entries(options.initialAssignments || {}));
  }

  getChestAssignments() {
    return Object.fromEntries(this.chestAssignments);
  }

  // Tentukan chest gudang untuk SATU jenis item: (1) ikuti assignment yang sudah diingat kalau
  // masih valid (chest itu masih ada & tidak penuh), (2) kalau belum ada assignment, cari chest
  // yang SUDAH berisi jenis ini, (3) kalau tidak ada yang cocok, pakai chest KOSONG pertama yang
  // belum ditugaskan ke jenis lain (supaya tidak tercampur), (4) kalau tidak ada yang kosong,
  // pakai chest tak-penuh pertama sebagai jalan terakhir. Assignment yang terpakai/ditemukan
  // disimpan supaya panggilan berikutnya untuk jenis yang sama konsisten ke chest yang sama.
  async resolveChestForItem(insideChests, itemName) {
    const candidates = insideChests.filter((pos) => !this.fullChestPositions.has(posKey(pos)));
    if (candidates.length === 0) return null;

    const assignedKey = this.chestAssignments.get(itemName);
    if (assignedKey) {
      const stillValid = candidates.find((pos) => posKey(pos) === assignedKey);
      if (stillValid) return stillValid;
    }

    for (const pos of candidates) {
      const items = await this.adapter.getChestContents(pos);
      if (items.some((it) => it.name === itemName)) {
        this.chestAssignments.set(itemName, posKey(pos));
        return pos;
      }
    }

    const assignedElsewhere = new Set(this.chestAssignments.values());
    for (const pos of candidates) {
      if (assignedElsewhere.has(posKey(pos))) continue;
      const items = await this.adapter.getChestContents(pos);
      if (items.length === 0) {
        this.chestAssignments.set(itemName, posKey(pos));
        return pos;
      }
    }

    this.chestAssignments.set(itemName, posKey(candidates[0]));
    return candidates[0];
  }

  getOutsideChestPositions() {
    return this.adapter.findChestPositions(this.options.scanRadius)
      .filter((pos) => isOutsideArea(pos, this.options.houseBounds));
  }

  getInsideChestPositions() {
    return this.adapter.findChestPositions(this.options.scanRadius)
      .filter((pos) => isInsideArea(pos, this.options.houseBounds));
  }

  async tick() {
    const carried = this.adapter.getInventoryItems();
    if (carried.length > 0) {
      const insideChests = this.getInsideChestPositions();
      if (insideChests.length === 0) return { action: 'idle', reason: 'no_house_chest' };

      // Antar TIAP JENIS item ke chest MASING-MASING yang cocok - bukan tumpuk semua jenis ke satu
      // chest berdasarkan jenis item pertama saja (bug nyata yang dilaporkan pemilik: barang
      // tercampur, "did not short the item well").
      const distinctNames = [...new Set(carried.map((item) => item.name))];
      const deliveries = [];
      let totalDelivered = 0;
      let attemptedAny = false;
      for (const name of distinctNames) {
        const target = await this.resolveChestForItem(insideChests, name);
        if (!target) continue;
        attemptedAny = true;
        await this.adapter.navigateNear(westOf(target), 1);
        try {
          const result = await this.adapter.depositToChest(target, (item) => item.name === name);
          totalDelivered += result.deposited;
          deliveries.push({ position: target, name, count: result.deposited });
          this.emit('delivered', { position: target, count: result.deposited, name });
        } catch (e) {
          // Chest penuh (atau gagal lain) - ingat chest ini supaya tick BERIKUTNYA memilih chest
          // gudang LAIN untuk jenis ini, bukan mengulang chest yang sama tanpa kemajuan selamanya.
          this.fullChestPositions.add(posKey(target));
          this.emit('deliverFailed', { position: target, error: e.message, name });
        }
      }

      if (deliveries.length === 0) {
        if (!attemptedAny) {
          // Semua chest gudang diketahui penuh - reset catatan supaya dicoba lagi nanti
          // (barangkali sudah dikosongkan manual sejak dicatat) daripada macet permanen.
          this.fullChestPositions.clear();
          return { action: 'idle', reason: 'all_house_chests_full' };
        }
        return { action: 'deliver_failed', reason: 'no_delivery_succeeded' };
      }
      this.metrics.delivered += totalDelivered;
      return { action: 'deliver', count: totalDelivered, deliveries };
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
      await this.adapter.navigateNear(westOf(nextToInspect), 1);
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
