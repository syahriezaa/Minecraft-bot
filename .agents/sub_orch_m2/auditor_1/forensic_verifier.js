/**
 * Forensic Verification Execution Script
 * Menjalankan verifikasi forensik independen terhadap implementasi Milestone 2.
 */
const assert = require('node:assert/strict');
const { HeadlessTestServer } = require('../../../src/server/testServer');
const {
  buildLevel1Arena,
  buildLevel2Arena,
  buildLevel3Arena,
  buildLevel4Arena,
  buildArena
} = require('../../../src/server/arenaBuilder');

async function runForensicChecks() {
  console.log('=== STARTING INDEPENDENT FORENSIC VERIFICATION ===');
  const server = new HeadlessTestServer();
  
  try {
    console.log('[1/6] Testing Server Start...');
    const inst = await server.startTestServer({ port: 25570, logging: false });
    assert.ok(inst, 'Server instance must exist');
    assert.equal(server.isServerRunning(), true, 'Server must report isRunning=true');
    console.log('  PASS: Server started on port 25570');

    console.log('[2/6] Testing Block Manipulation (setBlock / getBlock)...');
    await server.setBlock(10, 64, 10, 'stone');
    let block = await server.getBlock(10, 64, 10);
    assert.equal(block.name, 'stone');
    assert.equal(block.type, 1);

    await server.setBlock(10, 65, 10, 'ladder', { facing: 'north' });
    block = await server.getBlock(10, 65, 10);
    assert.equal(block.name, 'ladder');
    const props = block.getProperties ? block.getProperties() : {};
    assert.equal(props.facing, 'north');
    console.log('  PASS: Block placement & directional properties verified');

    console.log('[3/6] Testing Procedural Level 1-4 Generation on Real World Storage...');
    // Level 1
    const l1 = await buildLevel1Arena(server);
    assert.deepEqual(l1.startCoord, { x: 0, y: 64, z: 0 });
    assert.deepEqual(l1.targetCoord, { x: 30, y: 64, z: 0 });
    const floorL1 = await server.getBlock(15, 63, 0);
    assert.equal(floorL1.name, 'stone');

    // Level 2
    const l2 = await buildLevel2Arena(server);
    assert.equal(l2.targetCoord.x, 50);
    const elevatedL2 = await server.getBlock(20, 64, 0);
    assert.equal(elevatedL2.name, 'stone');
    const wallL2 = await server.getBlock(20, 65, 0);
    assert.equal(wallL2.name, 'stone');
    const detourL2 = await server.getBlock(20, 65, 2);
    assert.equal(detourL2.name, 'air');

    // Level 3
    const l3 = await buildLevel3Arena(server);
    const stairL3 = await server.getBlock(5, 68, 0);
    assert.equal(stairL3.name, 'stone_stairs');
    const bridgeL3 = await server.getBlock(10, 73, 5);
    assert.equal(bridgeL3.name, 'stone');
    const voidLeft = await server.getBlock(9, 73, 5);
    assert.equal(voidLeft.name, 'air');

    // Level 4
    const l4 = await buildLevel4Arena(server);
    assert.deepEqual(l4.targetCoord, { x: -256, y: -20, z: -432 });
    const spawnerL4 = await server.getBlock(-256, -19, -432);
    assert.equal(spawnerL4.name, 'spawner');
    const chestL4 = await server.getBlock(-258, -20, -429);
    assert.equal(chestL4.name, 'chest');
    const lavaL4 = await server.getBlock(-259, -21, -435);
    assert.equal(lavaL4.name, 'lava');
    console.log('  PASS: All 4 procedural levels built and verified on world chunks');

    console.log('[4/6] Testing Bounds Validation & Error Handling in Bahasa Indonesia...');
    try {
      await server.setBlock(0, -65, 0, 'stone');
      assert.fail('Should have thrown out-of-bounds error');
    } catch (e) {
      assert.match(e.message, /di luar batas dunia Minecraft/i);
    }

    try {
      await buildArena(99, server);
      assert.fail('Should have thrown invalid level error');
    } catch (e) {
      assert.match(e.message, /Tingkat level arena tidak valid!/i);
    }
    console.log('  PASS: Bounds validation and Bahasa Indonesia error messages verified');

    console.log('[5/6] Testing Server Teardown...');
    const stopped = await server.stopTestServer();
    assert.equal(stopped, true);
    assert.equal(server.isServerRunning(), false);
    console.log('  PASS: Server stopped cleanly');

    console.log('[6/6] VERDICT: ALL FORENSIC CHECKS PASSED EMPIRICALLY!');
  } finally {
    await server.stopTestServer();
  }
}

runForensicChecks().catch((err) => {
  console.error('FORENSIC CHECK FAILED:', err);
  process.exit(1);
});
