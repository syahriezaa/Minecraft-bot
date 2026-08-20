/**
 * @file mobFarmEngine.js
 * @description Engine farm mob untuk zombie/skeleton dengan makan, shield, dan cooldown serangan.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter, distance } = require('./mineflayerRoleAdapter');

const HOSTILE_MOBS = Object.freeze([
  'zombie',
  'zombie_villager',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'spider',
  'creeper'
]);

class MobFarmEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.options = {
      hostileMobs: HOSTILE_MOBS,
      killChamber: null,
      standbyPosition: null,
      retreatPosition: null,
      scanRadius: 16,
      attackRange: 3.6,
      retreatHealth: 8,
      resumeHealth: 14,
      eatFoodThreshold: 14,
      attackCooldownMs: 650,
      weaponNames: ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'diamond_axe', 'iron_axe'],
      shieldName: 'shield',
      ...options
    };
    this.lastAttackAt = 0;
    this.metrics = {
      attacks: 0,
      shieldUses: 0,
      retreats: 0,
      eaten: 0
    };
  }

  isInsideKillChamber(entity) {
    if (!this.options.killChamber || !entity?.position) return true;
    return distance(entity.position, this.options.killChamber.center) <= this.options.killChamber.radius;
  }

  getThreats() {
    const hostile = new Set(this.options.hostileMobs);
    return this.adapter.getEntities()
      .filter(entity => hostile.has(entity.name || entity.type))
      .filter(entity => this.isInsideKillChamber(entity))
      .filter(entity => distance(this.adapter.getPosition(), entity.position) <= this.options.scanRadius)
      .sort((a, b) => this.scoreThreat(b) - this.scoreThreat(a));
  }

  scoreThreat(entity) {
    const type = entity.name || entity.type;
    const d = distance(this.adapter.getPosition(), entity.position);
    let score = Math.max(0, this.options.scanRadius - d);
    if (type === 'creeper') score += 10;
    if (type === 'skeleton' || type === 'stray') score += 6;
    if (d <= this.options.attackRange) score += 8;
    return score;
  }

  async tick() {
    if (this.adapter.getHealth() <= this.options.retreatHealth) {
      if (this.options.retreatPosition) {
        await this.adapter.navigateNear(this.options.retreatPosition, 1);
        this.metrics.retreats++;
        return { action: 'retreat' };
      }
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        return { action: 'eat' };
      }
    }

    if (this.adapter.getFood() <= this.options.eatFoodThreshold) {
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        return { action: 'eat' };
      }
    }

    const target = this.getThreats()[0];
    if (!target) {
      if (this.options.standbyPosition) {
        await this.adapter.navigateNear(this.options.standbyPosition, 1);
        return { action: 'standby' };
      }
      return { action: 'idle' };
    }

    const type = target.name || target.type;
    if ((type === 'skeleton' || type === 'stray') && this.adapter.hasItem(this.options.shieldName)) {
      const equipped = await this.adapter.equipItem(this.options.shieldName, 'off-hand');
      if (equipped && this.adapter.activateShield()) {
        this.metrics.shieldUses++;
      }
    }

    const targetDistance = distance(this.adapter.getPosition(), target.position);
    if (targetDistance > this.options.attackRange) {
      await this.adapter.navigateNear(target.position, Math.max(1, this.options.attackRange - 0.5));
      return { action: 'approach', target: type };
    }

    const now = Date.now();
    if (now - this.lastAttackAt < this.options.attackCooldownMs) {
      return { action: 'cooldown', target: type };
    }

    await this.adapter.equipItem(this.options.weaponNames, 'hand');
    await this.adapter.attack(target);
    this.lastAttackAt = now;
    this.metrics.attacks++;
    this.emit('attacked', { target });
    return { action: 'attack', target: type };
  }
}

module.exports = {
  MobFarmEngine,
  HOSTILE_MOBS
};
