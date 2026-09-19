const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { StorageMaterialsCoordinator } = require('../../src/ai/storageMaterialsCoordinator');

function fakeSpawn() {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 9200;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => child.emit('exit', 0, signal);
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

test('materials coordinator menjalankan runner smelting/crafting dan memantulkan status kerja', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageMaterialsCoordinator({ spawnProcess: fake.spawnProcess, root: '/tmp/materials-test' });
  const started = coordinator.start({ botName: 'StorageMatUI', maxRunMs: 120000, maxCycles: 12, world: 'atoms-girl.tun.ply.gg:53635' });

  assert.equal(started.started, true);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].args[0], /runStorageRoomMaterials\.js$/);
  assert.equal(fake.calls[0].options.env.MC_BOT_NAME, 'StorageMatUI');
  assert.equal(fake.calls[0].options.env.MC_WORLD_ID, 'atoms-girl.tun.ply.gg:53635');
  assert.equal(fake.calls[0].options.env.STORAGE_MATERIALS_MAX_RUN_MS, '120000');
  assert.equal(fake.calls[0].options.env.STORAGE_MATERIALS_MAX_CYCLES, '12');

  fake.calls[0].child.stdout.emit('data', '[StorageMatUI] WORK_EVENT {"phase":"LOGISTICS","cycle":2,"produced":16,"deposited":12}\n');
  const status = coordinator.getStatus();
  assert.equal(status.phase, 'LOGISTICS');
  assert.equal(status.cycle, 2);
  assert.equal(status.produced, 16);
  assert.equal(status.deposited, 12);

  assert.equal(coordinator.stop().stopped, true);
  assert.equal(coordinator.getStatus().phase, 'STOPPED');
});

test('materials coordinator mencegah dua sesi yang sama berjalan bersamaan', () => {
  const fake = fakeSpawn();
  const coordinator = new StorageMaterialsCoordinator({ spawnProcess: fake.spawnProcess });
  assert.equal(coordinator.start().started, true);
  const duplicate = coordinator.start();
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'ALREADY_RUNNING');
  coordinator.stop();
});
