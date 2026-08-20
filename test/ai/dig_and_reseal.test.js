const { describe, it } = require('node:test');
const assert = require('node:assert');
const { digAndReseal } = require('../../src/ai/digAndReseal');

function fakeBot({ block = { name: 'cobblestone' }, inventoryItems = [], referenceBlock = { name: 'cobblestone', position: { x: 0, y: 0, z: 0 } } } = {}) {
  const digCalls = [];
  const equipCalls = [];
  const placeBlockCalls = [];
  return {
    inventory: { items: () => inventoryItems },
    blockAt: (pos) => {
      if (pos && pos.__isReference) return referenceBlock;
      return block;
    },
    dig: async (b) => { digCalls.push(b); },
    equip: async (item, dest) => { equipCalls.push({ item, dest }); },
    placeBlock: async (ref, faceVector) => { placeBlockCalls.push({ ref, faceVector }); },
    _digCalls: digCalls,
    _equipCalls: equipCalls,
    _placeBlockCalls: placeBlockCalls
  };
}

describe('digAndReseal - gali satu blok penghalang, lalu tambal kembali setelah lewat', () => {
  it('harus menggali blok di digPos', async () => {
    const bot = fakeBot({ inventoryItems: [{ name: 'cobblestone', count: 3 }] });
    await digAndReseal({ bot, digPos: { x: 1, y: 1, z: 1 }, referencePos: { x: 2, y: 1, z: 1, __isReference: true }, faceVector: { x: -1, y: 0, z: 0 }, replacementItemNames: ['cobblestone'] });
    assert.equal(bot._digCalls.length, 1);
  });

  it('kalau ADA blok cadangan yang cocok di inventaris, harus equip lalu placeBlock ke posisi referensi dengan faceVector yang diberikan - hasilnya resealed:true', async () => {
    const spareItem = { name: 'cobblestone', count: 1 };
    const bot = fakeBot({ inventoryItems: [spareItem] });
    const refPos = { x: 2, y: 1, z: 1, __isReference: true };
    const faceVector = { x: -1, y: 0, z: 0 };
    const result = await digAndReseal({ bot, digPos: { x: 1, y: 1, z: 1 }, referencePos: refPos, faceVector, replacementItemNames: ['cobblestone'] });
    assert.equal(bot._equipCalls.length, 1);
    assert.equal(bot._equipCalls[0].item, spareItem);
    assert.equal(bot._placeBlockCalls.length, 1);
    assert.equal(bot._placeBlockCalls[0].faceVector, faceVector);
    assert.equal(result.resealed, true);
  });

  it('kalau TIDAK ADA blok cadangan yang cocok di inventaris, TIDAK BOLEH mencoba placeBlock (akan gagal/exception) - cukup lapor resealed:false, dinding dibiarkan terbuka', async () => {
    const bot = fakeBot({ inventoryItems: [{ name: 'string', count: 1 }] });
    const result = await digAndReseal({ bot, digPos: { x: 1, y: 1, z: 1 }, referencePos: { x: 2, y: 1, z: 1, __isReference: true }, faceVector: { x: -1, y: 0, z: 0 }, replacementItemNames: ['cobblestone'] });
    assert.equal(bot._placeBlockCalls.length, 0);
    assert.equal(result.resealed, false);
  });
});
