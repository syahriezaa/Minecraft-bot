/**
 * Modul Assertion Khusus Pengujian E2E Minecraft Autonomous Companion.
 * Menyediakan assertion tingkat domain navigasi bot, sistem pertarungan, penyortiran peti,
 * keamanan bahaya, telemetri database, protokol WebSocket, dan lokalisasi UI.
 *
 * Semua pesan kesalahan ditulis dalam Bahasa Indonesia.
 */

const assert = require('node:assert/strict');

/**
 * Memvalidasi apakah posisi aktual bot berada dalam jarak toleransi dari target koordinat.
 * @param {{x: number, y: number, z: number}} actualPos - Posisi aktual bot
 * @param {{x: number, y: number, z: number}} targetPos - Posisi target
 * @param {number} tolerance - Jarak toleransi maksimum dalam blok/meter (default: 0.5)
 * @param {string} [message] - Pesan opsional saat assertion gagal
 */
function assertCoordinateClose(actualPos, targetPos, tolerance = 0.5, message = '') {
  assert.ok(actualPos, `Posisi aktual bot tidak boleh null atau undefined.`);
  assert.ok(targetPos, `Posisi target tidak boleh null atau undefined.`);

  const dx = actualPos.x - targetPos.x;
  const dy = actualPos.y - targetPos.y;
  const dz = actualPos.z - targetPos.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const customMsg = message ? ` (${message})` : '';
  assert.ok(
    distance <= tolerance + 1e-6,
    `Jarak koordinat melebihi toleransi! Jarak aktual: ${distance.toFixed(3)}m, toleransi maksimum: ${tolerance}m. ` +
    `Posisi Aktual: [${actualPos.x}, ${actualPos.y}, ${actualPos.z}], Target: [${targetPos.x}, ${targetPos.y}, ${targetPos.z}]${customMsg}`
  );
}

/**
 * Memverifikasi bahwa lintasan pergerakan bot menunjukkan progres mendekati target.
 * @param {Array<{x: number, y: number, z: number}>} pathHistory - Riwayat koordinat bot
 * @param {{x: number, y: number, z: number}} targetPos - Posisi target akhir
 */
function assertTrajectoryProgress(pathHistory, targetPos) {
  assert.ok(Array.isArray(pathHistory) && pathHistory.length >= 2, 'Riwayat lintasan harus memiliki minimal 2 titik.');
  const initialDist = Math.hypot(
    pathHistory[0].x - targetPos.x,
    pathHistory[0].y - targetPos.y,
    pathHistory[0].z - targetPos.z
  );
  const finalPos = pathHistory[pathHistory.length - 1];
  const finalDist = Math.hypot(
    finalPos.x - targetPos.x,
    finalPos.y - targetPos.y,
    finalPos.z - targetPos.z
  );

  assert.ok(
    finalDist < initialDist,
    `Lintasan tidak menunjukkan kemajuan! Jarak awal: ${initialDist.toFixed(2)}m, jarak akhir: ${finalDist.toFixed(2)}m.`
  );
}

/**
 * Memverifikasi transisi fase pemulihan macet (Stuck Recovery Phases: 1=Micro-jump, 2=Strafe, 3=Re-route, 4=Rewind).
 * @param {Array<{is_stuck?: boolean, recovery_phase?: number}>} movementLogs - Log pergerakan bot
 * @param {number|number[]} expectedPhases - Fase atau daftar fase yang diharapkan muncul
 */
function assertStuckRecoveryPhases(movementLogs, expectedPhases) {
  assert.ok(Array.isArray(movementLogs), 'movementLogs harus berupa array.');
  const phases = Array.isArray(expectedPhases) ? expectedPhases : [expectedPhases];

  const recordedPhases = movementLogs
    .filter(log => log.is_stuck || (log.recovery_phase && log.recovery_phase > 0))
    .map(log => log.recovery_phase);

  for (const expected of phases) {
    assert.ok(
      recordedPhases.includes(expected),
      `Fase pemulihan ${expected} tidak ditemukan dalam log pergerakan! Fase yang tercatat: [${recordedPhases.join(', ')}]`
    );
  }
}

/**
 * Memvalidasi jeda serangan senjata untuk menghindari spam click (weapon cooldown pacing >= minCooldownMs).
 * @param {number[]} attackTimestamps - Timestamp milidetik setiap serangan
 * @param {number} minCooldownMs - Batas minimum cooldown dalam milidetik (default: 625ms untuk pedang)
 */
function assertAttackPacing(attackTimestamps, minCooldownMs = 625) {
  assert.ok(Array.isArray(attackTimestamps) && attackTimestamps.length >= 2, 'Diperlukan minimal 2 serangan untuk validasi jeda.');

  for (let i = 1; i < attackTimestamps.length; i++) {
    const delta = attackTimestamps[i] - attackTimestamps[i - 1];
    assert.ok(
      delta >= minCooldownMs - 20, // Toleransi timer 20ms
      `Pelanggaran jeda serangan (Spam Attack terdeteksi)! Interval antara serangan ${i - 1} dan ${i} adalah ${delta}ms (minimum: ${minCooldownMs}ms).`
    );
  }
}

/**
 * Memverifikasi kategorisasi item dalam peti sesuai aturan penyimpanan.
 * @param {Object.<string, Array<{name: string, count: number}>>} chestSnapshot - Peta isi peti { chestId: items }
 * @param {Object.<string, string[]>} expectedRules - Aturan { categoryName: [allowedItemNames] }
 */
function assertChestSorting(chestSnapshot, expectedRules) {
  assert.ok(chestSnapshot && typeof chestSnapshot === 'object', 'chestSnapshot harus berupa objek.');
  assert.ok(expectedRules && typeof expectedRules === 'object', 'expectedRules harus berupa objek.');

  for (const [chestId, items] of Object.entries(chestSnapshot)) {
    const allowed = expectedRules[chestId];
    if (allowed) {
      for (const item of items) {
        assert.ok(
          allowed.includes(item.name),
          `Item tidak sesuai kategori! Peti "${chestId}" berisi item "${item.name}" yang tidak diizinkan. Item diizinkan: [${allowed.join(', ')}]`
        );
      }
    }
  }
}

/**
 * Memvalidasi bahwa posisi bot selalu menjaga jarak aman dari bahaya (lava/api).
 * @param {Array<{x: number, y: number, z: number}>|{x: number, y: number, z: number}} trajectoryOrPos - Riwayat atau posisi bot
 * @param {{x: number, y: number, z: number}} hazardCoord - Koordinat blok bahaya (lava/fire)
 * @param {number} minSafeDistance - Jarak minimum aman dalam meter (default: 1.5m)
 */
function assertSafeHazardDistance(trajectoryOrPos, hazardCoord, minSafeDistance = 1.5) {
  assert.ok(trajectoryOrPos, 'trajectoryOrPos tidak boleh kosong.');
  assert.ok(hazardCoord, 'hazardCoord tidak boleh kosong.');

  const points = Array.isArray(trajectoryOrPos) ? trajectoryOrPos : [trajectoryOrPos];

  for (const pt of points) {
    const dist2D = Math.hypot(pt.x - hazardCoord.x, pt.z - hazardCoord.z);
    assert.ok(
      dist2D >= minSafeDistance - 0.1,
      `Pelanggaran batas perimeter bahaya! Jarak bot ke lava adalah ${dist2D.toFixed(2)}m (batas minimum aman: ${minSafeDistance}m). Posisi bot: [${pt.x}, ${pt.y}, ${pt.z}]`
    );
  }
}

/**
 * Memverifikasi baris pencatatan telemetri di database PostgreSQL.
 * @param {Array<Object>} dbLogs - Rekaman log dari database
 * @param {string} [expectedLevel] - Level benchmark yang diharapkan ('1', '2', '3', '4' atau string)
 * @param {number} [minCount] - Jumlah minimum baris log yang diharapkan (default: 1)
 */
function assertDatabaseTelemetry(dbLogs, expectedLevel, minCount = 1) {
  assert.ok(Array.isArray(dbLogs), 'dbLogs harus berupa array hasil kueri database.');
  assert.ok(
    dbLogs.length >= minCount,
    `Jumlah baris log telemetri di database kurang dari yang diharapkan. Ditemukan: ${dbLogs.length}, minimal: ${minCount}.`
  );

  if (expectedLevel !== undefined && expectedLevel !== null) {
    const levelStr = String(expectedLevel);
    for (const log of dbLogs) {
      if (log.level) {
        assert.equal(
          String(log.level),
          levelStr,
          `Level pada log telemetri tidak cocok! Ditemukan: "${log.level}", diharapkan: "${levelStr}".`
        );
      }
    }
  }
}

/**
 * Memvalidasi penerimaan dan isi payload event WebSocket.
 * @param {Object} event - Objek event yang diterima dari WebSocket
 * @param {string} expectedType - Tipe event yang diharapkan (contoh: 'TICK_UPDATE', 'BENCHMARK_STATUS')
 * @param {Function} [validatorFn] - Fungsi validasi kustom untuk payload event data
 */
function assertWebSocketEvent(event, expectedType, validatorFn) {
  assert.ok(event, 'Event WebSocket tidak boleh null atau undefined.');
  assert.equal(
    event.type,
    expectedType,
    `Tipe event WebSocket tidak cocok! Diterima: "${event.type}", diharapkan: "${expectedType}".`
  );

  if (typeof validatorFn === 'function') {
    validatorFn(event.data);
  }
}

/**
 * Memvalidasi lokalisasi UI dan pesan kesalahan dalam Bahasa Indonesia.
 * @param {string} textOrHtml - Konten teks atau HTML yang akan divalidasi
 * @param {string[]} requiredTerms - Daftar kata/frasa Bahasa Indonesia yang harus ada
 */
function assertIndonesianLocalization(textOrHtml, requiredTerms) {
  assert.ok(typeof textOrHtml === 'string', 'textOrHtml harus berupa string.');
  assert.ok(Array.isArray(requiredTerms) && requiredTerms.length > 0, 'requiredTerms harus berupa array non-kosong.');

  for (const term of requiredTerms) {
    assert.ok(
      textOrHtml.includes(term),
      `Frasa lokalisasi Bahasa Indonesia "${term}" tidak ditemukan dalam konten yang diuji!`
    );
  }
}

/**
 * Memvalidasi penggunaan tipografi Google Fonts Poppins pada HTML atau CSS.
 * @param {string} cssOrHtml - Konten stylesheet atau markup halaman
 */
function assertPoppinsFont(cssOrHtml) {
  assert.ok(typeof cssOrHtml === 'string', 'cssOrHtml harus berupa string.');
  const hasPoppins = /font-family:[^;]*Poppins/i.test(cssOrHtml) || /fonts\.googleapis\.com[^"']*Poppins/i.test(cssOrHtml);
  assert.ok(
    hasPoppins,
    'Tipografi Google Fonts Poppins tidak ditemukan dalam stylesheet atau dokumen HTML!'
  );
}

module.exports = {
  ...assert,
  assertCoordinateClose,
  assertTrajectoryProgress,
  assertStuckRecoveryPhases,
  assertAttackPacing,
  assertChestSorting,
  assertSafeHazardDistance,
  assertDatabaseTelemetry,
  assertWebSocketEvent,
  assertIndonesianLocalization,
  assertPoppinsFont
};
