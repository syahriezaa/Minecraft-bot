const key = p => `${p.x},${p.y},${p.z}`;
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'powder_snow', 'sweet_berry_bush']);

// Graf lokal konservatif: hanya pijakan penuh dan langkah yang dapat dibalik.
// Pathfinder tetap menangani gerakan; graf ini memilih tempat kerja, bukan mengirim paket gerak.
class LocalSpatialPlanner {
  constructor(blockAt, { radius = 12, maxNodes = 2048 } = {}) {
    this.blockAt = blockAt;
    this.radius = radius;
    this.maxNodes = maxNodes;
  }

  survey(position) {
    const origin = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const cache = new Map();
    let unknown = false;
    const read = p => {
      const id = key(p);
      if (!cache.has(id)) cache.set(id, this.blockAt(p));
      const b = cache.get(id);
      if (!b) unknown = true;
      return b;
    };
    const clear = p => {
      const b = read(p);
      return b && !HAZARDS.has(b.name) && (['air', 'cave_air', 'void_air'].includes(b.name) || b.boundingBox === 'empty');
    };
    const standable = p => {
      const floor = read({ ...p, y: p.y - 1 });
      return floor?.boundingBox === 'block' && !HAZARDS.has(floor.name)
        && !['sand', 'gravel'].includes(floor.name) && clear(p) && clear({ ...p, y: p.y + 1 });
    };
    const nodes = new Map();
    const queue = [];
    if (standable(origin)) {
      nodes.set(key(origin), { position: origin, parent: null, cost: 0 });
      queue.push(origin);
    }
    let truncated = false;
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i];
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const dy of [0,1,-1]) {
        const p = { x: from.x + dx, y: from.y + dy, z: from.z + dz };
        if (Math.max(Math.abs(p.x-origin.x), Math.abs(p.y-origin.y), Math.abs(p.z-origin.z)) > this.radius) {
          truncated = true; continue;
        }
        if (nodes.has(key(p)) || !standable(p)) continue;
        const upper = dy > 0 ? from : p;
        if (dy !== 0 && !clear({ ...upper, y: upper.y + 2 })) continue;
        if (nodes.size >= this.maxNodes) { truncated = true; continue; }
        nodes.set(key(p), { position: p, parent: key(from), cost: nodes.get(key(from)).cost + 1 });
        queue.push(p);
      }
    }
    return { origin, nodes, unknown, truncated, observed: cache.size };
  }

  selectWorkPosition(survey, target, range = 3, { digging = false } = {}) {
    let best = null;
    for (const node of survey.nodes.values()) {
      const p = node.position;
      if (Math.hypot(p.x-target.x, p.y-target.y, p.z-target.z) > range) continue;
      const path = [];
      for (let n = node; n; n = n.parent ? survey.nodes.get(n.parent) : null) path.push(n.position);
      if (digging && path.some(s => s.x === target.x && s.z === target.z && s.y - 1 === target.y)) continue;
      // Periksa garis interaksi dari mata calon pijakan ke pusat target.
      const start = { x: p.x+.5, y: p.y+1.62, z: p.z+.5 };
      const end = { x: target.x+.5, y: target.y+.5, z: target.z+.5 };
      const length = Math.hypot(end.x-start.x, end.y-start.y, end.z-start.z);
      if (length > 4.5) continue;
      let blocked = false;
      for (let t = 0; t < 1; t += 0.2 / Math.max(length, 0.2)) {
        const q = { x: Math.floor(start.x+(end.x-start.x)*t), y: Math.floor(start.y+(end.y-start.y)*t), z: Math.floor(start.z+(end.z-start.z)*t) };
        if (key(q) === key(target)) break;
        const b = this.blockAt(q);
        if (!b || HAZARDS.has(b.name) || b.boundingBox !== 'empty' && !['air','cave_air','void_air'].includes(b.name)) { blocked = true; break; }
      }
      if (blocked) continue;
      const score = node.cost + length * 0.1;
      if (!best || score < best.score) best = { position: p, path: path.reverse(), score };
    }
    return best;
  }

  selectTarget(position, targets) {
    const survey = this.survey(position);
    let best = null;
    for (const target of targets) {
      if (Math.max(Math.abs(target.pos.x-survey.origin.x), Math.abs(target.pos.y-survey.origin.y), Math.abs(target.pos.z-survey.origin.z)) > this.radius + 3) continue;
      const stance = this.selectWorkPosition(survey, target.pos, 3, { digging: true });
      const priority = target.priority || 0;
      const bestPriority = best?.target.priority || 0;
      if (stance && (!best || priority < bestPriority || priority === bestPriority && stance.score < best.stance.score)) best = { target, stance };
    }
    return { ...best, status: best ? 'REACHABLE' : survey.unknown || survey.truncated ? 'NEEDS_SURVEY' : 'NEEDS_ACCESS', survey };
  }
}

module.exports = { LocalSpatialPlanner };
