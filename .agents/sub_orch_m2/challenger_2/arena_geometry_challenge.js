/**
 * @file arena_geometry_challenge.js
 * @description Adversarial Challenge & Stress Test Suite for arenaBuilder.js (Milestone 2).
 * Empirically challenges:
 * 1. Continuous Regenerations & Memory Boundedness (50 iterations of build/clear across L1-L4).
 * 2. Comprehensive Coordinate & Block State Verification (exact block types, stairs facing, ladder backing, spawner, chests, lava incinerator).
 * 3. Boundary & Negative Testing (Y bounds [-64, 320], invalid levels, invalid server mocks, invalid block names).
 * 4. 3D Path Connectivity & Corridor Reachability (BFS flood-fill verification for L1, L2, L3, and L4).
 */

const assert = require('node:assert/strict');
const v8 = require('node:v8');
const {
  MIN_WORLD_Y,
  MAX_WORLD_Y,
  LEVEL_ARENA_CONFIGS,
  validateYCoordinate,
  validateServerInstance,
  safeSetBlock,
  fillRegion,
  buildLevel1Arena,
  buildLevel2Arena,
  buildLevel3Arena,
  buildLevel4Arena,
  buildArena,
  clearArena
} = require('../../../src/server/arenaBuilder');

// =============================================================================
// MOCK HIGH-PERFORMANCE 3D WORLD HARNESS FOR EMPIRICAL TESTING
// =============================================================================
class MockWorldStorage {
  constructor() {
    this.blocks = new Map(); // key: "x,y,z" -> { type, properties }
    this.chests = new Map();
    this.hazards = new Map();
    this.mutationCount = 0;
  }

  setBlock(x, y, z, type, properties = {}) {
    if (typeof y !== 'number' || Number.isNaN(y) || y < -64 || y > 320) {
      throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [-64, 320].`);
    }
    const key = `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
    this.blocks.set(key, { type, properties: { ...properties } });
    this.mutationCount++;
  }

  getBlock(x, y, z) {
    const key = `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
    const entry = this.blocks.get(key);
    if (!entry) {
      return { name: 'air', type: 'air', properties: {}, getProperties: () => ({}) };
    }
    return {
      name: entry.type,
      type: entry.type,
      properties: entry.properties,
      getProperties: () => entry.properties
    };
  }

  setupChest(coord, chestId, items = []) {
    const key = `${Math.round(coord.x)},${Math.round(coord.y)},${Math.round(coord.z)}`;
    this.chests.set(key, { id: chestId, items: [...items] });
    this.setBlock(coord.x, coord.y, coord.z, 'chest');
  }

  setupHazardBlock(coord, type = 'lava') {
    const key = `${Math.round(coord.x)},${Math.round(coord.y)},${Math.round(coord.z)}`;
    this.hazards.set(key, type);
    this.setBlock(coord.x, coord.y, coord.z, type);
  }

  clear() {
    this.blocks.clear();
    this.chests.clear();
    this.hazards.clear();
    this.mutationCount = 0;
  }

  size() {
    return this.blocks.size;
  }
}

// =============================================================================
// CHALLENGE TEST RUNNER
// =============================================================================
const results = {
  totalTests: 0,
  passedTests: 0,
  failedTests: 0,
  details: []
};

function recordTest(suite, name, passed, error = null, extraInfo = '') {
  results.totalTests++;
  if (passed) {
    results.passedTests++;
    results.details.push({ suite, name, status: 'PASS', extraInfo });
    console.log(`  ✔ [PASS] ${suite} > ${name} ${extraInfo ? `(${extraInfo})` : ''}`);
  } else {
    results.failedTests++;
    results.details.push({ suite, name, status: 'FAIL', error: error ? error.message : 'Unknown error', extraInfo });
    console.error(`  ✖ [FAIL] ${suite} > ${name}: ${error ? error.message : 'Failed'}`);
  }
}

// =============================================================================
// 1. CONTINUOUS REGENERATIONS & MEMORY BOUNDEDNESS (50 ITERATIONS)
// =============================================================================
async function testContinuousRegenerations() {
  console.log('\n======================================================================');
  console.log('CHALLENGE 1: Continuous Regenerations (50 Iterations) & Memory Boundedness');
  console.log('======================================================================');

  const world = new MockWorldStorage();
  const ITERATIONS = 50;

  if (global.gc) global.gc();
  const initialHeap = process.memoryUsage().heapUsed;
  const memorySnapshots = [];

  let allIterationsSucceeded = true;
  let totalBlocksPlaced = 0;

  try {
    for (let i = 1; i <= ITERATIONS; i++) {
      // Level 1: Build -> Clear
      const meta1 = await buildArena(1, world);
      totalBlocksPlaced += world.size();
      await clearArena(world, meta1.bounds);

      // Level 2: Build -> Clear
      const meta2 = await buildArena(2, world);
      totalBlocksPlaced += world.size();
      await clearArena(world, meta2.bounds);

      // Level 3: Build -> Clear
      const meta3 = await buildArena(3, world);
      totalBlocksPlaced += world.size();
      await clearArena(world, meta3.bounds);

      // Level 4: Build -> Clear
      const meta4 = await buildArena(4, world);
      totalBlocksPlaced += world.size();
      await clearArena(world, meta4.bounds);

      // Clear world map
      world.clear();

      if (i % 10 === 0 || i === ITERATIONS) {
        if (global.gc) global.gc();
        const currentHeap = process.memoryUsage().heapUsed;
        const deltaMB = ((currentHeap - initialHeap) / 1024 / 1024).toFixed(2);
        memorySnapshots.push({ iteration: i, heapUsedMB: (currentHeap / 1024 / 1024).toFixed(2), deltaMB });
      }
    }

    recordTest(
      'Regenerations',
      `50 full cycles of L1-L4 build and clear (${ITERATIONS * 4} arena builds)`,
      true,
      null,
      `Mutations: ${world.mutationCount}, Snapshots: ${JSON.stringify(memorySnapshots)}`
    );

    // Memory growth check: delta should not exceed 50 MB
    const finalHeap = process.memoryUsage().heapUsed;
    const netGrowthMB = (finalHeap - initialHeap) / 1024 / 1024;
    const isMemoryBounded = netGrowthMB < 50;

    recordTest(
      'Memory Boundedness',
      `Heap memory remains bounded after 50 regenerations (Net growth: ${netGrowthMB.toFixed(2)} MB)`,
      isMemoryBounded,
      isMemoryBounded ? null : new Error(`Memory grew excessively: ${netGrowthMB.toFixed(2)} MB`)
    );
  } catch (err) {
    recordTest('Regenerations', 'Continuous regeneration iterations', false, err);
  }
}

// =============================================================================
// 2. COMPREHENSIVE COORDINATE & BLOCK SPECIFICATION CHECKS
// =============================================================================
async function testComprehensiveCoordinateChecks() {
  console.log('\n======================================================================');
  console.log('CHALLENGE 2: Comprehensive Coordinate & Block State Verification');
  console.log('======================================================================');

  // --- LEVEL 1 CHECKS ---
  const world1 = new MockWorldStorage();
  const meta1 = await buildLevel1Arena(world1);

  // L1.1 Start & Target Coordinates
  assert.deepEqual(meta1.startCoord, { x: 0, y: 64, z: 0 });
  assert.deepEqual(meta1.targetCoord, { x: 30, y: 64, z: 0 });
  recordTest('Level 1 Geometry', 'Start [0,64,0] and Target [30,64,0] metadata match', true);

  // L1.2 Floor stone at Y=63 along path
  let l1FloorOk = true;
  for (let x = -5; x <= 35; x++) {
    for (let z = -3; z <= 3; z++) {
      if (world1.getBlock(x, 63, z).name !== 'stone') {
        l1FloorOk = false;
        break;
      }
    }
  }
  recordTest('Level 1 Geometry', 'Complete stone floor on Y=63 (X: -5..35, Z: -3..3)', l1FloorOk);

  // L1.3 Air corridor at Y=64..67 along central walkway (Z=-2..2)
  let l1AirOk = true;
  for (let x = -4; x <= 34; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 64; y <= 67; y++) {
        if (world1.getBlock(x, y, z).name !== 'air') {
          l1AirOk = false;
          break;
        }
      }
    }
  }
  recordTest('Level 1 Geometry', 'Walkable 4-block high air corridor on Y=64..67 (X: -4..34, Z: -2..2)', l1AirOk);

  // L1.4 Perimeter walls at Z=-3, Z=3 and X=-5, X=35
  let l1WallsOk = true;
  for (let x = -5; x <= 35; x++) {
    if (world1.getBlock(x, 64, -3).name !== 'stone' || world1.getBlock(x, 65, -3).name !== 'stone' ||
        world1.getBlock(x, 64, 3).name !== 'stone' || world1.getBlock(x, 65, 3).name !== 'stone') {
      l1WallsOk = false;
      break;
    }
  }
  recordTest('Level 1 Geometry', 'Perimeter side walls on Z=-3 and Z=3 (Y=64..65)', l1WallsOk);

  // --- LEVEL 2 CHECKS ---
  const world2 = new MockWorldStorage();
  const meta2 = await buildLevel2Arena(world2);

  // L2.1 Start & Target
  assert.deepEqual(meta2.startCoord, { x: 0, y: 64, z: 0 });
  assert.deepEqual(meta2.targetCoord, { x: 50, y: 64, z: 0 });
  recordTest('Level 2 Geometry', 'Start [0,64,0] and Target [50,64,0] metadata match', true);

  // L2.2 Elevation step at X=15..29 (Y=64 vs Y=63 elsewhere)
  let l2ElevationOk = true;
  for (let x = -5; x <= 55; x++) {
    const expectedY = (x >= 15 && x < 30) ? 64 : 63;
    if (world2.getBlock(x, expectedY, 0).name !== 'stone') {
      l2ElevationOk = false;
      break;
    }
  }
  recordTest('Level 2 Geometry', 'Elevation step-up to Y=64 on X=15..29 and base Y=63 elsewhere', l2ElevationOk);

  // L2.3 Transverse obstacle walls and bypass air gaps
  // Wall 1 at X=20 (Y=65, 66): Z = -3..1 stone, Z = 2..3 air
  let l2Wall1Ok = true;
  for (let z = -3; z <= 1; z++) {
    if (world2.getBlock(20, 65, z).name !== 'stone' || world2.getBlock(20, 66, z).name !== 'stone') l2Wall1Ok = false;
  }
  const l2Wall1Gap = (world2.getBlock(20, 65, 2).name === 'air' && world2.getBlock(20, 66, 2).name === 'air' &&
                      world2.getBlock(20, 65, 3).name === 'air' && world2.getBlock(20, 66, 3).name === 'air');
  recordTest('Level 2 Geometry', 'Wall 1 at X=20 (barrier Z=-3..1, bypass gap Z=2..3)', l2Wall1Ok && l2Wall1Gap);

  // Jump obstacle 2 at X=25 (Y=65): Z = -1..3 stone, Z = -3..-2 air
  let l2Wall2Ok = true;
  for (let z = -1; z <= 3; z++) {
    if (world2.getBlock(25, 65, z).name !== 'stone') l2Wall2Ok = false;
  }
  const l2Wall2Gap = (world2.getBlock(25, 65, -3).name === 'air' && world2.getBlock(25, 65, -2).name === 'air');
  recordTest('Level 2 Geometry', 'Obstacle 2 at X=25 (barrier Z=-1..3, bypass gap Z=-3..-2)', l2Wall2Ok && l2Wall2Gap);

  // Wall 3 at X=38 (Y=64, 65): Z = -3..0 stone, Z = 1..3 air
  let l2Wall3Ok = true;
  for (let z = -3; z <= 0; z++) {
    if (world2.getBlock(38, 64, z).name !== 'stone' || world2.getBlock(38, 65, z).name !== 'stone') l2Wall3Ok = false;
  }
  const l2Wall3Gap = (world2.getBlock(38, 64, 1).name === 'air' && world2.getBlock(38, 65, 1).name === 'air' &&
                      world2.getBlock(38, 64, 2).name === 'air' && world2.getBlock(38, 65, 2).name === 'air');
  recordTest('Level 2 Geometry', 'Wall 3 at X=38 (barrier Z=-3..0, bypass gap Z=1..3)', l2Wall3Ok && l2Wall3Gap);

  // --- LEVEL 3 CHECKS ---
  const world3 = new MockWorldStorage();
  const meta3 = await buildLevel3Arena(world3);

  // L3.1 Start & Target
  assert.deepEqual(meta3.startCoord, { x: 0, y: 64, z: 0 });
  assert.deepEqual(meta3.targetCoord, { x: 10, y: 64, z: 15 });
  recordTest('Level 3 Geometry', 'Start [0,64,0] and Target [10,64,15] metadata match', true);

  // L3.2 Stairs orientation & foundation (X=0..10)
  let l3StairsOk = true;
  for (let i = 0; i <= 10; i++) {
    const yStep = 63 + i;
    const stairBlock = world3.getBlock(i, yStep, 0);
    if (stairBlock.name !== 'stone_stairs') l3StairsOk = false;
    if (stairBlock.properties.facing !== 'east' || stairBlock.properties.half !== 'bottom') l3StairsOk = false;

    // Solid foundation underneath stair
    for (let y = 63; y < yStep; y++) {
      if (world3.getBlock(i, y, 0).name !== 'stone') l3StairsOk = false;
    }
  }
  recordTest('Level 3 Geometry', '11 Ascending stairs with facing=east, half=bottom & solid foundation', l3StairsOk);

  // L3.3 Narrow 1-block bridge at X=10, Y=73, Z=0..15 with side drop void
  let l3BridgeOk = true;
  for (let z = 0; z <= 15; z++) {
    // Note: at z=15, ladder loop overwrites (10, 73, 15) with ladder
    if (z < 15) {
      if (world3.getBlock(10, 73, z).name !== 'stone') l3BridgeOk = false;
    }
    if (world3.getBlock(10, 74, z).name !== 'air' || world3.getBlock(10, 75, z).name !== 'air') l3BridgeOk = false;

    if (z >= 1 && z <= 14) {
      if (world3.getBlock(9, 73, z).name !== 'air' || world3.getBlock(11, 73, z).name !== 'air') l3BridgeOk = false;
    }
  }
  recordTest('Level 3 Geometry', 'Narrow 1-block bridge on Y=73 with left/right voids (X=9, X=11 is air)', l3BridgeOk);

  // L3.4 Vertical ladder shaft at X=10, Z=15 (Y=64..74)
  let l3LadderOk = true;
  for (let y = 64; y <= 74; y++) {
    const ladder = world3.getBlock(10, y, 15);
    const backing = world3.getBlock(10, y, 16);
    const botSpace = world3.getBlock(10, y, 14);

    if (ladder.name !== 'ladder' || ladder.properties.facing !== 'north') l3LadderOk = false;
    if (backing.name !== 'stone') l3LadderOk = false;
    if (botSpace.name !== 'air') l3LadderOk = false;
  }
  recordTest('Level 3 Geometry', 'Vertical ladder shaft (Y=64..74) with facing=north, backing stone at Z=16, air at Z=14', l3LadderOk);

  // L3.5 Landing platform at bottom (10, 63, 15) and (10, 63, 14)
  const l3LandingOk = (world3.getBlock(10, 63, 15).name === 'stone' && world3.getBlock(10, 63, 14).name === 'stone');
  recordTest('Level 3 Geometry', 'Landing base platform on Y=63 at target', l3LandingOk);

  // --- LEVEL 4 CHECKS ---
  const world4 = new MockWorldStorage();
  const meta4 = await buildLevel4Arena(world4);

  // L4.1 Start, Target, Spawner Coordinates
  assert.deepEqual(meta4.startCoord, { x: 0, y: 64, z: 0 });
  assert.deepEqual(meta4.targetCoord, { x: -256, y: -20, z: -432 });
  assert.deepEqual(meta4.spawnerCoord, { x: -256, y: -19, z: -432 });
  recordTest('Level 4 Geometry', 'Start [0,64,0], Target [-256,-20,-432], Spawner [-256,-19,-432] match metadata', true);

  // L4.2 Spawner block at exact coordinate [-256, -19, -432]
  const spawnerBlock = world4.getBlock(-256, -19, -432);
  recordTest('Level 4 Geometry', 'Spawner block at exact coordinate [-256, -19, -432]', spawnerBlock.name === 'spawner');

  // L4.3 Dungeon Room Floor, Ceiling, Air Dimensions
  const dungeonFloorOk = world4.getBlock(-256, -21, -432).name === 'deepslate';
  const dungeonCeilingOk = world4.getBlock(-256, -16, -432).name === 'deepslate';
  const dungeonCenterAirOk = world4.getBlock(-256, -20, -432).name === 'air';
  recordTest('Level 4 Geometry', 'Dungeon room center floor Y=-21 deepslate, ceiling Y=-16 deepslate, center air Y=-20', dungeonFloorOk && dungeonCeilingOk && dungeonCenterAirOk);

  // L4.4 4 Categorized Chests Verification
  const expectedChests = [
    { id: 'chest_weapons', coord: { x: -258, y: -20, z: -429 } },
    { id: 'chest_drops', coord: { x: -256, y: -20, z: -429 } },
    { id: 'chest_armor', coord: { x: -254, y: -20, z: -429 } },
    { id: 'chest_trash', coord: { x: -252, y: -20, z: -429 } }
  ];
  let chestsOk = true;
  for (const exp of expectedChests) {
    const block = world4.getBlock(exp.coord.x, exp.coord.y, exp.coord.z);
    if (block.name !== 'chest') chestsOk = false;
    const chestData = world4.chests.get(`${exp.coord.x},${exp.coord.y},${exp.coord.z}`);
    if (!chestData || chestData.id !== exp.id || !Array.isArray(chestData.items) || chestData.items.length === 0) {
      chestsOk = false;
    }
  }
  recordTest('Level 4 Geometry', '4 Categorized inventory chests at exact coordinates with items populated', chestsOk);

  // L4.5 Safe Lava Incinerator & Perimeter Iron Bars
  const lavaBlock = world4.getBlock(-259, -21, -435);
  const lavaAirHole = world4.getBlock(-259, -20, -435);
  const ironBarLeft = world4.getBlock(-260, -20, -435);
  const ironBarRight = world4.getBlock(-258, -20, -435);
  const ironBarBack = world4.getBlock(-259, -20, -436);
  const safePlatformFloor = world4.getBlock(-259, -21, -433);
  const safePlatformAir = world4.getBlock(-259, -20, -433);

  const incineratorOk = (
    lavaBlock.name === 'lava' &&
    lavaAirHole.name === 'air' &&
    ironBarLeft.name === 'iron_bars' &&
    ironBarRight.name === 'iron_bars' &&
    ironBarBack.name === 'iron_bars' &&
    safePlatformFloor.name === 'deepslate' &&
    safePlatformAir.name === 'air'
  );
  recordTest('Level 4 Geometry', 'Safe lava pool [-259, -21, -435] with 3-sided iron_bars and 2m safe platform', incineratorOk);
}

// =============================================================================
// 3. NEGATIVE & BOUNDARY TESTING
// =============================================================================
async function testNegativeAndBoundaryConditions() {
  console.log('\n======================================================================');
  console.log('CHALLENGE 3: Negative & Boundary Input Testing');
  console.log('======================================================================');

  // 3.1 Y-coordinate boundaries [-64, 320]
  try {
    validateYCoordinate(-64);
    validateYCoordinate(320);
    validateYCoordinate(0);
    validateYCoordinate(64);
    recordTest('Boundary Testing', 'Valid Y coordinates (-64, 0, 64, 320) pass validation', true);
  } catch (e) {
    recordTest('Boundary Testing', 'Valid Y coordinates pass validation', false, e);
  }

  // Y < -64
  let yUnderflowThrown = false;
  try {
    validateYCoordinate(-65);
  } catch (e) {
    yUnderflowThrown = /di luar batas/i.test(e.message);
  }
  recordTest('Boundary Testing', 'Y=-65 throws Indonesian boundary error', yUnderflowThrown);

  // Y > 320
  let yOverflowThrown = false;
  try {
    validateYCoordinate(321);
  } catch (e) {
    yOverflowThrown = /di luar batas/i.test(e.message);
  }
  recordTest('Boundary Testing', 'Y=321 throws Indonesian boundary error', yOverflowThrown);

  // Non-number Y
  const invalidYs = [NaN, null, undefined, '64', Infinity, -Infinity, {}, []];
  let allInvalidYThrown = true;
  for (const invY of invalidYs) {
    try {
      validateYCoordinate(invY);
      allInvalidYThrown = false;
    } catch (e) {
      // Expected
    }
  }
  recordTest('Negative Testing', 'Non-number / NaN / null / undefined / string Y inputs rejected', allInvalidYThrown);

  // 3.2 Server Instance Validation
  const invalidServers = [null, undefined, {}, { setBlock: 'notAFunction' }, { setBlock: 123 }, { other: true }];
  let allInvalidServersRejected = true;
  for (const invServ of invalidServers) {
    try {
      validateServerInstance(invServ);
      allInvalidServersRejected = false;
    } catch (e) {
      // Expected
    }
  }
  recordTest('Negative Testing', 'Invalid server instances (null, missing setBlock) rejected', allInvalidServersRejected);

  // 3.3 Invalid level parameters in buildArena
  const world = new MockWorldStorage();
  const invalidLevels = [0, 5, -1, -100, 100, 999, 'invalid', 'level1', null, undefined, NaN, {}, []];
  let allInvalidLevelsRejected = true;
  for (const invLevel of invalidLevels) {
    try {
      await buildArena(invLevel, world);
      allInvalidLevelsRejected = false;
    } catch (e) {
      if (!/Tingkat level arena tidak valid!/i.test(e.message)) {
        allInvalidLevelsRejected = false;
      }
    }
  }
  recordTest('Negative Testing', 'Invalid arena level numbers (0, 5, -1, NaN, strings) rejected with Indonesian error', allInvalidLevelsRejected);

  // Valid level strings ('1', '2', '3', '4')
  const validStringLevels = ['1', '2', '3', '4'];
  let allValidStringLevelsPassed = true;
  for (const vLevel of validStringLevels) {
    try {
      const res = await buildArena(vLevel, world);
      if (res.level !== Number(vLevel)) allValidStringLevelsPassed = false;
    } catch (e) {
      allValidStringLevelsPassed = false;
    }
  }
  recordTest('Boundary Testing', 'String representations of levels ("1", "2", "3", "4") coerced and accepted', allValidStringLevelsPassed);

  // 3.4 clearArena with empty / missing bounds
  try {
    await clearArena(world, null);
    await clearArena(world, undefined);
    recordTest('Edge Cases', 'clearArena safely handles null / undefined bounds', true);
  } catch (e) {
    recordTest('Edge Cases', 'clearArena safely handles null / undefined bounds', false, e);
  }
}

// =============================================================================
// 4. 3D PATH CONNECTIVITY & CORRIDOR REACHABILITY (BFS FLOOD-FILL)
// =============================================================================
function checkPathConnectivityBFS(world, start, target, maxSteps = 100000) {
  // 3D BFS to check if there is an unbroken traversable route for a Minecraft bot
  // Bot requires:
  // - Current coordinate (x, y, z) is walkable (air, stairs, ladder)
  // - Headroom (x, y+1, z) is walkable (air, stairs, ladder)
  // - Standing surface: block at (x, y-1, z) is solid OR block at (x,y,z) is ladder/stair
  
  function isSolid(type) {
    return ['stone', 'cobblestone', 'deepslate', 'mossy_cobblestone', 'iron_bars'].includes(type);
  }

  function isWalkable(type) {
    return ['air', 'ladder', 'stone_stairs', 'chest'].includes(type);
  }

  const startKey = `${Math.round(start.x)},${Math.round(start.y)},${Math.round(start.z)}`;
  const targetKey = `${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}`;

  const queue = [{ x: Math.round(start.x), y: Math.round(start.y), z: Math.round(start.z), dist: 0 }];
  const visited = new Set([startKey]);

  let reached = false;
  let minDistanceToTarget = Infinity;
  let closestPos = null;
  let stepsTaken = 0;

  // Directions: 6 cardinal directions (X +/- 1, Z +/- 1, Y +/- 1) and diagonal steps
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 1, dy: 1, dz: 0 },   // Step up X
    { dx: -1, dy: 1, dz: 0 },  // Step up -X
    { dx: 0, dy: 1, dz: 1 },   // Step up Z
    { dx: 0, dy: 1, dz: -1 },  // Step up -Z
    { dx: 1, dy: -1, dz: 0 },  // Step down X
    { dx: -1, dy: -1, dz: 0 }, // Step down -X
    { dx: 0, dy: -1, dz: 1 },  // Step down Z
    { dx: 0, dy: -1, dz: -1 }, // Step down -Z
    { dx: 0, dy: 1, dz: 0 },   // Vertical climb ladder/jump
    { dx: 0, dy: -1, dz: 0 }   // Vertical descend ladder/drop
  ];

  while (queue.length > 0 && stepsTaken < maxSteps) {
    stepsTaken++;
    const curr = queue.shift();

    const d = Math.hypot(curr.x - target.x, curr.y - target.y, curr.z - target.z);
    if (d < minDistanceToTarget) {
      minDistanceToTarget = d;
      closestPos = curr;
    }

    if (d <= 1.0) {
      reached = true;
      break;
    }

    for (const dir of dirs) {
      const nx = curr.x + dir.dx;
      const ny = curr.y + dir.dy;
      const nz = curr.z + dir.dz;

      if (ny < -64 || ny > 320) continue;

      const nkey = `${nx},${ny},${nz}`;
      if (visited.has(nkey)) continue;

      const blockAtFoot = world.getBlock(nx, ny, nz).name;
      const blockAtHead = world.getBlock(nx, ny + 1, nz).name;
      const blockUnderFoot = world.getBlock(nx, ny - 1, nz).name;

      // Check if bot can occupy (nx, ny, nz)
      if (!isWalkable(blockAtFoot) || !isWalkable(blockAtHead)) {
        continue; // Blocked by solid obstacle
      }

      // Check support: solid floor, ladder, or stairs
      const hasSupport = isSolid(blockUnderFoot) || blockAtFoot === 'ladder' || blockAtFoot === 'stone_stairs' || blockUnderFoot === 'stone_stairs';
      if (!hasSupport && dir.dy === 0) {
        // In mid-air without ladder, can only fall (dy < 0)
        continue;
      }

      visited.add(nkey);
      queue.push({ x: nx, y: ny, z: nz, dist: curr.dist + 1 });
    }
  }

  return { reached, minDistanceToTarget, closestPos, stepsTaken, visitedCount: visited.size };
}

async function testPathConnectivity() {
  console.log('\n======================================================================');
  console.log('CHALLENGE 4: 3D Path Connectivity & Corridor Reachability Verification');
  console.log('======================================================================');

  // Level 1 Connectivity
  const world1 = new MockWorldStorage();
  await buildLevel1Arena(world1);
  const bfsL1 = checkPathConnectivityBFS(world1, { x: 0, y: 64, z: 0 }, { x: 30, y: 64, z: 0 });
  recordTest(
    'Path Connectivity',
    'Level 1: Continuous unbroken air corridor from [0,64,0] to [30,64,0]',
    bfsL1.reached,
    bfsL1.reached ? null : new Error(`Failed to reach target. Min dist: ${bfsL1.minDistanceToTarget}`),
    `Visited: ${bfsL1.visitedCount} nodes`
  );

  // Level 2 Connectivity
  const world2 = new MockWorldStorage();
  await buildLevel2Arena(world2);
  const bfsL2 = checkPathConnectivityBFS(world2, { x: 0, y: 64, z: 0 }, { x: 50, y: 64, z: 0 });
  recordTest(
    'Path Connectivity',
    'Level 2: Continuous obstacle course & bypass corridor reachability to [50,64,0]',
    bfsL2.reached,
    bfsL2.reached ? null : new Error(`Failed to reach target. Min dist: ${bfsL2.minDistanceToTarget}`),
    `Visited: ${bfsL2.visitedCount} nodes`
  );

  // Level 3 Connectivity
  const world3 = new MockWorldStorage();
  await buildLevel3Arena(world3);
  const bfsL3 = checkPathConnectivityBFS(world3, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 15 });
  recordTest(
    'Path Connectivity',
    'Level 3: Full 3D vertical stairs -> bridge -> ladder descent reachability to [10,64,15]',
    bfsL3.reached,
    bfsL3.reached ? null : new Error(`Failed to reach target. Min dist: ${bfsL3.minDistanceToTarget}`),
    `Visited: ${bfsL3.visitedCount} nodes`
  );

  // Level 4 Connectivity
  const world4 = new MockWorldStorage();
  await buildLevel4Arena(world4);
  const bfsL4 = checkPathConnectivityBFS(world4, { x: 0, y: 64, z: 0 }, { x: -256, y: -20, z: -432 });
  recordTest(
    'Path Connectivity',
    'Level 4: Underground corridor descent from surface [0,64,0] to dungeon spawner [-256,-20,-432]',
    bfsL4.reached,
    bfsL4.reached ? null : new Error(`Failed to reach target. Min dist: ${bfsL4.minDistanceToTarget}, Closest: ${JSON.stringify(bfsL4.closestPos)}`),
    `Visited: ${bfsL4.visitedCount} nodes`
  );
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================
async function runAllChallenges() {
  console.log('======================================================================');
  console.log('STARTING ADVERSARIAL CHALLENGE SUITE FOR ARENABUILDER.JS (M2)');
  console.log('======================================================================');

  await testContinuousRegenerations();
  await testComprehensiveCoordinateChecks();
  await testNegativeAndBoundaryConditions();
  await testPathConnectivity();

  console.log('\n======================================================================');
  console.log(`CHALLENGE SUMMARY: ${results.passedTests}/${results.totalTests} Passed (${results.failedTests} Failed)`);
  console.log('======================================================================');

  if (results.failedTests > 0) {
    console.error(`\n❌ VERDICT: REQUEST_CHANGES (${results.failedTests} tests failed)`);
    process.exit(1);
  } else {
    console.log('\n✅ VERDICT: APPROVE (100% empirical challenge tests passed)');
    process.exit(0);
  }
}

if (require.main === module) {
  runAllChallenges().catch((err) => {
    console.error('Fatal challenge execution error:', err);
    process.exit(1);
  });
}

module.exports = {
  runAllChallenges,
  testContinuousRegenerations,
  testComprehensiveCoordinateChecks,
  testNegativeAndBoundaryConditions,
  testPathConnectivity
};
