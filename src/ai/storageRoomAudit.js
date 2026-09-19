/** Audit read-only untuk membuktikan storage room selesai dan aman dipakai. */

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_NAMES = new Set(['water', 'lava']);

function key(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function absolute(origin, block) {
  return { x: origin.x + block.x, y: origin.y + block.y, z: origin.z + block.z };
}

function isPassable(block) {
  return Boolean(block && !LIQUID_NAMES.has(block.name) && (AIR_NAMES.has(block.name) || block.boundingBox === 'empty'));
}

function getBlockProperty(block, name) {
  if (!block) return null;
  if (typeof block.getProperties === 'function') return block.getProperties()?.[name] ?? null;
  return block.properties?.[name] ?? block.state?.properties?.[name] ?? null;
}

function issue(list, value, maxIssues) {
  if (list.length < maxIssues) list.push(value);
}

/**
 * Memeriksa posisi blueprint tanpa menggali, menaruh blok, membuka chest, atau
 * mengubah inventory. Hasil ok hanya true bila semua gate yang dapat diverifikasi
 * lulus, termasuk data cahaya yang tersedia.
 */
async function auditStorageRoom({ adapter, blueprint, origin, minimumLight = 8, maxIssues = 50 } = {}) {
  if (!Number.isInteger(maxIssues) || maxIssues < 1) throw new TypeError('maxIssues must be a positive integer.');
  if (!adapter || typeof adapter.blockAt !== 'function') throw new TypeError('Audit membutuhkan adapter dengan blockAt().');
  if (!blueprint || !Array.isArray(blueprint.blocks) || !Array.isArray(blueprint.pairs)) throw new TypeError('Blueprint audit tidak valid.');
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isInteger)) throw new TypeError('Origin audit wajib berupa koordinat integer.');

  const expected = new Map();
  const expectedByName = {};
  const actualByName = {};
  const missing = [];
  const incorrect = [];
  const unknown = [];
  const liquids = [];
  const doorStateIssues = [];

  for (const block of blueprint.blocks) {
    const pos = absolute(origin, block);
    const id = key(pos);
    expected.set(id, { block, pos });
    expectedByName[block.name] = (expectedByName[block.name] || 0) + 1;
    const actual = adapter.blockAt(pos);
    if (!actual) {
      issue(unknown, { pos, expected: block.name }, maxIssues);
      continue;
    }
    if (LIQUID_NAMES.has(actual.name)) issue(liquids, { pos, name: actual.name }, maxIssues);
    if (actual.name !== block.name) {
      issue(incorrect, { pos, expected: block.name, actual: actual.name }, maxIssues);
      continue;
    }
    if (block.name.endsWith('_door') && typeof block.properties?.open === 'boolean') {
      const open = getBlockProperty(actual, 'open');
      if (open === null) {
        issue(unknown, { pos, expected: `door_open=${block.properties.open}` }, maxIssues);
      } else if (open !== block.properties.open) {
        issue(doorStateIssues, { pos, expectedOpen: block.properties.open, actualOpen: open }, maxIssues);
      }
    }
    actualByName[actual.name] = (actualByName[actual.name] || 0) + 1;
  }

  const pairIssues = [];
  const pairStateUnknown = [];
  let pairIssueCount = 0;
  let pairStateUnknownCount = 0;
  let verifiedDoubleChests = 0;
  let chestBlocksFound = 0;
  for (const pair of blueprint.pairs) {
    const left = absolute(origin, pair.left);
    const right = absolute(origin, pair.right);
    const leftBlock = adapter.blockAt(left);
    const rightBlock = adapter.blockAt(right);
    if (leftBlock?.name === 'chest') chestBlocksFound += 1;
    if (rightBlock?.name === 'chest') chestBlocksFound += 1;
    if (leftBlock?.name !== 'chest' || rightBlock?.name !== 'chest') {
      pairIssueCount += 1;
      issue(pairIssues, { id: pair.id, left, right, leftActual: leftBlock?.name || null, rightActual: rightBlock?.name || null }, maxIssues);
    } else {
      const leftType = getBlockProperty(leftBlock, 'type');
      const rightType = getBlockProperty(rightBlock, 'type');
      const leftFacing = getBlockProperty(leftBlock, 'facing');
      const rightFacing = getBlockProperty(rightBlock, 'facing');
      const facing = expected.get(key(left))?.block.properties?.facing;
      if (leftType === null || rightType === null || leftFacing === null || rightFacing === null) {
        pairStateUnknownCount += 1;
        issue(pairStateUnknown, { id: pair.id, left, right, leftType, rightType }, maxIssues);
      } else if (leftType !== (pair.left.properties?.type || 'left') || rightType !== (pair.right.properties?.type || 'right') ||
        leftFacing !== rightFacing || facing && leftFacing !== facing) {
        pairIssueCount += 1;
        issue(pairIssues, { id: pair.id, left, right, expected: { left: pair.left.properties?.type || 'left', right: pair.right.properties?.type || 'right', facing }, actual: { left: leftType, right: rightType, leftFacing, rightFacing } }, maxIssues);
      } else {
        verifiedDoubleChests += 1;
      }
    }
  }

  const entryAccessBlocked = [];
  const entryLaneX = 21;
  for (let z = -6; z <= 3; z += 1) {
    for (const y of [1, 2]) {
      const pos = absolute(origin, { x: entryLaneX, y, z });
      const actual = adapter.blockAt(pos);
      if (!actual) {
        issue(entryAccessBlocked, { pos, actual: null }, maxIssues);
        issue(unknown, { pos, expected: 'clear_entry_access' }, maxIssues);
      } else if (!isPassable(actual)) {
        issue(entryAccessBlocked, { pos, actual: actual.name }, maxIssues);
      } else if (LIQUID_NAMES.has(actual.name)) {
        issue(entryAccessBlocked, { pos, actual: actual.name }, maxIssues);
        issue(liquids, { pos, name: actual.name }, maxIssues);
      }
    }
  }

  const accessBlocked = [];
  for (const pair of blueprint.pairs) {
    for (const dy of [0, 1]) {
      const pos = absolute(origin, { ...pair.access, y: pair.access.y + dy });
      const actual = adapter.blockAt(pos);
      if (!isPassable(actual)) issue(accessBlocked, { id: pair.id, pos, actual: actual?.name || null }, maxIssues);
      if (!actual) issue(unknown, { pos, expected: 'clear_access' }, maxIssues);
      if (actual && LIQUID_NAMES.has(actual.name)) issue(liquids, { pos, name: actual.name }, maxIssues);
    }
  }

  const lightingExpected = blueprint.blocks.filter(block => block.phase === 'lighting');
  const lightingFound = lightingExpected.filter(block => adapter.blockAt(absolute(origin, block))?.name === block.name).length;
  const lowLight = [];
  let lightUnknown = 0;
  const width = blueprint.dimensions?.width || 0;
  const depth = blueprint.dimensions?.depth || 0;
  // Hanya audit sel lantai yang seharusnya menjadi lorong/ruang kosong; posisi chest
  // sendiri tidak dianggap sebagai ruang jalan.
  for (let x = 1; x < width - 1; x += 1) {
    for (let z = 1; z < depth - 1; z += 1) {
      const rel = { x, y: 1, z };
      const pos = absolute(origin, rel);
      if (expected.has(key(pos))) continue;
      const actual = adapter.blockAt(pos);
      if (!actual) { lightUnknown += 1; continue; }
      if (!isPassable(actual)) continue;
      if (!Number.isFinite(actual?.light)) {
        lightUnknown += 1;
      } else if (actual.light < minimumLight) {
        issue(lowLight, { pos, light: actual.light }, maxIssues);
      }
    }
  }

  const expectedBlockCount = blueprint.blocks.length;
  const actualBlockCount = Object.values(actualByName).reduce((sum, count) => sum + count, 0);
  const result = {
    ok: actualBlockCount === expectedBlockCount && missing.length === 0 && incorrect.length === 0 && unknown.length === 0 && liquids.length === 0 &&
    pairIssueCount === 0 && pairStateUnknownCount === 0 && doorStateIssues.length === 0 && accessBlocked.length === 0 && entryAccessBlocked.length === 0 && lightingFound === lightingExpected.length &&
      lowLight.length === 0 && lightUnknown === 0,
    expectedBlockCount,
    actualBlockCount,
    expectedByName,
    actualByName,
    expectedDoubleChests: blueprint.pairs.length,
    verifiedDoubleChests,
    expectedChestBlocks: blueprint.pairs.length * 2,
    chestBlocksFound,
    lightingExpected: lightingExpected.length,
    lightingFound,
    minimumLight,
    lightUnknown,
    lowLight,
    missing,
    incorrect,
    unknown,
    liquids,
    doorStateIssues,
    pairIssues,
    pairStateUnknown,
    accessBlocked,
    entryAccessBlocked
  };
  return result;
}

module.exports = { auditStorageRoom, key, isPassable };
