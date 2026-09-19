// Area yang wajib tetap bebas untuk berjalan, membuka kontainer, dan berpindah lantai di gudang
// lama. Mesin produksi boleh berinteraksi dari area ini, tetapi tidak boleh menempatkan atau
// memilih workstation di dalam volumenya.
const STORAGE_ACCESS_BOUNDS = {
  min: { x: -195, y: 70, z: -360 },
  max: { x: -175, y: 76, z: -338 }
};

function configuredStorageRoomBounds() {
  const values = String(process.env.STORAGE_ROOM_ORIGIN || '-110,70,-400').split(',').map(Number);
  const [x, y, z] = values.length === 3 && values.every(Number.isInteger) ? values : [-110, 70, -400];
  const wings = Math.ceil((250 * 2) / 260);
  return {
    min: { x, y, z: z - 6 },
    max: { x: x + 40, y: y + 6, z: z + wings * 22 }
  };
}

function isStorageAccessPosition(pos) {
  const bounds = [STORAGE_ACCESS_BOUNDS, configuredStorageRoomBounds()];
  return bounds.some(area => pos.x >= area.min.x && pos.x <= area.max.x &&
    pos.y >= area.min.y && pos.y <= area.max.y &&
    pos.z >= area.min.z && pos.z <= area.max.z);
}

module.exports = { STORAGE_ACCESS_BOUNDS, isStorageAccessPosition };
