/**
 * @file farmerEngine.js
 * @description Engine pertanian untuk panen, tanam ulang, dan deposit hasil.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter, distance } = require('./mineflayerRoleAdapter');

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
      scanRadius: 32,
      harvestBatchSize: 1,
      plantBatchSize: 1,
      depositChest: null,
      depositWhenSlotsFreeBelow: 4,
      autoEatFoodThreshold: 14,
      ...options
    };
    this.metrics = {
      harvested: 0,
      planted: 0,
      deposited: 0,
      eaten: 0
    };
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
      .sort((a, b) => distance(this.adapter.getPosition(), a.position) - distance(this.adapter.getPosition(), b.position));
  }

  findPlantingSpots() {
    const farmland = this.adapter
      .findBlocksByNames(['farmland', 'soul_sand'], { maxDistance: this.options.scanRadius })
      .filter(block => isInsideArea(block.position, this.options.farmArea));

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
    for (const rule of Object.values(CROP_RULES)) {
      if (this.adapter.hasItem(rule.seed)) return rule.seed;
    }
    return null;
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
    for (const spot of spots) {
      const seed = this.chooseSeedFor(spot);
      if (!seed) break;
      const planted = await this.adapter.placeSeed(spot, seed);
      if (planted) {
        this.metrics.planted++;
        this.emit('planted', { seed, position: spot.position });
        return { action: 'plant', seed };
      }
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
  isInsideArea
};
