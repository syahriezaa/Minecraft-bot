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
      // Titik-titik yang dikelilingi bergantian saat tidak ada ancaman - ditemukan dari keluhan
      // nyata: penjaga yang cuma diam di satu titik (standbyPosition) jarang sekali ketemu mob,
      // karena hanya bereaksi kalau mob kebetulan masuk ke bubble scanRadius di titik itu. Kalau
      // diisi, MENGGANTIKAN standbyPosition (bukan dipakai bersamaan).
      patrolWaypoints: null,
      waypointReachRadius: 3,
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
    this.patrolIndex = 0;
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
      // Mundur JUGA sambil coba makan, bukan salah satu saja - kalau retreat dan makan saling
      // eksklusif, food tidak pernah naik dan health tidak pernah regenerasi alami (Minecraft
      // butuh food tinggi untuk regen), jadi bot macet selamanya di status RETREAT tanpa pernah
      // pulih (bug yang sama persis dengan "tetap berlubang" di FarmerEngine).
      if (this.options.retreatPosition) {
        await this.adapter.navigateNear(this.options.retreatPosition, 1);
        this.metrics.retreats++;
      }
      const ate = await this.adapter.eatBestFood();
      if (ate) {
        this.metrics.eaten++;
        return { action: 'eat' };
      }
      return { action: 'retreat' };
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
      if (this.options.patrolWaypoints && this.options.patrolWaypoints.length > 0) {
        const waypoint = this.options.patrolWaypoints[this.patrolIndex % this.options.patrolWaypoints.length];
        if (distance(this.adapter.getPosition(), waypoint) <= this.options.waypointReachRadius) {
          this.patrolIndex = (this.patrolIndex + 1) % this.options.patrolWaypoints.length;
        }
        const current = this.options.patrolWaypoints[this.patrolIndex % this.options.patrolWaypoints.length];
        await this.adapter.navigateNear(current, 1);
        return { action: 'patrol', waypoint: current };
      }
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
      // GoalFollow DINAMIS, bukan navigateNear/GoalNear ke posisi sesaat - permintaan nyata
      // pemilik: "ketika kena hit dia tidak maju lagi". Target hostile terus bergerak (apalagi
      // bot sendiri kena knockback tiap dipukul), goto() ke titik statis lama jadi mengejar posisi
      // yang sudah basi dan harus menunggu penuh sampai timeout sebelum sempat mencoba lagi - dari
      // luar terlihat seperti "berhenti maju". TIDAK di-await - followEntity cuma memasang goal,
      // pathfinder-nya sendiri yang jalan otomatis di latar belakang lewat physicsTick, BUKAN
      // menunggu sampai tercapai/timeout di sini (versi pertama begitu, malah bikin bot benar-benar
      // diam - lihat komentar lengkap di mineflayerRoleAdapter.js: "tetap diam aja").
      this.adapter.followEntity(target, Math.max(1, this.options.attackRange - 0.5));
      return { action: 'approach', target: type };
    }

    // Sudah dalam attackRange - hentikan goal kejar-kejaran supaya pathfinder tidak menarik bot
    // bergerak SAAT sedang menebas di tempat.
    this.adapter.stopFollowing?.();

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
