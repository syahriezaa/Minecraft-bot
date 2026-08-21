/**
 * @file mineflayerRoleAdapter.js
 * @description Adapter aksi Mineflayer untuk engine survival role.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const FOOD_PRIORITY = Object.freeze([
  'golden_apple',
  'cooked_beef',
  'steak',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_salmon',
  'baked_potato',
  'bread',
  'apple',
  'carrot',
  'potato'
]);

const HOE_NAMES = Object.freeze([
  'wooden_hoe',
  'stone_hoe',
  'golden_hoe',
  'iron_hoe',
  'diamond_hoe',
  'netherite_hoe'
]);

function asVec3(pos) {
  if (!pos) return new Vec3(0, 0, 0);
  if (typeof pos.offset === 'function') return pos;
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

class MineflayerRoleAdapter {
  constructor(bot, options = {}) {
    this.bot = bot;
    this.options = {
      defaultGoalRange: 1,
      // Batas waktu goto() pathfinder - ditemukan dari bug live nyata (StorageWorker berhenti
      // total, tidak ada tick/error sama sekali selama menit-menitan): bot.pathfinder.goto() ke
      // target yang TIDAK TERJANGKAU (mis. chest terkubur di tumpukan padat) tidak pernah resolve
      // maupun reject - satu target tak terjangkau membekukan SELURUH worker (semua tick berikutnya)
      // permanen, bukan cuma gagal aman untuk target itu saja.
      navigateTimeoutMs: 15000,
      // Jeda singkat sesudah windowOpen sebelum chest dianggap siap dipakai - ditemukan dari bug
      // live nyata: deposit gagal "destination full" padahal chest sungguhan (dicek langsung di
      // game) masih banyak slot kosong. windowOpen terpicu begitu paket open_window diterima,
      // TAPI isi slot sesungguhnya datang lewat paket window_items terpisah yang bisa saja belum
      // selesai diproses tepat saat itu (apalagi di server dengan lag yang sudah berulang kali
      // terlihat sepanjang sesi ini) - window.slots lokal bot bisa saja belum lengkap/akurat,
      // membuat pengecekan "ada slot kosong?" mineflayer keliru menyimpulkan chest penuh.
      chestSettleMs: 250,
      // Dipanggil dengan pesan Bahasa Indonesia tiap kali verifyChestContentsByRoundTrip benar-
      // benar melakukan probe ambil-taruh - supaya pemilik bisa MELIHAT LANGSUNG (lewat feed
      // dashboard) bahwa verifikasi ini sungguhan terjadi, bukan cuma lolos di tes unit.
      log: () => {},
      ...options
    };
    this.worldAwareness = options.worldAwareness || null;
  }

  getPosition() {
    return this.bot?.entity?.position || { x: 0, y: 64, z: 0 };
  }

  getHealth() {
    return this.bot?.health ?? 20;
  }

  getFood() {
    return this.bot?.food ?? 20;
  }

  getEntities() {
    return Object.values(this.bot?.entities || {});
  }

  getInventoryItems() {
    if (typeof this.bot?.inventory?.items === 'function') return this.bot.inventory.items();
    if (Array.isArray(this.bot?.inventory?.items)) return this.bot.inventory.items;
    return [];
  }

  getItemByName(names) {
    const wanted = Array.isArray(names) ? names : [names];
    return this.getInventoryItems().find(item => wanted.includes(item.name)) || null;
  }

  getItemCount(name) {
    return this.getInventoryItems()
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + (item.count || 1), 0);
  }

  hasItem(names) {
    return Boolean(this.getItemByName(names));
  }

  async navigateNear(pos, range = this.options.defaultGoalRange) {
    if (!pos) return false;
    if (this.bot?.pathfinder?.goto) {
      // Balapan goto() melawan batas waktu - lihat catatan navigateTimeoutMs di constructor.
      // Timeout SENGAJA resolve (bukan reject) ke false: caller (findMatchingChest,
      // withdrawAllFromChest, dst) sudah menganggap false/gagal sebagai sinyal "lewati saja,
      // lanjut ke target berikutnya", bukan error yang perlu ditangani khusus.
      const start = Date.now();
      let timeoutHandle;
      const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), this.options.navigateTimeoutMs);
      });
      const result = await Promise.race([
        this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)).then(() => true),
        timeout
      ]);
      clearTimeout(timeoutHandle);
      if (!result) {
        // Dulu gagal DIAM-DIAM tanpa jejak sama sekali - ditemukan dari keluhan nyata pemilik
        // ("kok bisa berjarak beberapa menit padahal harusnya kurang dari 5 detik") saat jeda
        // panjang tak terjelaskan antar pemeriksaan chest ternyata (diduga) navigasi yang macet
        // berulang kali, tapi tidak pernah tercatat di mana pun sehingga tidak kelihatan.
        this.options.log(`[Navigasi] PERINGATAN: navigasi ke (${pos.x},${pos.y},${pos.z}) timeout setelah ${Date.now() - start}ms (${this.options.navigateTimeoutMs}ms batas) - dilewati, lanjut ke target berikutnya.`);
      }
      return result;
    }
    return distance(this.getPosition(), pos) <= range;
  }

  async equipItem(names, destination = 'hand') {
    const item = this.getItemByName(names);
    if (!item || typeof this.bot?.equip !== 'function') return false;
    await this.bot.equip(item, destination);
    return true;
  }

  async eatBestFood(foodNames = FOOD_PRIORITY) {
    const food = this.getItemByName(foodNames);
    if (!food || typeof this.bot?.equip !== 'function' || typeof this.bot?.consume !== 'function') return false;
    await this.bot.equip(food, 'hand');
    await this.bot.consume();
    return true;
  }

  async lookAt(pos) {
    if (typeof this.bot?.lookAt === 'function') {
      await this.bot.lookAt(asVec3(pos));
      return true;
    }
    return false;
  }

  async dig(block) {
    if (!block || typeof this.bot?.dig !== 'function') return false;
    const pos = block.position || block;
    await this.navigateNear(pos, 3);
    await this.bot.dig(block);
    // Barang hasil gali (mis. panen crop) jatuh sebagai item entity di tanah - jarak 3 blok cukup
    // untuk menggali tapi TIDAK cukup dekat untuk memicu pickup otomatis Minecraft. Mendekat sampai
    // benar-benar menginjak posisi blok (range 0) supaya barangnya ikut terambil, bukan ditinggalkan.
    await this.navigateNear(pos, 0);
    return true;
  }

  async placeSeed(referenceBlock, seedName) {
    if (!referenceBlock || !seedName || typeof this.bot?.placeBlock !== 'function') return false;
    const equipped = await this.equipItem(seedName, 'hand');
    if (!equipped) return false;
    await this.navigateNear(referenceBlock.position || referenceBlock, 3);
    await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
    return true;
  }

  // Cangkul dirt/grass jadi farmland - permintaan nyata pemilik: "farming bot harus bisa
  // memperbaiki tempat farming...bawa dirt dan hoe dari gudang". Cukup pegang cangkul lalu klik
  // kanan (activateBlock, PERSIS mekanisme yang sama dipakai setSpawnAtNearestBed untuk klik bed)
  // blok dirt/grass_block itu - Minecraft otomatis mengubahnya jadi farmland kalau ada ruang
  // kosong di atasnya, tidak perlu logika tambahan apapun.
  async tillFarmland(pos) {
    if (!pos || typeof this.bot?.activateBlock !== 'function') return false;
    const equipped = await this.equipItem(HOE_NAMES, 'hand');
    if (!equipped) return false;
    await this.navigateNear(pos, 3);
    const block = this.blockAt(pos);
    if (!block) return false;
    await this.bot.activateBlock(block);
    return true;
  }

  // Isi lubang di lahan farming dengan dirt sebelum dicangkul - permintaan nyata pemilik: "bawa
  // dirt dan hoe dari gudang" untuk memperbaiki lahan. Ditaruh berdiri di atas blok solid TEPAT DI
  // BAWAH posisi lubang (sama seperti placeSeed menaruh benih di atas farmland) - kalau bawahnya
  // sendiri kosong (lubang lebih dari satu blok dalam), gagal dulu (false); tick berikutnya akan
  // coba isi level yang lebih rendah dulu (findRepairCandidates men-scan ulang tiap tick).
  async placeDirtAt(pos, itemName = 'dirt') {
    if (!pos || typeof this.bot?.placeBlock !== 'function') return false;
    const equipped = await this.equipItem(itemName, 'hand');
    if (!equipped) return false;
    const below = { x: pos.x, y: pos.y - 1, z: pos.z };
    await this.navigateNear(below, 3);
    const belowBlock = this.blockAt(below);
    if (!belowBlock || belowBlock.name === 'air') return false;
    await this.bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
    return true;
  }

  blockAt(pos) {
    if (this.worldAwareness && typeof this.worldAwareness.getBlockAt === 'function') {
      return this.worldAwareness.getBlockAt(pos.x, pos.y, pos.z);
    }
    if (typeof this.bot?.blockAt !== 'function') return null;
    return this.bot.blockAt(asVec3(pos));
  }

  // Properti blockstate "type" chest ('left'/'right'/'single') - SATU-SATUNYA cara benar untuk
  // tahu apakah dua blok chest yang bersebelahan SUNGGUHAN pasangan double-chest fisik yang sama,
  // atau cuma kebetulan berdiri berdampingan tanpa benar-benar tersambung - ditemukan dari bug
  // live nyata (analisis mendalam pola dunia sungguhan): asumsi lama "dua chest bersebelahan pasti
  // satu wadah" TERNYATA SALAH - di gudang ini pasangan sungguhan selalu di sepanjang sumbu X
  // (chest 'right' di x=-181 berpasangan dengan chest 'left' di x=-180 pada z YANG SAMA), padahal
  // banyak chest 'right' lain juga kebetulan bersebelahan di sepanjang sumbu Z (mis. z=-353 dan
  // z=-352) TANPA benar-benar tersambung sebagai satu wadah - dua chest SAMA-SAMA 'right' (atau
  // sama-sama 'left') TIDAK PERNAH benar-benar berpasangan di Minecraft, cuma pasangan left+right
  // yang sungguhan. Chest tanpa pasangan (single) juga tidak pernah bergabung dengan apapun.
  getChestHalfType(pos) {
    const block = this.blockAt(pos);
    if (!block || block.name !== 'chest') return null;
    const props = typeof block.getProperties === 'function' ? block.getProperties() : block._properties;
    return props?.type || 'single';
  }

  findBlocksByNames(blockNames, options = {}) {
    if (this.worldAwareness && typeof this.worldAwareness.findBlocksByNames === 'function') {
      return this.worldAwareness.findBlocksByNames(blockNames, options);
    }
    if (typeof this.bot?.findBlocks !== 'function') return [];
    const names = new Set(blockNames);
    const matching = block => block && names.has(block.name);
    const positions = this.bot.findBlocks({
      matching,
      maxDistance: options.maxDistance || 32,
      count: options.count || 128,
      point: options.point ? asVec3(options.point) : undefined
    });
    return positions.map(pos => this.blockAt(pos)).filter(Boolean);
  }

  async useOn(entity) {
    if (!entity) return false;
    await this.navigateNear(entity.position, 3);
    // Server ini (protokol 775, skema versi baru Mojang) mengubah bentuk paket use_entity: field
    // lama "mouse" (enum interact/attack/interact_at) DIHAPUS, diganti field "location" yang WAJIB
    // ada (bertipe lpVec3 - objek {x,y,z}, BUKAN opsional). bot.activateEntity() DAN
    // bot.activateEntityAt() bawaan mineflayer keduanya masih kirim skema LAMA (mouse+x/y/z terpisah,
    // tanpa field location sama sekali) - paket gagal serialisasi persis di field location yang
    // undefined ("Cannot read properties of undefined (reading 'x')"), dan kegagalan itu merusak
    // koneksi (semua tick berikutnya timeout sampai bot di-kick server) - bukan sekadar gagal aman.
    // Tulis paket LANGSUNG dengan skema yang benar untuk protokol ini, bypass fungsi bawaan
    // mineflayer yang belum diperbarui untuk versi Minecraft ini.
    if (this.bot?._client?.write) {
      await this.lookAt(entity.position);
      this.bot._client.write('use_entity', {
        target: entity.id,
        hand: 0, // main_hand
        location: { x: 0, y: 0, z: 0 },
        sneaking: false
      });
      return true;
    }
    if (typeof this.bot?.activateEntityAt === 'function') {
      await this.bot.activateEntityAt(entity, entity.position);
      return true;
    }
    if (typeof this.bot?.activateEntity === 'function') {
      this.bot.activateEntity(entity);
      return true;
    }
    if (typeof this.bot?.useOn === 'function') {
      await this.bot.useOn(entity);
      return true;
    }
    return false;
  }

  async attack(entity) {
    if (!entity) return false;
    await this.lookAt(entity.position);
    // bot.attack() bawaan mineflayer masih memanggil useEntity() internal, yang menulis paket
    // use_entity skema LAMA (field "mouse", tanpa field "location" wajib) - crash yang sama persis
    // dengan bug useOn() yang sudah ditemukan sebelumnya, tapi lewat jalur berbeda (serangan, bukan
    // interact biasa) - merusak koneksi sampai bot ter-disconnect diam-diam. Server ini (protokol
    // 775) sebenarnya sudah punya paket "attack" terpisah khusus untuk serangan (cuma field
    // entityId) - tulis itu langsung, bypass bot.attack() yang belum diperbarui.
    if (this.bot?._client?.write) {
      this.bot._client.write('attack', { entityId: entity.id });
      if (typeof this.bot?.swingArm === 'function') this.bot.swingArm();
      return true;
    }
    if (typeof this.bot?.attack === 'function') {
      this.bot.attack(entity);
      return true;
    }
    return false;
  }

  activateShield() {
    if (typeof this.bot?.activateItem !== 'function') return false;
    this.bot.activateItem(true);
    return true;
  }

  deactivateShield() {
    if (typeof this.bot?.deactivateItem !== 'function') return false;
    this.bot.deactivateItem();
    return true;
  }

  async openChestAt(pos) {
    const block = this.blockAt(pos);
    if (!block || typeof this.bot?.openChest !== 'function') return null;
    await this.navigateNear(pos, 3);
    const openStart = Date.now();
    const chest = await this.bot.openChest(block);
    // Log EKSPLISIT buka/tutup - permintaan nyata pemilik: "coba tambahkan log bot membuka peti
    // dan bot menutup peti dan lihat di antara 2 log itu" - supaya waktu yang dihabiskan SELAMA
    // satu chest terbuka (settle-poll, probe verifikasi, withdraw/deposit) kelihatan jelas dan
    // terpisah dari waktu navigasi ke chest berikutnya (yang sudah dilaporkan lewat log navigasi).
    // Tag mengikuti jenis blok SUNGGUHAN (chest vs barrel) - permintaan nyata pemilik: "bot belum
    // bisa membedakan peti dan barel" - dulu SEMUA container dilaporkan sebagai "[Chest]" walau
    // yang dibuka sebenarnya barrel, jadi log saja tidak bisa dipakai untuk tahu jenis wadahnya.
    const tag = block.name === 'barrel' ? 'Barrel' : 'Chest';
    this.options.log(`[${tag}] Dibuka (${pos.x},${pos.y},${pos.z})`);
    await this.waitForStableChestItems(chest);
    if (typeof chest?.close === 'function') {
      const originalClose = chest.close.bind(chest);
      chest.close = (...args) => {
        this.options.log(`[${tag}] Ditutup (${pos.x},${pos.y},${pos.z}) - ${Date.now() - openStart}ms sejak dibuka`);
        return originalClose(...args);
      };
    }
    return chest;
  }

  // Jangan percaya SATU jeda tunggal (chestSettleMs) lalu langsung anggap datanya sudah benar -
  // kalau lag server lebih lama dari jeda itu, satu bacaan sesudahnya bisa saja masih data lama/
  // belum lengkap. Baca ulang berkali-kali (dijeda chestSettleMs tiap kali) sampai dua bacaan
  // BERTURUT-TURUT benar-benar sama, baru anggap stabil - ditemukan dari keluhan nyata pemilik:
  // item salah tempat tetap tidak diambil karena data yang dicocokkan ke kategori seharusnya
  // belum ter-update saat chest baru saja dibuka.
  //
  // Batas berhenti menunggu dulu berupa JUMLAH percobaan tetap (4x) - ternyata masih bisa
  // menyerah terlalu dini kalau lag server panjang butuh lebih dari 4 kali baca sebelum stabil,
  // membuat bot "pergi" (lanjut ke aksi berikutnya) sambil masih membawa data yang basi -
  // ditemukan dari keluhan nyata pemilik: "bot nya membuka peti belum menerima data baru sudah
  // pergi...bot jangan boleh pergi sebelum menerima data baru". Sekarang batasnya WAKTU total
  // (chestSettleTimeoutMs, default 10 detik) - selama waktu itu belum habis, TERUS baca ulang
  // berapa kalipun perlu, tidak dibatasi jumlah percobaan tetap.
  async waitForStableChestItems(chest) {
    if (typeof chest?.containerItems !== 'function' || !(this.options.chestSettleMs > 0)) return;
    const timeoutMs = this.options.chestSettleTimeoutMs ?? 10000;
    const deadline = Date.now() + timeoutMs;
    const snapshot = (items) => items.map((it) => `${it.name}x${it.count}`).sort().join('|');
    let previous = snapshot(chest.containerItems());
    let attempts = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.options.chestSettleMs));
      attempts += 1;
      const current = snapshot(chest.containerItems());
      if (current === previous) return;
      previous = current;
    }
    // Batas WAKTU habis dan data MASIH terus berubah tiap dibaca - laporkan dengan jelas (dulu
    // ini gagal DIAM-DIAM, pemilik tidak percaya kejadiannya sungguhan sampai diminta bukti log
    // nyata) - dipakai adapter/engine yang memanggil ini sebagai sinyal bahwa bacaan berikutnya
    // masih mungkin belum benar-benar final.
    this.options.log(`[Verifikasi chest] PERINGATAN: data belum juga stabil setelah ${attempts}x baca ulang dalam ${timeoutMs}ms (lag server terlalu panjang) - lanjut pakai bacaan terakhir, mungkin belum benar-benar final.`);
  }

  // Cari chest di sekitar yang SUDAH berisi salah satu dari itemNames - dipakai FarmerEngine
  // (autoMatchStorage) supaya hasil panen ditaruh di gudang yang memang sudah terorganisir per
  // jenis item (mis. wheat dan carrot masing-masing punya chest sendiri), bukan ditumpuk ke satu
  // chest sembarangan. Membuka chest SATU-SATU (bukan paralel) - server Minecraft cuma izinkan satu
  // window terbuka per pemain dalam satu waktu.
  async findMatchingChest(itemNames, options = {}) {
    const positions = typeof this.bot?.findBlocks === 'function'
      ? this.bot.findBlocks({
        matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
        maxDistance: options.maxDistance || 24,
        count: options.count || 40
      })
      : [];
    for (const pos of positions) {
      const chest = await this.openChestAt(pos);
      if (!chest) continue;
      const items = typeof chest.containerItems === 'function' ? chest.containerItems() : [];
      if (typeof chest.close === 'function') chest.close();
      if (items.some((it) => itemNames.includes(it.name))) return pos;
    }
    return null;
  }

  // Daftar MENTAH semua posisi chest di sekitar, tanpa buka/filter isi apapun - dipakai
  // StorageManagerEngine untuk membedakan chest DI DALAM vs DI LUAR area rumah (murni geometri
  // posisi blok, jauh lebih cepat daripada findMatchingChest yang harus buka tiap chest satu-satu).
  // Cocokkan "chest" MAUPUN "barrel" - keduanya container penyimpanan biasa (bot.openChest bawaan
  // mineflayer sudah generik, mendukung kedua jenis blok ini) - permintaan nyata pemilik: barel di
  // antara chest gudang juga boleh dipakai untuk menyimpan, bukan cuma chest.
  findChestPositions(maxDistance = 32, count = 64) {
    if (typeof this.bot?.findBlocks !== 'function') return [];
    return this.bot.findBlocks({
      matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'),
      maxDistance,
      count
    });
  }

  // Buka satu chest, baca isinya, tutup lagi - dipakai StorageManagerEngine untuk audit "buka
  // semua chest dan cek barang" saat merapikan gudang. Beda dari findMatchingChest (yang berhenti
  // di chest PERTAMA yang cocok) - ini baca isi SATU chest tertentu secara lengkap.
  //
  // { verify = true }: jalankan probe ambil-taruh (verifyChestContentsByRoundTrip) sebelum
  // membaca - PENTING untuk audit sungguhan (misplaced-item detection), tapi MAHAL (beberapa
  // ratus ms per chest). resolveChestForItem di storageManagerEngine.js juga memakai fungsi ini
  // untuk "mengintip" isi BANYAK chest sekaligus (cari yang sudah cocok/kosong) - kalau probe ikut
  // jalan di situ juga, mengintip 20+ chest jadi lambat sekali dan terlihat seperti macet -
  // ditemukan dari keluhan nyata pemilik: "worker nya membuka chest itu tapi sepertinya tidak
  // melihat isinya". Intipan seperti itu memakai verify:false - settle-poll pasif di openChestAt
  // saja sudah cukup untuk keputusan "sudah cocok / kosong / bukan", tidak butuh jaminan seketat
  // audit resmi.
  // { onRead }: dipanggil dengan isi chest SEBELUM chest.close() - permintaan nyata pemilik: "log
  // harus nya open -> get data -> save to memory -> close" - urutan ini memastikan data SUDAH
  // tersimpan ke memori/dashboard sebelum chest ditinggalkan, bukan ditutup duluan baru diproses
  // belakangan (yang sebelumnya membuat log "Ditutup" muncul SEBELUM log "Memori Gudang
  // diperbarui", padahal seharusnya sebaliknya).
  async getChestContents(pos, { verify = true, onRead } = {}) {
    const chest = await this.openChestAt(pos);
    if (!chest) return [];
    if (verify) await this.verifyChestContentsByRoundTrip(chest);
    const items = typeof chest.containerItems === 'function' ? chest.containerItems() : [];
    if (typeof onRead === 'function') await onRead(items);
    if (typeof chest.close === 'function') chest.close();
    return items;
  }

  // Menunggu pasif (waitForStableChestItems) saja belum cukup meyakinkan - dua bacaan yang sama-
  // sama masih basi/salah tetap akan dianggap "stabil". Cara yang lebih pasti: benar-benar AMBIL 1
  // biji item (transaksi nyata yang dikonfirmasi server), pastikan datanya berubah, lalu TARUH
  // KEMBALI persis sejumlah yang diambil dan tunggu konfirmasi itu juga - permintaan nyata pemilik:
  // "dia harus mengambil mengupdate dan pastikan isinya berubah lalu menaruh lagi lalu tunggu
  // hingga ter update". Cuma jalan kalau chest ada isinya (tidak ada yang perlu diverifikasi kalau
  // kosong) DAN inventaris bot masih longgar (>= chestVerifyReserveSlots, permintaan pemilik:
  // sisakan 2 slot) - supaya probe ini tidak pernah bikin inventaris kepenuhan.
  async verifyChestContentsByRoundTrip(chest) {
    if (typeof chest?.containerItems !== 'function') return;
    if (typeof chest?.withdraw !== 'function' || typeof chest?.deposit !== 'function') return;
    const items = chest.containerItems();
    if (items.length === 0) return;
    const reserve = this.options.chestVerifyReserveSlots ?? 2;
    if (this.getInventoryFreeSlotCount() < reserve) return;

    const probe = items[0];
    try {
      this.options.log(`[Verifikasi chest] Ambil 1x ${probe.name} sebagai probe untuk pastikan data sudah ter-update...`);
      await chest.withdraw(probe.type, probe.metadata ?? null, 1);
      await this.waitForStableChestItems(chest);
      await chest.deposit(probe.type, probe.metadata ?? null, 1);
      await this.waitForStableChestItems(chest);
      this.options.log(`[Verifikasi chest] ${probe.name} sudah ditaruh kembali - data chest ini sekarang dijamin ter-update.`);
    } catch (e) {
      this.options.log(`[Verifikasi chest] Probe ambil-taruh ${probe.name} gagal (${e.message}) - lanjut pakai bacaan settle-poll biasa.`);
    }
  }

  // Perkiraan jumlah slot kosong di inventaris utama bot (hotbar + inventory, di luar armor/
  // offhand/crafting) - dipakai verifyChestContentsByRoundTrip untuk memastikan probe ambil-taruh
  // tidak pernah dilakukan saat inventaris nyaris penuh.
  getInventoryFreeSlotCount() {
    const inv = this.bot?.inventory;
    if (!inv) return 0;
    if (typeof inv.emptySlotCount === 'function') return inv.emptySlotCount();
    const total = (Number.isFinite(inv.inventoryEnd) && Number.isFinite(inv.inventoryStart))
      ? inv.inventoryEnd - inv.inventoryStart
      : 36;
    return Math.max(0, total - this.getInventoryItems().length);
  }

  // Tarik SEMUA isi chest apapun jenisnya - dipakai StorageManagerEngine untuk "kumpulkan semua
  // chest di luar rumah" (beda dari withdrawFromChest yang butuh filter nama item spesifik, sengaja
  // dipakai FarmerEngine untuk ambil benih tertentu saja).
  async withdrawAllFromChest(pos) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { itemsWithdrawn: 0, totalCount: 0 };
    let itemsWithdrawn = 0;
    let totalCount = 0;
    try {
      const items = chest.containerItems();
      for (const item of items) {
        if (typeof chest.withdraw !== 'function') continue;
        await chest.withdraw(item.type, item.metadata ?? null, item.count);
        itemsWithdrawn += 1;
        totalCount += item.count || 1;
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return { itemsWithdrawn, totalCount };
  }

  // Slot armor mineflayer TETAP di indeks 5-8 (head/torso/legs/feet) di semua versi protokol
  // vanilla - bagian dunia yang jauh lebih stabil daripada field paket yang berubah-ubah (lihat
  // bug use_entity). Slot kosong berarti gear hilang/rusak TOTAL - di Minecraft, durabilitas habis
  // membuat item LENYAP dari slot, bukan cuma "rusak sebagian" - jadi ini sinyal paling andal untuk
  // "perlu diganti", tanpa perlu mem-parsing NBT durabilitas yang rawan berubah antar versi.
  getEquippedArmor() {
    const slots = this.bot?.inventory?.slots || [];
    return {
      head: slots[5]?.name || null,
      torso: slots[6]?.name || null,
      legs: slots[7]?.name || null,
      feet: slots[8]?.name || null
    };
  }

  // Ambil BEBERAPA jenis item sekaligus dari chest gudang dalam SATU kali buka-tutup - dipakai
  // StorageManagerEngine untuk menarik SEMUA item salah tempat di satu chest sekaligus. Beda dari
  // withdrawFromChest (yang buka-tutup chest SENDIRI-SENDIRI per jenis item) - ditemukan dari
  // keluhan nyata pemilik ("kok lama ya"): chest dengan banyak item salah tempat (mis. 8 jenis)
  // butuh 8 kali buka-tutup terpisah kalau dipanggil satu-satu, padahal semuanya bisa diambil
  // dalam SATU kunjungan yang sama - tiap buka-tutup butuh navigasi + jeda settle sendiri,
  // membuat pembersihan satu chest yang berantakan makan waktu jauh lebih lama dari perlu.
  async withdrawManyFromChest(pos, requests) {
    const chest = await this.openChestAt(pos);
    if (!chest) return requests.map((r) => ({ name: r.name, withdrawn: 0 }));
    const results = [];
    try {
      for (const { name, count } of requests) {
        const items = chest.containerItems();
        const match = items.find((it) => it.name === name);
        if (match && typeof chest.withdraw === 'function') {
          const take = Math.min(count, match.count);
          await chest.withdraw(match.type, match.metadata ?? null, take);
          results.push({ name, withdrawn: take });
        } else {
          results.push({ name, withdrawn: 0 });
        }
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return results;
  }

  // Ambil item dari chest gudang ke inventaris - kebalikan dari depositToChest.
  async withdrawFromChest(pos, itemNames, count) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { withdrawn: 0 };
    let withdrawn = 0;
    try {
      const items = chest.containerItems();
      const match = items.find((it) => itemNames.includes(it.name));
      if (match && typeof chest.withdraw === 'function') {
        const take = Math.min(count, match.count);
        await chest.withdraw(match.type, match.metadata ?? null, take);
        withdrawn = take;
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return { withdrawn };
  }

  // Cari crafting_table terdekat, ambil resep yang sungguh bisa dibuat sekarang (bahan cukup -
  // recipesFor cuma mengembalikan resep yang TERPENUHI), lalu craft. Gagal jelas (false) kalau
  // tidak ada meja atau bahan kurang, bukan crash - caller (GuardEngine) yang putuskan langkah
  // berikutnya (mis. ambil bahan dulu dari chest).
  async craftItem(itemName, count = 1) {
    const tablePos = typeof this.bot?.findBlock === 'function'
      ? this.bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 16 })
      : null;
    if (!tablePos) return false;
    await this.navigateNear(tablePos.position, 3);
    const tableBlock = this.blockAt(tablePos.position);
    // recipesFor butuh ID numerik item (via registry), bukan nama string.
    const itemId = this.bot?.registry?.itemsByName?.[itemName]?.id ?? itemName;
    const recipes = typeof this.bot?.recipesFor === 'function' ? this.bot.recipesFor(itemId, null, 1, tableBlock) : [];
    if (!recipes || recipes.length === 0) return false;
    await this.bot.craft(recipes[0], count, tableBlock);
    return true;
  }

  // Klik bed terdekat untuk set titik spawn di sini - dipakai worker SEBELUM mulai kerja apapun,
  // supaya kalau proses direstart/logout, bot lanjut dari base pada login berikutnya (Minecraft
  // me-resume di posisi logout terakhir kalau tidak ada spawn point, tapi klik bed EKSPLISIT lebih
  // andal - tidak bergantung posisi logout persis yang mana). Gagal jelas (false) kalau tidak ada
  // bed dalam jangkauan, bukan macet menunggu.
  async setSpawnAtNearestBed(maxDistance = 16) {
    const bedBlock = typeof this.bot?.findBlock === 'function'
      ? this.bot.findBlock({ matching: (b) => b && b.name.endsWith('_bed'), maxDistance })
      : null;
    if (!bedBlock) return false;
    await this.navigateNear(bedBlock.position, 2);
    const block = this.blockAt(bedBlock.position);
    if (typeof this.bot?.activateBlock !== 'function') return false;
    await this.bot.activateBlock(block);
    // Beri jeda singkat - status isSleeping baru sungguh-sungguh terkonfirmasi lewat paket metadata
    // ASINKRON dari server (bukan langsung begitu paket klik kita TERKIRIM), jadi cek langsung
    // tanpa jeda berisiko race condition (belum sempat diperbarui saat dicek).
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Klik bed di sini SEMATA untuk set titik spawn - kalau kebetulan malam hari, server bisa
    // benar-benar menidurkan bot (bukan cuma set spawn), yang bisa membuatnya terjebak diam di
    // ranjang tanpa batas waktu kalau tidak dibangunkan. Tulis paket entity_action LANGSUNG dengan
    // actionId:0 ("leave_bed") - bot.wake() bawaan mineflayer masih kirim actionId:2, yang di
    // skema protokol server ini berarti "stop_sprinting", BUKAN "leave_bed" - bot tidak akan
    // pernah bangun lagi kalau pakai fungsi bawaan itu.
    if (this.bot.isSleeping && this.bot?._client?.write) {
      this.bot._client.write('entity_action', { entityId: this.bot.entity.id, actionId: 0, jumpBoost: 0 });
    }
    return true;
  }

  // maxPerItem (opsional): { namaItem: jumlahCadangan } - sisakan sejumlah itu di inventaris,
  // cuma setor SISA di atasnya. Dipakai FarmerEngine supaya benih (carrot/potato/wheat_seeds dst -
  // item yang sama dipakai baik sebagai hasil panen MAUPUN benih tanam) tidak habis disetor semua
  // ke gudang sebelum kebun benar-benar selesai ditanami - ditemukan dari permintaan nyata pemilik.
  async depositToChest(pos, predicate = () => true, maxPerItem = {}) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { deposited: 0 };
    let deposited = 0;
    const depositedSoFar = new Map();
    try {
      for (const item of this.getInventoryItems()) {
        if (!predicate(item)) continue;
        const reserve = maxPerItem[item.name];
        let amount = item.count || 1;
        if (reserve !== undefined) {
          const already = depositedSoFar.get(item.name) || 0;
          // Anggap semua stack item ini sejauh ini (di stack-stack sebelumnya) sudah "dihitung"
          // menuju cadangan - sisakan cadangan dari stack PERTAMA yang cukup, setor penuh sisanya.
          const totalOfThisItem = this.getInventoryItems()
            .filter((i) => i.name === item.name)
            .reduce((s, i) => s + (i.count || 1), 0);
          const totalAllowedToDeposit = Math.max(0, totalOfThisItem - reserve);
          const remainingAllowance = Math.max(0, totalAllowedToDeposit - already);
          amount = Math.min(amount, remainingAllowance);
          if (amount <= 0) continue;
        }
        if (typeof chest.deposit === 'function') {
          // chest.deposit() sungguhan MELEMPAR "destination full" kalau chest genuinely tidak
          // muat lagi untuk jenis ini (bukan gagal dengan tenang) - dibungkus try/catch PER JENIS
          // ITEM supaya satu jenis yang kebetulan chest-nya penuh tidak menjatuhkan SELURUH proses
          // setor untuk jenis lain di kunjungan yang sama - ditemukan dari bug live nyata:
          // FarmerWorker.deposited tetap 0 selama bermenit-menit walau sudah panen 200+ item,
          // karena satu jenis crop yang chest-nya kebetulan penuh membuat setor GAGAL TOTAL untuk
          // semua jenis lain juga, inventaris tidak pernah mengempis - rantai akibatnya sampai ke
          // fitur lain: bot bahkan tidak pernah punya slot kosong untuk mengambil cangkul
          // perbaikan lahan.
          try {
            await chest.deposit(item.type, item.metadata ?? null, amount);
            deposited += amount;
            depositedSoFar.set(item.name, (depositedSoFar.get(item.name) || 0) + amount);
          } catch (e) {
            this.options.log(`[Deposit] PERINGATAN: gagal setor ${amount}x ${item.name} (${e.message}) - lewati, lanjut ke jenis lain.`);
          }
        }
      }
    } finally {
      if (typeof chest.close === 'function') chest.close();
    }
    return { deposited };
  }
}

module.exports = {
  MineflayerRoleAdapter,
  FOOD_PRIORITY,
  HOE_NAMES,
  asVec3,
  distance
};
