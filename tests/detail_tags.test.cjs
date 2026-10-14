const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/chapter.js','utf8');
const fn=source.slice(source.indexOf('async function saveDetailExtras'),source.indexOf('async function downloadArchive'));
const calls=[];
const context=vm.createContext({state:{detail:{tags:[{name:'猫',color:'#8AB0D8'}]}},detailTagItems:[{name:'猫',color:'#8AB0D8'}],$:()=>({value:''}),api:async(...args)=>calls.push(args),json:(method,body)=>({method,body})});
vm.runInContext(fn,context);
(async()=>{
  const body={favorite:true};await context.saveDetailExtras(body);
  assert.equal(body.tags,undefined,'Editing favorite must not freeze automatic tags');assert.equal(calls.length,0);
  context.detailTagItems[0].color='#649552';await context.saveDetailExtras({});assert.equal(calls.length,1);
  context.detailTagItems[0].name='  小猫  ';const changed={};await context.saveDetailExtras(changed);assert.equal(changed.tags[0],'小猫');
  context.detailTagItems.push({name:'小猫',color:'#649552'});await assert.rejects(()=>context.saveDetailExtras({}),/重复/);
  console.log('Detail tags: unchanged metadata preserved, explicit edits validated.');
})().catch(error=>{console.error(error);process.exitCode=1;});
