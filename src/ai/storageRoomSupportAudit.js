/** Audit pondasi saja; lantai dan bangunan di atas datum tidak pernah digali. */
const { Vec3 } = require('vec3');
const { isAir, LIQUID_NAMES } = require('./storageRoomLandscaper');

const LANDSCAPE_DIRT_SOURCE = Object.freeze({ x: -181, y: 74, z: -352 });
const RELOCATED_BOUNDS = Object.freeze({ minX: -110, maxX: -70, minZ: -400, maxZ: -356 });
const OFFSETS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const positionKey = pos => `${pos.x},${pos.y},${pos.z}`;
const fullSupport = block => Boolean(block && !LIQUID_NAMES.has(block.name) && block.boundingBox === 'block' &&
  (!block.shapes || block.shapes.some(shape => shape.length === 6 && shape.every((v, i) => v === (i < 3 ? 0 : 1)))));

function supportBounds(origin, blueprint) {
  if (!origin || !['x', 'y', 'z'].every(axis => Number.isInteger(origin[axis]))) throw new Error('Origin pondasi wajib integer.');
  const { width, depth } = blueprint?.dimensions || {};
  if (![width, depth].every(n => Number.isInteger(n) && n > 0)) throw new Error('Dimensi pondasi tidak valid.');
  return { minX: origin.x, maxX: origin.x + width - 1, minZ: origin.z, maxZ: origin.z + depth - 1 };
}

function overlapsRelocatedFootprint(origin, blueprint) {
  const b = supportBounds(origin, blueprint);
  return b.minX <= RELOCATED_BOUNDS.maxX && b.maxX >= RELOCATED_BOUNDS.minX &&
    b.minZ <= RELOCATED_BOUNDS.maxZ && b.maxZ >= RELOCATED_BOUNDS.minZ;
}

function auditStorageRoomSupport({ adapter, origin, blueprint }) {
  const bounds = supportBounds(origin, blueprint);
  const supportY = origin.y - 1;
  const summary = { columns: 0, supported: 0, holes: 0, unknown: 0, liquid: 0, blocked: 0, floorOccupied: 0, floorUnknown: 0 };
  const supportBlocks = {};
  const floorBlocks = {};
  const columns = [];
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
      const position = { x, y: supportY, z };
      const support = adapter.blockAt(position);
      const floor = adapter.blockAt({ x, y: origin.y, z });
      // Jika lantai datum sudah berupa blok penuh, ruang kosong tepat di bawahnya
      // bukan lubang pondasi yang perlu diisi. Audit lama menandainya sebagai hole
      // walau blok bangunan berikutnya tetap berdiri aman di atas lantai tersebut.
      const status = !support ? 'unknown' : LIQUID_NAMES.has(support.name) ? 'liquid' :
        isAir(support) ? (fullSupport(floor) ? 'supported' : 'holes') :
          fullSupport(support) ? 'supported' : 'blocked';
      summary.columns += 1;
      summary[status] += 1;
      if (!floor) summary.floorUnknown += 1;
      else if (!isAir(floor)) summary.floorOccupied += 1;
      if (support) supportBlocks[support.name] = (supportBlocks[support.name] || 0) + 1;
      if (floor) floorBlocks[floor.name] = (floorBlocks[floor.name] || 0) + 1;
      columns.push({ position, status, support: support?.name ?? null, floor: floor?.name ?? null });
    }
  }
  return { observedAt: new Date().toISOString(), bounds, supportY, floorY: origin.y,
    ok: summary.supported === summary.columns, summary, supportBlocks, floorBlocks, columns };
}

function inspectSupportHole(adapter, position) {
  const target = adapter.blockAt(position);
  if (!target) return { reason: 'unknown' };
  if (fullSupport(target)) return { reason: 'already_supported' };
  if (!isAir(target)) return { reason: 'target_not_air' };
  // Lubang tertutup lantai/dinding ditinggalkan; jangan membuka akses dengan menggali bangunan.
  for (const dy of [1, 2]) {
    const overhead = adapter.blockAt({ ...position, y: position.y + dy });
    if (!overhead) return { reason: 'unknown_access' };
    if (!isAir(overhead)) return { reason: 'covered_by_block' };
  }
  const references = [];
  for (const [dx, dy, dz] of OFFSETS) {
    const neighbor = adapter.blockAt({ x: position.x + dx, y: position.y + dy, z: position.z + dz });
    if (!neighbor) return { reason: 'unknown_neighbor' };
    if (LIQUID_NAMES.has(neighbor.name) || neighbor.getProperties?.().waterlogged) return { reason: 'liquid_neighbor' };
    if (fullSupport(neighbor)) references.push({ reference: neighbor, face: new Vec3(-dx || 0, -dy || 0, -dz || 0) });
  }
  return references.length ? { references } : { reason: 'no_reference' };
}

async function maintainStorageRoomSupport({ adapter, origin, blueprint, execute = false, restockDirt,
  verifyTimeoutMs = 3000, log = () => {} }) {
  const initial = auditStorageRoomSupport({ adapter, origin, blueprint });
  const result = { mode: execute ? 'repair_support' : 'observe_support', initial, final: initial, repairs: [], skipped: [], dirtWithdrawn: 0 };
  if (!execute || !initial.summary.holes || initial.summary.unknown || initial.summary.liquid || initial.summary.blocked) return result;
  const candidates = initial.columns.filter(column => column.status === 'holes' && !inspectSupportHole(adapter, column.position).reason);
  if (candidates.length > adapter.getItemCount('dirt') && restockDirt) {
    result.dirtWithdrawn = await restockDirt(candidates.length - adapter.getItemCount('dirt'));
  }
  for (const column of initial.columns.filter(column => column.status === 'holes')) {
    const pos = column.position;
    let check = inspectSupportHole(adapter, pos);
    let reason = check.reason;
    if (!reason && adapter.getItemCount('dirt') === 0) reason = 'dirt_shortage';
    if (!reason) {
      reason = 'placement_unverified';
      for (const candidate of check.references) {
        try {
          if (!await adapter.navigateNear(candidate.reference.position, 3)) continue;
          if (!await adapter.equipItem('dirt', 'hand')) break;
          // Aksi builder dapat terjadi selama perjalanan; baca ulang sebelum placement.
          check = inspectSupportHole(adapter, pos);
          if (check.reason) { reason = check.reason; break; }
          const liveReference = check.references.find(ref => positionKey(ref.reference.position) === positionKey(candidate.reference.position));
          if (!liveReference) continue;
          await adapter.placeBlockAt(pos, liveReference.reference, liveReference.face);
          const deadline = Date.now() + verifyTimeoutMs;
          do {
            if (adapter.blockAt(pos)?.name === 'dirt') { reason = null; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          if (!reason) break;
        } catch (error) { log(`Isi pondasi (${positionKey(pos)}) gagal: ${error.message}`); }
      }
    }
    if (reason) result.skipped.push({ position: pos, reason });
    else { result.repairs.push({ position: pos, material: 'dirt', verified: true }); log(`Pondasi dirt terverifikasi (${positionKey(pos)}).`); }
  }
  result.final = auditStorageRoomSupport({ adapter, origin, blueprint });
  return result;
}

module.exports = { auditStorageRoomSupport, maintainStorageRoomSupport, inspectSupportHole,
  overlapsRelocatedFootprint, LANDSCAPE_DIRT_SOURCE };
