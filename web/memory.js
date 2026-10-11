let collectionView = 'folders', folderList = [], editingFolder = null, timelineMonth = '', randomPhoto = null;
let timelinePhotos = [], timelinePeriods = [], timelineSelection = null, timelineRange = null, timelineMode = 'single', timelineUnit = 'month', timelineHeading = '';
function resetMemoryState() {
  collectionView = 'folders'; folderList = []; randomPhoto = null; timelinePhotos = []; timelinePeriods = []; timelineSelection = null; timelineRange = null; timelineMode = 'single'; timelineUnit = 'month'; timelineHeading = '';
  $('timeline-unit').value=timelineUnit;
  document.querySelectorAll('[data-timeline-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.timelineMode===timelineMode)));
  $('timeline-scrubber').hidden=false;$('timeline-start').hidden=true;$('timeline-end').hidden=true;$('timeline-range-labels').hidden=true;$('timeline-selected-track').hidden=true;$('timeline-rail').dataset.mode='single';
  for (const id of ['memory-dialog','folder-dialog']) $(id).close();
  $('folder-grid').replaceChildren(); $('memory-image').removeAttribute('src'); $('memory-story').textContent = '';
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.view === collectionView)));
  applyViewVisibility();
}
function applyViewVisibility() {
  const trash = collectionView === 'trash';
  $('search-form').hidden = trash; $('trash-note').hidden = !trash;
  $('folder-grid').hidden = collectionView !== 'folders' || state.mode !== 'browse';
  $('folder-path').hidden = collectionView !== 'folders';
  $('timeline-controls').hidden = collectionView !== 'timeline' || state.mode !== 'browse';
  $('manage-folder').hidden = collectionView !== 'folders' || !$('album-filter').value;
  for (const id of ['batch-favorite','batch-album','batch-move','batch-delete']) $(id).hidden = trash;
  for (const id of ['batch-restore','batch-purge']) $(id).hidden = !trash;
  $('new-album').hidden = trash; $('upload').closest('label').hidden = trash;
}
async function switchCollection(view) {
  collectionView = view; state.mode = 'browse'; state.query = null; state.selected.clear(); timelineSelection = null; timelineRange = null;
  resetFilters(); clearReference(); $('search-form').reset(); selectSearchMode('text');
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.view === view)));
  applyViewVisibility(); renderFolders(); await loadPhotos();
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = guard(() => switchCollection(b.dataset.view)));
function folderPath(folder) {
  const names = [], seen = new Set();
  while (folder && !seen.has(folder.id)) { seen.add(folder.id); names.unshift(folder.name); folder = folderList.find(a => a.id === folder.parent_id); }
  return names.join(' / ');
}
function updateFolders(albums) {
  folderList = albums;
  const entries = albums.map(a => ({...a,name:folderPath(a)}));
  fillSelect('album-filter', entries, '所有照片'); fillSelect('batch-album', entries, '移出文件夹'); fillSelect('detail-album', entries, '未归入文件夹');
  renderFolders();
}
async function enterFolder(id) {
  const previous = $('album-filter').value || null;
  const parent = folderList.find(a => a.id === previous)?.parent_id || null;
  const returning = previous && id !== previous && (id === parent || !id);
  $('album-filter').value = id || ''; state.mode = 'browse'; state.query = null; state.selected.clear();
  const content = document.querySelector('.library-content');
  content.classList.remove('chapter-returning','chapter-entering'); void content.offsetWidth;
  content.classList.add(returning ? 'chapter-returning' : 'chapter-entering');
  renderFolders(); await loadPhotos();
}
function renderFolders() {
  $('folder-grid').replaceChildren(); $('folder-breadcrumb').replaceChildren();
  const current = $('album-filter').value || null;
  $('folder-up').hidden = !current;
  const root = document.createElement('button'); root.textContent = '所有影集'; root.className = 'quiet'; root.onclick = guard(() => enterFolder(null)); $('folder-breadcrumb').append(root);
  const ancestors = []; let node = folderList.find(a => a.id === current); const seen = new Set();
  while (node && !seen.has(node.id)) { seen.add(node.id); ancestors.unshift(node); node = folderList.find(a => a.id === node.parent_id); }
  for (const ancestor of ancestors) { const button = document.createElement('button'); button.className='quiet'; button.textContent=' / '+ancestor.name; button.onclick=guard(()=>enterFolder(ancestor.id)); $('folder-breadcrumb').append(button); }
  folderList.filter(a => (a.parent_id || null) === current).forEach((album,index) => {
    const card = document.createElement('article'); card.className = 'album-book';
    const open = document.createElement('button'); open.className = 'book-open'; open.setAttribute('aria-label','打开影集 '+album.name);
    const cover = document.createElement('span'); cover.className = 'book-cover';
    for (let i=2;i>=0;i--) { const page = document.createElement('span'); page.className='book-page page-'+i;
      const photo = album.previews[i] || album.previews[0];
      if (photo) { const image=document.createElement('img'); image.src='/api/photos/'+photo+'/file?thumbnail=true'; image.alt=''; image.loading='lazy'; page.append(image); }
      else { const mark=document.createElement('span'); mark.className='empty-book-mark'; mark.textContent='拾光'; page.append(mark); }
      cover.append(page);
    }
    const spine = document.createElement('span'); spine.className='book-spine'; spine.textContent=String(index+1).padStart(2,'0'); cover.append(spine);
    const name=document.createElement('strong'); name.textContent=album.name;
    const count=document.createElement('small'); count.textContent=album.count+' 张照片 · '+folderList.filter(a=>a.parent_id===album.id).length+' 个子文件夹';
    open.append(cover,name,count); open.onclick=guard(()=>enterFolder(album.id));
    const edit=document.createElement('button'); edit.className='quiet book-edit'; edit.textContent='管理影集'; edit.setAttribute('aria-label','管理影集 '+album.name); edit.onclick=()=>openFolderEditor(album.id);
    card.append(open,edit); $('folder-grid').append(card);
  });
  applyViewVisibility();
}
$('folder-up').onclick = guard(() => {
  const current = folderList.find(a => a.id === $('album-filter').value);
  return enterFolder(current?.parent_id || null);
});
function openFolderEditor(id = null) {
  editingFolder = id; const folder=folderList.find(a=>a.id===id);
  $('folder-dialog-title').textContent=id?'整理这本影集':'给一段时光，起个名字';
  $('folder-name').value=folder?.name || ''; $('delete-folder').hidden=!id;
  fillSelect('folder-parent',folderList.filter(a=>a.id!==id).map(a=>({...a,name:folderPath(a)})),'顶层文件夹');
  $('folder-parent').value=folder ? folder.parent_id || '' : $('album-filter').value;
  $('folder-dialog').showModal();
}
$('manage-folder').onclick=()=>openFolderEditor($('album-filter').value);
$('folder-form').onsubmit=guard(async event=>{
  event.preventDefault(); const body={name:$('folder-name').value.trim(),parent_id:$('folder-parent').value||null};
  await api('/albums'+(editingFolder?'/'+editingFolder:''),json(editingFolder?'PATCH':'POST',body));
  $('folder-dialog').close(); await refreshOptions(); notice('影集已保存');
});
$('close-folder').onclick=()=>$('folder-dialog').close();
$('delete-folder').onclick=guard(async()=>{
  if (!confirm('删除这个文件夹？照片会保留在“全部照片”，子文件夹会移至上一层。')) return;
  const id=editingFolder; await api('/albums/'+id,{method:'DELETE'}); $('folder-dialog').close();
  if ($('album-filter').value===id) $('album-filter').value='';
  await refreshOptions(); await loadPhotos(); notice('文件夹已删除，照片已保留');
});
const cardSizes = ['dense','compact','medium','large'];
function setCardSize(size) {
  const index = cardSizes.indexOf(size);
  $('display-size').value = String(index + 1);
  $('display-size-label').value = ['密集','缩略','相纸','大幅'][index];
  document.body.dataset.cardSize = size;
  try { localStorage.setItem('aibum-card-size',size); } catch {}
}
$('display-size').oninput = () => setCardSize(cardSizes[Number($('display-size').value)-1]);
try { const saved = localStorage.getItem('aibum-card-size'); setCardSize(cardSizes.includes(saved) ? saved : saved === 'small' ? 'compact' : 'medium'); } catch { setCardSize('medium'); }
function prepareCollectionRender() {
  timelineHeading=''; applyViewVisibility();
  $('grid').classList.toggle('timeline-grid',collectionView==='timeline' && state.mode==='browse');
  if (collectionView==='folders') renderFolders();
}
function addTimelineHeading(photo) {
  if(collectionView!=='timeline' || state.mode!=='browse') return;
  const period=timelineKey(photo); if(period===timelineHeading)return; timelineHeading=period;
  const h=document.createElement('h2');h.className='timeline-heading';h.id='period-'+period;
  const year=document.createElement('span');year.textContent=period.slice(0,4);
  const label=document.createElement('em');label.textContent=timelineUnit==='year'?'全年 · 留在这一页':period.slice(5)+' 月 · 留在这一页';h.append(year,label);$('grid').append(h);
}
function timelineKey(photo) { const stamp=photo.taken_at||photo.created_at; return timelineUnit==='year'?stamp.slice(0,4):stamp.slice(0,7); }
function timelineLabel(period) { return !period?'—':timelineUnit==='year'?`${period} 年`:`${period.slice(0,4)} 年 ${period.slice(5)} 月`; }
function setTimelinePhotos(photos, redraw=false) {
  timelinePhotos = [...photos];
  timelinePeriods = [...new Set(photos.map(timelineKey))].sort();
  const max=Math.max(0,timelinePeriods.length-1);
  for(const id of ['timeline-scrubber','timeline-start','timeline-end']) $(id).max=String(max);
  if(!timelinePeriods.includes(timelineSelection)) timelineSelection=null;
  if(!timelineRange || !timelinePeriods.includes(timelineRange.start) || !timelinePeriods.includes(timelineRange.end)) timelineRange={start:timelinePeriods[0]||null,end:timelinePeriods.at(-1)||null};
  if(timelineRange.start&&timelineRange.end&&timelineRange.start>timelineRange.end) timelineRange={start:timelineRange.end,end:timelineRange.start};
  $('timeline-scrubber').value=String(timelineSelection?timelinePeriods.indexOf(timelineSelection):max);
  $('timeline-start').value=String(Math.max(0,timelinePeriods.indexOf(timelineRange.start)));
  $('timeline-end').value=String(Math.max(0,timelinePeriods.indexOf(timelineRange.end)));
  $('timeline-start-label').value=timelineLabel(timelineRange.start||''); $('timeline-end-label').value=timelineLabel(timelineRange.end||'');
  $('timeline-scrubber').hidden=timelineMode==='range'; $('timeline-start').hidden=$('timeline-end').hidden=timelineMode!=='range';$('timeline-range-labels').hidden=timelineMode!=='range';$('timeline-selected-track').hidden=timelineMode!=='range';$('timeline-rail').dataset.mode=timelineMode;
  document.querySelectorAll('[data-timeline-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.timelineMode===timelineMode)));
  $('timeline-scale').replaceChildren();
  const step=timelineUnit==='year'?1:Math.max(1,Math.ceil(timelinePeriods.length/18));
  const markers=timelinePeriods.filter((period,index)=>index===0||index===max||index%step===0);
  const width=$('timeline-rail').getBoundingClientRect().width, trackWidth=Math.max(0,width-16);
  for(const period of markers){const tick=document.createElement('span');tick.textContent=timelineUnit==='year'?period:`${period.slice(2,4)}·${period.slice(5)}`;tick.style.left=`${8+(max?timelinePeriods.indexOf(period)/max*trackWidth:trackWidth/2)}px`;$('timeline-scale').append(tick);}
  $('timeline-scrubber').disabled=timelinePeriods.length<2;
  $('timeline-start').disabled=$('timeline-end').disabled=timelinePeriods.length<2;
  updateTimelineRail();
  applyTimelineSelection(redraw);
}
function updateTimelineRail(){
  const max=Math.max(1,timelinePeriods.length-1), width=$('timeline-rail').getBoundingClientRect().width, trackWidth=Math.max(0,width-16);
  const start=Math.max(0,timelinePeriods.indexOf(timelineRange?.start)),end=Math.max(0,timelinePeriods.indexOf(timelineRange?.end));
  const selected=$('timeline-selected-track');
  selected.style.left=`${8+start/max*trackWidth}px`;selected.style.width=`${Math.max(0,(end-start)/max*trackWidth)}px`;
}
function applyTimelineSelection(redraw=true) {
  const single=timelineMode==='single'&&timelineSelection;
  const ranged=timelineMode==='range'&&timelineRange?.start&&timelineRange?.end;
  state.items=timelinePhotos.filter(photo=>{const period=timelineKey(photo);return single?period===timelineSelection:ranged?period>=timelineRange.start&&period<=timelineRange.end:true;});
  state.selected.clear();
  const all=state.items.length===timelinePhotos.length;
  $('timeline-period').textContent=single?`${timelineLabel(timelineSelection)} · ${state.items.length} 张`:ranged?`${timelineLabel(timelineRange.start)} — ${timelineLabel(timelineRange.end)} · ${state.items.length} 张`: `全部时期 · ${state.items.length} 张`;
  $('timeline-all').hidden=all;
  $('result-label').textContent=`${state.items.length} 张照片 · ${single?timelineLabel(timelineSelection):ranged?`${timelineLabel(timelineRange.start)} 至 ${timelineLabel(timelineRange.end)}`:'全部时期'}`;
  if(redraw)render();
}
$('timeline-scrubber').oninput=()=>{timelineSelection=timelinePeriods[Number($('timeline-scrubber').value)]||null;applyTimelineSelection();};
$('timeline-start').oninput=()=>{timelineRange.start=timelinePeriods[Number($('timeline-start').value)]||null;if(timelineRange.end&&timelineRange.start>timelineRange.end){timelineRange.end=timelineRange.start;$('timeline-end').value=$('timeline-start').value;}setTimelinePhotos(timelinePhotos,true);};
$('timeline-end').oninput=()=>{timelineRange.end=timelinePeriods[Number($('timeline-end').value)]||null;if(timelineRange.start&&timelineRange.end<timelineRange.start){timelineRange.start=timelineRange.end;$('timeline-start').value=$('timeline-end').value;}setTimelinePhotos(timelinePhotos,true);};
document.querySelectorAll('[data-timeline-mode]').forEach(button=>button.onclick=()=>{timelineMode=button.dataset.timelineMode;if(timelineMode==='range'&&timelineSelection)timelineRange={start:timelineSelection,end:timelineSelection};if(timelineMode==='single')timelineSelection=null;setTimelinePhotos(timelinePhotos,true);});
$('timeline-unit').onchange=()=>{timelineUnit=$('timeline-unit').value;timelineSelection=null;timelineRange=null;setTimelinePhotos(timelinePhotos,true);};
$('timeline-all').onclick=()=>{timelineSelection=null;timelineRange=null;setTimelinePhotos(timelinePhotos,true);};
window.addEventListener('resize',updateTimelineRail);
async function trashAction(permanent) {
  if (state.busy || !state.selected.size) return;
  if(permanent&&!confirm('永久删除所选 '+state.selected.size+' 张照片？原图和故事都将删除，无法恢复。'))return;
  state.busy=true;updateSelection();let done=0;
  try {for(const id of [...state.selected]){await api('/photos/'+id+(permanent?'/permanent':'/restore'),{method:permanent?'DELETE':'POST'});state.selected.delete(id);done++;}notice('已'+(permanent?'永久删除':'恢复')+' '+done+' 张照片');}
  catch(error){notice('已完成 '+done+' 张；'+error.message);}
  finally{state.busy=false;await refreshOptions();await loadPhotos();}
}
$('batch-restore').onclick=guard(()=>trashAction(false));$('batch-purge').onclick=guard(()=>trashAction(true));
function prepareStoryDetail(photo) {
  $('detail-story').value=photo.story||''; $('detail-date').value=(photo.taken_at||'').slice(0,10);
  $('story-handwriting').textContent=photo.story||'这一页，还等着你落笔。'; $('story-date').textContent=(photo.taken_at||photo.created_at).slice(0,10);
  $('detail-date-source').textContent=photo.taken_at?'时光轴按拍摄日期排列，可手动修正。':'缺少拍摄日期，时光轴暂使用上传日期。';
  $('story-flip').classList.remove('flipped');$('story-handwriting').classList.remove('readable'); $('flip-story').textContent='翻到背面 ↻'; $('readable-story').textContent='清晰阅读';
  $('story-flip').querySelector('.story-front').setAttribute('aria-hidden','false');$('story-flip').querySelector('.story-back').setAttribute('aria-hidden','true');
  $('detail-form').querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=!!photo.trashed_at);
  $('set-folder-cover').disabled=!photo.album_id || !!photo.trashed_at;
}
function storyDirty() {
  return $('detail').open && state.detail && ($('detail-story').value!==(state.detail.story||'') || $('detail-date').value!==(state.detail.taken_at||'').slice(0,10));
}
function closeStoryDetail() {if(storyDirty()&&!confirm('故事或日期尚未保存，确定放弃修改？'))return; $('detail').close();}
$('detail').addEventListener('cancel',event=>{if(storyDirty()){event.preventDefault();closeStoryDetail();}});
window.addEventListener('beforeunload',event=>{if(storyDirty()){event.preventDefault();event.returnValue='';}});
$('detail-story').oninput=()=>{$('story-handwriting').textContent=$('detail-story').value||'这一页，还等着你落笔。';};
$('detail-date').oninput=()=>{$('story-date').textContent=$('detail-date').value||(state.detail.created_at||'').slice(0,10);};
$('flip-story').onclick=()=>{const back=$('story-flip').classList.toggle('flipped');$('flip-story').textContent=back?'回到照片 ↻':'翻到背面 ↻';$('story-flip').querySelector('.story-front').setAttribute('aria-hidden',String(back));$('story-flip').querySelector('.story-back').setAttribute('aria-hidden',String(!back));};
$('readable-story').onclick=()=>{const readable=$('story-handwriting').classList.toggle('readable');$('readable-story').textContent=readable?'手写阅读':'清晰阅读';if(!$('story-flip').classList.contains('flipped'))$('flip-story').click();};
$('set-folder-cover').onclick=guard(async()=>{await api('/albums/'+state.detail.album_id,json('PATCH',{cover_id:state.detail.id}));await refreshOptions();notice('已设为影集封面');});
async function drawMemory() {
  $('another-memory').disabled=true;$('random-memory').disabled=true;
  try {const photo=await api('/memories/random?exclude='+encodeURIComponent(randomPhoto?.id||''));randomPhoto=photo;
    $('memory-image').src=photo.thumbnail_url;$('memory-image').alt=photo.name;$('memory-name').textContent=photo.name;
    $('memory-date').textContent=(photo.taken_at||photo.created_at).slice(0,10)+(photo.taken_at?' · 那一天':' · 收藏于');
    $('memory-story').textContent=photo.story||'有些瞬间，只是再看一眼，就很好。';
    $('memory-dialog').classList.remove('just-drawn');void $('memory-dialog').offsetWidth;$('memory-dialog').classList.add('just-drawn');
    if(!$('memory-dialog').open)$('memory-dialog').showModal();
  }finally{$('another-memory').disabled=false;$('random-memory').disabled=false;}
}
$('random-memory').onclick=guard(drawMemory);$('another-memory').onclick=guard(drawMemory);
$('close-memory').onclick=()=>$('memory-dialog').close();
$('memory-detail').onclick=guard(async()=>{$('memory-dialog').close();await openDetail(randomPhoto.id);});
if(state.user) refreshOptions().catch(error=>notice(error.message));
