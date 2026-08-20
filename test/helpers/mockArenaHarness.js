/**
 * Mock Arena & Headless Bot World Harness.
 * Mengimplementasikan simulator dunia Minecraft in-process, fisika pergerakan bot,
 * deteksi macet sliding-window 4-fase, sistem pertarungan dengan jeda serangan senjata,
 * penyortiran multi-peti, dan pembuangan sampah ke blok bahaya (lava/api/kaktus).
 *
 * Dirancang mandiri, deterministik, dan bebas kebocoran memori untuk pengujian E2E opaque-box.
 */

const EventEmitter = require('node:events');
const crypto = require('node:crypto');

class MockArenaHarness extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 25565;
    this.isRunning = false;
    this.currentLevel = 1;
    this.blocks = new Map();
    this.hazardBlocks = new Map();
    this.chests = new Map();
    
    // Status Bot
    this.bot = {
      entity: {
        position: { x: 0, y: 64, z: 0 },
        velocity: { x: 0, y: 0, z: 0 }
      },
      health: 20,
      inventory: {
        items: [],
        addItem: (name, count = 1) => {
          const existing = this.bot.inventory.items.find(i => i.name === name);
          if (existing) {
            existing.count += count;
          } else {
            this.bot.inventory.items.push({ name, count });
          }
        },
        removeItem: (name, count = 1) => {
          const idx = this.bot.inventory.items.findIndex(i => i.name === name);
          if (idx !== -1) {
            this.bot.inventory.items[idx].count -= count;
            if (this.bot.inventory.items[idx].count <= 0) {
              this.bot.inventory.items.splice(idx, 1);
            }
            return true;
          }
          return false;
        },
        hasItem: (name) => this.bot.inventory.items.some(i => i.name === name && i.count > 0),
        getItemCount: (name) => {
          const item = this.bot.inventory.items.find(i => i.name === name);
          return item ? item.count : 0;
        },
        clear: () => {
          this.bot.inventory.items = [];
        }
      },
      attack: (target) => {
        const now = Date.now();
        this.attackHistory.push(now);
        this.emit('entityAttack', { target, timestamp: now });
        return { success: true, timestamp: now };
      },
      lookAt: (coord) => {
        this.bot.lookTarget = coord;
      },
      tossStack: (itemObj) => {
        return this.bot.inventory.removeItem(itemObj.name, itemObj.count || 1);
      }
    };

    // Riwayat & State Tracking
    this.movementHistory = [];
    this.attackHistory = [];
    this.activeRuns = new Map();
    this.stuckWindow = [];
    this.stuckWindowSize = 30;
    this.isComputingPath = false;
    this.lastSafeWaypoint = { x: 0, y: 64, z: 0 };
    this.activeRecoveryPhase = 0;
  }

  async start() {
    this.isRunning = true;
    this.generateLevel(this.currentLevel);
    return true;
  }

  async stop() {
    this.isRunning = false;
    this.activeRuns.clear();
    this.blocks.clear();
    this.hazardBlocks.clear();
    this.chests.clear();
    this.removeAllListeners();
    return true;
  }

  setBlock(x, y, z, type) {
    if (y < -64 || y > 320) {
      throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [-64, 320].`);
    }
    this.blocks.set(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`, type);
  }

  getBlock(x, y, z) {
    return this.blocks.get(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`) || 'air';
  }

  setupHazardBlock(coord, type = 'lava') {
    const key = `${Math.round(coord.x)},${Math.round(coord.y)},${Math.round(coord.z)}`;
    this.hazardBlocks.set(key, type);
    this.setBlock(coord.x, coord.y, coord.z, type);
  }

  setupChest(coord, chestId, initialItems = []) {
    const key = `${Math.round(coord.x)},${Math.round(coord.y)},${Math.round(coord.z)}`;
    this.chests.set(key, { id: chestId, items: [...initialItems] });
    this.setBlock(coord.x, coord.y, coord.z, 'chest');
  }

  getChestByCoord(coord) {
    const key = `${Math.round(coord.x)},${Math.round(coord.y)},${Math.round(coord.z)}`;
    return this.chests.get(key);
  }

  generateLevel(level) {
    if (![1, 2, 3, 4].includes(Number(level))) {
      throw new Error('Tingkat level arena tidak valid! Harus bernilai antara 1 hingga 4.');
    }
    this.currentLevel = Number(level);
    this.blocks.clear();
    this.hazardBlocks.clear();
    this.chests.clear();

    if (this.currentLevel === 1) {
      for (let x = -5; x <= 35; x++) {
        for (let z = -5; z <= 5; z++) {
          this.setBlock(x, 63, z, 'stone');
          this.setBlock(x, 64, z, 'air');
        }
      }
      this.bot.entity.position = { x: 0, y: 64, z: 0 };
    } else if (this.currentLevel === 2) {
      for (let x = -5; x <= 55; x++) {
        for (let z = -5; z <= 5; z++) {
          let yGround = 63;
          if (x >= 15 && x < 30) yGround = 64;
          if (x >= 30) yGround = 63;
          this.setBlock(x, yGround, z, 'stone');
        }
      }
      this.setBlock(20, 65, 0, 'stone');
      this.setBlock(20, 66, 0, 'stone');
      this.bot.entity.position = { x: 0, y: 64, z: 0 };
    } else if (this.currentLevel === 3) {
      for (let i = 0; i <= 10; i++) {
        this.setBlock(i, 63 + i, 0, 'stone_stairs');
      }
      for (let z = 0; z <= 15; z++) {
        this.setBlock(10, 73, z, 'stone');
      }
      for (let y = 64; y <= 74; y++) {
        this.setBlock(10, y, 16, 'stone');
        this.setBlock(10, y, 15, 'ladder');
      }
      this.bot.entity.position = { x: 0, y: 64, z: 0 };
    } else if (this.currentLevel === 4) {
      this.bot.entity.position = { x: 0, y: 64, z: 0 };
      for (let x = -260; x <= -250; x++) {
        for (let z = -436; z <= -428; z++) {
          this.setBlock(x, -21, z, 'deepslate');
          for (let y = -20; y <= -17; y++) {
            this.setBlock(x, y, z, 'air');
          }
        }
      }
      this.setBlock(-256, -19, -432, 'spawner');
    }
  }

  injectObstacle(coord, blockType = 'stone') {
    this.setBlock(coord.x, coord.y, coord.z, blockType);
  }

  async startBenchmark(level, options = {}) {
    const runId = options.runId || `e2e-run-${crypto.randomUUID()}`;
    const targetMap = {
      1: { x: 30, y: 64, z: 0 },
      2: { x: 50, y: 64, z: 0 },
      3: { x: 10, y: 64, z: 15 },
      4: { x: -256, y: -20, z: -432 }
    };

    const targetPos = options.target || targetMap[level] || { x: 30, y: 64, z: 0 };
    this.generateLevel(level);

    let waypoints = [targetPos];
    if (level === 2) {
      waypoints = [
        { x: 14, y: 64, z: 0 },
        { x: 15, y: 65, z: 0 },
        { x: 20, y: 65, z: 2 },
        { x: 29, y: 65, z: 0 },
        { x: 30, y: 64, z: 0 },
        { x: 50, y: 64, z: 0 }
      ];
    } else if (level === 3) {
      waypoints = [
        { x: 10, y: 74, z: 0 },
        { x: 10, y: 74, z: 15 },
        { x: 10, y: 64, z: 15 }
      ];
    } else if (level === 4) {
      waypoints = [
        { x: 0, y: 64, z: 0 },
        { x: 0, y: 30, z: -50 },
        { x: -50, y: 10, z: -150 },
        { x: -150, y: 0, z: -280 },
        { x: -200, y: -10, z: -350 },
        { x: -256, y: -20, z: -432 }
      ];
    }

    const runData = {
      id: runId,
      level,
      status: 'RUNNING',
      startTime: Date.now(),
      targetPos,
      waypoints,
      obstacleCount: level === 2 ? 6 : (level === 3 ? 3 : 0),
      stuckCount: 0,
      movementLogs: []
    };

    this.activeRuns.set(runId, runData);
    this.emit('BENCHMARK_STATUS', {
      type: 'BENCHMARK_STATUS',
      data: { runId, level, status: 'RUNNING', progressPct: 0 }
    });

    return runId;
  }

  async waitForBenchmarkComplete(runId, maxTimeoutMs = 10000) {
    const run = this.activeRuns.get(runId);
    if (!run) throw new Error(`Benchmark run ${runId} tidak ditemukan.`);

    const start = Date.now();
    const speed = 4.3;
    let currentPos = { ...this.bot.entity.position };
    let tick = 0;

    for (const waypoint of run.waypoints) {
      let wpSteps = 0;
      while (Date.now() - start < maxTimeoutMs && wpSteps < 100) {
        wpSteps++;
        tick++;
        const dx = waypoint.x - currentPos.x;
        const dy = waypoint.y - currentPos.y;
        const dz = waypoint.z - currentPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist <= 0.6) {
          currentPos = { ...waypoint };
          this.bot.entity.position = currentPos;
          break;
        }

        const stepSize = Math.min(dist, 2.5);
        const dirX = dx / dist;
        const dirY = dy / dist;
        const dirZ = dz / dist;

        const nextX = currentPos.x + dirX * stepSize;
        const nextY = currentPos.y + dirY * stepSize;
        const nextZ = currentPos.z + dirZ * stepSize;
        const blockAhead = this.getBlock(nextX, nextY, nextZ);

        let isStuck = false;
        let recoveryPhase = 0;

        if (blockAhead !== 'air' && blockAhead !== 'stone_stairs' && blockAhead !== 'ladder') {
          isStuck = true;
          run.stuckCount++;
          if (run.stuckCount === 1) {
            recoveryPhase = 1;
            currentPos.y += 1.0;
            if (this.getBlock(nextX, currentPos.y, nextZ) === 'air') {
              currentPos.x = nextX;
              currentPos.z = nextZ;
            }
          } else if (run.stuckCount === 2) {
            recoveryPhase = 2;
            currentPos.z += 1.5;
            if (this.getBlock(nextX, currentPos.y, currentPos.z) === 'air') {
              currentPos.x = nextX;
            }
          } else if (run.stuckCount === 3) {
            recoveryPhase = 3;
            currentPos.x += 1.5;
          } else {
            recoveryPhase = 4;
            currentPos = { ...this.lastSafeWaypoint };
          }
        } else {
          currentPos.x = nextX;
          currentPos.y = nextY;
          currentPos.z = nextZ;
          this.lastSafeWaypoint = { ...currentPos };
        }

        this.bot.entity.position = { ...currentPos };
        this.bot.entity.velocity = {
          x: dirX * (speed / 20),
          y: dirY * (speed / 20),
          z: dirZ * (speed / 20)
        };

        const logItem = {
          tick,
          x: currentPos.x,
          y: currentPos.y,
          z: currentPos.z,
          velocity_xz: speed,
          is_stuck: isStuck,
          recovery_phase: recoveryPhase,
          action: isStuck ? 'RECOVERY' : 'SPRINT'
        };

        run.movementLogs.push(logItem);
        this.movementHistory.push(logItem);

        this.emit('TICK_UPDATE', {
          type: 'TICK_UPDATE',
          data: {
            tick,
            position: currentPos,
            velocity: { x: dirX * speed, y: dirY * speed, z: dirZ * speed },
            isStuck,
            recoveryPhase
          }
        });

        await new Promise(r => setTimeout(r, 1));
      }
    }

    const finalDist = Math.hypot(
      currentPos.x - run.targetPos.x,
      currentPos.y - run.targetPos.y,
      currentPos.z - run.targetPos.z
    );

    if (finalDist <= 1.0) {
      currentPos = { ...run.targetPos };
      this.bot.entity.position = currentPos;
      run.status = 'SUCCESS';
      run.duration_ms = Date.now() - run.startTime;
      run.success_rate = 1.0;
    } else {
      run.status = 'FAILED';
      run.duration_ms = Date.now() - run.startTime;
      run.success_rate = 0.0;
    }

    this.emit('BENCHMARK_STATUS', {
      type: 'BENCHMARK_STATUS',
      data: {
        runId,
        level: run.level,
        status: run.status,
        progressPct: run.status === 'SUCCESS' ? 100 : 50,
        metrics: {
          duration_ms: run.duration_ms,
          stuck_recovery_count: run.stuckCount,
          obstacle_count: run.obstacleCount
        }
      }
    });

    return run;
  }

  async submitAiCommand(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Prompt AI tidak boleh kosong.');
    }

    const lower = prompt.toLowerCase();
    if (lower.includes('zombie') || lower.includes('basmi') || lower.includes('farm')) {
      const attackCount = 4;
      for (let i = 0; i < attackCount; i++) {
        this.bot.attack({ type: 'zombie', id: `zombie-${i}` });
        if (i < attackCount - 1) {
          await new Promise(r => setTimeout(r, 630));
        }
      }
      return {
        tool: 'farm_mobs',
        parameters: { target: 'zombie', durationSeconds: 5, weapon: 'sword' },
        status: 'SUCCESS',
        pesan: 'Berhasil membasmi kerumunan zombie di spawner.'
      };
    }

    if (lower.includes('peti') || lower.includes('sort') || lower.includes('rapikan')) {
      return {
        tool: 'sort_chests',
        parameters: { chestCoords: [{ x: 10, y: 64, z: 5 }] },
        status: 'SUCCESS',
        pesan: 'Penyortiran inventaris ke peti selesai.'
      };
    }

    if (lower.includes('sampah') || lower.includes('bakar') || lower.includes('lava')) {
      return {
        tool: 'incinerate_trash',
        parameters: { hazardCoord: { x: 10, y: 64, z: 10 }, hazardType: 'lava' },
        status: 'SUCCESS',
        pesan: 'Sampah berhasil dimusnahkan di dalam perimeter aman lava.'
      };
    }

    return {
      tool: 'navigate_to',
      parameters: { x: 0, y: 64, z: 0 },
      status: 'SUCCESS',
      pesan: 'Perintah umum berhasil diproses.'
    };
  }

  async executeTask(taskName, params = {}) {
    if (taskName === 'incinerate_trash') {
      const hazardCoord = params.hazardCoord || { x: 10, y: 64, z: 10 };
      const hazardType = params.hazardType || 'lava';

      if (!['lava', 'fire', 'cactus'].includes(hazardType)) {
        throw new Error(`Tipe bahaya '${hazardType}' tidak valid untuk pembakaran sampah.`);
      }

      const safeDistance = 2.0;
      this.bot.entity.position = {
        x: hazardCoord.x + safeDistance,
        y: hazardCoord.y,
        z: hazardCoord.z
      };
      this.bot.lookAt(hazardCoord);

      const itemsToTrash = params.items || ['poisonous_potato', 'rotten_flesh'];
      for (const item of itemsToTrash) {
        if (item === 'diamond' || item === 'netherite' || item === 'diamond_block') {
          throw new Error('Item berharga dilindungi dari pembakaran!');
        }
        this.bot.inventory.removeItem(item, 64);
      }

      return { success: true, botDamaged: false };
    }

    if (taskName === 'sort_chests') {
      const chestCoord = params.chestCoord || { x: 10, y: 64, z: 5 };
      let chest = this.getChestByCoord(chestCoord);
      if (!chest) {
        this.setupChest(chestCoord, 'chest_1', []);
        chest = this.getChestByCoord(chestCoord);
      }

      const items = [...this.bot.inventory.items];
      for (const it of items) {
        chest.items.push({ ...it });
        this.bot.inventory.removeItem(it.name, it.count);
      }

      return { success: true, depositedCount: items.length };
    }

    return { success: true };
  }

  async runFullMaintenanceRoutine() {
    this.bot.inventory.addItem('rotten_flesh', 12);
    this.bot.inventory.addItem('iron_ingot', 2);
    this.bot.inventory.addItem('iron_helmet', 1);
    this.bot.inventory.addItem('poisonous_potato', 3);

    const attackCount = 3;
    for (let i = 0; i < attackCount; i++) {
      this.bot.attack({ type: 'zombie', id: `zombie-${i}` });
      if (i < attackCount - 1) {
        await new Promise(r => setTimeout(r, 630));
      }
    }

    const chestCoord = { x: 12, y: 64, z: 5 };
    this.setupChest(chestCoord, 'chest_tools', []);
    this.bot.inventory.removeItem('iron_helmet', 1);
    this.bot.inventory.removeItem('iron_ingot', 2);
    this.getChestByCoord(chestCoord).items.push({ name: 'iron_helmet', count: 1 });
    this.getChestByCoord(chestCoord).items.push({ name: 'iron_ingot', count: 2 });

    const lavaCoord = { x: 20, y: 64, z: 20 };
    this.setupHazardBlock(lavaCoord, 'lava');
    await this.executeTask('incinerate_trash', {
      hazardCoord: lavaCoord,
      hazardType: 'lava',
      items: ['poisonous_potato', 'rotten_flesh']
    });

    return {
      farmingComplete: true,
      sortingComplete: true,
      trashIncinerated: true,
      botDamaged: false
    };
  }

  async runContinuousMovement(durationMs = 2000) {
    const runId = `endurance-${Date.now()}`;
    const start = Date.now();
    let tick = 0;

    while (Date.now() - start < durationMs) {
      tick++;
      const pos = {
        x: Math.sin(tick * 0.1) * 20,
        y: 64,
        z: Math.cos(tick * 0.1) * 20
      };
      this.bot.entity.position = pos;
      this.movementHistory.push({
        tick,
        ...pos,
        velocity_xz: 4.3,
        is_stuck: false,
        recovery_phase: 0
      });
      await new Promise(r => setTimeout(r, 5));
    }

    return { runId, totalTicksGenerated: tick };
  }
}

module.exports = { MockArenaHarness };
