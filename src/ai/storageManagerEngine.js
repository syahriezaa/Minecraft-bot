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

function parseKey(key) {
  const [x, y, z] = key.split(',').map(Number);
  return { x, y, z };
}

// Chest DOUBLE (dua blok bersebelahan persis 1 blok, x ATAU z) berbagi SATU wadah fisik yang sama
// di Minecraft - findChestPositions mengembalikan KEDUA bloknya sebagai posisi terpisah. Tanpa
// normalisasi ini, membandingkan "posisi assignment" vs "posisi chest yang sedang diperiksa" akan
// keliru menganggap separuh chest yang satu sebagai "chest lain" dari separuhnya sendiri, memicu
// reorganize sia-sia (pindah barang ke wadah yang sebenarnya SAMA). Selalu menormalkan ke
// koordinat TERKECIL di antara pos itu sendiri dan tetangga sebelahnya (kalau ada) - baik pos itu
// sendiri maupun pasangannya akan menghasilkan key kanonik yang SAMA persis.
function canonicalKeyFor(pos, allPositions) {
  const set = new Set(allPositions.map(posKey));
  const candidates = [pos];
  for (const neighbor of [
    { x: pos.x - 1, y: pos.y, z: pos.z },
    { x: pos.x + 1, y: pos.y, z: pos.z },
    { x: pos.x, y: pos.y, z: pos.z - 1 },
    { x: pos.x, y: pos.y, z: pos.z + 1 }
  ]) {
    if (set.has(posKey(neighbor))) candidates.push(neighbor);
  }
  candidates.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
  return posKey(candidates[0]);
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
      inspected: 0,
      reorganized: 0
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
    // Chest yang GAGAL DIBUKA SAMA SEKALI (bukan "penuh" - genuinely tidak merespons, mis.
    // "windowOpen" timeout) - dikecualikan dari resolveChestForItem juga, sama seperti
    // fullChestPositions, supaya tiap kali mengantar barang tidak berulang kali mencoba membuka
    // chest yang sudah diketahui rusak (masing-masing percobaan menunggu ~20 detik sebelum gagal).
    this.brokenPositions = new Set();
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
  // Bungkus getChestContents supaya chest yang gagal dibuka (windowOpen timeout dsb) tidak
  // menjatuhkan seluruh tick - ditandai rusak (dilewati permanen) dan dilaporkan lewat event,
  // bukan dilempar sebagai exception yang bisa merembet sampai ke luar tick() tanpa tertangani.
  async safeGetChestContents(pos) {
    try {
      return await this.adapter.getChestContents(pos);
    } catch (e) {
      this.brokenPositions.add(posKey(pos));
      this.emit('chestError', { position: pos, error: e.message });
      return null;
    }
  }

  async resolveChestForItem(insideChests, itemName) {
    const candidates = insideChests.filter((pos) => !this.fullChestPositions.has(posKey(pos)) && !this.brokenPositions.has(posKey(pos)));

    const assignedKey = this.chestAssignments.get(itemName);
    const hasExistingAssignment = Boolean(assignedKey);
    if (assignedKey) {
      const stillValid = candidates.find((pos) => posKey(pos) === assignedKey);
      if (stillValid) return stillValid;
      // Rumah yang sudah diketahui BENAR untuk item ini kebetulan sedang penuh - lanjut cari
      // ALTERNATIF AMAN di bawah (chest lain yang sudah berisi jenis sama, atau yang benar-benar
      // kosong) SEBELUM menyerah - tapi kalau tidak ada alternatif aman, JANGAN paksa ke chest
      // sembarangan (lihat penjelasan di bawah kenapa itu berbahaya).
    }

    if (candidates.length === 0) return null;

    // Pencocokan isi ("chest lain sudah berisi jenis ini juga, pakai itu") HANYA untuk item yang
    // BELUM PERNAH punya rumah sama sekali - kalau item SUDAH punya assignment yang diketahui
    // benar, JANGAN percaya begitu saja isi chest lain sebagai bukti "tujuan yang valid": chest
    // itu bisa saja masih menyimpan stack NYASAR dari sesi lama (mis. sisa korupsi bug lama yang
    // belum sempat dirapikan reorganize) - mempercayainya di sini MENGKONFIRMASI kesalahan itu
    // dan menimpa assignment yang sudah benar, persis bug live nyata (leather_chestplate ke chest
    // buku karena chest buku itu MASIH menyimpan leather_chestplate nyasar dari korupsi lama).
    if (!hasExistingAssignment) {
      for (const pos of candidates) {
        const items = await this.safeGetChestContents(pos);
        if (!items) continue;
        if (items.some((it) => it.name === itemName)) {
          this.chestAssignments.set(itemName, posKey(pos));
          return pos;
        }
      }
    }

    const assignedElsewhere = new Set(this.chestAssignments.values());
    for (const pos of candidates) {
      if (assignedElsewhere.has(posKey(pos))) continue;
      const items = await this.safeGetChestContents(pos);
      if (!items) continue;
      if (items.length === 0) {
        this.chestAssignments.set(itemName, posKey(pos));
        return pos;
      }
    }

    if (hasExistingAssignment) {
      // Sudah punya rumah yang diketahui BENAR, tapi sekarang penuh DAN tidak ada alternatif
      // aman (tidak ada chest lain yang sudah cocok isinya atau benar-benar kosong) - JANGAN
      // paksa ke sembarang chest tak-penuh (itu penyebab bug live nyata: dirt yang sudah benar
      // ke chest dirt malah ke-timpa jadi menunjuk ke chest buku, hanya karena chest dirt-nya
      // kebetulan penuh saat itu). Menyerah untuk tick ini - assignment lama tetap dipertahankan,
      // coba lagi nanti setelah fullChestPositions di-reset (lihat akhir tick()).
      return null;
    }

    // Item BENAR-BENAR belum pernah punya rumah sama sekali (bukan kasus "rumahnya lagi penuh")
    // - pakai chest tak-penuh pertama sebagai jalan terakhir supaya barang tidak menumpuk
    // selamanya di inventaris tanpa tujuan sama sekali.
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
      // Chest yang GAGAL DIBUKA SAMA SEKALI (mis. "windowOpen" tidak pernah merespons - beda dari
      // "penuh", ini genuinely tidak bisa diakses) tetap harus ditandai "sudah dicoba" SEBELUM
      // melempar error lagi ke atas - kalau tidak, tick berikutnya memilih posisi yang PERSIS SAMA
      // lagi (karena belum pernah masuk collectedPositions), macet mengulang chest yang sama
      // selamanya - bug live nyata: StorageWorker diam di tempat 5+ menit gara-gara ini.
      this.collectedPositions.add(posKey(nextToCollect));
      try {
        await this.adapter.navigateNear(nextToCollect, 3);
        const result = await this.adapter.withdrawAllFromChest(nextToCollect);
        this.metrics.collected += 1;
        this.metrics.itemsCollected += result.totalCount;
        this.emit('collected', { position: nextToCollect, count: result.totalCount });
        return { action: 'collect', position: nextToCollect, count: result.totalCount };
      } catch (e) {
        this.emit('chestError', { position: nextToCollect, error: e.message });
        return { action: 'error', position: nextToCollect, error: e.message };
      }
    }

    const insideChests = this.getInsideChestPositions();
    const nextToInspect = insideChests.find((pos) => !this.inspectedPositions.has(posKey(pos)));
    if (nextToInspect) {
      let items;
      try {
        items = await this.adapter.getChestContents(nextToInspect);
      } catch (e) {
        // Sama seperti chest luar - tandai "sudah dicoba" dulu supaya tidak mengulang posisi
        // yang persis sama selamanya kalau chest ini genuinely tidak bisa dibuka.
        this.inspectedPositions.add(posKey(nextToInspect));
        this.emit('chestError', { position: nextToInspect, error: e.message });
        return { action: 'error', position: nextToInspect, error: e.message };
      }

      // Item SALAH TEMPAT: assignment yang sudah diketahui menunjuk ke chest LAIN (dinormalkan
      // lewat canonicalKeyFor supaya separuh double-chest yang sama tidak dianggap "lain"). Cuma
      // barang yang MEMANG punya assignment jelas yang dipindah - kalau belum ada info rumah yang
      // benar, jangan tebak (itu justru penyebab bug sortir tercampur sebelumnya).
      const hereKey = canonicalKeyFor(nextToInspect, insideChests);
      const misplacedItems = items.filter((it) => {
        const assignedKey = this.chestAssignments.get(it.name);
        if (!assignedKey) return false;
        return canonicalKeyFor(parseKey(assignedKey), insideChests) !== hereKey;
      });

      if (misplacedItems.length > 0) {
        // Ambil SEMUA item salah tempat di chest ini dalam SATU kunjungan (bukan satu per
        // kunjungan) - ditemukan dari keluhan nyata pemilik ("banyak yang tidak sesuai"): dengan
        // satu item per kunjungan, membersihkan chest berisi puluhan barang salah tempat butuh
        // puluhan tick bolak-balik (kalah prioritas sama deliver/collect tiap kali), progresnya
        // jadi sangat lambat. Bot sudah berdiri di sini - sekalian ambil semuanya.
        await this.adapter.navigateNear(westOf(nextToInspect), 1);
        const relocated = [];
        for (const item of misplacedItems) {
          const result = await this.adapter.withdrawFromChest(nextToInspect, [item.name], item.count);
          if (result.withdrawn <= 0) continue;
          this.metrics.reorganized += result.withdrawn;
          relocated.push({ name: item.name, count: result.withdrawn });
          this.emit('misplaced', {
            position: nextToInspect,
            item: item.name,
            count: result.withdrawn,
            correctPosition: parseKey(this.chestAssignments.get(item.name))
          });
        }
        // JANGAN tandai chest ini "sudah diperiksa" - periksa ulang tick berikutnya untuk
        // memastikan benar-benar bersih (mis. kalau ada stack lain dari jenis yang sama).
        return { action: 'reorganize', position: nextToInspect, items: relocated, count: relocated.reduce((s, i) => s + i.count, 0) };
      }

      await this.adapter.navigateNear(westOf(nextToInspect), 1);
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
