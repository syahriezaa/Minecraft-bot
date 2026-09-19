const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { MiningFleetCoordinator, normalizeMiningArea } = require('../../src/ai/miningFleetCoordinator');

function fakeSpawn() {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 8100;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => child.emit('exit', 0, signal);
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

test('empat sudut dinormalisasi dan dibagi menjadi region worker tanpa overlap', () => {
  const area = normalizeMiningArea([
    { x: -63, z: -379 }, { x: -66, z: -406 }, { x: -66, z: -379 }, { x: -63, z: -406 }
  ], { count: 4, floorY: 40, maxY: 80 });
  assert.deepEqual(area.bounds, { minX: -66, maxX: -63, minZ: -406, maxZ: -379, floorY: 40, maxY: 80 });
  assert.deepEqual(area.regions, [
    '-66,-63,-406,-400,40,80', '-66,-63,-399,-393,40,80',
    '-66,-63,-392,-386,40,80', '-66,-63,-385,-379,40,80'
  ]);
});

test('sudut wajib membentuk persegi panjang yang lengkap', () => {
  assert.throws(() => normalizeMiningArea([
    { x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 2, z: 4 }
  ]), /persegi panjang/);
});

test('coordinator miner mandiri meneruskan region, nama bot, dan status worker', () => {
  const fake = fakeSpawn();
  const coordinator = new MiningFleetCoordinator({ spawnProcess: fake.spawnProcess, root: '/tmp/mining-test' });
  const started = coordinator.start({
    count: 2,
    world: 'atoms-girl.tun.ply.gg:53635',
    corners: [{ x: 10, z: 20 }, { x: 14, z: 20 }, { x: 14, z: 27 }, { x: 10, z: 27 }],
    floorY: -32,
    maxY: 70
  });
  assert.equal(started.started, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.env.STORAGE_GATHERER_COUNT, '2');
  assert.equal(fake.calls[0].options.env.STORAGE_GATHERER_REGIONS, '10,14,20,23,-32,70;10,14,24,27,-32,70');
  assert.equal(fake.calls[0].options.env.STORAGE_GATHERER_BOT_1, 'ResourceW1');
  assert.equal(fake.calls[0].options.env.STORAGE_GATHERER_BOT_2, 'ResourceW2');
  assert.equal(fake.calls[0].options.env.MC_WORLD_ID, 'atoms-girl.tun.ply.gg:53635');
  assert.equal(fake.calls[0].options.env.STORAGE_QUARRY_MODE, 'strip_surface_to_floor');
  assert.equal(started.status.config.mode, 'strip_surface_to_floor');
  assert.match(fake.calls[0].options.env.STORAGE_GATHERER_CHECKPOINT_1, /10_14_20_27_-32_70-worker-1\.json$/);

  fake.calls[0].child.stdout.emit('data', '[ResourceW1] WORK_EVENT {"phase":"EXCAVATE","verifiedBlocks":8,"inventoryFillRatio":0.4}\n');
  assert.equal(coordinator.getStatus().workers.ResourceW1.phase, 'EXCAVATE');
  assert.equal(coordinator.getStatus().workers.ResourceW1.verifiedBlocks, 8);
  assert.equal(coordinator.stop().stopped, true);
  assert.equal(coordinator.getStatus().phase, 'STOPPED');
});

test('coordinator meneruskan mode strip dengan tangga tetap', () => {
  const fake = fakeSpawn();
  const coordinator = new MiningFleetCoordinator({ spawnProcess: fake.spawnProcess, root: '/tmp/mining-test' });
  const started = coordinator.start({
    count: 1,
    mode: 'strip_surface_to_floor',
    corners: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }],
    floorY: 0,
    maxY: 80
  });
  assert.equal(started.status.config.mode, 'strip_surface_to_floor');
  assert.equal(fake.calls[0].options.env.STORAGE_QUARRY_MODE, 'strip_surface_to_floor');
  coordinator.stop();
});

test('coordinator menerima mode permukaan rata lalu tangga', () => {
  const fake = fakeSpawn();
  const coordinator = new MiningFleetCoordinator({ spawnProcess: fake.spawnProcess, root: '/tmp/mining-test' });
  const started = coordinator.start({
    count: 1,
    mode: 'surface_flat_then_stair',
    corners: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }],
    floorY: 0,
    maxY: 80
  });
  assert.equal(started.status.config.mode, 'surface_flat_then_stair');
  assert.equal(fake.calls[0].options.env.STORAGE_QUARRY_MODE, 'surface_flat_then_stair');
  coordinator.stop();
});

test('sesi yang keluar code 0 tanpa blok terverifikasi tidak dilaporkan COMPLETE', () => {
  const fake = fakeSpawn();
  const coordinator = new MiningFleetCoordinator({ spawnProcess: fake.spawnProcess, root: '/tmp/mining-test' });
  coordinator.start({
    count: 1,
    autoRestart: false,
    corners: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }],
    floorY: 0,
    maxY: 80
  });
  fake.calls[0].child.emit('exit', 0, null);
  assert.equal(coordinator.getStatus().phase, 'NEEDS_ATTENTION');
  assert.match(coordinator.getStatus().lastError, /tanpa satu pun blok terverifikasi/);
});
