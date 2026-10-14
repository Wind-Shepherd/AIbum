/* One staging model for new files and existing items. No write before confirmation. */
let importNodes=[],importSerial=0,importBusy=false,importOwner=null;
let organizerMode='upload',organizerTarget=null,organizerAlbums=[],organizerExisting=[],organizerOpen=new Set(),organizerSelected=new Set(),organizerCollapsed=new Set(),organizerVersion=0;
const importDialog=$('import-dialog');
const isPhoto=file=>/\.(jpe?g|png|webp)$/i.test(file.name);
function memoryIcon(folder){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.classList.add('memory-icon');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',folder?'M2 7V5h7l2 3h11v12H2z':'M3 3h18v18H3zM7 3v18M17 3v18M3 7h4m-4 5h4m-4 5h4M17 7h4m-4 5h4m-4 5h4');svg.append(path);return svg;}
function importNode(name,parent,file=null,extra={}){const node={id:String(++importSerial),name,parent,file,url:null,...extra};importNodes.push(node);if(!file&&!extra.remotePhoto&&parent&&!parent.startsWith('existing:'))organizerCollapsed.add(node.id);return node;}
function canMoveImport(id,parent){if(id===parent)return false;for(let cursor=importNodes.find(n=>n.id===parent);cursor;cursor=importNodes.find(n=>n.id===cursor.parent))if(cursor.id===id)return false;return true;}
function moveImportSelection(ids,parent){
 const selected=new Set(ids),roots=importNodes.filter(n=>selected.has(n.id)&&!hasSelectedParent(n,selected));
 if(roots.some(n=>!canMoveImport(n.id,parent))){notice('文件夹不能放进自己或自己的子文件夹');return;}
 roots.forEach(n=>n.parent=parent);
}
function hasSelectedParent(node,selected){for(let cursor=importNodes.find(n=>n.id===node.parent);cursor;cursor=importNodes.find(n=>n.id===cursor.parent))if(selected.has(cursor.id))return true;return false;}
function clearImport(){importNodes.forEach(n=>n.url&&URL.revokeObjectURL(n.url));importNodes=[];organizerSelected.clear();$('upload').value='';$('import-folders').value='';renderImport();}
function organizerPath(id){const names=[],seen=new Set();let folder=organizerAlbums.find(a=>a.id===id);while(folder&&!seen.has(folder.id)){seen.add(folder.id);names.unshift(folder.name);folder=organizerAlbums.find(a=>a.id===folder.parent_id);}return names.join(' / ')||'相册根目录';}
async function openOrganizer(mode='upload',albumId=null){
 if(importBusy)return;
 if(importOwner!==accountVersion||mode!==organizerMode||mode==='move')clearImport();
 importOwner=accountVersion;organizerMode=mode;organizerTarget=$('album-filter').value||null;
 organizerAlbums=await api('/albums');
 if(mode==='move'){
  if(albumId){const album=organizerAlbums.find(a=>a.id===albumId);importNode(album.name,null,null,{remoteAlbum:albumId});}
  else state.items.filter(p=>state.selected.has(p.id)).forEach(p=>importNode(p.name,null,null,{remotePhoto:p.id,preview:p.thumbnail_url}));
 }
 $('import-title').textContent=mode==='move'?'给回忆，换一个位置。':'给新的回忆，找到位置。';
 $('import-drop').hidden=mode==='move';$('import-folder-pick').hidden=mode==='move';$('import-confirm').textContent=mode==='move'?'确认并移动':'确认位置并上传';
 $('organizer-search').value='';renderImport();importDialog.showModal();await navigateOrganizer(organizerTarget);
}
$('open-import').onclick=guard(()=>openOrganizer());
$('batch-move').onclick=guard(()=>openOrganizer('move'));
$('folder-move').onclick=guard(()=>openOrganizer('move',$('album-filter').value));
$('import-close').onclick=()=>{if(!importBusy)importDialog.close();};importDialog.oncancel=event=>{if(importBusy)event.preventDefault();};
$('import-clear').onclick=()=>{if(!importBusy)clearImport();};
function setImportLocked(locked){importDialog.querySelectorAll('button,select,input').forEach(el=>el.disabled=locked);$('upload').disabled=locked;$('logout').disabled=locked;$('security-button').disabled=locked;}
function stageParent(){return organizerTarget?'existing:'+organizerTarget:null;}
function addImportFiles(files){let skipped=0;for(const file of files){if(!isPhoto(file)||!file.size||file.size>20*1024*1024){skipped++;continue;}let parent=stageParent();const parts=(file.webkitRelativePath||file.name).split('/');for(const name of parts.slice(0,-1)){let folder=importNodes.find(n=>!n.file&&!n.remotePhoto&&n.parent===parent&&n.name===name);if(!folder)folder=importNode(name,parent);parent=folder.id;}importNode(file.name,parent,file);}renderImport();if(skipped)notice(`已略过 ${skipped} 个不支持或过大的文件`);}
$('upload').onchange=()=>{addImportFiles($('upload').files);$('upload').value='';};$('import-folders').onchange=()=>{addImportFiles($('import-folders').files);$('import-folders').value='';};
$('import-folder-pick').onclick=()=>$('import-folders').click();
$('import-new-folder').onclick=()=>{const name=prompt('新文件夹名称');if(name?.trim()){importNode(name.trim().slice(0,80),stageParent());renderImport();}};
$('import-drop').onclick=()=>{if(!importBusy)$('upload').click();};$('import-drop').onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();$('import-drop').click();}};
$('import-drop').ondragover=e=>{e.preventDefault();if(!importBusy)$('import-drop').classList.add('dragging');};$('import-drop').ondragleave=()=>$('import-drop').classList.remove('dragging');
async function readImportEntry(entry,parent){if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));if(isPhoto(file)&&file.size&&file.size<=20*1024*1024)importNode(file.name,parent,file);}else if(entry.isDirectory){const folder=importNode(entry.name,parent),reader=entry.createReader();for(;;){const entries=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const child of entries)await readImportEntry(child,folder.id);}}}
$('import-drop').ondrop=guard(async e=>{e.preventDefault();$('import-drop').classList.remove('dragging');if(importBusy)return;const entries=[...e.dataTransfer.items].map(item=>item.webkitGetAsEntry?.()).filter(Boolean),files=[...e.dataTransfer.files],parent=stageParent();importBusy=true;setImportLocked(true);try{if(entries.length){for(const entry of entries)await readImportEntry(entry,parent);}else addImportFiles(files);}finally{importBusy=false;setImportLocked(false);renderImport();}});
function bindDestination(element,parent){element.dataset.importTarget=parent??"__root__";element.ondragover=e=>{if(importBusy||!e.dataTransfer.types.includes('application/x-aibum-node'))return;e.preventDefault();e.stopPropagation();element.classList.add('drop-target');};element.ondragleave=()=>element.classList.remove('drop-target');element.ondrop=e=>{e.preventDefault();e.stopPropagation();element.classList.remove('drop-target');if(importBusy)return;let ids;try{ids=JSON.parse(e.dataTransfer.getData('application/x-aibum-node'));}catch{return;}if(!Array.isArray(ids))return;moveImportSelection(ids,parent);renderImport();};}
function bindImportDrag(label,node){
 let drag=null,suppressClick=false;
 label.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
 label.onpointerdown=e=>{if(e.button!==0||importBusy)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,target:null,ghost:null};label.setPointerCapture(e.pointerId);};
 label.onpointermove=e=>{
  if(!drag||e.pointerId!==drag.id)return;
  if(!drag.ghost&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
  e.preventDefault();
  if(!drag.ghost){drag.ghost=document.createElement('div');drag.ghost.className='filing-drag-ghost';drag.ghost.textContent=node.name;importDialog.append(drag.ghost);}
  drag.ghost.style.left=e.clientX+12+'px';drag.ghost.style.top=e.clientY+10+'px';
  const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-import-target]');
  if(target!==drag.target){drag.target?.classList.remove('drop-target');drag.target=target;target?.classList.add('drop-target');}
 };
 label.onpointerup=e=>{if(!drag)return;const current=drag;drag=null;current.target?.classList.remove('drop-target');if(current.ghost){suppressClick=true;current.ghost.remove();if(current.target){const parent=current.target.dataset.importTarget;moveImportSelection(organizerSelected.has(node.id)?[...organizerSelected]:[node.id],parent==='__root__'?null:parent);renderImport();}}};
 label.onpointercancel=()=>{drag?.target?.classList.remove('drop-target');drag?.ghost?.remove();drag=null;};
}
async function navigateOrganizer(id){const version=++organizerVersion;organizerTarget=id;const params=new URLSearchParams({album_id:id||'__unfiled__',page_size:'100'});const data=await api('/photos?'+params);if(version!==organizerVersion)return;organizerExisting=data.items;renderImport();}
function renderDestinations(){const list=$('organizer-destinations');list.replaceChildren();const search=$('organizer-search').value.trim().toLowerCase();
 function add(folder,depth){const row=document.createElement('div');row.className='destination-row';row.style.paddingLeft=(depth*13)+'px';const toggle=document.createElement('button');toggle.className='quiet';toggle.textContent=organizerOpen.has(folder.id)?'⌄':'›';toggle.setAttribute('aria-label','展开或收起 '+folder.name);toggle.setAttribute('aria-expanded',String(organizerOpen.has(folder.id)));toggle.onclick=()=>{organizerOpen.has(folder.id)?organizerOpen.delete(folder.id):organizerOpen.add(folder.id);renderDestinations();};const button=document.createElement('button');button.className='destination-name';button.append(memoryIcon(true),document.createTextNode(search?organizerPath(folder.id):folder.name));button.title=organizerPath(folder.id);button.onclick=guard(()=>navigateOrganizer(folder.id));button.classList.toggle('active',organizerTarget===folder.id);row.append(toggle,button);bindDestination(row,'existing:'+folder.id);list.append(row);if(!search&&organizerOpen.has(folder.id))organizerAlbums.filter(a=>a.parent_id===folder.id).forEach(a=>add(a,depth+1));}
 const root=document.createElement('button');root.textContent='⌂ 相册根目录';root.onclick=guard(()=>navigateOrganizer(null));bindDestination(root,null);list.append(root);
 (search?organizerAlbums.filter(a=>organizerPath(a.id).toLowerCase().includes(search)):organizerAlbums.filter(a=>!a.parent_id)).forEach(a=>add(a,0));
}
$('organizer-search').oninput=renderDestinations;
function renderImport(){
 renderDestinations();$('organizer-path').replaceChildren();const path=document.createElement('span');path.textContent=organizerPath(organizerTarget);$('organizer-path').append(path);const use=document.createElement('button');use.textContent=organizerSelected.size?'将勾选项放到这里':'将全部待整理项放到这里';use.disabled=importBusy||!importNodes.length;use.onclick=()=>{const selected=organizerSelected.size?organizerSelected:new Set(importNodes.filter(n=>!importNodes.some(p=>p.id===n.parent)).map(n=>n.id));moveImportSelection([...selected],stageParent());renderImport();};$('organizer-path').append(use);bindDestination($('organizer-path'),stageParent());
 const existing=$('organizer-existing');existing.replaceChildren();
 for(const album of organizerAlbums.filter(a=>(a.parent_id||null)===organizerTarget)){const button=document.createElement('button');button.className='existing-item';button.append(memoryIcon(true),document.createTextNode(album.name));button.onclick=guard(()=>navigateOrganizer(album.id));bindDestination(button,'existing:'+album.id);existing.append(button);}
 if(!existing.children.length){const empty=document.createElement('small');empty.textContent='此目录暂无子文件夹，可以新建或将待入藏项放在当前目录';existing.append(empty);}
 if(organizerExisting.length){const hint=document.createElement('small');hint.textContent=`此目录已有 ${organizerExisting.length} 张照片${organizerExisting.length===100?'（仅预览前100张）':''}`;existing.append(hint);}
 const tree=$('import-tree');tree.replaceChildren();
 function branch(parent,depth){for(const node of importNodes.filter(n=>n.parent===parent)){
 const folder=!node.file&&!node.remotePhoto,row=document.createElement('div');row.className='import-row';row.style.setProperty('--depth',depth);row.draggable=false;row.tabIndex=0;
 const check=document.createElement('input');check.type='checkbox';check.checked=organizerSelected.has(node.id);check.setAttribute('aria-label','选择 '+node.name);check.disabled=importBusy;check.onchange=()=>{check.checked?organizerSelected.add(node.id):organizerSelected.delete(node.id);renderImport();};
 const label=document.createElement('button');label.className='staged-name';label.append(memoryIcon(folder),document.createTextNode(node.name));label.title=node.name;label.disabled=importBusy;bindImportDrag(label,node);if(folder){label.setAttribute('aria-expanded',String(!organizerCollapsed.has(node.id)));label.onclick=()=>{organizerCollapsed.has(node.id)?organizerCollapsed.delete(node.id):organizerCollapsed.add(node.id);renderImport();};bindDestination(row,node.id);}
 const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','移除 '+node.name);remove.disabled=importBusy;remove.onclick=()=>{const ids=new Set([node.id]);for(let i=0;i<importNodes.length;i++)importNodes.forEach(n=>{if(ids.has(n.parent))ids.add(n.id);});importNodes.filter(n=>ids.has(n.id)).forEach(n=>n.url&&URL.revokeObjectURL(n.url));importNodes=importNodes.filter(n=>!ids.has(n.id));ids.forEach(id=>organizerSelected.delete(id));renderImport();};row.append(check,label,remove);
 row.ondragstart=e=>{e.stopPropagation();const ids=organizerSelected.has(node.id)?[...organizerSelected]:[node.id];e.dataTransfer.setData('application/x-aibum-node',JSON.stringify(ids));e.dataTransfer.effectAllowed='move';};
 if(!folder){const preview=document.createElement('div');preview.className='import-preview';const img=document.createElement('img');if(node.file&&!node.url)node.url=URL.createObjectURL(node.file);img.src=node.url||node.preview;img.alt=node.name;preview.append(img);row.append(preview);}
 tree.append(row);if(folder&&!organizerCollapsed.has(node.id))branch(node.id,depth+1);
 }}
 const roots=[...new Set(importNodes.filter(n=>!importNodes.some(p=>p.id===n.parent)).map(n=>n.parent))];
 for(const parent of roots){const heading=document.createElement('div');heading.className='import-root';heading.textContent='待'+(organizerMode==='move'?'移动':'入藏')+' → '+organizerPath(parent?.startsWith('existing:')?parent.slice(9):null);bindDestination(heading,parent);tree.append(heading);branch(parent,0);}
 $('import-status').textContent=`${importNodes.filter(n=>n.file||n.remotePhoto).length} 张照片 · ${importNodes.filter(n=>!n.file&&!n.remotePhoto).length} 个文件夹 · 确认前不会保存更改`;
 $('import-confirm').disabled=importBusy||!importNodes.length;
}
$('import-confirm').onclick=guard(async()=>{
 if(importBusy||importOwner!==accountVersion||!importNodes.length)return;
 importBusy=true;setImportLocked(true);renderImport();const errors=[],saved=new Map(),items=[...importNodes];let done=0;
 async function destination(id){if(!id)return null;if(id.startsWith('existing:'))return id.slice(9);if(saved.has(id))return saved.get(id);const node=importNodes.find(n=>n.id===id);if(!node)throw new Error('目标文件夹不存在');const parent=await destination(node.parent);if(node.remoteAlbum){await api('/albums/'+node.remoteAlbum,json('PATCH',{parent_id:parent}));saved.set(id,node.remoteAlbum);return node.remoteAlbum;}let album=organizerAlbums.find(a=>a.name===node.name&&(a.parent_id||null)===parent);if(!album){album=await api('/albums',json('POST',{name:node.name,parent_id:parent}));album.parent_id=parent;organizerAlbums.push(album);}saved.set(id,album.id);return album.id;}
 try{for(let i=0;i<items.length;i++){if(importOwner!==accountVersion)throw new Error('账户已变更');const node=items[i];$('import-status').textContent=`正在整理 ${i+1}/${items.length} · ${node.name}`;try{if(node.file){const result=await uploadOne(node.file,await destination(node.parent),fraction=>$('import-progress').value=(i+fraction)/items.length*100);if(result.duplicate)throw new Error('照片已存在，未改变原来的位置，请从相册移动');}else if(node.remotePhoto)await api('/photos/'+node.remotePhoto,json('PATCH',{album_id:await destination(node.parent)}));else await destination(node.id);node.done=true;done++;}catch(error){errors.push(node.name+'：'+error.message);}}
 // Keep successful folders as existing targets for any failed children.
 for(const n of importNodes)if(saved.has(n.parent))n.parent='existing:'+saved.get(n.parent);
 importNodes.filter(n=>n.done).forEach(n=>n.url&&URL.revokeObjectURL(n.url));importNodes=importNodes.filter(n=>!n.done);organizerSelected.clear();await refreshOptions();await reload();organizerAlbums=await api('/albums');
 }finally{importBusy=false;setImportLocked(false);renderImport();$('import-status').textContent=`已完成 ${done}/${items.length} 项。${errors.length?'失败项已保留：'+errors.slice(0,3).join('；'):'已整理妥当。'}`;}
});
document.addEventListener('paste',guard(async event=>{
 const files=[...(event.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
 if(!files.length)return;
 if(typeof pasteFeedbackImages==='function'&&pasteFeedbackImages(files,event.target)){event.preventDefault();return;}
 if(importDialog.open&&organizerMode==='upload'&&!importBusy){event.preventDefault();addImportFiles(files);notice('粘贴的照片已加入待入藏');}
 else if(state.user&&!document.querySelector('dialog[open]')&&searchMode==='image'){event.preventDefault();setReference(files[0]);notice('已粘贴参考图');}
}));
/* A modal above the detail sheet, with cursor-anchored zoom. */
let viewerZoom=1, viewerX=0, viewerY=0, viewerPointer=null;
function paintViewer(){ $('viewer-image').style.transform=`translate(${viewerX}px,${viewerY}px) scale(${viewerZoom})`; $('viewer-scale').value=Math.round(viewerZoom*100)+'%'; }
function fitViewer(){viewerZoom=1;viewerX=viewerY=0;paintViewer();}
function zoomViewer(factor,x=0,y=0){const next=Math.min(8,Math.max(.25,viewerZoom*factor));const ratio=next/viewerZoom;viewerX=x-(x-viewerX)*ratio;viewerY=y-(y-viewerY)*ratio;viewerZoom=next;paintViewer();}
$('detail-image').tabIndex=0; $('detail-image').setAttribute('role','button'); $('detail-image').setAttribute('aria-label','打开图片浏览器');
function openImageViewer(src,alt='图片预览'){$('viewer-image').src=src;$('viewer-image').alt=alt;if(!$('image-viewer').open)$('image-viewer').showModal();fitViewer();}
$('detail-image').ondblclick=()=>openImageViewer($('detail-image').src);
$('detail-image').onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('detail-image').ondblclick();}};
$('viewer-close').onclick=()=>$('image-viewer').close(); $('viewer-fit').onclick=fitViewer;
$('viewer-in').onclick=()=>zoomViewer(1.25); $('viewer-out').onclick=()=>zoomViewer(.8);
$('viewer-stage').addEventListener('wheel',event=>{event.preventDefault();const r=$('viewer-stage').getBoundingClientRect();zoomViewer(Math.exp(-event.deltaY*.0015),event.clientX-r.left-r.width/2,event.clientY-r.top-r.height/2);},{passive:false});
$('viewer-stage').onpointerdown=event=>{if(event.button!==0)return;viewerPointer={id:event.pointerId,x:event.clientX,y:event.clientY};$('viewer-stage').setPointerCapture(event.pointerId);};
$('viewer-stage').onpointermove=event=>{if(viewerPointer?.id!==event.pointerId)return;viewerX+=event.clientX-viewerPointer.x;viewerY+=event.clientY-viewerPointer.y;viewerPointer.x=event.clientX;viewerPointer.y=event.clientY;paintViewer();};
$('viewer-stage').onpointerup=$('viewer-stage').onpointercancel=()=>viewerPointer=null;
$('viewer-stage').ondblclick=fitViewer;
