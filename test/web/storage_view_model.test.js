const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateItems,
  aggregateMisplaced,
  filterChests,
  summarizeStorage
} = require('../../src/web/public/js/storageViewModel');

const chests = [
  {
    position: { x: 1, y: 70, z: 2 },
    items: [{ name: 'dirt', count: 64 }, { name: 'dirt', count: 4 }, { name: 'coal', count: 8 }],
    misplaced: [
      { name: 'dirt', count: 64, targetPosition: { x: 3, y: 70, z: 2 } },
      { name: 'dirt', count: 4, targetPosition: { x: 3, y: 70, z: 2 } }
    ]
  },
  { position: { x: 2, y: 70, z: 2 }, items: [{ name: 'oak_log', count: 12 }], misplaced: [] }
];

test('meringkas unit barang dan kondisi peti', () => {
  assert.deepEqual(summarizeStorage(chests), {
    chests: 2,
    cleanChests: 1,
    itemUnits: 88,
    misplacedUnits: 68
  });
});

test('menggabungkan stack item agar daftar gudang mudah dibaca', () => {
  assert.deepEqual(aggregateItems(chests[0].items), [
    { name: 'dirt', count: 68, stacks: 2 },
    { name: 'coal', count: 8, stacks: 1 }
  ]);
  assert.deepEqual(aggregateMisplaced(chests), [{
    name: 'dirt', count: 68, stacks: 2,
    from: { x: 1, y: 70, z: 2 }, to: { x: 3, y: 70, z: 2 }
  }]);
});

test('memfilter peti menurut kondisi, kategori, item, dan koordinat', () => {
  const categories = { '1,70,2': 'Blok tambang', '2,70,2': 'Kayu' };
  assert.deepEqual(filterChests(chests, categories, '', 'clean').map(c => c.position.x), [2]);
  assert.deepEqual(filterChests(chests, categories, 'tambang', 'all').map(c => c.position.x), [1]);
  assert.deepEqual(filterChests(chests, categories, 'oak_log', 'all').map(c => c.position.x), [2]);
  assert.deepEqual(filterChests(chests, categories, '1,70,2', 'all').map(c => c.position.x), [1]);
});
