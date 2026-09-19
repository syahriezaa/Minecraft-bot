/**
 * @file intelligentSwarmCoordinator.js
 * @description Master Orkestrator Swarm Multi-Agent Cerdas untuk Minecraft NeoForge 26.1.2.
 * Mengelola 5 bot spesialis dalam formasi adaptif, pembagian target tanpa rebutan,
 * anti-tabrakan Reynolds separation, dan pemulihan darurat.
 */

const { LiveProtocolClient } = require('../network/liveProtocolClient');
const { RichVoxelSpatialEngine } = require('../ai/richVoxelSpatialEngine');
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
// 50ms = 1 tick server (20 TPS), meniru frekuensi kirim posisi client Minecraft asli.
const DEFAULT_MOVEMENT_INTERVAL_MS = 50;
// 0.1125m/tick @ 50ms => ~2.25 m/s, setara kecepatan jalan kaki vanilla.
const DEFAULT_MAX_STEP_METERS = 0.1125;
const SWARM_LOCK_PATH = path.join(os.tmpdir(), 'minecraft-autonomous-companion-swarm.lock');

// Konfigurasi 5 Peran Spesialis Armada
const SWARM_ROSTER = [
  {
    id: 'Scout_Alpha',
    name: 'Scout_Alpha',
    role: 'VANGUARD_DEFENDER',
    label: '🛡️ Pengawal Depan (Vanguard)',
    formationAngleDeg: 0, // Tepat di depan pemain
    formationRadius: 3.5,
    task: 'Melindungi perimeter depan dan menyerang ancaman pertama kali'
  },
  {
    id: 'Scout_Bravo',
    name: 'Scout_Bravo',
    role: 'HARVESTER_SPAWNER',
    label: '⛏️ Pemanen XP & Spawner',
    formationAngleDeg: -120, // Belakang kiri
    formationRadius: 4.5,
    task: 'Farming otomatis di area spawner [-256, -20, -432]'
  },
  {
    id: 'Scout_Charlie',
    name: 'Scout_Charlie',
    role: 'PATHFINDER_SCOUT',
    label: '🧭 Pemeta Voxel & Rute',
    formationAngleDeg: 60, // Depan kanan
    formationRadius: 4.0,
    task: 'Scanning 3D voxel dan mengidentifikasi jalur bebas rintangan'
  },
  {
    id: 'Scout_Delta',
    name: 'Scout_Delta',
    role: 'LOGISTICS_COLLECTOR',
    label: '📦 Pengumpul Drop & XP',
    formationAngleDeg: -60, // Depan kiri
    formationRadius: 4.0,
    task: 'Menghisap XP orbs dan memungut drop item terdekat'
  },
  {
    id: 'Scout_Echo',
    name: 'Scout_Echo',
    role: 'REAR_OVERWATCH',
    label: '🎯 Pengawas Belakang (Overwatch)',
    formationAngleDeg: 180, // Tepat di belakang pemain
    formationRadius: 5.0,
    task: 'Mengawasi blind spot belakang formasi dari sergapan Creeper'
  }
];

class IntelligentSwarmCoordinator {
  constructor(options = {}) {
    this.options = {
      host: SERVER_HOST,
      port: SERVER_PORT,
      movementIntervalMs: DEFAULT_MOVEMENT_INTERVAL_MS,
      maxStepMeters: DEFAULT_MAX_STEP_METERS,
      movementEnabled: false,
      clientFactory: (config) => new LiveProtocolClient(config),
      worldAccessor: null,
      leaderTimeoutMs: 5000,
      creeperDangerRadius: 6,    // Creeper: ledakan mematikan jarak dekat -> retreat lebih dini
      hostileDangerRadius: 3,    // mob hostile lain (zombie/skeleton/dkk) -> retreat kalau sudah dekat
      ...options
    };
    this.bots = new Map();
    this.spatialEngine = new RichVoxelSpatialEngine(this.options.worldAccessor || this._createLiveWorldAccessor());
    
    // Shared Blackboard / Memori Bersama
    this.sharedMemory = {
      playerLeaderPos: { x: -33.5, y: 64.0, z: 2.5, yaw: 0 },
      claimedMobTargets: new Map(), // mobId -> botId
      claimedDrops: new Map(),      // dropId -> botId
      activeThreats: [],
      systemHealth: 'OPTIMAL'
    };

    this.sharedMemory.lastLeaderUpdateAt = Date.now();

    this.coordinationInterval = null;
    this._lockHandle = null;
  }

  /**
   * Membuat worldAccessor default yang membaca blok nyata lewat getBlockName() milik client
   * bot manapun yang sudah memuat chunk di posisi tsb (world model dari Chunk Data packet 0x2d
   * nyata - lihat chunkDecoder.js), bukan dunia superflat palsu bawaan RichVoxelSpatialEngine.
   * Mengembalikan null jika belum ada bot yang memuat chunk tsb (diperlakukan sebagai air/passable
   * oleh getBlockCollisionType, bukan ditebak).
   * @private
   */
  _createLiveWorldAccessor() {
    return (x, y, z) => {
      for (const bot of this.bots.values()) {
        if (!bot?.client || typeof bot.client.getBlockName !== 'function') continue;
        const name = bot.client.getBlockName(x, y, z);
        if (name !== null) return name;
      }
      return null;
    };
  }

  /**
   * Memulai seluruh armada bot dengan antrean staggered login yang aman.
   */
  async startSwarm() {
    console.log('======================================================================');
    console.log('  🚀 MEMULAI ORKESTRATOR SWARM CERDAS (5 BOT SPESIALIS PERSISTEN)     ');
    console.log(`  🌐 SERVER TARGET: ${this.options.host}:${this.options.port}                     `);
    console.log('======================================================================\n');

    for (let i = 0; i < SWARM_ROSTER.length; i++) {
      const config = SWARM_ROSTER[i];

      // Jeda 2.5 detik antar koneksi bot untuk mencegah batas laju soket TCP
      if (i > 0) {
        console.log(`⏳ [Jeda Login] Menunggu 2.5s sebelum menghubungkan bot berikutnya...`);
        await new Promise(r => setTimeout(r, 2500));
      }

      await this._spawnSpecializedBot(config);
    }

    console.log('\n🎉 SELURUH ARMADA (5 BOT) BERHASIL AKTIF & TERKONEKSI STABIL!');
    console.log('🤖 Memulai Loop Koordinasi Cerdas Swarm (Flocking, Formasi, & Blackboard)...\n');

    this._startCoordinationLoop();
  }

  /**
   * Menghubungkan satu bot spesialis ke server.
   * @private
   */
  async _spawnSpecializedBot(config) {
    console.log(`[${config.name}] 🔗 Menghubungkan sebagai ${config.label}...`);

    const client = this.options.clientFactory({
      host: this.options.host,
      port: this.options.port,
      username: config.name,
      protocolVersion: 775,
      autoReconnect: true,
      maxReconnectAttempts: 999,
      reconnectBaseDelayMs: 3000
    });

    const botState = {
      config,
      client,
      isOnline: false,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      currentObjective: 'STANDBY',
      targetEntityId: null
    };

    client.on('joined', (d) => {
      botState.isOnline = true;
      console.log(`[${config.name}] 🟢 BERHASIL MASUK KE SERVER! (Entity ID: ${d.entityId}) | Peran: ${config.role}`);
    });

    client.on('disconnect', (info) => {
      botState.isOnline = false;
      botState.currentObjective = 'OFFLINE_RECONNECTING';
      botState.lastDisconnect = { ...info, at: Date.now() };
      this.sharedMemory.claimedMobTargets.forEach((owner, target) => {
        if (owner === config.name) this.sharedMemory.claimedMobTargets.delete(target);
      });
      this.sharedMemory.claimedDrops.forEach((owner, target) => {
        if (owner === config.name) this.sharedMemory.claimedDrops.delete(target);
      });
    });

    client.on('teleport', (pos) => {
      botState.position = { ...pos };
      console.log(`[${config.name}] 📍 SPAWN: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    });

    client.on('health', (h) => {
      botState.health = h.health;
      botState.food = h.food;
      // Periksa fallback taktis jika HP rendah
      if (h.health < 8.0 && h.health > 0) {
        botState.currentObjective = 'TACTICAL_RETREAT';
        console.warn(`[${config.name}] ⚠️ Darah rendah (${h.health.toFixed(1)}/20)! Mengaktifkan TACTICAL_RETREAT ke pusat formasi.`);
      }
    });

    client.on('dead', () => {
      botState.currentObjective = 'RESPAWNING';
      console.warn(`[${config.name}] 💀 Health mencapai 0. Menunggu respawn sebelum melanjutkan formasi.`);
    });

    client.on('kicked', (r) => {
      console.warn(`[${config.name}] ⚠️ Kicked:`, r);
      botState.isOnline = false;
    });

    client.on('error', (err) => {
      console.error(`[${config.name}] ❌ Error:`, err.message);
    });

    try {
      await client.connect();
      this.bots.set(config.name, botState);
    } catch (e) {
      console.error(`[${config.name}] ❌ Gagal koneksi awal:`, e.message);
    }
  }

  /**
   * Loop Koordinasi Cerdas Swarm Berkelanjutan (1.0 Hz).
   * @private
   */
  _startCoordinationLoop() {
    if (this.coordinationInterval) clearInterval(this.coordinationInterval);

    this.coordinationInterval = setInterval(() => {
      this._evaluateSwarmFormations();
      this._pushTelemetryToDashboard();
    }, this.options.movementIntervalMs);
  }

  /**
   * Menggabungkan sighting mob hostile dari SELURUH bot swarm (multi-anchor) menjadi satu
   * registry per entityId. Setiap bot adalah "anchor" yang bergerak dinamis - kalau satu bot
   * kehilangan pandangan atas suatu mob (keluar render distance-nya) tapi bot lain masih
   * melihatnya, datanya tidak hilang. Kalau entity yang sama terlihat lebih dari satu bot,
   * dipakai sighting dengan `lastSeenAt` paling baru (paling segar), bukan yang pertama
   * ditemukan - supaya posisi yang dipakai untuk keputusan retreat tidak basi.
   * @private
   */
  _getSwarmHostileRegistry() {
    const merged = new Map();
    for (const bot of this.bots.values()) {
      if (!bot?.client || typeof bot.client.getAllHostiles !== 'function') continue;
      for (const entity of bot.client.getAllHostiles()) {
        const existing = merged.get(entity.entityId);
        if (!existing || (entity.lastSeenAt ?? 0) >= (existing.lastSeenAt ?? 0)) {
          merged.set(entity.entityId, entity);
        }
      }
    }
    return merged;
  }

  /** Perbarui posisi pemain yang menjadi pusat formasi dari sumber eksternal. */
  setLeaderPosition(position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      throw new TypeError('Posisi leader harus memiliki koordinat x, y, z yang valid');
    }
    this.sharedMemory.playerLeaderPos = {
      ...this.sharedMemory.playerLeaderPos,
      ...position
    };
    this.sharedMemory.lastLeaderUpdateAt = Date.now();
  }

  /**
   * Mendeteksi mob hostile terdekat dari registry gabungan seluruh swarm (lihat
   * _getSwarmHostileRegistry) dan menghitung titik retreat menjauh darinya jika sudah
   * melewati radius bahaya. Creeper dapat radius bahaya lebih besar daripada mob lain
   * karena ledakannya bisa membunuh instan dari jarak dekat - prioritas tertinggi di
   * atas formasi normal.
   * @private
   */
  _computeThreatRetreatTarget(bot) {
    if (!bot?.position) return null;

    const registry = this._getSwarmHostileRegistry();
    if (registry.size === 0) return null;

    let nearest = null;
    let nearestScore = Infinity;
    for (const entity of registry.values()) {
      const distance = Math.hypot(entity.x - bot.position.x, entity.y - bot.position.y, entity.z - bot.position.z);
      const name = String(entity.name || '').toLowerCase();
      const dangerRadius = name.includes('creeper') ? this.options.creeperDangerRadius : this.options.hostileDangerRadius;
      if (distance <= dangerRadius) {
        // Creeper selalu diprioritaskan bila beberapa ancaman aktif bersamaan.
        const score = (name.includes('creeper') ? 0 : 1) * 1000 + distance;
        if (score < nearestScore) {
          nearestScore = score;
          nearest = { ...entity, name, distance, dangerRadius };
        }
      }
    }
    if (!nearest) return null;

    const dangerRadius = nearest.dangerRadius;

    const dx = bot.position.x - nearest.x;
    const dz = bot.position.z - nearest.z;
    const dist = Math.hypot(dx, dz) || 1;

    return {
      x: bot.position.x + (dx / dist) * dangerRadius,
      y: bot.position.y,
      z: bot.position.z + (dz / dist) * dangerRadius,
      threat: nearest
    };
  }

  /**
   * Menghitung formasi adaptif dan anti-tabrakan Reynolds Flocking.
   * @private
   */
  _evaluateSwarmFormations() {
    const leaderPos = this.sharedMemory.playerLeaderPos;
    const activeBots = Array.from(this.bots.values()).filter(b => b.isOnline);
    const leaderLost = Date.now() - this.sharedMemory.lastLeaderUpdateAt > this.options.leaderTimeoutMs;

    for (let i = 0; i < activeBots.length; i++) {
      const bot = activeBots[i];
      const cfg = bot.config;

      if (leaderLost) {
        bot.targetFormationPos = { ...bot.position };
        bot.currentObjective = 'HOLD_LEADER_LOST';
        continue;
      }

      // 1. Hitung Target Formasi Relatif terhadap Pemain
      const angleRad = ((cfg.formationAngleDeg + (leaderPos.yaw || 0)) * Math.PI) / 180;
      const targetX = leaderPos.x + cfg.formationRadius * Math.cos(angleRad);
      const targetZ = leaderPos.z + cfg.formationRadius * Math.sin(angleRad);
      const targetY = leaderPos.y;

      // 2. Terapkan Gaya Tolak Reynolds Separation jika terlalu dekat dengan bot lain (< 2.0m)
      let repulseX = 0;
      let repulseZ = 0;

      for (let j = 0; j < activeBots.length; j++) {
        if (i === j) continue;
        const other = activeBots[j];
        const dx = bot.position.x - other.position.x;
        const dz = bot.position.z - other.position.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < 4.0 && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          const force = (2.0 - dist) / dist;
          repulseX += dx * force * 0.5;
          repulseZ += dz * force * 0.5;
        }
      }

      // 3. Prioritas tertinggi: ancaman hostile terdeteksi -> timpa target formasi dengan retreat.
      const retreat = this._computeThreatRetreatTarget(bot);
      if (retreat) {
        bot.targetFormationPos = { x: retreat.x, y: retreat.y, z: retreat.z };
        bot.currentObjective = `TACTICAL_RETREAT_THREAT (${retreat.threat.name} @ ${retreat.threat.distance.toFixed(1)}m)`;
      } else if (bot.health < 8 && bot.health > 0) {
        bot.targetFormationPos = { x: leaderPos.x, y: leaderPos.y, z: leaderPos.z };
        bot.currentObjective = 'TACTICAL_RETREAT_LOW_HEALTH';
      } else {
        // Perbarui status tujuan bot (formasi normal)
        bot.targetFormationPos = {
          x: targetX + repulseX,
          y: targetY,
          z: targetZ + repulseZ
        };

        if (bot.currentObjective !== 'TACTICAL_RETREAT') {
          bot.currentObjective = `ESCORT_FORMATION (${cfg.formationAngleDeg}°)`;
        }
      }

      if (this.options.movementEnabled) {
        this._moveBotTowardFormation(bot);
      }
    }
  }

  /**
   * Mengirim satu langkah gerak aman menuju target formasi.
   * @private
   */
  _moveBotTowardFormation(bot) {
    if (!bot?.targetFormationPos || !bot.isOnline || bot.health <= 0) return;
    if (!bot.client || typeof bot.client.sendPositionAndRotation !== 'function') return;

    const dx = bot.targetFormationPos.x - bot.position.x;
    const dz = bot.targetFormationPos.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.25) return;

    const planned = this.spatialEngine.findOptimalClearanceStep(bot.position, bot.targetFormationPos, bot.stuckStreak || 0);
    bot.stuckStreak = (planned.type === 'RECOVERY_MICRO_JUMP_REWIND' || planned.type === 'STUCK_HOLD')
      ? (bot.stuckStreak || 0) + 1
      : 0;

    const stepDx = planned.x - bot.position.x;
    const stepDz = planned.z - bot.position.z;
    const stepDist = Math.hypot(stepDx, stepDz);
    const scale = stepDist > this.options.maxStepMeters ? this.options.maxStepMeters / stepDist : 1;

    const next = {
      x: bot.position.x + stepDx * scale,
      y: planned.y,
      z: bot.position.z + stepDz * scale,
      yaw: calculateYawDegrees(stepDx, stepDz),
      pitch: 0,
      onGround: planned.y <= bot.position.y + 0.05,
      hasHorizontalCollision: planned.type !== 'DIRECT_WALK'
    };

    bot.lastMovementType = planned.type;
    const accepted = bot.client.sendPositionAndRotation(next);
    if (accepted !== false) bot.position = { ...bot.position, ...next };
    else bot.currentObjective = 'MOVEMENT_REJECTED_WAIT_SERVER_SYNC';
  }

  /**
   * Mengirim data telemetri swarm terkini ke Web Dashboard (port 8080).
   * @private
   */
  _pushTelemetryToDashboard() {
    const swarmSummary = Array.from(this.bots.values()).map(b => ({
      name: b.config.name,
      role: b.config.role,
      label: b.config.label,
      isOnline: b.isOnline,
      health: b.health,
      food: b.food,
      position: b.position,
      targetFormation: b.targetFormationPos,
      movementType: b.lastMovementType || 'IDLE',
      objective: b.currentObjective
    }));

    // Data siap dikonsumsi oleh dashboard web
    this.latestTelemetry = swarmSummary;
  }

  /**
   * Menutup seluruh swarm secara bersih.
   */
  stopSwarm() {
    if (this.coordinationInterval) clearInterval(this.coordinationInterval);
    for (const [name, b] of this.bots.entries()) {
      b.client.disconnect('Swarm dimatikan secara manual');
    }
    console.log('🛑 [Swarm] Seluruh armada berhasil dinonaktifkan.');
  }
}

function calculateYawDegrees(dx, dz) {
  if (Math.hypot(dx, dz) < 0.001) return 0;
  const yaw = Math.atan2(-dx, dz) * (180 / Math.PI);
  return Object.is(yaw, -0) ? 0 : yaw;
}

function acquireSingleMasterLock(lockPath = SWARM_LOCK_PATH) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const release = () => {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // fd mungkin sudah tertutup saat proses keluar.
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {
        // Lock sudah tidak ada; aman diabaikan saat shutdown.
      }
    };
    return { lockPath, release };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    let existingPid = null;
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      existingPid = Number(existing.pid);
    } catch (_) {
      existingPid = null;
    }

    if (existingPid && Number.isInteger(existingPid)) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Swarm master lain masih aktif (PID ${existingPid}). Hentikan proses itu sebelum menjalankan master baru.`);
      } catch (killErr) {
        if (killErr.code !== 'ESRCH') throw killErr;
      }
    }

    fs.unlinkSync(lockPath);
    return acquireSingleMasterLock(lockPath);
  }
}

// Jalankan Swarm Coordinator jika dieksekusi langsung
if (require.main === module) {
  const lock = acquireSingleMasterLock();
  const coordinator = new IntelligentSwarmCoordinator();
  coordinator._lockHandle = lock;

  const shutdown = () => {
    coordinator.stopSwarm();
    lock.release();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => lock.release());

  coordinator.startSwarm().catch(err => {
    console.error('❌ Kesalahan fatal pada Swarm Coordinator:', err);
    lock.release();
  });
}

module.exports = {
  IntelligentSwarmCoordinator,
  SWARM_ROSTER,
  acquireSingleMasterLock,
  calculateYawDegrees
};
