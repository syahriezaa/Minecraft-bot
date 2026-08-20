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
      let timeoutHandle;
      const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), this.options.navigateTimeoutMs);
      });
      const result = await Promise.race([
        this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)).then(() => true),
        timeout
      ]);
      clearTimeout(timeoutHandle);
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

  blockAt(pos) {
    if (this.worldAwareness && typeof this.worldAwareness.getBlockAt === 'function') {
      return this.worldAwareness.getBlockAt(pos.x, pos.y, pos.z);
    }
    if (typeof this.bot?.blockAt !== 'function') return null;
    return this.bot.blockAt(asVec3(pos));
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
    return this.bot.openChest(block);
  }

  // Cari chest di sekitar yang SUDAH berisi salah satu dari itemNames - dipakai FarmerEngine
  // (autoMatchStorage) supaya hasil panen ditaruh di gudang yang memang sudah terorganisir per
  // jenis item (mis. wheat dan carrot masing-masing punya chest sendiri), bukan ditumpuk ke satu
  // chest sembarangan. Membuka chest SATU-SATU (bukan paralel) - server Minecraft cuma izinkan satu
  // window terbuka per pemain dalam satu waktu.
  async findMatchingChest(itemNames, options = {}) {
    const positions = typeof this.bot?.findBlocks === 'function'
      ? this.bot.findBlocks({
        matching: (b) => b && b.name === 'chest',
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
  findChestPositions(maxDistance = 32, count = 64) {
    if (typeof this.bot?.findBlocks !== 'function') return [];
    return this.bot.findBlocks({
      matching: (b) => b && b.name === 'chest',
      maxDistance,
      count
    });
  }

  // Buka satu chest, baca isinya, tutup lagi - dipakai StorageManagerEngine untuk audit "buka
  // semua chest dan cek barang" saat merapikan gudang. Beda dari findMatchingChest (yang berhenti
  // di chest PERTAMA yang cocok) - ini baca isi SATU chest tertentu secara lengkap.
  async getChestContents(pos) {
    const chest = await this.openChestAt(pos);
    if (!chest) return [];
    const items = typeof chest.containerItems === 'function' ? chest.containerItems() : [];
    if (typeof chest.close === 'function') chest.close();
    return items;
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
          await chest.deposit(item.type, item.metadata ?? null, amount);
          deposited += amount;
          depositedSoFar.set(item.name, (depositedSoFar.get(item.name) || 0) + amount);
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
  asVec3,
  distance
};
