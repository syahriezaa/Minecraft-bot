const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { MAX_WORKERS, getWorkerCount, getWorkerIndices, buildWorkerEnv } = require('../../src/ai/runStorageRoomSwarm');
const { configureBuilderMovements, nextPausedRetries, capBatchRestock, acquireInstanceLock, isUnsafeSpawnPosition, filterBlueprintPhases } = require('../../src/ai/runStorageRoomBuilder');
const { createStorageRoomBlueprint } = require('../../src/ai/storageRoomBlueprint');
const { withLock } = require('../../src/ai/runStorageRoomQuarry');
const { withStorageLock, chestResourceKey } = require('../../src/ai/storageRoomLock');

describe('Storage room swarm configuration', () => {
  test('phase filter memisahkan pekerjaan peti dari struktur utama', () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const installer = filterBlueprintPhases(blueprint, 'storage');
    const structure = filterBlueprintPhases(blueprint, 'floor,walls,lighting,roof');
    assert.ok(installer.blocks.length > 0);
    assert.ok(installer.blocks.every(block => block.phase === 'storage' && block.name === 'chest'));
    assert.equal(installer.chestBlocks, blueprint.chestBlocks);
    assert.ok(structure.blocks.every(block => block.phase !== 'storage'));
    assert.equal(structure.materials.chest, undefined);
  });
  test('double chest memakai satu resource fisik, chest bersebelahan yang bukan pasangan tetap terpisah', () => {
    const types = new Map([
      ['-181,71,-352', 'right'],
      ['-180,71,-352', 'left'],
      ['-181,71,-351', 'right']
    ]);
    const adapter = {
      getChestHalfType: pos => types.get(`${pos.x},${pos.y},${pos.z}`) || 'single'
    };
    assert.equal(
      chestResourceKey({ x: -181, y: 71, z: -352 }, adapter),
      chestResourceKey({ x: -180, y: 71, z: -352 }, adapter),
      'dua sisi double chest harus berbagi kapasitas maksimal dua operasi'
    );
    assert.notEqual(
      chestResourceKey({ x: -181, y: 71, z: -352 }, adapter),
      chestResourceKey({ x: -181, y: 71, z: -351 }, adapter),
      'dua chest type=right yang berdampingan bukan satu wadah fisik'
    );
  });

  test('batch sukses tidak menghabiskan jatah retry gagal', () => {
    assert.equal(nextPausedRetries({ status: 'PAUSED', built: 8 }, 30), 0);
    assert.equal(nextPausedRetries({ status: 'PAUSED', built: 0 }, 3), 4);
    assert.equal(nextPausedRetries({ status: 'BLOCKED' }, 3), 4);
  });
  test('restock builder hanya meminta kebutuhan batch, bukan stok seluruh ruangan', () => {
    assert.deepEqual(capBatchRestock({ stone_bricks: 2, chest: 1 }, { stone_bricks: 4353, chest: 520 }), {
      stone_bricks: 2, chest: 1
    });
  });

  test('penggalian navigasi melindungi bangunan, wing lain, dan area luar', () => {
    const movements = configureBuilderMovements({ exclusionAreasBreak: [] }, {
      origin: { x: 10, y: 70, z: 20 }, allowTerrainWork: true,
      blueprint: { dimensions: { width: 41, depth: 45, height: 6 }, wingBounds: { minZ: 11, maxZ: 21 } }
    });
    const cost = (name, x, y, z) => movements.exclusionAreasBreak[0]({ name, position: { x, y, z } });
    assert.equal(cost('dirt', 10, 68, 31), 100);
    assert.equal(cost('dirt', 10, 69, 31), 100);
    assert.equal(cost('dirt', 10, 70, 31), 0);
    assert.equal(movements.canDig, true);
    assert.equal(cost('stone_bricks', 10, 68, 31), 100);
    assert.equal(cost('chest', 10, 71, 31), 100);
    assert.equal(cost('dirt', 10, 68, 30), 100);
    assert.equal(cost('stone', 9, 68, 31), 100);
    assert.equal(movements.allow1by1towers, true);
  });
  test('membatasi jumlah worker agar server tidak dibanjiri koneksi', () => {
    assert.equal(MAX_WORKERS, 8);
    assert.equal(getWorkerCount({ STORAGE_ROOM_SWARM_WORKERS: '8' }), 8);
    assert.equal(getWorkerCount({ STORAGE_ROOM_SWARM_WORKERS: '0' }), 2);
    assert.equal(getWorkerCount({ STORAGE_ROOM_SWARM_WORKERS: '1' }), 1);
  });

  test('mengizinkan satu batch terawasi tanpa continuous loop', () => {
    const env = buildWorkerEnv({ env: { STORAGE_ROOM_CONTINUOUS: '0' }, index: 0, count: 4 });
    assert.equal(env.STORAGE_ROOM_CONTINUOUS, '0');
  });

  test('dapat menjalankan subset worker tanpa mengubah pembagian segmen total', () => {
    assert.deepEqual(getWorkerIndices({ STORAGE_ROOM_SWARM_WORKER_INDICES: '7,1,7' }, 8), [1, 7]);
    assert.deepEqual(getWorkerIndices({}, 2), [0, 1]);
    assert.throws(() => getWorkerIndices({ STORAGE_ROOM_SWARM_WORKER_INDICES: '9' }, 8), /index valid/);
  });

  test('memberi index, jumlah worker, checkpoint, dan jeda bertahap yang konsisten', () => {
    const env = buildWorkerEnv({
      env: { STORAGE_ROOM_SWARM_WORKERS: '4' },
      index: 2,
      count: 4,
      rootDir: '/tmp/storage-room-test'
    });
    assert.equal(env.STORAGE_ROOM_WORKER_INDEX, '2');
    assert.equal(env.STORAGE_ROOM_WORKER_COUNT, '4');
    assert.equal(env.STORAGE_ROOM_WING, '2');
    assert.equal(env.STORAGE_ROOM_START_DELAY_MS, '16000');
    assert.equal(env.STORAGE_ROOM_CHECKPOINT, 'data/storage-room-checkpoint-worker-3-of-4.json');
    assert.equal(env.STORAGE_ROOM_RESTOCK_LOCK, path.join('/tmp/storage-room-test', 'data/storage-room-restock.lock'));
    assert.equal(env.STORAGE_ROOM_INSTANCE_LOCK, path.join('/tmp/storage-room-test', 'data/storage-room-instance-3.lock'));
  });

  test('mencegah dua proses memakai worker/checkpoint yang sama', async () => {
    const dir = await fs.mkdtemp('/tmp/storage-room-lock-');
    const lockPath = path.join(dir, 'worker.lock');
    const release = acquireInstanceLock(lockPath);
    assert.throws(() => acquireInstanceLock(lockPath), /dipakai proses lain/);
    release();
    const releaseAgain = acquireInstanceLock(lockPath);
    releaseAgain();
  });

  test('membersihkan lock instance bila owner process sudah mati', async () => {
    const dir = await fs.mkdtemp('/tmp/storage-room-instance-lock-');
    const lockPath = path.join(dir, 'worker.lock');
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999 }));
    const release = acquireInstanceLock(lockPath);
    release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  test('membersihkan lock logistik bila owner process sudah mati', async () => {
    const dir = await fs.mkdtemp('/tmp/storage-room-restock-lock-');
    const lockPath = path.join(dir, 'restock.lock');
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999 }));
    let ran = false;
    await withLock(async () => { ran = true; }, () => {}, lockPath);
    assert.equal(ran, true);
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  test('membatasi dua worker pada chest yang sama tetapi membuka chest berbeda secara paralel', async () => {
    const dir = await fs.mkdtemp('/tmp/storage-room-resource-lock-');
    const lockPath = path.join(dir, 'restock.lock');
    let sameActive = 0;
    let samePeak = 0;
    let firstSameStarted;
    const sameStarted = new Promise(resolve => { firstSameStarted = resolve; });
    let sameCalls = 0;
    const sameChestAction = async () => {
      sameCalls += 1;
      if (sameCalls === 1) firstSameStarted();
      sameActive += 1;
      samePeak = Math.max(samePeak, sameActive);
      await new Promise(resolve => setTimeout(resolve, 140));
      sameActive -= 1;
    };
    const firstSame = withStorageLock(sameChestAction, {
      lockPath,
      resourceKey: 'chest:-181,71,-352',
      resourceCapacity: 2,
      totalCapacity: 8,
      actionTimeoutMs: 5000
    });
    await sameStarted;
    await Promise.all([firstSame, ...Array.from({ length: 2 }, () => withStorageLock(sameChestAction, {
      lockPath,
      resourceKey: 'chest:-181,71,-352',
      resourceCapacity: 2,
      totalCapacity: 8,
      actionTimeoutMs: 5000
    }))]);
    assert.equal(samePeak, 2);

    let differentPeak = 0;
    let differentActive = 0;
    let firstDifferentStarted;
    const differentStarted = new Promise(resolve => { firstDifferentStarted = resolve; });
    let differentCalls = 0;
    const differentChestAction = async () => {
      differentCalls += 1;
      if (differentCalls === 1) firstDifferentStarted();
      differentActive += 1;
      differentPeak = Math.max(differentPeak, differentActive);
      await new Promise(resolve => setTimeout(resolve, 140));
      differentActive -= 1;
    };
    const firstDifferent = withStorageLock(differentChestAction, { lockPath, resourceKey: 'chest:-181,71,-352', actionTimeoutMs: 5000 });
    await differentStarted;
    await Promise.all([firstDifferent,
      withStorageLock(differentChestAction, { lockPath, resourceKey: 'chest:-181,73,-352', actionTimeoutMs: 5000 })
    ]);
    assert.equal(differentPeak, 2);
  });

  test('menolak posisi spawn yang sudah masuk gua sebelum builder mulai bekerja', () => {
    assert.equal(isUnsafeSpawnPosition({ y: 1 }, 58), true);
    assert.equal(isUnsafeSpawnPosition({ y: 52 }, 58), false);
    assert.equal(isUnsafeSpawnPosition({ y: 70 }, 58), false);
  });

  test('tetap memakai nama checkpoint lama ketika swarm dua worker', () => {
    assert.equal(buildWorkerEnv({ env: {}, index: 0, count: 2 }).STORAGE_ROOM_CHECKPOINT, 'data/storage-room-checkpoint-live.json');
    assert.equal(buildWorkerEnv({ env: {}, index: 1, count: 2 }).STORAGE_ROOM_CHECKPOINT, 'data/storage-room-checkpoint-wing-2-live.json');
  });
});
