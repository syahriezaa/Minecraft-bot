const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { ROLE_SCRIPTS, StorageRoomConstructionCoordinator } = require('../../src/ai/storageRoomConstructionCoordinator');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { GlobalSwarmOrchestrator } = require('../../src/ai/globalSwarmOrchestrator');

function fakeSpawn() {
  const children = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 7000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => child.emit('exit', 0, signal);
    children.push({ child, file, args, options });
    return child;
  };
  return { children, spawnProcess };
}

function childFor(fake, predicate) {
  const match = fake.children.find(predicate);
  assert.ok(match, 'child role yang diminta harus dibuat');
  return match;
}

test('construction lifecycle menyiapkan pemasang peti tanpa mengikat miner atau materials', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({
    spawnProcess: fake.spawnProcess,
    root: '/tmp/storage-room-coordinator-test'
  });
  const result = coordinator.start({
    builderWorkerCount: 4,
    landscaperWorkerCount: 1,
    roleStartStaggerMs: 0,
    gathererCount: 8,
    materialsWorkerCount: 8,
    mode: 'miner_only'
  });

  assert.equal(result.started, true);
  assert.equal(result.status.phase, 'BUILDING_AND_LANDSCAPING');
  assert.deepEqual(Object.keys(ROLE_SCRIPTS).sort(), ['builder', 'chestInstaller', 'landscaper']);
  assert.equal(fake.children.length, 2);
  assert.deepEqual(Object.keys(coordinator.getStatus().children).sort(), ['builder', 'chestInstaller', 'landscaper']);
  assert.ok(fake.children.every(item => !/Gatherer|Materials/.test(item.args[0])));

  const landscaper = childFor(fake, item => item.options.env.MC_BOT_NAME === 'StorageLand2');
  const builder = childFor(fake, item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '4');
  assert.equal(landscaper.options.env.STORAGE_LANDSCAPE_SUPPORT_ONLY, '1');
  assert.equal(builder.options.env.STORAGE_ROOM_CONTINUOUS, '1');
  assert.equal(builder.options.env.STORAGE_ROOM_PHASES, 'floor,walls,entry,lighting,roof');
  assert.equal(builder.options.env.STORAGE_ROOM_BOT_4, 'BuildBot4');
  assert.match(builder.options.env.STORAGE_ROOM_INSTANCE_LOCK_4, /storage-room-construction-builder-4\.lock$/);
  assert.equal(builder.options.env.STORAGE_GATHERER_COUNT, undefined);
  assert.equal(builder.options.env.STORAGE_MATERIALS_WORKERS, undefined);
  assert.equal(coordinator.getStatus().children.chestInstaller.status, 'WAITING_FOR_FLOOR');
  coordinator.stop();
});

test('repair akses dapat menjalankan fase entry saja tanpa worker lain', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  const result = coordinator.start({
    builderWorkerCount: 1,
    builderBotNames: ['EntryRepair1'],
    builderPhases: ['entry'],
    landscaperWorkerCount: 0,
    chestInstallerWorkerCount: 0,
    roleStartStaggerMs: 0
  });

  assert.equal(result.started, true);
  assert.deepEqual(Object.keys(result.status.children), ['builder']);
  assert.equal(fake.children.length, 1);
  assert.equal(fake.children[0].options.env.STORAGE_ROOM_BOT_1, 'EntryRepair1');
  assert.equal(fake.children[0].options.env.STORAGE_ROOM_PHASES, 'entry');
  assert.equal(coordinator.getStatus().children.chestInstaller, undefined);
  coordinator.stop();
});

test('pemasang peti baru dibuat setelah semua segmen builder melewati lantai', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  coordinator.start({ builderWorkerCount: 2, roleStartStaggerMs: 0 });
  const builder = childFor(fake, item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '2').child;

  builder.stdout.emit('data', '[StorageW1] WORK_EVENT {"phase":"BUILD","buildPhase":"walls","verifiedBlocks":32}\n');
  assert.equal(fake.children.length, 2);
  assert.equal(coordinator.getStatus().children.chestInstaller.status, 'WAITING_FOR_FLOOR');

  builder.stdout.emit('data', '[StorageW2] WORK_EVENT {"phase":"BUILD","buildPhase":"walls","verifiedBlocks":32}\n');
  assert.equal(fake.children.length, 3);
  const installer = childFor(fake, item => item.options.env.STORAGE_ROOM_BOT_1 === 'ChestInstaller');
  assert.equal(installer.options.env.STORAGE_ROOM_PHASES, 'storage');
  assert.equal(installer.options.env.STORAGE_ROOM_ALLOW_TERRAIN_WORK, '0');
  coordinator.stop();
});

test('landscaper dimulai lebih dulu dan antrean builder dibatalkan saat stop', async () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  coordinator.start({ roleStartStaggerMs: 25 });

  assert.equal(fake.children.length, 1);
  assert.equal(coordinator.getStatus().children.landscaper.status, 'STARTING');
  assert.equal(coordinator.getStatus().children.builder.status, 'QUEUED');
  coordinator.stop();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fake.children.length, 1);
  assert.equal(coordinator.getStatus().children.builder.status, 'STOPPED');
});

test('kegagalan koneksi transient diulang per role dengan backoff terbatas', async () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({
    spawnProcess: fake.spawnProcess,
    restartDelayMs: 1,
    maxRestarts: 2
  });
  coordinator.start({ roleStartStaggerMs: 60000 });
  const first = fake.children[0].child;
  first.stdout.emit('data', 'event spawn tidak diterima setelah 30000ms\n');
  first.emit('exit', 2, null);
  assert.equal(coordinator.getStatus().restarts, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.children.length, 2);
  coordinator.stop();
});

test('coordinator menunggu SLP sehat lalu hanya membuat dua role konstruksi', async () => {
  const fake = fakeSpawn();
  let probes = 0;
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  const queued = coordinator.startWhenReady({ builderWorkerCount: 3, roleStartStaggerMs: 0 }, {
    intervalMs: 5,
    probe: async () => {
      probes += 1;
      if (probes === 1) throw new Error('ECONNRESET');
      return { version: { protocol: 775 }, players: { online: 0, max: 200 }, latencyMs: 4 };
    }
  });
  assert.equal(queued.waiting, true);
  assert.equal(fake.children.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(probes, 2);
  assert.equal(fake.children.length, 2);
  assert.equal(coordinator.getStatus().config.serverPreflight.protocol, 775);
  coordinator.stop();
});

test('coordinator menolak lifecycle kedua dan menyimpan log worker', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  coordinator.start();
  assert.equal(coordinator.start().reason, 'ALREADY_RUNNING');
  fake.children[0].child.stdout.emit('data', 'WORK_EVENT {"phase":"LANDSCAPE"}\n');
  assert.match(coordinator.getStatus().recentLogs.at(-1).message, /LANDSCAPE/);
  coordinator.stop();
});

test('pause karena batas sesi dijadwalkan lanjut dari checkpoint', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess, restartDelayMs: 1 });
  coordinator.start({ roleStartStaggerMs: 60000 });
  const child = fake.children[0].child;
  child.stdout.emit('data', 'WORK_EVENT {"phase":"PAUSED","reason":"TIME_LIMIT","verifiedBlocks":0}\n');
  child.emit('exit', 0, null);
  assert.equal(coordinator.getStatus().active, true);
  assert.equal(coordinator.getStatus().phase, 'BUILDING_AND_LANDSCAPING');
  assert.equal(coordinator.getStatus().restarts, 1);
  assert.equal(coordinator.getStatus().children.landscaper.status, 'RESTARTING');
  coordinator.stop();
});

test('builder yang berhenti karena material otomatis menunggu lalu retry dari checkpoint', async () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({
    spawnProcess: fake.spawnProcess,
    materialRetryDelayMs: 1
  });
  coordinator.start({ builderWorkerCount: 1, roleStartStaggerMs: 0 });
  const builder = childFor(fake, item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '1').child;
  builder.stdout.emit('data', '[StorageW1] WORK_EVENT {"phase":"BLOCKED","reason":"MATERIAL_UNAVAILABLE","verifiedBlocks":0}\n');
  builder.emit('exit', 2, null);
  assert.equal(coordinator.getStatus().children.builder.status, 'WAITING_MATERIAL');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.children.filter(item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '1').length, 2);
  coordinator.stop();
});

test('chest installer yang kehabisan chest otomatis menunggu lalu retry dari checkpoint', async () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({
    spawnProcess: fake.spawnProcess,
    materialRetryDelayMs: 1
  });
  coordinator.start({ builderWorkerCount: 1, roleStartStaggerMs: 0 });
  const builder = childFor(fake, item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '1').child;
  builder.stdout.emit('data', '[StorageW1] WORK_EVENT {"phase":"BUILD","buildPhase":"walls","verifiedBlocks":4}\n');
  const installer = childFor(fake, item => item.options.env.STORAGE_ROOM_BOT_1 === 'ChestInstaller').child;
  installer.stdout.emit('data', '[StorageW1] WORK_EVENT {"phase":"BLOCKED","reason":"MATERIAL_SOURCE_UNCHANGED","verifiedBlocks":0}\n');
  installer.emit('exit', 2, null);
  assert.equal(coordinator.getStatus().children.chestInstaller.status, 'WAITING_MATERIAL');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.children.filter(item => item.options.env.STORAGE_ROOM_BOT_1 === 'ChestInstaller').length, 2);
  coordinator.stop();
});

test('semua role termasuk pemasang peti selesai menjadikan lifecycle complete', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  coordinator.start({ roleStartStaggerMs: 0 });
  const builder = childFor(fake, item => item.options.env.STORAGE_ROOM_SWARM_WORKERS === '2').child;
  builder.stdout.emit('data', '[StorageW1] WORK_EVENT {"phase":"COMPLETE","buildPhase":"roof","verifiedBlocks":4}\n');
  builder.stdout.emit('data', '[StorageW2] WORK_EVENT {"phase":"COMPLETE","buildPhase":"roof","verifiedBlocks":4}\n');
  for (const item of [...fake.children]) {
    item.child.stdout.emit('data', 'WORK_EVENT {"phase":"COMPLETE","verifiedBlocks":4}\n');
    item.child.emit('exit', 0, null);
  }
  const status = coordinator.getStatus();
  assert.equal(status.phase, 'COMPLETE');
  assert.equal(status.active, false);
  assert.ok(status.stoppedAt);
});

test('role terblokir tidak menghentikan role konstruksi lain', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess });
  coordinator.start({ roleStartStaggerMs: 0 });
  const landscaper = childFor(fake, item => item.options.env.MC_BOT_NAME === 'StorageLand2').child;
  landscaper.stdout.emit('data', 'WORK_EVENT {"phase":"BLOCKED","reason":"NO_PATH"}\n');
  landscaper.emit('exit', 2, null);
  assert.equal(coordinator.getStatus().active, true);
  assert.equal(coordinator.getStatus().phase, 'PARTIAL_ATTENTION');
  assert.ok(coordinator.getStatus().children.builder);
  coordinator.stop();
});

test('construction goal hanya memiliki task builder dan landscaper lalu dibatalkan saat stop', t => {
  const fake = fakeSpawn();
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const orchestrator = new GlobalSwarmOrchestrator({ memory });
  const coordinator = new StorageRoomConstructionCoordinator({ spawnProcess: fake.spawnProcess, orchestrator });
  const started = coordinator.start({
    world: 'atoms-girl.tun.ply.gg:53635',
    builderWorkerCount: 2,
    landscaperWorkerCount: 1,
    roleStartStaggerMs: 0,
    gathererCount: 4,
    materialsWorkerCount: 2
  });
  const goal = orchestrator.getGoal(started.status.goalId);
  assert.ok(fake.children.every(item => item.options.env.MC_WORLD_ID === 'atoms-girl.tun.ply.gg:53635'));
  assert.ok(goal.tasks.every(task => task.world === 'atoms-girl.tun.ply.gg:53635'));
  assert.deepEqual(goal.tasks.map(task => task.type).sort(), ['BUILD_STORAGE', 'BUILD_STORAGE', 'LANDSCAPE_SITE']);
  coordinator.stop();
  assert.equal(orchestrator.getGoal(started.status.goalId).status, 'CANCELLED');
});
