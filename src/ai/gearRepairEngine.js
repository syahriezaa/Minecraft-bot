/**
 * @file gearRepairEngine.js
 * @description Perbaiki gear armor yang hilang/rusak dengan craft besi baru dari gudang. Slot
 * armor kosong berarti gear hilang/rusak TOTAL - di Minecraft, durabilitas habis membuat item
 * LENYAP dari slot, bukan cuma "rusak sebagian" (lihat getEquippedArmor di mineflayerRoleAdapter.js)
 * - jadi slot kosong sudah sinyal paling andal untuk "perlu diganti", tanpa perlu mem-parsing NBT
 * durabilitas yang rawan berubah antar versi protokol.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');

const ARMOR_PIECES = Object.freeze([
  { slot: 'head', item: 'iron_helmet', ironCost: 5 },
  { slot: 'torso', item: 'iron_chestplate', ironCost: 8 },
  { slot: 'legs', item: 'iron_leggings', ironCost: 7 },
  { slot: 'feet', item: 'iron_boots', ironCost: 4 }
]);

class GearRepairEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      pieces: ARMOR_PIECES,
      ironItemNames: ['iron_ingot'],
      ...options
    };
    this.metrics = { repaired: 0, gathered: 0 };
  }

  async tick() {
    const armor = this.adapter.getEquippedArmor();

    for (const piece of this.options.pieces) {
      if (armor[piece.slot]) continue; // slot terisi, tidak perlu diganti

      // Sudah punya cadangan piece ini siap pakai di inventaris? Langsung equip.
      if (this.adapter.hasItem(piece.item)) {
        await this.adapter.equipItem(piece.item, piece.slot);
        this.metrics.repaired++;
        this.emit('repaired', { piece: piece.item });
        return { action: 'repair', piece: piece.item };
      }

      // Coba craft langsung - kalau bahan iron di inventaris sudah cukup, ini berhasil tanpa
      // perlu ke gudang sama sekali.
      const crafted = await this.adapter.craftItem(piece.item, 1);
      if (crafted) {
        await this.adapter.equipItem(piece.item, piece.slot);
        this.metrics.repaired++;
        this.emit('repaired', { piece: piece.item });
        return { action: 'repair', piece: piece.item };
      }

      // Bahan kurang - ambil iron dari chest gudang yang sudah berisi iron (lihat
      // findMatchingChest, dipakai juga oleh FarmerEngine.autoMatchStorage). Craft baru dicoba
      // lagi tick berikutnya, setelah iron ada di inventaris.
      const chestPos = await this.adapter.findMatchingChest(this.options.ironItemNames);
      if (chestPos) {
        const result = await this.adapter.withdrawFromChest(chestPos, this.options.ironItemNames, piece.ironCost);
        if (result.withdrawn > 0) {
          this.metrics.gathered += result.withdrawn;
          this.emit('gathered', { item: 'iron_ingot', count: result.withdrawn });
          return { action: 'gather_iron', count: result.withdrawn };
        }
      }
      // Tidak ada iron sama sekali (gudang juga kosong) - lewati piece ini, coba piece lain.
    }

    return { action: 'idle' };
  }
}

module.exports = { GearRepairEngine, ARMOR_PIECES };
