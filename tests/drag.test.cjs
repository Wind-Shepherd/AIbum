const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const classes=()=>({add(){},remove(){}});
const makeElement=()=>({style:{},classList:classes(),remove(){this.removed=true;},setAttribute(){},setPointerCapture(){},addEventListener(type,fn){this[type+'Capture']=fn;}});
const event=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){}});
// Pointer drags from the label must move the selection, not trigger folder folding.
const source=fs.readFileSync('web/atelier.js','utf8');let target={dataset:{importTarget:'existing:destination'},classList:classes()},moved=[],rendered=0;
const ctx=vm.createContext({importBusy:false,organizerSelected:new Set(['parent','child']),importDialog:{append(){}},document:{createElement:makeElement,elementFromPoint:()=>({closest:()=>target})},moveImportSelection:(...args)=>moved.push(args),renderImport:()=>rendered++});
vm.runInContext(source.slice(source.indexOf('function bindImportDrag'),source.indexOf('async function navigateOrganizer')),ctx);
const label=makeElement();ctx.bindImportDrag(label,{id:'parent',name:'旅途'});
label.onpointerdown(event(10,10));label.onpointermove(event(100,80));label.onpointerup(event(100,80));
assert.equal(moved.length,1);assert.deepEqual(Array.from(moved[0][0]),['parent','child']);assert.equal(moved[0][1],'existing:destination');assert.equal(rendered,1);
let stopped=false;label.clickCapture({preventDefault(){},stopImmediatePropagation(){stopped=true;}});assert.ok(stopped);
// A palette drop creates exactly one node at the pointer's canvas location.
const conditions=fs.readFileSync('web/conditions.js','utf8'),added=[],links=[];
let hit='canvas';const board={getBoundingClientRect:()=>({left:100,top:200}),append(){}};
const graph=vm.createContext({ConditionCore:require('../web/condition-core.js'),conditionZoom:1,conditionWire:null,document:{createElement:makeElement,createElementNS:makeElement,body:{append(){}},elementFromPoint:()=>({closest:selector=>hit==='canvas'?{}:{dataset:{nodeId:'operator',slot:'0'}}})},$:()=>board,addConditionNode:(...args)=>added.push(args),conditionConnect:(...args)=>links.push(args)});
vm.runInContext(conditions.slice(conditions.indexOf('function makeConditionToken'),conditions.indexOf('function addConditionNode')),graph);
const token=makeElement();graph.makeConditionToken(token,{tag:'猫'});token.onpointerdown(event(5,5));token.onpointermove(event(200,300));token.onpointerup(event(200,300));token.onclick();assert.equal(added.length,1);assert.equal(added[0][1],28);assert.equal(added[0][2],75);
// Dragging an output to an input connects the intended port, once.
hit='input';const port=makeElement();graph.bindConditionWire(port,{id:'leaf',x:10,y:20});port.onpointerdown(event(100,100));port.onpointermove(event(220,320));port.onpointerup(event(220,320));port.onclick(event(220,320));assert.equal(links.length,1);assert.deepEqual(links[0],['leaf','operator',0]);
console.log('Pointer interactions: hierarchy drop, palette placement and wire connection passed.');
