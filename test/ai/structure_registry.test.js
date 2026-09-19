const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SharedWorldMemory}=require('../../src/ai/sharedWorldMemory');
const {StructureRegistry}=require('../../src/ai/structureRegistry');
const ctx={world:'test',dimension:'overworld'};
const b=(x,name='oak_planks',y=64)=>({name,position:{x,y,z:0}});

test('ID lintas pengamatan, label, pemisahan lantai, merge dan invalidasi setelah penghubung hilang',()=>{
  const memory=new SharedWorldMemory(':memory:');const registry=new StructureRegistry(memory);
  try {
    registry.observe(ctx,[b(0),b(1)]);
    const id=registry.list()[0].id;
    registry.label(id,'Rumah utama');
    registry.observe(ctx,[b(1),b(2)]);
    assert.equal(registry.list()[0].id,id);
    assert.equal(registry.list()[0].observedVoxels,3);
    assert.equal(registry.list()[0].label,'Rumah utama');
    registry.observe(ctx,[b(1,'air')]);
    assert.equal(registry.list().filter(s=>s.observedVoxels).length,2);
    registry.observe(ctx,[b(1)]);
    assert.equal(registry.list().filter(s=>s.observedVoxels).length,1);
    registry.observe(ctx,[b(0,'oak_planks',70)]);
    assert.equal(registry.list().filter(s=>s.observedVoxels).length,2);
    registry.observe({...ctx,dimension:'nether'},[b(0)]);
    assert.equal(registry.list().filter(s=>s.observedVoxels).length,3);
  }finally{memory.close();}
});
