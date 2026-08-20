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
      await this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
      return true;
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
    // bot.activateEntity() (paket use_entity TANPA field x/y/z) crash di server ini (protokol 775) -
    // "Cannot read properties of undefined (reading 'x')" saat serialisasi, karena protokol ini
    // mensyaratkan field posisi SELALU ada walau untuk interact biasa. Paket itu gagal terkirim
    // dengan cara yang merusak koneksi (tick berikutnya semua timeout sampai bot di-kick server) -
    // bukan sekadar gagal aman. activateEntityAt() menyertakan x/y/z, aman dipakai di protokol ini.
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
    if (!entity || typeof this.bot?.attack !== 'function') return false;
    await this.lookAt(entity.position);
    this.bot.attack(entity);
    return true;
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

  async depositToChest(pos, predicate = () => true) {
    const chest = await this.openChestAt(pos);
    if (!chest) return { deposited: 0 };
    let deposited = 0;
    try {
      for (const item of this.getInventoryItems()) {
        if (!predicate(item)) continue;
        if (typeof chest.deposit === 'function') {
          await chest.deposit(item.type, item.metadata ?? null, item.count || 1);
          deposited += item.count || 1;
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
