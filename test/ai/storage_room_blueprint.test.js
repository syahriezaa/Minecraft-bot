const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStorageRoomBlueprint } = require('../../src/ai/storageRoomBlueprint');
const { orderedBlocks } = require('../../src/ai/storageRoomBuilder');

for (const countAs of ['blocks', 'double']) {
  test(`blueprint 250 ${countAs}: kapasitas, akses, dan koordinat tanpa tumpang tindih`, () => {
    const plan = createStorageRoomBlueprint({ countAs });
    assert.ok((countAs === 'double' ? plan.doubleChests : plan.chestBlocks) >= 250);
    const occupied = new Map(plan.blocks.map(b => [`${b.x},${b.y},${b.z}`, b]));
    assert.equal(occupied.size, plan.blocks.length);
    assert.equal(plan.materials.chest, plan.chestBlocks);
    assert.equal(plan.materials.air, undefined);
    for (const pair of plan.pairs) {
      const p = pair.access;
      assert.equal(occupied.has(`${p.x},1,${p.z}`), false);
      assert.equal(occupied.has(`${p.x},2,${p.z}`), false);
      assert.equal(occupied.get(`${p.x},0,${p.z}`).name, 'stone_bricks');
      assert.equal(occupied.has(`${pair.left.x},3,${pair.left.z}`), false);
    }
    assert.equal(plan.origin, null);
    const entry = plan.blocks.filter(block => block.phase === 'entry');
    assert.equal(entry.filter(block => block.name === 'oak_door').length, 2);
    assert.equal(entry.filter(block => block.name === 'air').length, 4);
    assert.equal(entry.filter(block => block.name === 'stone_bricks').length, 21);
    assert.equal(entry.some(block => block.x === 20 && block.y === 1 && block.z === 0), true);
    assert.equal(entry.find(block => block.x === 20 && block.y === 1 && block.z === 0 && block.name === 'oak_door').properties.open, true);
    assert.equal(entry.some(block => block.x === 19 && block.y === 1 && block.z === 0 && block.name === 'air' && block.replaceNames.includes('stone_bricks')), true);
    assert.equal(entry.some(block => block.x === 21 && block.y === 1 && block.z === 0 && block.name === 'air' && block.replaceNames.includes('stone_bricks')), true);
    assert.equal(occupied.get('20,3,0').phase, 'entry', 'header ikut dikerjakan bersama pintu');
    assert.equal(occupied.get('21,3,0').phase, 'entry', 'header ikut dikerjakan bersama pintu');
    for (let z = 1; z < plan.dimensions.depth - 1; z += 1) {
      assert.equal(occupied.has(`21,1,${z}`), false, `lorong masuk terhalang pada z=${z}`);
      assert.equal(occupied.has(`21,2,${z}`), false, `ruang kepala lorong terhalang pada z=${z}`);
    }
    const ordered = orderedBlocks(plan.blocks);
    const firstEntry = ordered.findIndex(block => block.phase === 'entry');
    const firstWall = ordered.findIndex(block => block.phase === 'walls');
    assert.ok(firstEntry >= 0 && firstWall >= 0 && firstEntry < firstWall, 'entry harus diproses sebelum dinding');
  });
}
