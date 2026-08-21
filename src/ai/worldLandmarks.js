/**
 * @file worldLandmarks.js
 * @description Memori landmark dunia - lokasi penting yang ditemukan/ditandai (peti, farming area,
 * mob spawner, sungai, villager trading hall, villager farm, dst) - DIBAGIKAN ke semua bot, sama
 * seperti storageMemory.js. Permintaan nyata pemilik: "mari kita buat bot explorer yang menandai
 * akan mengeksplor map area area dan tempat tempat penting dengan ruang 3d koordinat xyz...jika
 * itu satu titik tulis titiknya, jika area tulis batas batasnya sebagai vektor yang nantinya bisa
 * di interpretasikan". Landmark titik (chest, mob spawner) disimpan sebagai satu koordinat
 * {x,y,z}; landmark area (farming area, sungai, villager farm) disimpan sebagai poligon (daftar
 * titik {x,z} berurutan) yang bisa diuji "apakah posisi ini di dalamnya" lewat point-in-polygon.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORLD_LANDMARKS_FILE = process.env.WORLD_LANDMARKS_FILE || path.join(__dirname, '..', '..', 'data', 'worldLandmarks.json');

function loadLandmarks(log = () => {}) {
  try {
    if (!fs.existsSync(WORLD_LANDMARKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(WORLD_LANDMARKS_FILE, 'utf8'));
  } catch (e) {
    log(`PERINGATAN: gagal memuat memori landmark dunia dari disk (${e.message}) - mulai dari kosong.`);
    return [];
  }
}

function saveLandmarks(landmarks, log = () => {}) {
  try {
    fs.mkdirSync(path.dirname(WORLD_LANDMARKS_FILE), { recursive: true });
    fs.writeFileSync(WORLD_LANDMARKS_FILE, JSON.stringify(landmarks, null, 2));
  } catch (e) {
    log(`PERINGATAN: gagal menyimpan memori landmark dunia ke disk (${e.message})`);
  }
}

// Tambah SATU landmark baru ke memori yang sudah ada di disk (bukan menimpa) - bot explorer
// menemukan landmark satu-satu seiring berjalan, bukan sekaligus semua di akhir sesi (kalau
// proses mati di tengah jalan, landmark yang sudah ditemukan tidak boleh hilang).
function addLandmark(landmark, log = () => {}) {
  const landmarks = loadLandmarks(log);
  landmarks.push(landmark);
  saveLandmarks(landmarks, log);
  return landmarks;
}

function makePointLandmark({ name, category, position, description, source = 'explorer' }) {
  return {
    id: crypto.randomUUID(),
    shape: 'point',
    name,
    category,
    position: { x: position.x, y: position.y, z: position.z },
    description: description || null,
    source,
    discoveredAt: Date.now()
  };
}

// boundary: daftar titik {x,z} berurutan mengelilingi tepi area (poligon) - Y sengaja tidak
// dipakai untuk batas (area di Minecraft dipahami sebagai jejak di peta atas, bukan volume 3D
// tertutup) - permintaan nyata pemilik: "batas batasnya sebagai vektor yang nantinya bisa di
// interpretasikan".
function makeAreaLandmark({ name, category, boundary, description, source = 'explorer' }) {
  return {
    id: crypto.randomUUID(),
    shape: 'area',
    name,
    category,
    boundary: boundary.map((p) => ({ x: p.x, z: p.z })),
    description: description || null,
    source,
    discoveredAt: Date.now()
  };
}

// Point-in-polygon standar (ray casting) - bekerja untuk poligon TIDAK BERATURAN/tidak cembung
// (mis. bentuk L, sungai berkelok), bukan cuma kotak.
function isInsideAreaLandmark(landmark, pos) {
  if (!landmark || landmark.shape !== 'area' || !Array.isArray(landmark.boundary)) return false;
  const { x, z } = pos;
  const points = landmark.boundary;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, zi = points[i].z;
    const xj = points[j].x, zj = points[j].z;
    const intersects = ((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

// Landmark TITIK dalam jarak tertentu dari suatu posisi, diurutkan dari yang terdekat - dipakai
// bot lain untuk "apa saja yang sudah dikenal di sekitar sini" tanpa perlu memindai dunia lagi.
function findNearbyLandmarks(pos, maxDistance, log = () => {}) {
  return loadLandmarks(log)
    .filter((l) => l.shape === 'point')
    .filter((l) => distance(l.position, pos) <= maxDistance)
    .sort((a, b) => distance(a.position, pos) - distance(b.position, pos));
}

// Cek apakah suatu posisi ada di dalam AREA landmark manapun dari kategori yang diberikan -
// dipakai bot lain (mis. FarmerWorker) untuk menghindari zona yang sudah ditandai otomatis
// (mis. villager_farm, villager_trading_hall, hazard) tanpa perlu koordinat hardcode manual lagi.
function isInsideAnyLandmarkOfCategory(pos, categories, log = () => {}) {
  const wanted = new Set(categories);
  return loadLandmarks(log)
    .filter((l) => l.shape === 'area' && wanted.has(l.category))
    .some((l) => isInsideAreaLandmark(l, pos));
}

module.exports = {
  WORLD_LANDMARKS_FILE,
  loadLandmarks,
  saveLandmarks,
  addLandmark,
  makePointLandmark,
  makeAreaLandmark,
  isInsideAreaLandmark,
  findNearbyLandmarks,
  isInsideAnyLandmarkOfCategory
};
