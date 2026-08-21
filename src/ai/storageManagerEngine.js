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
//
// BARREL SELALU wadah tunggal (tidak pernah gabung fisik dengan blok lain di Minecraft, beda dari
// chest) - tapi barel di gudang ini justru diletakkan PERSIS di antara dua kolom chest (permintaan
// nyata pemilik: "the barel is in betwen cess"), artinya jarak 1 blok dari barel ke CHEST tetangga
// SAMA PERSIS dengan jarak antar dua separuh chest yang sungguh berpasangan.
//
// PENTING (ditemukan lewat analisis mendalam pola dunia sungguhan, setelah beberapa kali salah
// diagnosis di sesi ini): dua blok chest yang bersebelahan TIDAK OTOMATIS berarti satu wadah
// fisik yang sama! Contoh nyata gudang ini: chest di x=-181 SEMUA berblockstate type="right",
// berpasangan sungguhan dengan chest type="left" di x=-180 pada z YANG SAMA (sumbu X) - TAPI
// chest di x=-181 pada z yang bersebelahan (mis. z=-353 dan z=-352) SAMA-SAMA "right" dan
// TIDAK PERNAH benar-benar terhubung, walau sama-sama chest dan tepat bersebelahan. Di Minecraft,
// double chest SUNGGUHAN selalu satu "left" + satu "right" - dua "right" (atau dua "left") yang
// bersebelahan cuma kebetulan berdampingan, bukan wadah yang sama. getChestTypeFn (bergantung ke
// MineflayerRoleAdapter.getChestHalfType) memastikan penggabungan HANYA terjadi kalau blockstate
// KEDUA blok memang pasangan left+right yang valid - chest "single" (tanpa pasangan) atau barel
// (getChestTypeFn mengembalikan null) tidak pernah bergabung dengan apapun.
function canonicalKeyFor(pos, allPositions, getChestTypeFn) {
  const set = new Set(allPositions.map(posKey));
  const candidates = [pos];
  const hereType = getChestTypeFn(pos);
  const isValidPair = (a, b) => (a === 'left' && b === 'right') || (a === 'right' && b === 'left');
  if (hereType && hereType !== 'single') {
    for (const neighbor of [
      { x: pos.x - 1, y: pos.y, z: pos.z },
      { x: pos.x + 1, y: pos.y, z: pos.z },
      { x: pos.x, y: pos.y, z: pos.z - 1 },
      { x: pos.x, y: pos.y, z: pos.z + 1 }
    ]) {
      if (set.has(posKey(neighbor)) && isValidPair(hereType, getChestTypeFn(neighbor))) candidates.push(neighbor);
    }
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
    // posKey -> jumlah item salah tempat yang TERAKHIR DIKETAHUI di chest itu, dari chestSnapshot
    // manapun (inspect resmi ATAUPUN intipan resolveChestForItem) - permintaan nyata pemilik:
    // "jika state item sudah di ketahui salah selesaikan semua kesalahannya dulu baru re
    // inspeksi...gunakan memory untuk melakukan perencanaan se akurat mungkin". Dipakai untuk
    // memprioritaskan chest yang SUDAH DIKETAHUI berantakan (diurutkan dari yang paling banyak
    // salah) di atas urutan alami nearest-neighbor - lihat pemilihan nextToInspect di tick().
    this.knownMisplacedCounts = new Map();
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
    // Chest yang BARU SAJA dikosongkan oleh reorganize (isinya diambil karena salah tempat) -
    // dikecualikan dari fallback "chest kosong sembarangan" di resolveChestForItem, supaya item
    // yang baru diambil tidak langsung ditaruh balik ke chest yang SAMA (bug bolak-balik tanpa
    // henti - lihat resolveChestForItem untuk detail).
    this.recentlyVacatedPositions = new Set();
    // Memori "jenis item ini pergi ke chest itu" (posKey string) - dipertahankan SELAMA proses ini
    // berjalan, dan bisa dimuat ulang lewat initialAssignments (disimpan/dipulihkan pemanggil lewat
    // getChestAssignments()) supaya sortir tetap KONSISTEN lintas restart worker, bukan pilih
    // sembarangan tiap kali chest kebetulan sedang kosong saat dicek isinya - ditemukan dari
    // keluhan nyata pemilik: kuartermaster "does not have any memory about storage chest" dan
    // "did not short the item well" (barang tercampur karena semua jenis ditumpuk ke satu chest).
    this.chestAssignments = new Map(Object.entries(options.initialAssignments || {}));
    // Mode eksplisit "collect" (ambil semua yang belum pada tempatnya - dari luar rumah maupun
    // yang salah tempat di dalam) vs "deposit" (taruh semua yang di tangan ke tempatnya) -
    // permintaan nyata pemilik: algoritma konsisten, bukan bolak-balik ambil-satu-taruh-satu tiap
    // tick. Tetap di mode collect sampai tas mencapai maxCarrySlots ATAU tidak ada lagi yang bisa
    // diambil; tetap di mode deposit sampai tas BENAR-BENAR kosong.
    //
    // Kalau tas SUDAH membawa sesuatu sejak awal (mis. worker baru restart dan masih memegang
    // barang dari sesi sebelumnya), mulai LANGSUNG di mode deposit - selesaikan dulu yang sudah
    // dipegang sebelum keluar mengumpulkan lagi, bukan malah dibiarkan menganggur di tangan
    // sampai kebetulan tas penuh/putaran collect habis.
    this.mode = this.adapter.getInventoryItems().length > 0 ? 'deposit' : 'collect';
    if (this.options.maxCarrySlots === undefined) this.options.maxCarrySlots = 30;
    // Permintaan nyata pemilik: sisakan 2 slot inventaris selama mode collect, khusus supaya
    // verifyChestContentsByRoundTrip (adapter, saat memeriksa isi chest) selalu punya ruang aman
    // untuk probe ambil-taruh-kembali-nya, tidak pernah terhalang inventaris penuh.
    if (this.options.chestVerifyReserveSlots === undefined) this.options.chestVerifyReserveSlots = 2;
  }

  // Berapa slot inventaris yang masih kosong sekarang - Infinity kalau adapter tidak menyediakan
  // info ini (mis. adapter uji yang belum diperbarui), supaya tidak tiba-tiba memblokir collect.
  getFreeInventorySlotCount() {
    return typeof this.adapter.getInventoryFreeSlotCount === 'function'
      ? this.adapter.getInventoryFreeSlotCount()
      : Infinity;
  }

  getChestAssignments() {
    return Object.fromEntries(this.chestAssignments);
  }

  // true HANYA untuk blok "chest" - dipakai di tempat yang cuma butuh tahu "ini chest atau
  // bukan" (bukan penggabungan double-chest, lihat getChestHalfType untuk itu).
  isChestBlock(pos) {
    return this.adapter.blockAt(pos)?.name === 'chest';
  }

  // "left"/"right"/"single" dari blockstate chest sungguhan, null kalau bukan chest sama sekali -
  // dipakai canonicalKeyFor untuk penggabungan double-chest yang BENAR (lihat komentar
  // canonicalKeyFor untuk kenapa sekadar "bersebelahan" tidak cukup).
  getChestHalfType(pos) {
    return typeof this.adapter.getChestHalfType === 'function' ? this.adapter.getChestHalfType(pos) : null;
  }

  // Dipanggil SETELAH collect/reorganize berhasil mengambil sesuatu - kalau tas sekarang sudah
  // mencapai maxCarrySlots, langsung beralih ke mode deposit untuk tick BERIKUTNYA (permintaan
  // nyata pemilik: berhenti mengumpulkan begitu tas penuh, jangan terus ambil sampai benar-benar
  // meluap).
  switchToDepositIfCarryFull() {
    if (this.mode !== 'collect') return;
    const carriedNow = this.adapter.getInventoryItems();
    const carryFull = carriedNow.length >= this.options.maxCarrySlots;
    const outOfReserve = this.getFreeInventorySlotCount() < this.options.chestVerifyReserveSlots;
    if (carryFull || outOfReserve) {
      this.mode = 'deposit';
    }
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
  // Dipakai HANYA untuk "mengintip" (cari chest yang sudah cocok/kosong) - selalu verify:false
  // supaya intipan cepat, bukan audit penuh (lihat komentar getChestContents di adapter untuk
  // kenapa: probe ambil-taruh di SETIAP chest yang diintip bikin resolveChestForItem lambat
  // sekali - ditemukan dari keluhan nyata pemilik: "worker nya membuka chest itu tapi sepertinya
  // tidak melihat isinya").
  async safeGetChestContents(pos, insideChests) {
    try {
      return await this.adapter.getChestContents(pos, {
        verify: false,
        // Permintaan nyata pemilik: "bot wajib mengambil data peti ketika membuka peti dan
        // mengupdate ke memory setiap kali membuka peti" - dulu intipan resolveChestForItem
        // (dipakai buat cari chest kosong/cocok) diam-diam TIDAK PERNAH memperbarui peta gudang
        // di dashboard walau chest-nya benar-benar dibuka dan dibaca - sekarang SETIAP chest yang
        // dibuka (baik lewat inspect resmi maupun intipan ini) ikut memperbarui memori/dashboard.
        onRead: (items) => this.emitChestSnapshot(pos, items, insideChests)
      });
    } catch (e) {
      this.brokenPositions.add(posKey(pos));
      this.emit('chestError', { position: pos, error: e.message });
      return null;
    }
  }

  // "left"/"right"/"single" -> hasUsableHome/hereKey -> daftar item salah tempat, dipakai BAIK
  // oleh inspect() resmi MAUPUN oleh intipan resolveChestForItem - satu logika yang sama supaya
  // hasil "salah tempat atau tidak" konsisten di mana pun chest ini dibaca.
  computeMisplacedItems(pos, items, insideChests) {
    const getType = (p) => this.getChestHalfType(p);
    const hereKey = canonicalKeyFor(pos, insideChests, getType);
    const hasUsableHome = (assignedKey) => {
      if (!this.fullChestPositions.has(assignedKey) && !this.brokenPositions.has(assignedKey)) return true;
      const overflowKey = this.options.overflowChests?.[assignedKey];
      return Boolean(overflowKey) && !this.fullChestPositions.has(overflowKey) && !this.brokenPositions.has(overflowKey);
    };
    return items.filter((it) => {
      const assignedKey = this.chestAssignments.get(it.name);
      if (!assignedKey) return false;
      if (!hasUsableHome(assignedKey)) return false;
      return canonicalKeyFor(parseKey(assignedKey), insideChests, getType) !== hereKey;
    });
  }

  // Emit SELURUH isi chest ini plus rencana pemindahan (item salah tempat -> tujuannya) - dipakai
  // panel peta gudang di dashboard (permintaan nyata pemilik: "tampilkan isi semua peti...dan
  // bagaimana bot akan memindahkannya di tandai dengan panah panah", dan "bot wajib mengambil
  // data peti ketika membuka peti dan mengupdate ke memory setiap kali membuka peti"). Dipanggil
  // lewat onRead SEBELUM chest ditutup (permintaan nyata pemilik: "log harus nya open -> get data
  // -> save to memory -> close").
  emitChestSnapshot(pos, items, insideChests) {
    const misplacedItems = this.computeMisplacedItems(pos, items, insideChests);
    // Ingat berapa banyak item salah tempat yang TERAKHIR diketahui di chest ini - dipakai
    // nextToInspect di tick() untuk memprioritaskan chest yang sudah diketahui berantakan.
    // Hapus dari peta kalau sekarang bersih (0) supaya tidak terus dianggap prioritas selamanya.
    const key = posKey(pos);
    if (misplacedItems.length > 0) {
      this.knownMisplacedCounts.set(key, misplacedItems.reduce((s, it) => s + it.count, 0));
    } else {
      this.knownMisplacedCounts.delete(key);
    }
    this.emit('chestSnapshot', {
      position: pos,
      // Salin (bukan referensi langsung) - kode lain bisa memutasi objek item yang sama sesudah
      // snapshot ini di-emit - snapshot yang sudah dikirim ke UI tidak boleh ikut berubah.
      items: items.map((it) => ({ ...it })),
      misplaced: misplacedItems.map((it) => ({
        name: it.name,
        count: it.count,
        targetPosition: parseKey(this.chestAssignments.get(it.name))
      }))
    });
  }

  async resolveChestForItem(insideChests, itemName) {
    const candidates = insideChests.filter((pos) => !this.fullChestPositions.has(posKey(pos)) && !this.brokenPositions.has(posKey(pos)));

    const assignedKey = this.chestAssignments.get(itemName);
    const hasExistingAssignment = Boolean(assignedKey);
    if (assignedKey) {
      const stillValid = candidates.find((pos) => posKey(pos) === assignedKey);
      if (stillValid) return stillValid;
      // Rumah utama kebetulan sedang penuh - kalau chest utama ini SUDAH punya overflow yang
      // secara eksplisit didaftarkan untuknya (options.overflowChests), pakai ITU DULU sebelum
      // tebak-tebakan generik di bawah - permintaan nyata pemilik: "make the overflow chest is
      // for emergency only when the actual cest is full". Overflow eksplisit BOLEH dipakai
      // BERSAMA oleh banyak jenis item berbeda yang berbagi chest utama yang sama (beda dari
      // fallback "chest kosong" generik di bawah, yang cuma muat SATU jenis sampai chest itu
      // terisi) - assignment PERMANEN item tetap ke chest utama, TIDAK pernah ditimpa jadi
      // overflow (lihat return langsung tanpa chestAssignments.set di bawah).
      const overflowKey = this.options.overflowChests?.[assignedKey];
      if (overflowKey && !this.fullChestPositions.has(overflowKey) && !this.brokenPositions.has(overflowKey)) {
        const overflowPos = candidates.find((pos) => posKey(pos) === overflowKey);
        if (overflowPos) return overflowPos;
      }
      // Tidak ada overflow eksplisit (atau overflow-nya sendiri juga penuh/rusak) - lanjut cari
      // ALTERNATIF AMAN generik di bawah (chest lain yang sudah berisi jenis sama, atau yang
      // benar-benar kosong) SEBELUM menyerah - tapi kalau tidak ada alternatif aman, JANGAN paksa
      // ke chest sembarangan (lihat penjelasan di bawah kenapa itu berbahaya).
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
        const items = await this.safeGetChestContents(pos, insideChests);
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
      // JANGAN pakai chest yang BARU SAJA dikosongkan oleh reorganize sebagai tujuan sementara -
      // ditemukan dari bug live nyata (dua kali - dulu rotten_flesh, sekarang redstone): chest
      // "kosong" yang kebetulan cocok itu SERING KALI adalah chest yang barusan diambil isinya
      // OLEH REORGANIZE PADA SIKLUS INI JUGA (source-nya sendiri) - begitu diisi lagi di sini,
      // jadi "salah tempat" lagi tick berikutnya, reorganize ambil lagi, delivery jatuh ke
      // fallback yang SAMA lagi, taruh balik lagi... bolak-balik tanpa akhir.
      if (this.recentlyVacatedPositions.has(posKey(pos))) continue;
      const items = await this.safeGetChestContents(pos, insideChests);
      if (!items) continue;
      if (items.length === 0) {
        // Chest kosong ini SEMENTARA saja (rumah asli sedang penuh) - kalau item ini SUDAH
        // punya rumah permanen yang diketahui benar, JANGAN timpa memori sortirnya dengan chest
        // kosong ini, itu akan MEMUTUSKAN item dari rumah aslinya - ditemukan dari bug live
        // nyata: rotten_flesh bolak-balik TANPA HENTI karena assignment permanennya berulang
        // kali ke-timpa jadi chest sementara ini, lalu ke-timpa balik ke rumah asli oleh
        // canonical override saat restart, lalu ke-timpa lagi... Cuma simpan permanen kalau
        // item ini MEMANG belum pernah punya rumah sama sekali.
        if (!hasExistingAssignment) this.chestAssignments.set(itemName, posKey(pos));
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

  // Antar TIAP JENIS item di tangan ke chest MASING-MASING yang cocok - bukan tumpuk semua jenis
  // ke satu chest berdasarkan jenis item pertama saja (bug nyata yang dilaporkan pemilik: barang
  // tercampur, "did not short the item well"). Dipakai MODE DEPOSIT.
  async runDeliverPhase(carried) {
    const insideChests = this.getInsideChestPositions();
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

    if (deliveries.length > 0) {
      this.metrics.delivered += totalDelivered;
      return { action: 'deliver', count: totalDelivered, deliveries };
    }
    if (attemptedAny) {
      return { action: 'deliver_failed', reason: 'no_delivery_succeeded' };
    }
    // TIDAK ADA satupun item yang punya target sama sekali tick ini (semua rumahnya penuh, tanpa
    // alternatif aman) - caller (tick()) memutuskan langkah berikutnya (biasanya jatuh ke
    // collect/inspect supaya bot tetap produktif, TANPA keluar dari mode deposit).
    return { action: 'idle', reason: 'no_delivery_target' };
  }

  async tick() {
    let carried = this.adapter.getInventoryItems();

    // MODE DEPOSIT: taruh SEMUA item di tangan sampai tas BENAR-BENAR KOSONG sebelum kembali
    // mengumpulkan lagi - permintaan nyata pemilik: algoritma konsisten, ada mode mengambil
    // (sampai tas penuh) dan mode menaruh (sampai tas kosong), bukan bolak-balik ambil-satu-
    // taruh-satu setiap tick.
    if (this.mode === 'deposit') {
      if (carried.length === 0) {
        this.mode = 'collect';
      } else {
        const deliverResult = await this.runDeliverPhase(carried);
        if (deliverResult.action !== 'idle') return deliverResult;
        // TIDAK ADA target sama sekali untuk item manapun tick ini - JANGAN diam menunggu, lanjut
        // ke collect/inspect di bawah supaya bot tetap produktif (mode TETAP 'deposit' - dicoba
        // lagi tick berikutnya begitu ada tujuan yang tersedia) - ditemukan dari bug live nyata:
        // bot berhenti TOTAL selama bermenit-menit hanya karena satu item di tangan buntu.
      }
    }

    if (carried.length > 0 && this.getInsideChestPositions().length === 0) {
      return { action: 'idle', reason: 'no_house_chest' };
    }

    // MODE COLLECT: kalau tas SUDAH penuh di awal tick ini (mis. lompatan besar dari satu kali
    // reorganize/collect batch sebelumnya), jangan ambil lagi - langsung menaruh. Kasus umum
    // (baru mencapai batas SETELAH collect/reorganize tick ini) ditangani oleh
    // switchToDepositIfCarryFull() di titik aksi masing-masing, bukan di sini.
    if (this.mode === 'collect' && carried.length >= this.options.maxCarrySlots) {
      this.mode = 'deposit';
      return await this.runDeliverPhase(carried);
    }

    // PRIORITASKAN memeriksa chest DI DALAM (inspect/reorganize barang salah tempat) DI ATAS
    // mengumpulkan chest DI LUAR - permintaan nyata pemilik (setelah keluhan berulang "dia tetap
    // tidak mengambil apapun yang salah dalam mode collect"): dunia luar bisa punya PULUHAN chest
    // tersebar jauh (loot dungeon/village dsb dalam radius scan) yang makan waktu ber-menit-menit
    // untuk didatangi SEMUA sebelum urutan lama ini akhirnya sempat memeriksa satu pun chest dalam
    // - sementara rapikan gudang (tujuan UTAMA fitur mode collect/deposit ini) jadi kelaparan
    // giliran tanpa batas waktu. Chest DALAM jumlahnya kecil & TETAP (satu ruang gudang tunggal),
    // jadi mendahulukannya menjamin rapi-rapi selesai cepat TANPA BERGANTUNG berapa banyak/jauh
    // chest luar yang kebetulan ada di dunia - koleksi chest luar tetap jalan sesudahnya, giliran
    // KEDUA, bukan dihapus.
    const insideChests = this.getInsideChestPositions();
    // Chest yang SUDAH DIKETAHUI berantakan (dari chestSnapshot manapun - inspect resmi ATAUPUN
    // intipan resolveChestForItem) DIDAHULUKAN di atas urutan alami nearest-neighbor, diurutkan
    // dari yang PALING BANYAK item salah tempatnya - permintaan nyata pemilik: "jika state item
    // sudah di ketahui salah selesaikan semua kesalahannya dulu baru re inspeksi dan ambil chest
    // yang paling penuh dan salah terlebih dahulu, gunakan memory untuk melakukan perencanaan se
    // akurat mungkin". Kalau tidak ada yang diketahui berantakan, baru jatuh ke urutan biasa
    // (chest pertama yang belum pernah diperiksa sama sekali).
    let nextToInspect = null;
    if (this.knownMisplacedCounts.size > 0) {
      const byMisplacedDesc = [...this.knownMisplacedCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [key] of byMisplacedDesc) {
        const match = insideChests.find((pos) => posKey(pos) === key);
        if (match) { nextToInspect = match; break; }
      }
    }
    if (!nextToInspect) {
      nextToInspect = insideChests.find((pos) => !this.inspectedPositions.has(posKey(pos)));
    }
    if (nextToInspect) {
      let items;
      try {
        // onRead: simpan ke memori/dashboard SEBELUM chest ditutup - permintaan nyata pemilik:
        // "log harus nya open -> get data -> save to memory -> close" (dulu chest.close()
        // terjadi DI DALAM getChestContents, sebelum data ini sempat diproses, jadi log
        // "Ditutup" muncul lebih dulu daripada log "Memori Gudang diperbarui" - urutan yang
        // salah).
        items = await this.adapter.getChestContents(nextToInspect, {
          onRead: (readItems) => this.emitChestSnapshot(nextToInspect, readItems, insideChests)
        });
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
      // benar, jangan tebak (itu justru penyebab bug sortir tercampur sebelumnya). Kalau rumah
      // aslinya sendiri sedang PENUH/RUSAK DAN tidak ada overflow terdaftar yang masih longgar,
      // JANGAN tandai salah tempat sama sekali - memindahkan ke sana pasti gagal lagi (balik ke
      // sini), lalu dianggap salah tempat lagi tick berikutnya - ditemukan dari bug live nyata:
      // rotten_flesh bolak-balik TANPA HENTI 2+ menit karena reorganize terus memaksa memindah ke
      // rumah yang ternyata masih penuh. TAPI kalau ADA overflow terdaftar (options.overflowChests)
      // untuk rumah utama itu dan overflow-nya sendiri MASIH longgar, tetap tandai salah tempat -
      // resolveChestForItem (dipakai saat deliver nanti) sudah tahu cara memakai overflow itu.
      // Tanpa pengecualian ini, item yang rumah utamanya kebetulan penuh jadi TIDAK PERNAH
      // terdeteksi salah tempat sama sekali walau overflow-nya kosong melompong - ditemukan dari
      // keluhan nyata pemilik ("dia tetap tidak mengambil apapun yang salah dalam mode collect"),
      // dikonfirmasi lewat pemantauan live: rotten_flesh terlihat jelas di log isi chest tapi tidak
      // pernah ditandai salah tempat.
      const misplacedItems = this.computeMisplacedItems(nextToInspect, items, insideChests);

      if (misplacedItems.length > 0) {
        // Ambil SEMUA item salah tempat di chest ini dalam SATU kunjungan (bukan satu per
        // kunjungan) - ditemukan dari keluhan nyata pemilik ("banyak yang tidak sesuai"): dengan
        // satu item per kunjungan, membersihkan chest berisi puluhan barang salah tempat butuh
        // puluhan tick bolak-balik (kalah prioritas sama deliver/collect tiap kali), progresnya
        // jadi sangat lambat. Bot sudah berdiri di sini - sekalian ambil semuanya.
        await this.adapter.navigateNear(westOf(nextToInspect), 1);
        // SATU kali buka-tutup untuk SEMUA item salah tempat di chest ini - dulu satu buka-tutup
        // PER jenis item (withdrawFromChest berulang), yang untuk chest berantakan (mis. 8 jenis
        // salah tempat) berarti 8 kali navigasi+buka+jeda settle terpisah - ditemukan dari
        // keluhan nyata pemilik ("kok lama ya apa setiap kali membuka peti tidak selalu membaca
        // data") - jawabannya iya selalu membaca, tapi PROSESNYA sendiri lambat karena buka-tutup
        // berulang yang sebenarnya tidak perlu.
        const withdrawResults = await this.adapter.withdrawManyFromChest(
          nextToInspect,
          misplacedItems.map((item) => ({ name: item.name, count: item.count }))
        );
        const relocated = [];
        for (const result of withdrawResults) {
          if (result.withdrawn <= 0) continue;
          this.metrics.reorganized += result.withdrawn;
          relocated.push({ name: result.name, count: result.withdrawn });
          this.emit('misplaced', {
            position: nextToInspect,
            item: result.name,
            count: result.withdrawn,
            correctPosition: parseKey(this.chestAssignments.get(result.name))
          });
        }
        // JANGAN tandai chest ini "sudah diperiksa" - periksa ulang tick berikutnya untuk
        // memastikan benar-benar bersih (mis. kalau ada stack lain dari jenis yang sama).
        if (relocated.length > 0) this.recentlyVacatedPositions.add(posKey(nextToInspect));
        this.switchToDepositIfCarryFull();
        return { action: 'reorganize', position: nextToInspect, items: relocated, count: relocated.reduce((s, i) => s + i.count, 0) };
      }

      await this.adapter.navigateNear(westOf(nextToInspect), 1);
      this.inspectedPositions.add(posKey(nextToInspect));
      this.metrics.inspected += 1;
      this.emit('inspected', { position: nextToInspect, items });
      return { action: 'inspect', position: nextToInspect, items };
    }

    // Giliran KEDUA (semua chest dalam sudah diperiksa duluan di atas) - kumpulkan chest DI LUAR.
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
        this.switchToDepositIfCarryFull();
        return { action: 'collect', position: nextToCollect, count: result.totalCount };
      } catch (e) {
        this.emit('chestError', { position: nextToCollect, error: e.message });
        return { action: 'error', position: nextToCollect, error: e.message };
      }
    }

    // Semua chest luar sudah dikumpulkan dan semua chest dalam sudah diperiksa - reset supaya
    // putaran berikutnya mengulang (chest baru bisa saja terisi lagi seiring waktu berjalan). Chest
    // yang tercatat penuh JUGA di-reset di SINI SAJA (satu kali per putaran penuh) - bukan di jalur
    // deliver setiap kali satu item kebetulan buntu (itu penyebab loop 2-tick tanpa henti yang
    // sudah diperbaiki di atas).
    // brokenPositions JUGA di-reset di sini (sama seperti fullChestPositions) - satu kegagalan
    // buka chest biasanya cuma lag server SESAAT, bukan kerusakan permanen. Tanpa reset ini, makin
    // lama sesi berjalan makin banyak chest yang ter-blacklist SELAMANYA (setiap kegagalan
    // transien menambah daftar), sampai akhirnya item dengan rumah mapan sekalipun (mis. diamond,
    // iron_ingot) kehabisan tujuan yang valid sama sekali - ditemukan dari keluhan nyata pemilik:
    // storage worker berhenti total mengantar walau membawa banyak item yang rumahnya sudah lama
    // benar, gara-gara rumahnya kena blacklist permanen dari SATU kegagalan lama.
    if (this.collectedPositions.size > 0 || this.inspectedPositions.size > 0 || this.fullChestPositions.size > 0 || this.brokenPositions.size > 0 || this.recentlyVacatedPositions.size > 0) {
      this.collectedPositions.clear();
      this.inspectedPositions.clear();
      this.fullChestPositions.clear();
      this.brokenPositions.clear();
      this.recentlyVacatedPositions.clear();
    }
    // Tidak ada lagi yang bisa diambil (chest luar & dalam sudah habis untuk putaran ini) - kalau
    // tas masih membawa sesuatu, jangan tunggu sampai benar-benar penuh ATAU sampai tick idle
    // terbuang percuma - langsung beralih ke mode menaruh DAN mulai mengantar tick ini juga.
    if (this.mode === 'collect' && carried.length > 0) {
      this.mode = 'deposit';
      return await this.runDeliverPhase(carried);
    }
    return { action: 'idle' };
  }
}

module.exports = { StorageManagerEngine };
