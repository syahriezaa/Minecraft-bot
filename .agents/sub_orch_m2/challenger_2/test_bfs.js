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

async function testBFS() {
  const world = new MockWorld();
  await buildLevel4Arena(world);

  const start = { x: 0, y: 64, z: 0 };
  const target = { x: -256, y: -20, z: -432 };

  function isSolid(type) {
    return ['stone', 'cobblestone', 'deepslate', 'mossy_cobblestone', 'iron_bars'].includes(type);
  }

  function isWalkable(type) {
    return ['air', 'ladder', 'stone_stairs', 'chest'].includes(type);
  }

  const queue = [{ x: start.x, y: start.y, z: start.z, dist: 0 }];
  const visited = new Set([`${start.x},${start.y},${start.z}`]);
  let reached = false;
  let minDistance = Infinity;
  let closest = null;
  let iterations = 0;

  // Directions: 6 cardinal + 3D diagonal steps
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        dirs.push({ dx, dy, dz });
      }
    }
  }

  while (queue.length > 0 && iterations < 500000) {
    iterations++;
    const curr = queue.shift();
    const d = Math.hypot(curr.x - target.x, curr.y - target.y, curr.z - target.z);
    if (d < minDistance) {
      minDistance = d;
      closest = curr;
    }

    if (d <= 1.0) {
      reached = true;
      break;
    }

    for (const dir of dirs) {
      const nx = curr.x + dir.dx;
      const ny = curr.y + dir.dy;
      const nz = curr.z + dir.dz;

      const key = `${nx},${ny},${nz}`;
      if (visited.has(key)) continue;

      const foot = world.getBlock(nx, ny, nz).name;
      const head = world.getBlock(nx, ny + 1, nz).name;
      const under = world.getBlock(nx, ny - 1, nz).name;

      if (!isWalkable(foot) || !isWalkable(head)) continue;
      // Support check: solid under foot, or stepping down
      if (!isSolid(under) && dir.dy >= 0) continue;

      visited.add(key);
      queue.push({ x: nx, y: ny, z: nz, dist: curr.dist + 1 });
    }
  }

  console.log('BFS Reached:', reached);
  console.log('Min distance:', minDistance);
  console.log('Closest node:', closest);
  console.log('Iterations:', iterations);
  console.log('Visited count:', visited.size);
}

testBFS();
