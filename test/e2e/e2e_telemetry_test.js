/**
 * Alias Suite Pengujian E2E: Telemetry & Dashboard (PostgreSQL & WebSocket)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { PgTestClient } = require('../helpers/dbTestHelper');
const { MockWebServer, WsTestClient } = require('../helpers/wsTestHelper');
const { assertPoppinsFont, assertIndonesianLocalization, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E Telemetry & Dashboard (PostgreSQL & WebSocket)...');
  const db = new PgTestClient();
  await db.connect();
  await db.runMigrations();

  const webServer = new MockWebServer(8085);
  await webServer.start();

  const wsClient = new WsTestClient('ws://localhost:8085');
  await wsClient.connect();

  const runId = db.createTestRunId();
  for (let i = 0; i < 20; i++) {
    await db.insertMovementLog({ run_id: runId, tick: i, x: i, y: 64, z: 0 });
  }

  const count = await db.countMovementTicks(runId);
  equal(count, 20, '20 tick tersimpan di PostgreSQL.');

  const res = await fetch('http://localhost:8085/');
  const html = await res.text();
  assertPoppinsFont(html);
  assertIndonesianLocalization(html, ['Dasbor Pengendali', 'Status Sistem']);

  await wsClient.disconnect();
  await webServer.stop();
  await db.cleanupAndClose();
  console.log('🎉 Telemetry & Dashboard Selesai: Verifikasi DB & Web UI Sukses 100%!');
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji Telemetry Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
