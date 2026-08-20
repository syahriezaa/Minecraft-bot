/**
 * @file run_survival_role_bot.test.js
 * @description Unit test parser konfigurasi launcher SurvivalRoleBot.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildOptionsFromEnv, parseArea, parseCoord } = require('../../src/ai/runSurvivalRoleBot');

describe('runSurvivalRoleBot config parser', () => {
  it('harus membaca koordinat dan area dari environment', () => {
    assert.deepEqual(parseCoord('1,64,-2'), { x: 1, y: 64, z: -2 });
    assert.deepEqual(parseArea('0,63,0:10,70,10'), {
      min: { x: 0, y: 63, z: 0 },
      max: { x: 10, y: 70, z: 10 }
    });
  });

  it('harus membangun opsi coordinator lengkap tanpa menyentuh server', () => {
    const options = buildOptionsFromEnv({
      MC_HOST: 'example.test',
      MC_PORT: '25566',
      MC_USERNAME: 'FarmBot',
      MC_VERSION: '26.1.2',
      AWARENESS_SCAN_PROFILE: 'cave',
      AWARENESS_CHUNK_RADIUS: '10',
      AWARENESS_VERTICAL_RADIUS: '6',
      AWARENESS_VERTICAL_BELOW: '9',
      AWARENESS_VERTICAL_ABOVE: '5',
      FARM_AREA: '0,63,0:10,70,10',
      FARM_CHEST: '5,64,5',
      MOB_FARM_CENTER: '-20,60,8',
      MOB_FARM_RADIUS: '6',
      MOB_STANDBY: '-20,61,10',
      MOB_RETREAT: '-20,61,16'
    });

    assert.equal(options.host, 'example.test');
    assert.equal(options.port, 25566);
    assert.equal(options.username, 'FarmBot');
    assert.equal(options.coordinator.awareness.scanProfile, 'cave');
    assert.equal(options.coordinator.awareness.chunkRadius, 10);
    assert.equal(options.coordinator.awareness.verticalRadius, 6);
    assert.equal(options.coordinator.awareness.verticalBelow, 9);
    assert.equal(options.coordinator.awareness.verticalAbove, 5);
    assert.deepEqual(options.coordinator.mobFarmOptions.killChamber, {
      center: { x: -20, y: 60, z: 8 },
      radius: 6
    });
    assert.deepEqual(options.coordinator.farmerOptions.depositChest, { x: 5, y: 64, z: 5 });
  });
});
