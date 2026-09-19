const {test} = require('node:test');
const assert = require('node:assert/strict');
const {analyzeSpatialRegion,TYPES} = require('../../src/ai/semanticSpatialAnalysis');
const bounds = {min:{x:0,y:0,z:0},max:{x:8,y:8,z:8}};
const b = (name,x=1,y=1,z=1)=>({name,position:{x,y,z},boundingBox:name==='air'?'empty':'block'});
const analyze = (blocks,entities=[])=>analyzeSpatialRegion({blocks,entities,bounds});

test('tanaman harus berada tepat di atas farmland; klasifikasi multi fungsi',()=>{
  const result=analyze([b('farmland'),b('wheat',1,2),b('chest',2),b('furnace',3),b('crafting_table',4)]);
  for(const type of ['crop_farm','storage','smeltery','workshop'])assert.ok(result.hypotheses.some(h=>h.type===type));
  assert.equal(result.complete,false);
  assert.equal(result.evidence.planted,1);
});
test('villager bukan bukti breeder atau iron farm',()=>{
  const result=analyze([], [{name:'villager',position:{x:1,y:1,z:1}}]);
  assert.deepEqual(result.hypotheses.map(h=>h.type),['villager_area']);
});
test('ruang tertutup memerlukan keenam batas diketahui',()=>{
  const blocks=[];
  for(let x=0;x<4;x++)for(let y=0;y<4;y++)for(let z=0;z<4;z++)blocks.push(b(x===0||y===0||z===0||x===3||y===3||z===3?'stone':'air',x,y,z));
  assert.equal(analyze(blocks).rooms.length,1);
  assert.equal(analyze(blocks.filter(v=>!(v.position.x===1&&v.position.y===3&&v.position.z===1))).rooms.length,0);
});
test('kategori infrastruktur memiliki bukti dan tidak mengklaim pasti',()=>{
  const result=analyze([b('nether_portal'),b('rail',2),b('redstone_wire',3),b('lava',4),b('water',5),b('spawner',6)]);
  for(const type of ['portal','railway','redstone_system','lava_hazard','water_area','mob_farm_candidate'])assert.ok(result.hypotheses.some(h=>h.type===type));
  assert.ok(result.hypotheses.every(h=>TYPES.includes(h.type)&&h.status==='tentative'));
});
