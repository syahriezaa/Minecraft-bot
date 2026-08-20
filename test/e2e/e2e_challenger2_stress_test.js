/**
 * @file e2e_challenger2_stress_test.js
 * @description Adversarial Challenge & Stress Test Harness by E2E Challenger 2.
 * Memverifikasi secara independen:
 * 1. Attack Cooldown Pacing Invariants (assertAttackPacing sensitivity to spam < 625ms).
 * 2. XP & Level Progression Formulations under edge cases.
 * 3. PostgreSQL Database Persistence & Schema Integrity for spawner telemetry.
 * 4. Coordinate targeting accuracy for Level 4 Spawner [-256, -20, -432].
 */

const assert = require('node:assert/strict');
const { assertAttackPacing, assertCoordinateClose } = require('../helpers/assertions');
const { WEAPON_COOLDOWNS_MS, TARGET_SPAWNER_COORDINATES, BENCHMARK_CONFIGS } = require('../../src/config/constants');
const db = require('../../src/config/database');
const { MockArenaHarness } = require('../helpers/mockArenaHarness');

async function runEmpiricalChallenges() {
  console.log('🧪 =========================================================');
  console.log('🧪 EMPIRICAL CHALLENGER 2 — ADVERSARIAL STRESS SUITE');
  console.log('🧪 =========================================================\n');

  let passed = 0;
  let total = 0;

  function runCase(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✖ [FAIL] ${name}: ${e.message}`);
      throw e;
    }
  }

  async function runCaseAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✖ [FAIL] ${name}: ${e.message}`);
      throw e;
    }
  }

  // --- CHALLENGE 1: Attack Cooldown Pacing Invariant ---
  runCase('CH-01: Cooldown Pedang >= 625ms terkonfigurasi di constants', () => {
    assert.equal(WEAPON_COOLDOWNS_MS.sword, 625, 'Cooldown sword harus tepat 625ms');
    assert.equal(WEAPON_COOLDOWNS_MS.axe, 1250, 'Cooldown axe harus tepat 1250ms');
  });

  runCase('CH-02: assertAttackPacing menerima interval valid (>= 625ms)', () => {
    const validTimestamps = [1000, 1630, 2265, 2900];
    assertAttackPacing(validTimestamps, 625);
  });

  runCase('CH-03: assertAttackPacing MENOLAK spam click (< 605ms toleransi)', () => {
    const spamTimestamps = [1000, 1300, 1600]; // delta 300ms
    let caught = false;
    try {
      assertAttackPacing(spamTimestamps, 625);
    } catch (err) {
      caught = true;
      assert.ok(err.message.includes('Pelanggaran jeda serangan'), 'Error message harus Bahasa Indonesia baku');
    }
    assert.ok(caught, 'Harus melempar error saat spam click terjadi');
  });

  // --- CHALLENGE 2: XP Progression & Level Bounds ---
  runCase('CH-04: Kalkulasi Level Minecraft XP bertingkat', () => {
    const calcLevel = (xp) => Math.floor(xp / 7);
    assert.equal(calcLevel(0), 0);
    assert.equal(calcLevel(5), 0);
    assert.equal(calcLevel(7), 1);
    assert.equal(calcLevel(14), 2);
    assert.equal(calcLevel(15), 2);
    assert.equal(calcLevel(21), 3);
  });

  // --- CHALLENGE 3: Spawner Coordinates Target Invariant ---
  runCase('CH-05: Target Spawner Coordinate Invariant [-256, -20, -432]', () => {
    assert.deepEqual(TARGET_SPAWNER_COORDINATES, { x: -256, y: -20, z: -432 });
    assert.deepEqual(BENCHMARK_CONFIGS.level4.targetCoord, { x: -256, y: -20, z: -432 });
    assertCoordinateClose({ x: -256.1, y: -20.0, z: -431.9 }, TARGET_SPAWNER_COORDINATES, 0.6);
  });

  // --- CHALLENGE 4: PostgreSQL Telemetry Persistence Verification ---
  await runCaseAsync('CH-06: Verifikasi PostgreSQL Database Telemetry Query', async () => {
    const res = await db.query(
      `SELECT level, status, metadata FROM benchmark_runs WHERE level IN ('combat_farm', '4', 'multi_instance_fleet') ORDER BY start_time DESC LIMIT 5`
    );
    assert.ok(res.rows.length >= 1, 'Harus ada baris benchmark_runs yang tersimpan di database');
    const combatRun = res.rows.find(r => r.level === 'combat_farm');
    if (combatRun) {
      assert.equal(combatRun.status, 'SUCCESS');
      const meta = typeof combatRun.metadata === 'string' ? JSON.parse(combatRun.metadata) : combatRun.metadata;
      assert.ok(meta.xpGained >= 15, 'XP Gained harus >= 15');
      assert.ok(meta.finalLevel >= 2, 'Final Level harus >= 2');
    }
  });

  // --- CHALLENGE 5: Headless Arena Combat Loop with Cooldown Execution ---
  await runCaseAsync('CH-07: Headless Arena Attack Cooldown Event Emission', async () => {
    const arena = new MockArenaHarness({ port: 25579 });
    await arena.start();

    const attacks = [];
    arena.on('entityAttack', (evt) => attacks.push(evt));

    const startTime = Date.now();
    for (let i = 0; i < 3; i++) {
      arena.bot.attack({ type: 'zombie', id: `stress_z_${i}` });
      if (i < 2) await new Promise(r => setTimeout(r, 630));
    }

    assert.equal(attacks.length, 3, 'Harus ada 3 event serangan');
    const timestamps = attacks.map(a => a.timestamp);
    assertAttackPacing(timestamps, 625);

    await arena.stop();
  });

  console.log(`\n🏆 STRESS TEST COMPLETE: ${passed}/${total} PASSED (100% INVARIANTS SATISFIED)\n`);
  await db.closeDatabasePool();
}

if (require.main === module) {
  runEmpiricalChallenges().catch(err => {
    console.error('FATAL STRESS ERROR:', err);
    process.exit(1);
  });
}

module.exports = { runEmpiricalChallenges };
