/** Blueprint relatif; lokasi wajib diverifikasi melalui survei sebelum pembangunan. */
function createStorageRoomBlueprint({ minimumChests = 250, countAs = 'double' } = {}) {
  if (!Number.isInteger(minimumChests) || minimumChests < 1 || minimumChests > 1000) throw new RangeError('Kapasitas harus 1-1000 peti');
  if (!['blocks', 'double'].includes(countAs)) throw new TypeError('Hitungan peti tidak valid');
  const wings = Math.ceil(minimumChests * (countAs === 'double' ? 2 : 1) / 260);
  const width = 41;
  const depth = wings * 22 + 1;
  const blocks = [];
  const pairs = [];
  const add = (x, y, z, name, phase, properties) => {
    const { replaceNames, ...blockProperties } = properties || {};
    blocks.push({
      x, y, z, name, phase,
      ...(Object.keys(blockProperties).length ? { properties: blockProperties } : {}),
      ...(replaceNames ? { replaceNames } : {})
    });
  };
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      add(x, 0, z, 'stone_bricks', 'floor');
      add(x, 5, z, 'stone_bricks', 'roof');
      if (x === 0 || x === width - 1 || z === 0 || z === depth - 1) {
        for (let y = 1; y < 5; y++) {
          // Bukaan tiga blok membuat pintu terlihat dari luar dan menyisakan
          // jalur samping yang tidak bergantung pada state pintu.
          if (z === 0 && (x === 19 || x === 20 || x === 21) && y <= 2) continue;
          if (z === 0 && (x === 19 || x === 20 || x === 21) && y === 3) {
            add(x, y, z, 'stone_bricks', 'entry');
            continue;
          }
          add(x, y, z, 'stone_bricks', 'walls');
        }
      }
    }
  }
  // Akses depan harus menjadi bagian dari blueprint, bukan sekadar lubang pada
  // dinding. Worker pertama menangani ambang bersama ini setelah lantai/walls;
  // teras tiga blok selebar enam blok memberi bot dan pemain jalur masuk yang
  // terbaca dari luar, sekaligus menjaga permukaan tetap rata dengan lantai.
  for (let z = -6; z <= -1; z++) {
    for (let x = 19; x <= 21; x++) add(x, 0, z, 'stone_bricks', 'entry');
  }
  add(20, 1, 0, 'oak_door', 'entry', { facing: 'south', half: 'lower', hinge: 'left', open: true, powered: false });
  add(20, 2, 0, 'oak_door', 'entry', { facing: 'south', half: 'upper', hinge: 'left', open: true, powered: false });
  add(19, 1, 0, 'air', 'entry', { replaceNames: ['stone_bricks'] });
  add(19, 2, 0, 'air', 'entry', { replaceNames: ['stone_bricks'] });
  // The side clearance aligns with the chest-free aisle and makes the route
  // passable even when the door leaf is open.
  add(21, 1, 0, 'air', 'entry', { replaceNames: ['stone_bricks'] });
  add(21, 2, 0, 'air', 'entry', { replaceNames: ['stone_bricks'] });
  for (let wing = 0; wing < wings; wing++) {
    for (let bank = 0; bank < 5; bank++) {
      const z = wing * 22 + 2 + bank * 4;
      for (let pair = 0; pair < 13; pair++) {
        const x = 1 + pair * 3;
        for (let y = 1; y <= 2; y++) {
          // Jeda antar pasangan mencegah penggabungan dengan pasangan lain.
          // Untuk chest menghadap north, Minecraft menandai blok X sebagai
          // type=left dan blok X+1 sebagai type=right. Metadata harus mengikuti
          // blockstate live, bukan asumsi visual kiri/kanan dari blueprint.
          add(x, y, z, 'chest', 'storage', { facing: 'north', type: 'left' });
          add(x + 1, y, z, 'chest', 'storage', { facing: 'north', type: 'right' });
          pairs.push({ id: `w${wing}-b${bank}-p${pair}-h${y}`, left: { x: x + 1, y, z, properties: { facing: 'north', type: 'right' } }, right: { x, y, z, properties: { facing: 'north', type: 'left' } }, access: { x, y: 1, z: z - 1 } });
        }
      }
      for (let x = 2; x < width - 1; x += 6) add(x, 1, z + 2, 'torch', 'lighting');
    }
  }
  const materials = {};
  for (const block of blocks) {
    if (block.name === 'air') continue;
    materials[block.name] = (materials[block.name] || 0) + 1;
  }
  return {
    status: 'BLUEPRINT_ONLY_SITE_UNVERIFIED',
    dimensions: { width, depth, height: 6 },
    origin: null,
    chestBlocks: pairs.length * 2,
    doubleChests: pairs.length,
    inventorySlots: pairs.length * 54,
    materials,
    pairs,
    blocks,
    prerequisites: ['Survei voxel dan akses dari base', 'Validasi lahan bebas bangunan/kebun/air', 'Audit material', 'Builder survival dengan verifikasi blockstate dan checkpoint', 'Verifikasi cahaya serta pengamanan pintu']
  };
}

module.exports = { createStorageRoomBlueprint };
