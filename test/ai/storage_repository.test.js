const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { StorageRepository } = require('../../src/ai/storageRepository');

function createStore(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-repository-'));
  const file = path.join(directory, 'world.sqlite');
  const memory = new SharedWorldMemory(file);
  const repository = new StorageRepository(memory, options);
  t.after(() => {
    try { memory.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { file, memory, repository };
}

const context = { world: 'server:25565', dimension: 'overworld' };

test('snapshot peti bertahan setelah database ditutup dan dibuka kembali', t => {
  const { file, memory, repository } = createStore(t);
  repository.saveChestSnapshot(context, {
    position: { x: -180, y: 71, z: -352 },
    items: [{ slot: 0, name: 'dirt', count: 64 }],
    misplaced: [{ name: 'dirt', count: 64, targetPosition: { x: -181, y: 71, z: -352 } }],
    timestamp: 1000
  }, 'StorageA');
  memory.close();

  const reopenedMemory = new SharedWorldMemory(file);
  t.after(() => reopenedMemory.close());
  const snapshots = new StorageRepository(reopenedMemory).listChestSnapshots(context);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].items[0].name, 'dirt');
  assert.equal(snapshots[0].misplaced[0].count, 64);
  assert.equal(snapshots[0].observer, 'StorageA');
});

test('snapshot terbaru mengganti seluruh isi dan snapshot lama ditolak', t => {
  const { repository } = createStore(t);
  const position = { x: 1, y: 70, z: 2 };
  repository.saveChestSnapshot(context, {
    position, items: [{ slot: 0, name: 'stone', count: 64 }], misplaced: [], timestamp: 2000
  });
  repository.saveChestSnapshot(context, {
    position, items: [{ slot: 1, name: 'coal', count: 8 }], misplaced: [], timestamp: 3000
  });
  assert.equal(repository.saveChestSnapshot(context, {
    position, items: [{ slot: 2, name: 'dirt', count: 1 }], misplaced: [], timestamp: 2500
  }), false);
  const [snapshot] = repository.listChestSnapshots(context);
  assert.deepEqual(snapshot.items.map(item => item.name), ['coal']);
  assert.equal(snapshot.revision, 2);
});

test('riwayat dibatasi dan assignment tersedia tanpa worker aktif', t => {
  const { repository } = createStore(t, { historyLimit: 2 });
  for (let index = 1; index <= 3; index += 1) {
    repository.recordCompliance(context, { botName: 'StorageA', item: `item_${index}`, timestamp: index });
  }
  assert.deepEqual(repository.listCompliance(context).map(entry => entry.item), ['item_3', 'item_2']);
  repository.upsertAssignments(context, { coal: '-181,74,-353', dirt: '-181,71,-352' }, 'seed', 1000);
  assert.deepEqual(repository.getAssignments(context), {
    coal: '-181,74,-353', dirt: '-181,71,-352'
  });
});

test('dua proses worker berbagi database dan pengamatan terbaru menang', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-repository-shared-'));
  const file = path.join(directory, 'world.sqlite');
  const firstMemory = new SharedWorldMemory(file);
  const secondMemory = new SharedWorldMemory(file);
  t.after(() => {
    try { firstMemory.close(); } catch {}
    try { secondMemory.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = new StorageRepository(firstMemory);
  const second = new StorageRepository(secondMemory);
  const position = { x: 5, y: 72, z: 8 };

  first.saveChestSnapshot(context, {
    position, items: [{ slot: 0, name: 'stone', count: 10 }], misplaced: [], timestamp: 1000
  }, 'StorageA');
  second.saveChestSnapshot(context, {
    position, items: [{ slot: 0, name: 'iron_ingot', count: 4 }], misplaced: [], timestamp: 2000
  }, 'StorageB');

  const [snapshot] = first.listChestSnapshots(context);
  assert.equal(snapshot.items[0].name, 'iron_ingot');
  assert.equal(snapshot.observer, 'StorageB');
  assert.equal(snapshot.revision, 2);
});
