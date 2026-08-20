const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const {
  IntelligentSwarmCoordinator,
  acquireSingleMasterLock,
  calculateYawDegrees
} = require('../../src/swarm/intelligentSwarmCoordinator');

class DummyClient extends EventEmitter {
  constructor() {
    super();
    this.sentPositions = [];
  }

  sendPositionAndRotation(pos) {
    this.sentPositions.push(pos);
  }
}

describe('IntelligentSwarmCoordinator movement actuator', () => {
  it('tidak boleh mengirim paket movement dari loop formasi jika movementEnabled belum aktif', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator();

    coordinator.bots.set('Scout_Test', {
      config: { name: 'Scout_Test', role: 'TEST', formationAngleDeg: 0, formationRadius: 3 },
      client,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      currentObjective: 'STANDBY'
    });

    coordinator._evaluateSwarmFormations();

    assert.equal(client.sentPositions.length, 0);
    assert.ok(coordinator.bots.get('Scout_Test').targetFormationPos);
  });

  it('harus mengirim langkah posisi aman menuju target formasi', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.3,
      worldAccessor: (x, y) => {
        if (y < 63) return 'stone';
        if (y === 63) return 'grass_block';
        return 'air';
      }
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      targetFormationPos: { x: 5, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    coordinator._moveBotTowardFormation(bot);

    assert.equal(client.sentPositions.length, 1);
    const sent = client.sentPositions[0];
    assert.ok(Math.hypot(sent.x, sent.z) <= 0.3001, 'Langkah harus dibatasi maxStepMeters');
    assert.equal(sent.y, 64);
    assert.equal(sent.onGround, true);
    assert.equal(bot.lastMovementType, 'DIRECT_WALK');
  });

  it('harus menghindari obstacle memakai RichVoxelSpatialEngine sebelum mengirim posisi', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.8,
      worldAccessor: (x, y) => {
        if (x === 1 && y >= 64) return 'stone';
        if (y < 63) return 'stone';
        if (y === 63) return 'grass_block';
        return 'air';
      }
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0.2, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      targetFormationPos: { x: 2, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    coordinator._moveBotTowardFormation(bot);

    assert.equal(client.sentPositions.length, 1);
    assert.notEqual(bot.lastMovementType, 'DIRECT_WALK');
    assert.notEqual(Math.round(client.sentPositions[0].z * 100) / 100, 0, 'Langkah harus membuat offset Z untuk menghindari tembok');
  });

  it('harus menghitung yaw stabil dari vektor langkah', () => {
    assert.equal(calculateYawDegrees(0, 1), 0);
    assert.equal(calculateYawDegrees(1, 0), -90);
    assert.equal(calculateYawDegrees(-1, 0), 90);
  });

  it('default movementIntervalMs harus mendekati tick rate server (<=100ms) agar movement tidak patah-patah', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    assert.ok(
      coordinator.options.movementIntervalMs <= 100,
      `movementIntervalMs terlalu jarang (${coordinator.options.movementIntervalMs}ms), client asli mengirim posisi tiap tick (50ms)`
    );
  });

  it('default maxStepMeters harus proporsional dengan movementIntervalMs sehingga kecepatan tetap setara jalan kaki vanilla (~2.2 m/s)', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const speedMetersPerSecond = coordinator.options.maxStepMeters / (coordinator.options.movementIntervalMs / 1000);
    assert.ok(
      speedMetersPerSecond >= 1.8 && speedMetersPerSecond <= 2.6,
      `Kecepatan efektif ${speedMetersPerSecond.toFixed(2)} m/s di luar rentang jalan kaki natural (1.8-2.6 m/s)`
    );
  });

  it('harus menandai hasHorizontalCollision true ketika spatial engine terpaksa detour karena rintangan', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.8,
      worldAccessor: (x, y) => {
        if (x === 1 && y >= 64) return 'stone';
        if (y < 63) return 'stone';
        if (y === 63) return 'grass_block';
        return 'air';
      }
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0.2, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      targetFormationPos: { x: 2, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    coordinator._moveBotTowardFormation(bot);

    assert.equal(client.sentPositions[0].hasHorizontalCollision, true);
  });

  it('worldAccessor default (tanpa opsi eksplisit) harus membaca blok nyata lewat getBlockName milik client bot yang terhubung, bukan dunia superflat palsu', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const fakeClient = {
      getBlockName: (x, y, z) => (x === 5 && y === 10 && z === 5) ? 'deepslate' : null
    };
    coordinator.bots.set('Scout_Test', { client: fakeClient });

    assert.equal(coordinator.spatialEngine.world(5, 10, 5), 'deepslate');
  });

  it('worldAccessor default harus mengembalikan null jika belum ada bot yang memuat chunk di posisi tsb', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const fakeClient = { getBlockName: () => null };
    coordinator.bots.set('Scout_Test', { client: fakeClient });

    assert.equal(coordinator.spatialEngine.world(999, 999, 999), null);
  });

  it('harus menandai hasHorizontalCollision false ketika jalur langsung bebas rintangan', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.3,
      worldAccessor: (x, y) => {
        if (y < 63) return 'stone';
        if (y === 63) return 'grass_block';
        return 'air';
      }
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      targetFormationPos: { x: 5, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    coordinator._moveBotTowardFormation(bot);

    assert.equal(client.sentPositions[0].hasHorizontalCollision, false);
  });

  it('bot.stuckStreak harus naik saat macet berturut-turut dan berhenti eskalasi Y (STUCK_HOLD) - mencegah bug bot "terbang" tanpa batas', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.8,
      worldAccessor: () => 'stone' // padat total di semua arah -> selalu macet
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      targetFormationPos: { x: 10, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    for (let i = 0; i < 5; i++) {
      coordinator._moveBotTowardFormation(bot);
    }

    assert.ok(bot.stuckStreak >= 2, `stuckStreak harus naik setelah macet berulang, dapat ${bot.stuckStreak}`);
    // Boleh naik sedikit (maks 2x percobaan mikro-lompat sebelum STUCK_HOLD aktif), tapi tidak boleh
    // terus naik tanpa batas (bug nyata sebelumnya: Y bisa mencapai >1000 setelah banyak iterasi).
    const lastSent = client.sentPositions[client.sentPositions.length - 1];
    assert.ok(lastSent.y <= 64 + 2, `Y harus dibatasi (maks 2 lompatan mikro), dapat ${lastSent.y}`);
    const secondToLast = client.sentPositions[client.sentPositions.length - 2];
    assert.equal(lastSent.y, secondToLast.y, 'begitu STUCK_HOLD aktif, Y tidak boleh berubah lagi di iterasi berikutnya');
  });

  it('bot.stuckStreak harus reset ke 0 begitu langkah berhasil (DIRECT_WALK) lagi', () => {
    const client = new DummyClient();
    const coordinator = new IntelligentSwarmCoordinator({
      maxStepMeters: 0.8,
      worldAccessor: (x, y) => {
        if (y < 63) return 'stone';
        if (y === 63) return 'grass_block';
        return 'air';
      }
    });

    const bot = {
      config: { name: 'Scout_Test', role: 'TEST' },
      client,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20,
      food: 20,
      stuckStreak: 3,
      targetFormationPos: { x: 10, y: 64, z: 0 },
      currentObjective: 'ESCORT_FORMATION'
    };

    coordinator._moveBotTowardFormation(bot);

    assert.equal(bot.stuckStreak, 0);
  });
});

describe('IntelligentSwarmCoordinator hostile threat retreat (agregasi multi-anchor)', () => {
  // hostiles: array {entityId, name, x, y, z, lastSeenAt} - TANPA distance, karena sekarang
  // dihitung oleh coordinator sendiri dari posisi tiap bot (bukan dari sudut pandang satu client).
  function makeBotWithHostiles(hostiles, position = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }) {
    const client = new DummyClient();
    client.getAllHostiles = () => hostiles;
    return {
      config: { name: 'Scout_Test', role: 'TEST', formationAngleDeg: 0, formationRadius: 3 },
      client,
      isOnline: true,
      position,
      health: 20,
      food: 20,
      currentObjective: 'STANDBY'
    };
  }

  it('tanpa hostile terdekat, formasi normal tetap dipakai (tidak override target)', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const bot = makeBotWithHostiles([]);
    coordinator.bots.set('Scout_Test', bot);

    coordinator._evaluateSwarmFormations();

    assert.match(bot.currentObjective, /^ESCORT_FORMATION/);
  });

  it('Creeper dalam radius bahaya (default 6 blok) harus memicu retreat menjauh, walau jaraknya di luar radius mob biasa', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const bot = makeBotWithHostiles([
      { entityId: 1, name: 'creeper', x: 5, y: 64, z: 0, lastSeenAt: Date.now() } // 5 blok
    ]);
    coordinator.bots.set('Scout_Test', bot);

    coordinator._evaluateSwarmFormations();

    assert.match(bot.currentObjective, /TACTICAL_RETREAT_THREAT/);
    assert.match(bot.currentObjective, /creeper/);
    // target retreat harus menjauhi creeper (creeper di +X, bot harus diarahkan ke -X)
    assert.ok(bot.targetFormationPos.x < bot.position.x, 'target retreat harus menjauh dari arah creeper');
  });

  it('mob hostile biasa (bukan creeper) baru memicu retreat kalau lebih dekat dari radius bahaya generik (default 3 blok)', () => {
    const coordinator = new IntelligentSwarmCoordinator();
    const botFar = makeBotWithHostiles([
      { entityId: 2, name: 'zombie', x: 5, y: 64, z: 0, lastSeenAt: Date.now() } // di luar radius generik 3 blok
    ]);
    coordinator.bots.set('Scout_Test', botFar);
    coordinator._evaluateSwarmFormations();
    assert.match(botFar.currentObjective, /^ESCORT_FORMATION/, 'zombie 5 blok belum cukup dekat untuk retreat');

    const botNear = makeBotWithHostiles([
      { entityId: 3, name: 'zombie', x: 2, y: 64, z: 0, lastSeenAt: Date.now() }
    ]);
    coordinator.bots.set('Scout_Test2', botNear);
    coordinator._evaluateSwarmFormations();
    assert.match(botNear.currentObjective, /TACTICAL_RETREAT_THREAT/);
  });

  it('bot A harus tetap retreat dari threat yang HANYA dilihat bot B (multi-anchor: threat dari satu bot mempengaruhi keputusan bot lain)', () => {
    const coordinator = new IntelligentSwarmCoordinator();

    const clientA = new DummyClient();
    clientA.getAllHostiles = () => []; // bot A sendiri tidak melihat apapun

    const botA = {
      config: { name: 'Scout_A', role: 'TEST', formationAngleDeg: 0, formationRadius: 3 },
      client: clientA,
      isOnline: true,
      position: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
      health: 20, food: 20, currentObjective: 'STANDBY'
    };

    // bot B ada di tempat lain, tapi DIA yang melihat creeper - posisi creeper itu kebetulan
    // dekat dengan bot A (bukan bot B), membuktikan agregasinya benar-benar dipakai lintas bot.
    const botB = makeBotWithHostiles(
      [{ entityId: 99, name: 'creeper', x: 4, y: 64, z: 0, lastSeenAt: Date.now() }],
      { x: 50, y: 64, z: 50, yaw: 0, pitch: 0 }
    );

    coordinator.bots.set('Scout_A', botA);
    coordinator.bots.set('Scout_B', botB);

    coordinator._evaluateSwarmFormations();

    assert.match(botA.currentObjective, /TACTICAL_RETREAT_THREAT/, 'bot A harus retreat meski client-nya sendiri tidak melihat creeper');
  });

  it('kalau entity yang sama terlihat 2 bot dengan lastSeenAt berbeda, posisi TERBARU yang dipakai (bukan yang pertama ditemukan)', () => {
    const coordinator = new IntelligentSwarmCoordinator();

    const staleClient = new DummyClient();
    staleClient.getAllHostiles = () => [
      { entityId: 7, name: 'creeper', x: 100, y: 64, z: 100, lastSeenAt: 1000 } // posisi lama, jauh dari bot manapun
    ];
    const freshClient = new DummyClient();
    freshClient.getAllHostiles = () => [
      { entityId: 7, name: 'creeper', x: 4, y: 64, z: 0, lastSeenAt: 5000 } // posisi baru, dekat bot uji
    ];

    const observerA = {
      config: { name: 'Observer_A', role: 'TEST', formationAngleDeg: 0, formationRadius: 3 },
      client: staleClient, isOnline: true,
      position: { x: 200, y: 64, z: 200, yaw: 0, pitch: 0 }, health: 20, food: 20, currentObjective: 'STANDBY'
    };
    const observerB = {
      config: { name: 'Observer_B', role: 'TEST', formationAngleDeg: 0, formationRadius: 3 },
      client: freshClient, isOnline: true,
      position: { x: 200, y: 64, z: 200, yaw: 0, pitch: 0 }, health: 20, food: 20, currentObjective: 'STANDBY'
    };
    const botUnderTest = makeBotWithHostiles([], { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 });

    coordinator.bots.set('Observer_A', observerA);
    coordinator.bots.set('Observer_B', observerB);
    coordinator.bots.set('Scout_Test', botUnderTest);

    coordinator._evaluateSwarmFormations();

    assert.match(botUnderTest.currentObjective, /TACTICAL_RETREAT_THREAT/, 'harus pakai posisi terbaru (dekat), bukan posisi lama (jauh)');
  });
});

describe('IntelligentSwarmCoordinator single-master lock', () => {
  it('harus menolak lock kedua saat lock pertama masih aktif', () => {
    const lockPath = `/tmp/minecraft-autonomous-companion-test-${process.pid}.lock`;
    const first = acquireSingleMasterLock(lockPath);

    try {
      assert.throws(
        () => acquireSingleMasterLock(lockPath),
        /Swarm master lain masih aktif/
      );
    } finally {
      first.release();
    }
  });
});
