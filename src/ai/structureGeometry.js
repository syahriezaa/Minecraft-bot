function voxelKey(p) { return `${p.x},${p.y},${p.z}`; }

function connectedComponents(blocks) {
  const remaining = new Map(blocks.map(b => [voxelKey(b.position), b]));
  const groups = [];
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(voxelKey(first.position));
    const group = [first];
    for (let i = 0; i < group.length; i++) {
      const p = group[i].position;
      for (const [dx, dy, dz] of offsets) {
        const key = voxelKey({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
        const neighbor = remaining.get(key);
        if (neighbor) { remaining.delete(key); group.push(neighbor); }
      }
    }
    groups.push(group);
  }
  return groups;
}

function boundsOf(blocks) {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { position } of blocks) for (const axis of ['x', 'y', 'z']) {
    min[axis] = Math.min(min[axis], Math.floor(position[axis]));
    max[axis] = Math.max(max[axis], Math.floor(position[axis]) + 1);
  }
  return { min, max };
}

function rectangle(bounds) {
  const { min, max } = bounds;
  return [{ x: min.x, z: min.z }, { x: max.x, z: min.z },
    { x: max.x, z: max.z }, { x: min.x, z: max.z }];
}

module.exports = { connectedComponents, boundsOf, rectangle, voxelKey };
