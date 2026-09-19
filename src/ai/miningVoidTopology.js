const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const DIRECTIONS_2D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRECTIONS_3D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const columnKey = (x, z) => `${x},${z}`;
const voxelKey = (x, y, z) => `${x},${y},${z}`;

function isAirBlock(block) {
  return Boolean(block && AIR_NAMES.has(block.name));
}

function isLiquidBlock(block) {
  return Boolean(block && LIQUID_NAMES.has(block.name));
}

function accessColumnSet(cells = []) {
  const columns = new Set();
  for (const cell of cells) {
    const [x, , z] = typeof cell === 'string'
      ? cell.split(',').map(Number)
      : [cell?.x, cell?.y, cell?.z];
    if (Number.isInteger(x) && Number.isInteger(z)) columns.add(columnKey(x, z));
  }
  return columns;
}

function analyzeMiningVoidTopology(adapter, bounds, options = {}) {
  if (!adapter?.blockAt) throw new TypeError('Analisis rongga mining membutuhkan adapter blockAt().');
  const maxSafeDrop = Math.max(1, Number(options.maxSafeDrop) || 1);
  const ravineDepth = Math.max(maxSafeDrop + 1, Number(options.ravineDepth) || 4);
  const minCaveHeight = Math.max(2, Number(options.minCaveHeight) || 2);
  const scanTop = Number.isInteger(options.scanTop) ? options.scanTop : bounds.maxY;
  const columns = new Map();
  const blocks = new Map();
  const caveVoxels = new Set();
  const ravineVoxels = new Set();
  const plannedAccessColumns = accessColumnSet(options.plannedAccessCells);
  let unknownVoxels = 0;

  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      const solidYs = [];
      for (let y = bounds.floorY; y <= scanTop; y += 1) {
        const block = adapter.blockAt({ x, y, z });
        blocks.set(voxelKey(x, y, z), block || null);
        if (!block) unknownVoxels += 1;
        else if (!isAirBlock(block) && !isLiquidBlock(block)) solidYs.push(y);
      }
      const surfaceY = solidYs.length ? solidYs.at(-1) : null;
      columns.set(columnKey(x, z), { x, z, surfaceY, caveRuns: [] });

      // The verified stair corridor intentionally contains long air runs
      // between supports. It is navigable infrastructure, not a natural cave.
      if (solidYs.length < 2 || plannedAccessColumns.has(columnKey(x, z))) continue;
      for (let index = 0; index < solidYs.length - 1; index += 1) {
        const bottom = solidYs[index];
        const top = solidYs[index + 1];
        if (top - bottom - 1 < minCaveHeight) continue;
        const run = [];
        for (let y = bottom + 1; y < top; y += 1) {
          if (!isAirBlock(blocks.get(voxelKey(x, y, z)))) {
            run.length = 0;
            break;
          }
          run.push({ x, y, z });
        }
        if (run.length >= minCaveHeight) {
          columns.get(columnKey(x, z)).caveRuns.push({ minY: run[0].y, maxY: run.at(-1).y, height: run.length });
          for (const position of run) caveVoxels.add(voxelKey(position.x, position.y, position.z));
        }
      }
    }
  }

  let maxDropDepth = 0;
  const ravineColumns = new Set();
  for (const column of columns.values()) {
    if (plannedAccessColumns.has(columnKey(column.x, column.z))) continue;
    let neighbourSurface = null;
    for (const [dx, dz] of DIRECTIONS_2D) {
      const neighbour = columns.get(columnKey(column.x + dx, column.z + dz));
      if (Number.isInteger(neighbour?.surfaceY)) {
        neighbourSurface = neighbourSurface === null ? neighbour.surfaceY : Math.max(neighbourSurface, neighbour.surfaceY);
      }
    }
    if (neighbourSurface === null) continue;
    const ownSurface = Number.isInteger(column.surfaceY) ? column.surfaceY : bounds.floorY - 1;
    const dropDepth = neighbourSurface - ownSurface;
    maxDropDepth = Math.max(maxDropDepth, dropDepth);
    if (dropDepth < ravineDepth) continue;
    ravineColumns.add(columnKey(column.x, column.z));
    for (let y = ownSurface + 1; y <= neighbourSurface; y += 1) {
      if (isAirBlock(blocks.get(voxelKey(column.x, y, column.z)))) {
        ravineVoxels.add(voxelKey(column.x, y, column.z));
      }
    }
  }

  const caveColumns = new Set([...columns.values()].filter(column => column.caveRuns.length)
    .map(column => columnKey(column.x, column.z)));
  const unsafeColumns = new Set([...caveColumns, ...ravineColumns]);
  const boundaryColumns = new Set(unsafeColumns);
  for (const raw of unsafeColumns) {
    const [x, z] = raw.split(',').map(Number);
    for (const [dx, dz] of DIRECTIONS_2D) {
      const neighbour = columnKey(x + dx, z + dz);
      if (columns.has(neighbour)) boundaryColumns.add(neighbour);
    }
  }

  const allVoidVoxels = new Set([...caveVoxels, ...ravineVoxels]);
  const remaining = new Set(allVoidVoxels);
  const components = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    remaining.delete(start);
    const queue = [start.split(',').map(Number)];
    for (let index = 0; index < queue.length; index += 1) {
      const [x, y, z] = queue[index];
      for (const [dx, dy, dz] of DIRECTIONS_3D) {
        const neighbour = voxelKey(x + dx, y + dy, z + dz);
        if (!remaining.delete(neighbour)) continue;
        queue.push([x + dx, y + dy, z + dz]);
      }
    }
    components.push({
      volume: queue.length,
      min: { x: Math.min(...queue.map(p => p[0])), y: Math.min(...queue.map(p => p[1])), z: Math.min(...queue.map(p => p[2])) },
      max: { x: Math.max(...queue.map(p => p[0])), y: Math.max(...queue.map(p => p[1])), z: Math.max(...queue.map(p => p[2])) }
    });
  }
  components.sort((a, b) => b.volume - a.volume);

  return {
    caveColumns: [...caveColumns],
    ravineColumns: [...ravineColumns],
    unsafeColumns: [...unsafeColumns],
    boundaryColumns: [...boundaryColumns],
    components,
    evidence: {
      caveColumns: caveColumns.size,
      ravineColumns: ravineColumns.size,
      voidColumns: unsafeColumns.size,
      voidComponents: components.length,
      largestVoidComponent: components[0]?.volume || 0,
      maxDropDepth,
      unknownVoxels
    },
    policy: { maxSafeDrop, ravineDepth, minCaveHeight,
      plannedAccessColumns: [...plannedAccessColumns] }
  };
}

function inspectMiningTargetVoidRisk(adapter, pos, bounds, options = {}) {
  const maxSafeDrop = Math.max(1, Number(options.maxSafeDrop) || 1);
  const ravineDepth = Math.max(maxSafeDrop + 1, Number(options.ravineDepth) || 4);
  const plannedAccessColumns = new Set(options.plannedAccessColumns || []);
  const measureDrop = start => {
    let depth = 0;
    for (let y = start.y; y >= bounds.floorY; y -= 1) {
      const block = adapter.blockAt({ x: start.x, y, z: start.z });
      if (!block) return { unsafe: true, reason: 'UNKNOWN_VOID', depth };
      if (isLiquidBlock(block)) return { unsafe: true, reason: 'LIQUID_VOID', depth };
      if (!isAirBlock(block)) return { unsafe: false, depth, supportY: y };
      depth += 1;
    }
    return { unsafe: depth > maxSafeDrop, reason: 'OPEN_VOID_TO_FLOOR', depth };
  };

  const below = measureDrop({ x: pos.x, y: pos.y - 1, z: pos.z });
  if (below.unsafe || below.depth > maxSafeDrop) {
    return { unsafe: true, reason: below.reason || 'DEEP_VOID_BELOW', depth: below.depth };
  }
  for (const [dx, dz] of DIRECTIONS_2D) {
    const side = { x: pos.x + dx, y: pos.y, z: pos.z + dz };
    const sideBlock = adapter.blockAt(side);
    if (!sideBlock) return { unsafe: true, reason: 'UNKNOWN_VOID_EDGE', depth: 0 };
    if (isLiquidBlock(sideBlock)) return { unsafe: true, reason: 'LIQUID_VOID_EDGE', depth: 0 };
    if (!isAirBlock(sideBlock)) continue;
    if (plannedAccessColumns.has(columnKey(side.x, side.z))) continue;
    const drop = measureDrop(side);
    if (drop.unsafe || drop.depth >= ravineDepth) {
      return { unsafe: true, reason: drop.reason || 'RAVINE_EDGE', depth: drop.depth, direction: { x: dx, z: dz } };
    }
  }
  return { unsafe: false, reason: null, depth: 0 };
}

module.exports = {
  AIR_NAMES,
  LIQUID_NAMES,
  analyzeMiningVoidTopology,
  inspectMiningTargetVoidRisk,
  accessColumnSet,
  columnKey
};
