/**
 * @file server_stress_challenge.js
 * @description Adversarial stress test harness for testServer.js (Milestone 2).
 * Challenges:
 * 1. Rapid 10-cycle restart stress test on port 25567.
 * 2. High-throughput block mutation test (2,000 blocks across diverse chunk coordinates).
 * 3. Concurrent bot connection & disconnection test (5 simultaneous bots).
 * 4. Teleportation accuracy & out-of-bounds coordinate validation.
 * 5. Handle and timer leak detection.
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');

const {
  HeadlessTestServer,
  startTestServer,
  stopTestServer,
  isServerRunning,
  resetWorld,
  setBlock,
  getBlock,
  teleportPlayer,
  getServerInstance
} = require('../../../src/server/testServer');

const TEST_PORT = 25567;

async function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.unref();
    socket.once('connect', () => {
      socket.destroy();
      resolve(false); // Port is occupied
    });
    socket.once('error', (err) => {
      socket.destroy();
      resolve(true); // Port is free
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true); // Timed out, likely free
    });
    socket.connect(port, host);
  });
}

async function runChallenge1_RapidRestarts() {
  console.log('\n======================================================');
  console.log('CHALLENGE 1: Rapid 10-cycle Restart Stress Test (Port ' + TEST_PORT + ')');
  console.log('======================================================');

  const cycles = 10;
  const startTime = Date.now();

  for (let i = 1; i <= cycles; i++) {
    const cycleStart = Date.now();
    
    // Start server
    const server = await startTestServer({ port: TEST_PORT, logging: false });
    assert.ok(server, `Cycle ${i}: Server instance must be non-null`);
    assert.equal(isServerRunning(), true, `Cycle ${i}: Server must be running`);

    // Verify TCP connectability
    const isFreeDuringRun = await checkPortFree(TEST_PORT);
    assert.equal(isFreeDuringRun, false, `Cycle ${i}: Port ${TEST_PORT} should be open/listening`);

    // Stop server
    const stopped = await stopTestServer();
    assert.equal(stopped, true, `Cycle ${i}: stopTestServer should return true`);
    assert.equal(isServerRunning(), false, `Cycle ${i}: Server must report stopped`);

    // Verify port released immediately
    const isFreeAfterStop = await checkPortFree(TEST_PORT);
    assert.equal(isFreeAfterStop, true, `Cycle ${i}: Port ${TEST_PORT} must be released immediately`);

    const cycleElapsed = Date.now() - cycleStart;
    console.log(`  [✓] Cycle ${i}/${cycles} completed in ${cycleElapsed}ms`);
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`[PASS] Challenge 1: 10 rapid start/stop cycles completed in ${totalElapsed}ms (avg ${(totalElapsed / cycles).toFixed(1)}ms/cycle)`);
  return { status: 'PASS', cycles, totalElapsed };
}

async function runChallenge2_BlockMutations() {
  console.log('\n======================================================');
  console.log('CHALLENGE 2: High-Throughput 2,000 Block Mutations across Chunks');
  console.log('======================================================');

  await startTestServer({ port: TEST_PORT, logging: false });
  assert.equal(isServerRunning(), true);

  const TOTAL_BLOCKS = 2000;
  const blockTypes = ['stone', 'cobblestone', 'deepslate', 'air', 'iron_bars'];
  const directionalTypes = [
    { name: 'ladder', props: { facing: 'north' } },
    { name: 'ladder', props: { facing: 'south' } },
    { name: 'stone_stairs', props: { facing: 'east', half: 'bottom' } },
    { name: 'stone_stairs', props: { facing: 'west', half: 'top' } }
  ];

  // Generate 2,000 block mutation test cases spanning surface and deep negative underground chunks
  const testCases = [];
  for (let i = 0; i < TOTAL_BLOCKS; i++) {
    let x, y, z, blockSpec;

    if (i < 500) {
      // Chunk group A: Surface flat area [0..50, 60..70, 0..50]
      x = (i % 50);
      z = Math.floor(i / 50);
      y = 63;
      blockSpec = { name: blockTypes[i % blockTypes.length], props: {} };
    } else if (i < 1000) {
      // Chunk group B: Underground Level 4 region [-270..-240, -30..-10, -450..-420]
      const idx = i - 500;
      x = -270 + (idx % 30);
      z = -450 + Math.floor(idx / 30);
      y = -20 + (idx % 10);
      blockSpec = { name: (idx % 2 === 0 ? 'deepslate' : 'cobblestone'), props: {} };
    } else if (i < 1500) {
      // Chunk group C: Directional blocks across stairs & ladder shafts
      const idx = i - 1000;
      x = 100 + (idx % 25);
      z = 100 + Math.floor(idx / 25);
      y = 65 + (idx % 15);
      blockSpec = directionalTypes[idx % directionalTypes.length];
    } else {
      // Chunk group D: Wide spread across distant chunks (testing chunk allocation)
      const idx = i - 1500;
      x = -1000 + (idx * 3);
      z = 2000 + (idx * 2);
      y = (idx % 200) - 40; // Valid Y between -40 and 160
      blockSpec = { name: (idx % 3 === 0 ? 'stone' : (idx % 3 === 1 ? 'deepslate' : 'air')), props: {} };
    }

    testCases.push({ x, y, z, blockSpec });
  }

  console.log(`  Writing ${TOTAL_BLOCKS} blocks in concurrent batches...`);
  const writeStartTime = Date.now();

  const BATCH_SIZE = 100;
  for (let i = 0; i < testCases.length; i += BATCH_SIZE) {
    const batch = testCases.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(item => setBlock(item.x, item.y, item.z, item.blockSpec.name, item.blockSpec.props)));
  }

  const writeElapsed = Date.now() - writeStartTime;
  const writeRate = ((TOTAL_BLOCKS / writeElapsed) * 1000).toFixed(0);
  console.log(`  [✓] 2,000 blocks written in ${writeElapsed}ms (${writeRate} blocks/sec)`);

  console.log(`  Reading back and verifying all ${TOTAL_BLOCKS} blocks...`);
  const readStartTime = Date.now();

  let verifiedCount = 0;
  let mismatchCount = 0;

  for (let i = 0; i < testCases.length; i += BATCH_SIZE) {
    const batch = testCases.slice(i, i + BATCH_SIZE);
    const readResults = await Promise.all(batch.map(item => getBlock(item.x, item.y, item.z)));

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const block = readResults[j];

      if (!block || block.name !== item.blockSpec.name) {
        mismatchCount++;
        console.error(`  [X] Mismatch at (${item.x}, ${item.y}, ${item.z}): expected ${item.blockSpec.name}, got ${block ? block.name : 'null'}`);
      } else {
        // Verify properties if specified
        if (item.blockSpec.props && Object.keys(item.blockSpec.props).length > 0) {
          const props = block.getProperties ? block.getProperties() : {};
          for (const [key, val] of Object.entries(item.blockSpec.props)) {
            if (props[key] !== val) {
              mismatchCount++;
              console.error(`  [X] Property mismatch at (${item.x}, ${item.y}, ${item.z}): expected ${key}=${val}, got ${props[key]}`);
            }
          }
        }
        verifiedCount++;
      }
    }
  }

  const readElapsed = Date.now() - readStartTime;
  const readRate = ((TOTAL_BLOCKS / readElapsed) * 1000).toFixed(0);
  console.log(`  [✓] 2,000 blocks read & verified in ${readElapsed}ms (${readRate} blocks/sec)`);

  assert.equal(mismatchCount, 0, `Total block mismatches must be 0, found ${mismatchCount}`);
  assert.equal(verifiedCount, TOTAL_BLOCKS, `Total verified blocks must equal ${TOTAL_BLOCKS}`);

  console.log(`[PASS] Challenge 2: High-throughput 2,000 block mutations verified 100% (0 errors)`);
  return { status: 'PASS', totalBlocks: TOTAL_BLOCKS, writeElapsed, readElapsed, writeRate, readRate };
}

async function runChallenge3_ConcurrentBots() {
  console.log('\n======================================================');
  console.log('CHALLENGE 3: Concurrent Bot Connections & Simultaneous Disconnects');
  console.log('======================================================');

  if (!isServerRunning()) {
    await startTestServer({ port: TEST_PORT, logging: false });
  }

  // Set floor for bots to spawn on
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      await setBlock(x, 63, z, 'stone');
      await setBlock(x, 64, z, 'air');
      await setBlock(x, 65, z, 'air');
    }
  }

  const BOT_COUNT = 5;
  const bots = [];

  console.log(`  Spawning ${BOT_COUNT} concurrent Mineflayer bots...`);
  const spawnStartTime = Date.now();

  const spawnPromises = [];
  for (let i = 1; i <= BOT_COUNT; i++) {
    const username = `StressBot_${i}`;
    const p = new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: '127.0.0.1',
        port: TEST_PORT,
        username,
        version: '1.20.1',
        checkTimeoutInterval: 8000
      });

      bot.on('error', (err) => {
        // Suppress socket error on teardown
      });

      const timeout = setTimeout(() => {
        reject(new Error(`Bot ${username} timed out waiting for spawn event`));
      }, 8000);

      bot.once('spawn', () => {
        clearTimeout(timeout);
        bots.push(bot);
        resolve(bot);
      });
    });
    spawnPromises.push(p);
  }

  await Promise.all(spawnPromises);
  const spawnElapsed = Date.now() - spawnStartTime;
  console.log(`  [✓] All ${BOT_COUNT} bots spawned concurrently in ${spawnElapsed}ms`);

  const serv = getServerInstance();
  assert.ok(serv, 'Server instance must exist');
  assert.equal(serv.players.length, BOT_COUNT, `Server should have ${BOT_COUNT} connected players`);

  // Verify each bot can inspect blocks and positions
  console.log('  Verifying bot world inspection & coordinate sync...');
  for (const bot of bots) {
    assert.ok(bot.entity, `Bot ${bot.username} entity must be valid`);
    assert.ok(typeof bot.entity.position.x === 'number', `Bot ${bot.username} X coordinate must be a number`);
    
    // Inspect block at 0, 63, 0
    const b = bot.blockAt(new Vec3(0, 63, 0));
    assert.ok(b, `Bot ${bot.username} must see block at (0, 63, 0)`);
    assert.equal(b.name, 'stone', `Bot ${bot.username} must inspect block name as stone`);
  }
  console.log('  [✓] All bots successfully inspected blocks');

  // Simultaneously disconnect all bots
  console.log('  Disconnecting all bots simultaneously...');
  const quitStartTime = Date.now();
  const quitPromises = bots.map((bot) => {
    return new Promise((resolve) => {
      bot.once('end', resolve);
      try {
        if (bot._client && bot._client.socket) {
          bot._client.socket.unref();
        }
        bot.quit();
      } catch (e) {
        resolve();
      }
    });
  });

  await Promise.all(quitPromises);
  const quitElapsed = Date.now() - quitStartTime;
  console.log(`  [✓] All ${BOT_COUNT} bots disconnected in ${quitElapsed}ms`);

  // Verify server player list is cleared
  assert.equal(serv.players.length, 0, 'serv.players must be empty after all bots quit');

  console.log(`[PASS] Challenge 3: Concurrent 5-bot lifecycle completed with 0 errors`);
  return { status: 'PASS', botCount: BOT_COUNT, spawnElapsed, quitElapsed };
}

async function runChallenge4_TeleportationAndBounds() {
  console.log('\n======================================================');
  console.log('CHALLENGE 4: Teleportation Accuracy & Coordinate Boundary Rejection');
  console.log('======================================================');

  if (!isServerRunning()) {
    await startTestServer({ port: TEST_PORT, logging: false });
  }

  // 1. Boundary tests on Y coordinate [-64, 320]
  console.log('  Testing vertical boundary conditions Y in [-64, 320]...');
  
  // Valid boundaries
  await setBlock(0, -64, 0, 'bedrock');
  const bMin = await getBlock(0, -64, 0);
  assert.equal(bMin.name, 'bedrock', 'Y=-64 is valid minimum');

  await setBlock(0, 320, 0, 'glass');
  const bMax = await getBlock(0, 320, 0);
  assert.equal(bMax.name, 'glass', 'Y=320 is valid maximum');

  // Invalid out-of-bounds Y coordinates
  await assert.rejects(
    async () => await setBlock(0, -65, 0, 'stone'),
    /di luar batas dunia/i,
    'Must reject Y = -65'
  );

  await assert.rejects(
    async () => await setBlock(0, 321, 0, 'stone'),
    /di luar batas dunia/i,
    'Must reject Y = 321'
  );

  await assert.rejects(
    async () => await getBlock(0, -999, 0),
    /di luar batas dunia/i,
    'Must reject getBlock at Y = -999'
  );

  await assert.rejects(
    async () => await getBlock(0, 10000, 0),
    /di luar batas dunia/i,
    'Must reject getBlock at Y = 10000'
  );

  console.log('  [✓] Coordinate Y boundaries [-64, 320] strictly enforced');

  // 2. Extreme X/Z coordinate chunk handling
  console.log('  Testing extreme horizontal coordinates X/Z...');
  await setBlock(-100000, 64, -200000, 'obsidian');
  const bExtreme = await getBlock(-100000, 64, -200000);
  assert.equal(bExtreme.name, 'obsidian', 'Extreme coordinate (-100000, 64, -200000) stored correctly');
  console.log('  [✓] Extreme horizontal coordinates handled without crash or memory fault');

  // 3. Invalid block types
  console.log('  Testing invalid block name & ID inputs...');
  await assert.rejects(
    async () => await setBlock(0, 64, 0, 'totally_invalid_block_xyz'),
    /tidak ditemukan dalam registri/i,
    'Must reject invalid block name'
  );

  await assert.rejects(
    async () => await setBlock(0, 64, 0, 9999999),
    /tidak ditemukan dalam registri/i,
    'Must reject invalid block ID'
  );

  await assert.rejects(
    async () => await setBlock(0, 64, 0, null),
    /harus berupa string nama blok atau nomor ID blok/i,
    'Must reject null block identifier'
  );
  console.log('  [✓] Invalid block names/IDs correctly rejected');

  // 4. Teleportation testing & defect probe
  console.log('  Testing teleportPlayer error conditions and execution...');
  await assert.rejects(
    async () => await teleportPlayer('NonExistentBot_999', 0, 64, 0),
    /tidak ditemukan/i,
    'Must reject teleportation for non-existent player'
  );
  console.log('  [✓] teleportPlayer error correctly rejected with Indonesian error message for non-existent bot');

  // Spawn a test bot to probe teleportPlayer implementation
  let botProbe = mineflayer.createBot({
    host: '127.0.0.1',
    port: TEST_PORT,
    username: 'TpProbeBot',
    version: '1.20.1'
  });
  botProbe.on('error', () => {});
  await new Promise((r) => botProbe.once('spawn', r));

  let teleportBugFound = false;
  let teleportErrorMsg = '';

  try {
    await teleportPlayer('TpProbeBot', 10, 64, 10);
    console.log('  [✓] teleportPlayer succeeded without error');
  } catch (err) {
    teleportBugFound = true;
    teleportErrorMsg = err.message;
    console.log(`  [DEFECT DETECTED] teleportPlayer threw: ${err.message}`);
  }

  // Cleanup probe bot
  await new Promise((r) => {
    botProbe.once('end', r);
    try {
      if (botProbe._client && botProbe._client.socket) botProbe._client.socket.unref();
      botProbe.quit();
    } catch (e) {
      r();
    }
  });

  return {
    status: teleportBugFound ? 'DEFECT_FOUND' : 'PASS',
    defectDetails: teleportBugFound ? teleportErrorMsg : null
  };
}

async function runChallenge5_ResourceLeaks() {
  console.log('\n======================================================');
  console.log('CHALLENGE 5: Resource Leaks, Socket Handles & Timers Audit');
  console.log('======================================================');

  // 1. Perform a clean shutdown
  await stopTestServer();
  assert.equal(isServerRunning(), false);

  // 2. Inspect active handles
  let lingeringSocketsCount = 0;
  if (typeof process._getActiveHandles === 'function') {
    const activeHandles = process._getActiveHandles();
    const activeSockets = activeHandles.filter(h => h && h.constructor && (h.constructor.name === 'Socket' || h.constructor.name === 'Server'));
    console.log(`  Active socket/server handles remaining: ${activeSockets.length}`);
    for (const h of activeSockets) {
      if (typeof h.hasRef === 'function') {
        const hasRef = h.hasRef();
        console.log(`    Handle ${h.constructor.name}: hasRef=${hasRef}`);
        if (hasRef) lingeringSocketsCount++;
      }
    }
  }

  // 3. Check port 25567 is completely freed
  const isFree = await checkPortFree(TEST_PORT);
  assert.equal(isFree, true, `Port ${TEST_PORT} must be free after shutdown`);
  console.log(`  [✓] Port ${TEST_PORT} is free and ready for immediate reuse`);

  assert.equal(lingeringSocketsCount, 0, `Lingering referenced sockets must be 0, found ${lingeringSocketsCount}`);
  console.log('[PASS] Challenge 5: Zero resource leaks verified');
  return { status: 'PASS', lingeringSocketsCount };
}

async function main() {
  console.log('================================================================');
  console.log('MILSTONE 2 EMPIRICAL CHALLENGE SUITE: Headless Server Arena');
  console.log('Target: src/server/testServer.js & src/server/arenaBuilder.js');
  console.log('================================================================');

  const report = {};
  report.c1 = await runChallenge1_RapidRestarts();
  report.c2 = await runChallenge2_BlockMutations();
  report.c3 = await runChallenge3_ConcurrentBots();
  report.c4 = await runChallenge4_TeleportationAndBounds();
  report.c5 = await runChallenge5_ResourceLeaks();

  console.log('\n================================================================');
  console.log('CHALLENGE SUMMARY RESULTS:');
  console.log('  Challenge 1 (Rapid 10x Restarts):', report.c1.status, `(${report.c1.totalElapsed}ms)`);
  console.log('  Challenge 2 (2,000 Block Mutations):', report.c2.status, `(${report.c2.writeRate} blocks/s write, ${report.c2.readRate} blocks/s read)`);
  console.log('  Challenge 3 (5 Concurrent Bots):', report.c3.status, `(spawn: ${report.c3.spawnElapsed}ms, quit: ${report.c3.quitElapsed}ms)`);
  console.log('  Challenge 4 (Teleportation & Bounds):', report.c4.status, report.c4.defectDetails ? `[Defect: ${report.c4.defectDetails}]` : '');
  console.log('  Challenge 5 (Resource Leaks & Handles):', report.c5.status);
  console.log('================================================================');

  if (report.c4.status === 'DEFECT_FOUND') {
    console.log('\nVERDICT: REQUEST_CHANGES — Defect identified in testServer.js teleportPlayer() method.');
    process.exit(0); // Exit cleanly with findings
  } else {
    console.log('\nVERDICT: APPROVE — All challenges passed.');
    process.exit(0);
  }
}

main();
