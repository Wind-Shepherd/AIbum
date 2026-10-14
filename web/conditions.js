let conditionZoom=1;
let tagLogic=null, conditionNodes=[], conditionRoot=null, conditionSerial=0, conditionSelected=null, conditionWire=null, conditionHistory=[];
const TAG_COLORS=['#8AB0D8','#649552','#F2A082','#F4B842','#B29AD8','#5AB8B8','#B0BCC8'];
function conditionRemember(){conditionHistory.push(JSON.stringify({nodes:conditionNodes,root:conditionRoot}));if(conditionHistory.length>30)conditionHistory.shift();}
function resetTagLogic(){conditionZoom=1;if($('condition-canvas'))$('condition-canvas').style.zoom=1;tagLogic=null;conditionNodes=[];conditionRoot=null;conditionSelected=null;conditionHistory=[];if($('condition-canvas')){renderConditionCanvas();$('condition-text').value='';$('condition-status').textContent='拖入条件和运算符，再连接圆点。';}}
function renderTagOptions(){
  const host=$('tag-options');host.replaceChildren();const key=$('tag-keyword').value.toLowerCase();
  state.tagOptions.filter(t=>t.name.toLowerCase().includes(key)).forEach((tag,i)=>{const b=document.createElement('button');b.type='button';b.className='condition-token';b.style.setProperty('--token-color',tag.color||TAG_COLORS[i%7]);b.textContent=tag.name+' · '+tag.count;b.title='拖入画布，或点击添加 '+tag.name;makeConditionToken(b,{tag:tag.name});host.append(b);});
  if(!host.children.length)host.textContent='还没有匹配的标签';
}
function makeConditionToken(button,value){
  let drag=null,suppressClick=false;button.draggable=false;
  button.onclick=()=>{if(suppressClick){suppressClick=false;return;}addConditionNode(value);};
  button.onpointerdown=e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,ghost:null};button.setPointerCapture(e.pointerId);};
  button.onpointermove=e=>{if(!drag||drag.id!==e.pointerId)return;if(!drag.ghost&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;e.preventDefault();if(!drag.ghost){drag.ghost=document.createElement('div');drag.ghost.className='filing-drag-ghost';drag.ghost.textContent=ConditionCore.label(value);document.body.append(drag.ghost);}drag.ghost.style.left=e.clientX+12+'px';drag.ghost.style.top=e.clientY+12+'px';};
  button.onpointerup=e=>{if(!drag)return;const current=drag;drag=null;if(!current.ghost)return;suppressClick=true;current.ghost.remove();const target=document.elementFromPoint(e.clientX,e.clientY);if(target?.closest('.condition-canvas-scroll')){const rect=$('condition-canvas').getBoundingClientRect();addConditionNode(value,Math.max(12,(e.clientX-rect.left)/conditionZoom-72),Math.max(24,(e.clientY-rect.top)/conditionZoom-25));}};
  button.onpointercancel=()=>{drag?.ghost?.remove();drag=null;};
}

function bindConditionWire(port,node){
  let drag=null,suppressClick=false;port.draggable=false;
  port.onclick=e=>{e.stopPropagation();if(suppressClick){suppressClick=false;return;}if(conditionWire?.target)conditionConnect(node.id,conditionWire.target,conditionWire.slot);else{conditionWire={source:node.id};$('condition-status').textContent='再点击运算符上方的输入圆点';}};
  port.onpointerdown=e=>{if(e.button!==0)return;e.stopPropagation();drag={id:e.pointerId,x:e.clientX,y:e.clientY,path:null};port.setPointerCapture(e.pointerId);};
  port.onpointermove=e=>{if(!drag||drag.id!==e.pointerId)return;if(!drag.path&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;e.preventDefault();if(!drag.path){drag.path=document.createElementNS('http://www.w3.org/2000/svg','path');drag.path.classList.add('wire-preview');$('condition-lines').append(drag.path);}const rect=$('condition-canvas').getBoundingClientRect(),x=(e.clientX-rect.left)/conditionZoom,y=(e.clientY-rect.top)/conditionZoom;drag.path.setAttribute('d',`M${node.x+72},${node.y+58} C${node.x+72},${node.y+90} ${x},${y-30} ${x},${y}`);};
  port.onpointerup=e=>{if(!drag)return;const current=drag;drag=null;if(!current.path)return;suppressClick=true;current.path.remove();const input=document.elementFromPoint(e.clientX,e.clientY)?.closest('.condition-port.input');if(input)conditionConnect(node.id,input.dataset.nodeId,Number(input.dataset.slot));};
  port.onpointercancel=()=>{drag?.path?.remove();drag=null;};
}
function addConditionNode(value,x,y){
  if(conditionNodes.length>=63){notice('最多63个条件节点');return;}
  conditionRemember();const id='c'+(++conditionSerial);conditionNodes.push({id,value:structuredClone(value),x:x??30+(conditionNodes.length%3)*175,y:y??35+Math.floor(conditionNodes.length/3)*100,inputs:value.op?Array(value.op==='not'?1:2).fill(null):[]});conditionSelected=id;conditionRoot=null;renderConditionCanvas();conditionDraft();
}
function conditionDraft(){ $('condition-status').textContent='画布已修改 · 点击“应用画布”更新照片'; }
function conditionNodeLabel(node){return ConditionCore.label(node.value);}
function conditionLines(){
  const svg=$('condition-lines');svg.replaceChildren();
  conditionNodes.forEach(n=>n.inputs.forEach((id,slot)=>{const source=conditionNodes.find(v=>v.id===id);if(!source)return;const endX=n.x+(n.inputs.length===1?72:slot===0?36:108),endY=n.y;const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',`M${source.x+72},${source.y+58} C${source.x+72},${source.y+95} ${endX},${endY-40} ${endX},${endY}`);p.setAttribute('tabindex','0');p.setAttribute('role','button');p.setAttribute('aria-label','断开 '+conditionNodeLabel(source)+' 到 '+conditionNodeLabel(n));p.onclick=()=>{conditionRemember();n.inputs[slot]=null;conditionRoot=null;renderConditionCanvas();conditionDraft();};p.onkeydown=e=>{if(['Enter','Delete','Backspace'].includes(e.key)){e.preventDefault();p.onclick();}};svg.append(p);}));
}
function conditionConnect(sourceId,targetId,slot){
  if(sourceId===targetId)return notice('不能连接自身');
  const reaches=(id,target,seen=new Set())=>{if(id===target)return true;if(seen.has(id))return false;seen.add(id);return (conditionNodes.find(n=>n.id===id)?.inputs||[]).some(child=>child&&reaches(child,target,seen));};
  if(reaches(sourceId,targetId))return notice('这条连线会形成循环');
  conditionRemember();conditionNodes.find(n=>n.id===targetId).inputs[slot]=sourceId;conditionWire=null;conditionRoot=null;renderConditionCanvas();conditionDraft();
}
function renderConditionCanvas(){
  const canvas=$('condition-canvas');canvas.querySelectorAll('.condition-node').forEach(n=>n.remove());
  canvas.style.width=Math.max(590,...conditionNodes.map(n=>n.x+185))+'px';canvas.style.height=Math.max(390,...conditionNodes.map(n=>n.y+115))+'px';
  for(const node of conditionNodes){
    const el=document.createElement('article');el.className='condition-node'+(node.value.op?' operation':'')+(conditionSelected===node.id?' selected':'');el.style.left=node.x+'px';el.style.top=node.y+'px';
    const head=document.createElement('button');head.className='condition-handle';head.textContent=conditionNodeLabel(node);head.title=ConditionCore.format(node.value.op?null:node.value)||'拖动调整位置';
    head.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();conditionSelected=node.id;conditionRemember();const start={x:e.clientX,y:e.clientY,nx:node.x,ny:node.y};head.setPointerCapture(e.pointerId);el.classList.add('selected');head.onpointermove=move=>{node.x=Math.max(12,start.nx+(move.clientX-start.x)/conditionZoom);node.y=Math.max(24,start.ny+(move.clientY-start.y)/conditionZoom);el.style.left=node.x+'px';el.style.top=node.y+'px';conditionLines();};head.onpointerup=()=>{head.onpointermove=null;head.onpointerup=null;renderConditionCanvas();};head.onpointercancel=head.onpointerup;};
    head.onclick=()=>{conditionSelected=node.id;canvas.querySelectorAll('.condition-node').forEach(n=>n.classList.toggle('selected',n===el));};
    el.append(head);
    node.inputs.forEach((id,slot)=>{const port=document.createElement('button');port.className='condition-port input';port.dataset.nodeId=node.id;port.dataset.slot=String(slot);port.style.left=(node.inputs.length===1?72:slot===0?36:108)+'px';port.textContent=node.inputs.length===1?'':'LR'[slot];port.title=slot===0?'左侧输入':'右侧输入';port.setAttribute('aria-label',conditionNodeLabel(node)+' '+port.title);port.classList.toggle('connected',!!id);port.onclick=e=>{e.stopPropagation();if(conditionWire?.source)conditionConnect(conditionWire.source,node.id,slot);else{conditionWire={target:node.id,slot};$('condition-status').textContent='再点击一个条件的下方出口圆点';}};port.ondragover=e=>{if(e.dataTransfer.types.includes('application/x-condition-wire'))e.preventDefault();};port.ondrop=e=>{e.preventDefault();e.stopPropagation();conditionConnect(e.dataTransfer.getData('application/x-condition-wire'),node.id,slot);};el.append(port);});
    const out=document.createElement('button');out.className='condition-port output';out.title='输出：点击或拖动到运算符上方圆点';out.setAttribute('aria-label',conditionNodeLabel(node)+' 输出');bindConditionWire(out,node);el.append(out);canvas.append(el);
  }
  conditionLines();$('logic-undo').disabled=!conditionHistory.length;
}
function drawConditionTree(tree){
  conditionNodes=[];conditionRoot=null;let leaf=0;
  function build(value){const inputs=[];if(value.op==='not')inputs.push(build(value.child));else if(value.op)inputs.push(build(value.left),build(value.right));const children=inputs.map(id=>conditionNodes.find(n=>n.id===id));const id='c'+(++conditionSerial),x=children.length?children.reduce((s,n)=>s+n.x,0)/children.length:25+leaf++*175,y=children.length?Math.max(...children.map(n=>n.y))+115:35;conditionNodes.push({id,value:value.op?{op:value.op}:value,x,y,inputs});return id;}
  if(tree)conditionRoot=build(tree);conditionSelected=null;renderConditionCanvas();fitConditionCanvas();
}
async function applyConditionTree(tree){
  const old=tagLogic;tagLogic=tree;state.tags.clear();
  // A condition canvas describes photos across albums; the folder browser stays separate.
  if(collectionView==='folders'){$('album-filter').value='';collectionView='photos';document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view==='photos')));applyViewVisibility();}
  try{await applyFilters();$('condition-text').value=ConditionCore.format(tree);$('condition-status').textContent=tree?'已应用 · '+ConditionCore.format(tree):'已显示全部照片';}catch(error){tagLogic=old;throw error;}
}
const conditionPanel=$('logic-panel');conditionPanel.hidden=false;document.querySelector('.filter-sidebar').append(conditionPanel);$('open-globe').after(conditionPanel);
$('tag-keyword').oninput=renderTagOptions;
$('clear-tags').onclick=guard(async()=>{resetTagLogic();await applyConditionTree(null);});
$('condition-apply').onclick=guard(()=>applyConditionTree(ConditionCore.compile(conditionNodes,conditionRoot)));
$('condition-text-apply').onclick=guard(async()=>{const tree=ConditionCore.parse($('condition-text').value);conditionRemember();await applyConditionTree(tree);drawConditionTree(tree);});
$('logic-undo').onclick=()=>{if(!conditionHistory.length)return;const snapshot=JSON.parse(conditionHistory.pop());conditionNodes=snapshot.nodes;conditionRoot=snapshot.root;conditionSelected=null;renderConditionCanvas();conditionDraft();};
$('condition-delete').onclick=()=>{if(!conditionSelected)return notice('先点选画布中的节点');conditionRemember();conditionNodes=conditionNodes.filter(n=>n.id!==conditionSelected);conditionNodes.forEach(n=>n.inputs=n.inputs.map(id=>id===conditionSelected?null:id));conditionRoot=null;conditionSelected=null;renderConditionCanvas();conditionDraft();};
document.querySelectorAll('[data-condition-op]').forEach(button=>makeConditionToken(button,{op:button.dataset.conditionOp}));
document.querySelectorAll('[data-formula-insert]').forEach(button=>button.onclick=()=>{const input=$('condition-text'),start=input.selectionStart,end=input.selectionEnd;input.setRangeText(button.dataset.formulaInsert,start,end,'end');input.focus();});
$('condition-add').onclick=()=>{const field=$('condition-kind').value,value=$('condition-value').value.trim();if(field==='favorite')return addConditionNode({field,value:true});if(!value)return notice('先填入名称、故事、地点或搜索描述');addConditionNode({field,value,...(field==='search'?{score:[.24,.30,.34][Number($('match-range').value)]}:{})});};
$('condition-canvas').ondragover=e=>{if(e.dataTransfer.types.includes('application/x-condition'))e.preventDefault();};
$('condition-canvas').ondrop=e=>{e.preventDefault();let value;try{value=JSON.parse(e.dataTransfer.getData('application/x-condition'));}catch{return;}const rect=$('condition-canvas').getBoundingClientRect();addConditionNode(value,Math.max(12,(e.clientX-rect.left)/conditionZoom-72),Math.max(24,(e.clientY-rect.top)/conditionZoom-25));};
function addPlaceConditions(conditions){for(const value of conditions)addConditionNode(value);notice('地点已放入左侧画布，可连线后应用');}

function fitConditionCanvas(){const canvas=$('condition-canvas');conditionZoom=Math.min(1,(canvas.parentElement.clientWidth-8)/canvas.offsetWidth);canvas.style.zoom=conditionZoom;}
$('condition-fit').onclick=fitConditionCanvas;$('condition-fullsize').onclick=()=>{conditionZoom=1;$('condition-canvas').style.zoom=1;};
