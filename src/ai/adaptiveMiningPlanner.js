const OCEAN_LIQUID_RATIO = 0.55;
const OCEAN_DEEP_RATIO = 0.45;

function normalizeBounds(bounds) {
  return {
    minX: Math.min(bounds.minX, bounds.maxX), maxX: Math.max(bounds.minX, bounds.maxX),
    minZ: Math.min(bounds.minZ, bounds.maxZ), maxZ: Math.max(bounds.minZ, bounds.maxZ),
    floorY: Math.min(bounds.floorY, bounds.maxY), maxY: Math.max(bounds.floorY, bounds.maxY)
  };
}

function cellId(bounds) {
  return `mining:${bounds.minX}:${bounds.maxX}:${bounds.minZ}:${bounds.maxZ}:${bounds.floorY}:${bounds.maxY}`;
}

class AdaptiveMiningPlanner {
  constructor(options = {}) {
    this.cellSize = Math.max(4, Math.min(32, Number(options.cellSize) || 8));
    this.direction = options.direction === 'west' ? 'west' : 'east';
    this.protectionMargin = Math.max(2, Number(options.protectionMargin) || 4);
  }

  createSeedCells({ seedX, minZ, maxZ, floorY, maxY }) {
    if (![seedX, minZ, maxZ, floorY, maxY].every(Number.isInteger)) throw new Error('Seed frontier wajib memakai koordinat integer.');
    const lowZ = Math.min(minZ, maxZ);
    const highZ = Math.max(minZ, maxZ);
    const minX = this.direction === 'east' ? seedX : seedX - this.cellSize + 1;
    const maxX = this.direction === 'east' ? seedX + this.cellSize - 1 : seedX;
    const cells = [];
    for (let z = lowZ; z <= highZ; z += this.cellSize) {
      const bounds = normalizeBounds({ minX, maxX, minZ: z, maxZ: Math.min(highZ, z + this.cellSize - 1), floorY, maxY });
      cells.push({ id: cellId(bounds), bounds, state: 'UNSURVEYED', parentId: null, direction: this.direction });
    }
    return cells;
  }

  classifyCell(evidence = {}) {
    const total = Math.max(1, Number(evidence.totalColumns) || 0);
    const unknown = Math.max(0, Number(evidence.unknownColumns) || 0);
    const structures = Math.max(0, Number(evidence.structureColumns) || 0);
    const hazards = Math.max(0, Number(evidence.hazardColumns) || 0);
    const liquids = Math.max(0, Number(evidence.liquidColumns) || 0);
    const deepLiquids = Math.max(0, Number(evidence.deepLiquidColumns) || 0);
    const natural = Math.max(0, Number(evidence.naturalColumns) || 0);
    const caveColumns = Math.max(0, Number(evidence.caveColumns) || 0);
    const ravineColumns = Math.max(0, Number(evidence.ravineColumns) || 0);
    if (unknown > 0) return { classification: 'UNKNOWN', confidence: 1 - unknown / total, mineable: false };
    if (structures > 0) return { classification: 'PROTECTED', confidence: 1, mineable: false, protectionMargin: this.protectionMargin };
    if (hazards > 0) return { classification: 'HAZARD', confidence: 1, mineable: false };
    if (liquids / total >= OCEAN_LIQUID_RATIO && deepLiquids / total >= OCEAN_DEEP_RATIO) {
      return { classification: 'OCEAN', confidence: Math.min(1, (liquids + deepLiquids) / (total * 2)), mineable: false };
    }
    if (liquids > 0) return { classification: 'LIQUID_EDGE', confidence: 1, mineable: false };
    if (ravineColumns > 0) return { classification: 'RAVINE_EDGE', confidence: 1,
      mineable: natural > 0, restricted: true };
    if (caveColumns > 0) return { classification: 'CAVE_EDGE', confidence: 1,
      mineable: natural > 0, restricted: true };
    if (natural === total) return { classification: 'SAFE', confidence: 1, mineable: true };
    return { classification: 'MIXED', confidence: natural / total, mineable: false };
  }

  nextFrontierCells(cell, { classification, exhausted }) {
    // Struktur yang terdeteksi bukan alasan untuk mengulang sel yang sama
    // selamanya. Sel tersebut dilewati dan survei dilanjutkan ke timur; sel
    // tidak pernah dianggap mineable atau diberi izin menggali.
    const frontierEligible = ['SAFE', 'CAVE_EDGE', 'RAVINE_EDGE', 'PROTECTED'].includes(classification);
    if (!cell?.bounds || !frontierEligible || exhausted !== true) return [];
    const width = cell.bounds.maxX - cell.bounds.minX + 1;
    const delta = this.direction === 'east' ? width : -width;
    const bounds = normalizeBounds({
      ...cell.bounds,
      minX: cell.bounds.minX + delta,
      maxX: cell.bounds.maxX + delta
    });
    return [{ id: cellId(bounds), bounds, state: 'UNSURVEYED', parentId: cell.id, direction: this.direction }];
  }

  shouldReturn(snapshot = {}) {
    if (Number(snapshot.inventoryFillRatio) >= Number(snapshot.returnInventoryRatio ?? 0.8)) return { return: true, reason: 'INVENTORY_TARGET' };
    if (Number.isFinite(snapshot.toolDurabilityRatio) && snapshot.toolDurabilityRatio <= 0.12) return { return: true, reason: 'TOOL_LOW' };
    if (Number.isFinite(snapshot.health) && snapshot.health < 10) return { return: true, reason: 'LOW_HEALTH' };
    if (Number.isFinite(snapshot.food) && snapshot.food < 8) return { return: true, reason: 'LOW_FOOD' };
    if (snapshot.routeHomeAvailable === false) return { return: true, reason: 'NO_SAFE_RETURN_ROUTE' };
    if (snapshot.safeTargetsRemaining === 0) return { return: true, reason: 'NO_SAFE_TARGET' };
    return { return: false, reason: null };
  }
}

module.exports = { AdaptiveMiningPlanner, cellId, normalizeBounds };
