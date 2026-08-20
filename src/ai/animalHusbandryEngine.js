/**
 * @file animalHusbandryEngine.js
 * @description Engine peternakan untuk breeding dan panen hewan tanpa membunuh bayi atau indukan minimum.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter, distance } = require('./mineflayerRoleAdapter');
const { isOutsideArea } = require('./farmerEngine');

const ANIMAL_RULES = Object.freeze({
  cow: { feed: 'wheat', preserveAdults: 2, maxAdults: 8, drops: ['beef', 'leather'] },
  goat: { feed: 'wheat', preserveAdults: 2, maxAdults: 8, drops: [] },
  sheep: { feed: 'wheat', preserveAdults: 2, maxAdults: 8, drops: ['mutton', 'white_wool'] },
  pig: { feed: ['carrot', 'potato', 'beetroot'], preserveAdults: 2, maxAdults: 8, drops: ['porkchop'] },
  chicken: { feed: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'], preserveAdults: 2, maxAdults: 10, drops: ['chicken', 'feather'] }
});

function isBabyEntity(entity) {
  if (!entity) return false;
  if (entity.isBaby === true) return true;
  if (typeof entity.age === 'number' && entity.age < 0) return true;
  if (entity.metadata && Array.isArray(entity.metadata)) {
    return entity.metadata.some(value => value === true && String(entity.name || entity.type).includes('baby'));
  }
  return false;
}

class AnimalHusbandryEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      scanRadius: 24,
      avoidArea: null,
      rules: ANIMAL_RULES,
      maxFeedPerTick: 2,
      maxCullPerTick: 1,
      weaponNames: ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'axe'],
      ...options
    };
    this.metrics = {
      fed: 0,
      culled: 0
    };
  }

  getAnimals() {
    const allowed = new Set(Object.keys(this.options.rules));
    return this.adapter.getEntities()
      .filter(entity => allowed.has(entity.name || entity.type))
      .filter(entity => distance(this.adapter.getPosition(), entity.position) <= this.options.scanRadius)
      // Hewan di dalam area terlarang (mis. area peternakan villager dekat base, sebagian
      // terhalang tembok) dikecualikan sama sekali - jangan terus mencoba mencapainya sia-sia.
      .filter(entity => isOutsideArea(entity.position, this.options.avoidArea));
  }

  groupAdultsByType() {
    const groups = new Map();
    for (const animal of this.getAnimals()) {
      const type = animal.name || animal.type;
      if (!groups.has(type)) groups.set(type, []);
      if (!isBabyEntity(animal)) groups.get(type).push(animal);
    }
    for (const adults of groups.values()) {
      adults.sort((a, b) => distance(this.adapter.getPosition(), a.position) - distance(this.adapter.getPosition(), b.position));
    }
    return groups;
  }

  chooseFeed(rule) {
    const feeds = Array.isArray(rule.feed) ? rule.feed : [rule.feed];
    return feeds.find(feed => this.adapter.hasItem(feed)) || null;
  }

  selectFeedTargets() {
    const targets = [];
    const groups = this.groupAdultsByType();
    for (const [type, adults] of groups.entries()) {
      const rule = this.options.rules[type];
      if (adults.length < 2) continue;
      const feed = this.chooseFeed(rule);
      if (!feed) continue;
      targets.push(...adults.slice(0, 2).map(entity => ({ entity, feed, type })));
      if (targets.length >= this.options.maxFeedPerTick) break;
    }
    return targets.slice(0, this.options.maxFeedPerTick);
  }

  selectCullTargets() {
    const targets = [];
    const groups = this.groupAdultsByType();
    for (const [type, adults] of groups.entries()) {
      const rule = this.options.rules[type];
      const surplus = adults.length - Math.max(rule.preserveAdults, rule.maxAdults);
      if (surplus <= 0) continue;
      targets.push(...adults.slice(-surplus).map(entity => ({ entity, type })));
      if (targets.length >= this.options.maxCullPerTick) break;
    }
    return targets.slice(0, this.options.maxCullPerTick);
  }

  async tick() {
    const feedTargets = this.selectFeedTargets();
    if (feedTargets.length > 0) {
      for (const target of feedTargets) {
        await this.adapter.equipItem(target.feed, 'hand');
        await this.adapter.useOn(target.entity);
        this.metrics.fed++;
        this.emit('fed', target);
      }
      return { action: 'feed', count: feedTargets.length };
    }

    const cullTargets = this.selectCullTargets();
    if (cullTargets.length > 0) {
      await this.adapter.equipItem(this.options.weaponNames, 'hand');
      for (const target of cullTargets) {
        await this.adapter.attack(target.entity);
        this.metrics.culled++;
        this.emit('culled', target);
      }
      return { action: 'cull', count: cullTargets.length };
    }

    return { action: 'idle' };
  }
}

module.exports = {
  AnimalHusbandryEngine,
  ANIMAL_RULES,
  isBabyEntity
};
