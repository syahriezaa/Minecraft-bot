const { buildLevel4Arena } = require('../../../src/server/arenaBuilder');

class MockWorld {
  constructor() {
    this.blocks = new Map();
  }
  setBlock(x, y, z, type) {
    this.blocks.set(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`, type);
  }
  getBlock(x, y, z) {
    return { name: this.blocks.get(`${Math.round(x)},${Math.round(y)},${Math.round(z)}`) || 'air' };
  }
}

async function run() {
  const world = new MockWorld();
  const meta = await buildLevel4Arena(world);
  console.log('Total blocks placed in Level 4:', world.blocks.size);
  console.log('Start pos:', meta.startPos);
  console.log('Target pos:', meta.targetPos);
  console.log('Spawner coord:', meta.spawnerCoord);

  // Check dungeon center
  console.log('Dungeon floor at (-256, -21, -432):', world.getBlock(-256, -21, -432));
  console.log('Dungeon center at (-256, -20, -432):', world.getBlock(-256, -20, -432));
  console.log('Spawner at (-256, -19, -432):', world.getBlock(-256, -19, -432));

  // Check tunnel entrance into dungeon room
  // Dungeon room bounds: minX: -261, maxX: -251, minZ: -437, maxZ: -427
  // The last tunnel waypoint is [-240, -15, -400] to [-256, -20, -432].
  // Where does it cross the dungeon wall?
  // At maxX = -251 or maxZ = -427!
  console.log('Wall at (-251, -20, -427):', world.getBlock(-251, -20, -427));
  console.log('Wall at (-251, -19, -427):', world.getBlock(-251, -19, -427));
}

run();
