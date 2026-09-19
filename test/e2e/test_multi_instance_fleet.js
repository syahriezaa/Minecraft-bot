/**
 * @file test_multi_instance_fleet.js
 * @description Demonstrasi & eksekusi Armada Multi-Instance Bot Headless (3 Bot Simultan).
 */

const { MultiInstanceFarmManager } = require('../../src/benchmark/multiInstanceFarmRunner');
const { test } = require('node:test');

test('multi-instance fleet menyelesaikan simulasi farming', async () => {
  console.log('🌟 MEMULAI SIMULASI FARMING ARMADA MULTI-INSTANCE (3 BOT SIMULTAN) 🌟\n');

  const manager = new MultiInstanceFarmManager({ persistTelemetry: false });
  
  // Siapkan 3 Bot dengan tugas masing-masing
  const bots = manager.setupFleet(3);

  console.log('🤖 DAFTAR ARMADA BOT YANG DIKERAHKAN:');
  bots.forEach((b, idx) => {
    console.log(`   ${idx + 1}. [${b.id}] ${b.name} -> Target Posisi: (${b.position.x}, ${b.position.y}, ${b.position.z})`);
  });

  // Jalankan farming simultan selama 6 detik
  await manager.runFleet(6, (update) => {
    console.log(`[LIVE ${update.name}] ${update.action}`);
  });

  console.log('✅ EKSEKUSI MULTI-INSTANCE SELESAI DENGAN SUKSES!');
});
