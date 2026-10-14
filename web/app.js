const $ = id => document.getElementById(id);
const adminPortal = location.pathname === '/admin';
const state = {user: null, register: false, items: [], selected: new Set(), page: 1, total: 0, mode: 'browse', detail: null, health: '', query: null, busy: false, tags: new Set(), tagOptions: [], referenceFile: null, referenceUrl: null, similarId: null, users: []};
let noticeTimer, accountVersion = 0, resultVersion = 0;
function notice(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').hidden = true, 7000); }
async function api(path, options = {}) {
  const version = accountVersion;
  const response = await fetch('/api' + path, {...options, headers: {'X-AIbum-Request': '1', ...options.headers}});
  if (version !== accountVersion) throw new Error('账户状态已更新，请重试');
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 401 && state.user) showAuth();
    const detail = Array.isArray(error.detail) ? error.detail.map(e => e.msg).join('；') : error.detail;
    throw new Error(detail || `请求失败 (${response.status})`);
  }
  return response.json();
}
const json = (method, body) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
function guard(fn) { return async event => { try { await fn(event); } catch (error) { notice(error.message); } }; }
function showAuth() {
  accountVersion++; resultVersion++;
  state.user = null; state.items = []; state.selected.clear(); state.query = null; state.detail = null;
  state.tags.clear(); state.tagOptions = []; state.users = []; clearReference();
  if (typeof resetMemoryState === 'function') resetMemoryState();
  if (typeof resetMusic === 'function') resetMusic();
  document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close()); if(typeof resetChapter==='function')resetChapter();
  $('detail').close(); $('detail-image').removeAttribute('src'); $('grid').replaceChildren();
  $('security').close(); $('admin-users').replaceChildren(); $('admin-workspace').hidden = true;
  $('security-button').disabled = false;
  $('workspace').hidden = true; $('account').hidden = true; $('auth').hidden = false;
  $('portal-link').hidden = false;
}
async function showWorkspace(user) {
  accountVersion++; resultVersion++;
  state.user = user; state.mode = 'browse'; state.health = ''; state.selected.clear();
  if (typeof resetMemoryState === 'function') resetMemoryState();
  if (typeof resetMusic === 'function') resetMusic();
  state.tags.clear(); state.tagOptions = []; clearReference(); resetFilters();
  $('search-form').reset(); selectSearchMode('text'); $('reference-info').hidden = true;
  $('auth').hidden = true; $('workspace').hidden = false; $('account').hidden = false; renderProfile();
  $('admin-button').hidden = !user.is_admin; $('query').disabled = false;
  $('portal-link').hidden = true; $('library-link').hidden = !adminPortal;
  $('auth-password').value = '';
  if (adminPortal) {
    if (typeof resetMusic === 'function') resetMusic();
    if (!user.is_admin) { showAuth(); $('auth-error').textContent = '请使用管理员账号登录'; return; }
    $('workspace').hidden = true; $('admin-workspace').hidden = false; $('admin-button').hidden = true;
    await loadUsers(); if(typeof loadCommunity==='function')await loadCommunity(); return;
  }
  await refreshOptions(); await loadPhotos(); await updateHealth();
  if (typeof loadMusic === 'function') await loadMusic(); if(typeof loadCommunity==='function')await loadCommunity();
}
$('auth-toggle').onclick = () => { state.register = !state.register; $('auth-title').textContent = state.register ? '创建你的相册' : '登录你的相册'; $('auth-submit').textContent = state.register ? '创建账户' : '登录'; $('auth-toggle').textContent = state.register ? '已有账户？返回登录' : '还没有账户？创建一个'; $('auth-password').autocomplete = state.register ? 'new-password' : 'current-password'; $('auth-error').textContent = ''; };
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-submit').disabled = true; $('auth-error').textContent = '';
  try { const endpoint = adminPortal ? '/admin/login' : '/auth/' + (state.register ? 'register' : 'login'); const user = await api(endpoint, json('POST', {username: $('auth-name').value, password: $('auth-password').value})); await showWorkspace(user); if (user.recovery_code) showRecovery(user.recovery_code); }
  catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
};
$('logout').onclick = guard(async () => { await api('/auth/logout', {method: 'POST'}); showAuth(); });
function fillSelect(id, entries, first) {
  const node = $(id), previous = node.value;
  node.replaceChildren(new Option(first, ''));
  entries.forEach(item => node.add(new Option(item.name + (item.count !== undefined ? ` (${item.count})` : ''), item.id ?? item.name)));
  if ([...node.options].some(o => o.value === previous)) node.value = previous;
}
async function refreshOptions() {
  const [albums, tags] = await Promise.all([api('/albums'), api('/tags')]);
  fillSelect('album-filter', albums, '所有相册'); fillSelect('batch-album', albums, '移出相册');
  fillSelect('detail-album', albums, '未归入相册'); state.tagOptions = tags; renderTagOptions();
  if (typeof updateFolders === 'function') updateFolders(albums);
}
$('tag-keyword').oninput = () => renderTagOptions();
$('clear-tags').onclick = guard(async () => { state.tags.clear(); if(typeof resetTagLogic==='function')resetTagLogic(); renderTagOptions(); await applyFilters(); });
function resetFilters() { state.tags.clear(); if(typeof resetTagLogic==='function')resetTagLogic(); ['album-filter','location-filter','start-filter','end-filter','tag-keyword'].forEach(id => $(id).value = ''); $('favorite-filter').checked = false; $('order').value = 'newest'; renderTagOptions(); }
$('clear-filters').onclick = guard(async () => { resetFilters(); await applyFilters(); });
function appendFilters(target) {
  for (const key of ['album_id','location','start','end','favorite','tags','tag_expr']) target.delete(key);
  for (const [key,value] of Object.entries(filterValues())) if (value) target.set(key,value);
  if (typeof collectionView !== 'undefined' && collectionView === 'favorites') target.set('favorite','true');
  if(typeof tagLogic!=='undefined'&&tagLogic)target.set('tag_expr',JSON.stringify(tagLogic)); else for (const tag of state.tags) target.append('tags',tag);
}
function filterValues() {
  if ($('start-filter').value && $('end-filter').value && $('start-filter').value > $('end-filter').value) throw new Error('开始日期不能晚于结束日期');
  return {album_id: $('album-filter').value, location: $('location-filter').value.trim(), start: $('start-filter').value, end: $('end-filter').value, favorite: $('favorite-filter').checked ? 'true' : ''};
}
async function loadPhotos(append = false) {
  const version = ++resultVersion;
  const page = append ? state.page + 1 : 1;
  const params = new URLSearchParams({page, order: $('order').value}); appendFilters(params);
  const view = typeof collectionView === 'undefined' ? 'photos' : collectionView;
  if (view === 'trash') params.set('trash','true');
  if (view === 'folders' && !$('album-filter').value) params.set('album_id','__unfiled__');
  if (view === 'timeline') { params.set('page_size','100'); params.set('page','1'); }
  const data = await api('/photos?' + params);
  if (view === 'timeline') {
    for (let next = 2; data.items.length < data.total; next++) { params.set('page',next); const extra = await api('/photos?' + params); if (!extra.items.length) break; data.items.push(...extra.items); }
  }
  if (version !== resultVersion) return;
  state.page = page; state.total = data.total; state.items = append ? [...state.items, ...data.items] : data.items;
  if (view === 'timeline' && typeof setTimelinePhotos === 'function') {
    setTimelinePhotos(state.items);
  }
  state.mode = 'browse'; state.query = null;
  state.similarId = null; $('search-summary').hidden = true;
  $('result-label').textContent = view === 'timeline'
    ? `${state.items.length} 张照片 · ${timelineMode === 'single' && timelineSelection ? timelineSelection : timelineMode === 'range' && timelineRange?.start ? `${timelineRange.start} 至 ${timelineRange.end}` : '全部时期'}`
    : `${data.total} 张照片 · 已显示 ${state.items.length} 张`;
  $('load-more').hidden = view === 'timeline' || state.items.length >= data.total; render();
}
function render() {
  $('grid').replaceChildren(); $('empty').hidden = state.items.length > 0;
  if (typeof prepareCollectionRender === 'function') prepareCollectionRender();
  $('empty').querySelector('h2').textContent = state.mode === 'browse' ? '这里还没有照片' : '没有找到符合条件的照片';
  $('empty').querySelector('p').textContent = state.mode === 'browse' ? '上传一些照片，或调整当前筛选条件。' : '没有达到当前匹配门槛的照片。可以调低匹配分数、调整描述或筛选，并确认照片已完成分析。';
  const ids = new Set(state.items.map(p => p.id)); state.selected = new Set([...state.selected].filter(id => ids.has(id)));
  state.items.forEach((photo, index) => {
    if (typeof addTimelineHeading === 'function') addTimelineHeading(photo);
    const stage = document.createElement('div'); stage.className = 'card-stage';
    const card = document.createElement('article'); card.className = 'card';
    card.style.setProperty('--reveal-delay', `${Math.min(index, 8) * 45}ms`);
    const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'card-select'; check.checked = state.selected.has(photo.id); check.setAttribute('aria-label', '选择 ' + photo.name);
    card.classList.toggle('selected', check.checked);
    check.onchange = () => { check.checked ? state.selected.add(photo.id) : state.selected.delete(photo.id); card.classList.toggle('selected', check.checked); updateSelection(); };
    const open = document.createElement('button'); open.className = 'card-image'; open.setAttribute('aria-label', '查看 ' + photo.name); open.onclick = guard(() => openDetail(photo.id));
    const image = document.createElement('img'); image.onload = () => image.classList.add('developed'); image.onerror = () => { image.classList.add('developed'); }; image.src = photo.thumbnail_url; image.alt = photo.name; image.loading = 'lazy'; open.append(image);
    const body = document.createElement('div'); body.className = 'card-body';
    const title = document.createElement('p'); title.className = 'card-title'; title.textContent = (photo.favorite ? '★ ' : '') + photo.name; title.title = photo.name;
    const subtitle = document.createElement('p'); subtitle.className = 'card-subtitle'; subtitle.textContent = photo.score !== undefined ? `相似度 ${photo.score.toFixed(3)}` : `${(photo.taken_at || photo.created_at).slice(0,10)} · ${photo.taken_at ? '拍摄于' : '上传于'} · ${statusName(photo.status)}`;
    const tags = document.createElement('div'); tags.className = 'tags';
    photo.tags.forEach(t => { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t.name; tag.style.backgroundColor=t.color||'#cfb58f'; tags.append(tag); });
    body.append(title, subtitle, tags); card.append(check, open, body); stage.append(card); $('grid').append(stage);
  }); updateSelection();
  if (collectionView === 'folders' && $('folder-grid').children.length) $('empty').hidden = true;
  if (collectionView === 'trash') {
    $('empty').querySelector('h2').textContent = '回收站是空的';
    $('empty').querySelector('p').textContent = '移入这里的照片可以恢复，也可以手动永久删除。';
  }
}
function statusName(status) { return {pending: '等待分析', processing: '分析中', ready: '已分析', failed: '分析失败', deleting: '删除中'}[status] || status; }
function updateSelection() { $('selected-count').textContent = `已选 ${state.selected.size} 张`; $('select-all').checked = !!state.items.length && state.selected.size === state.items.length; ['batch-favorite','batch-move','batch-download','batch-delete','batch-restore','batch-purge'].forEach(id => $(id).disabled = state.selected.size === 0 || state.busy); }
$('select-all').onchange = () => { state.selected = $('select-all').checked ? new Set(state.items.map(p => p.id)) : new Set(); render(); };
$('load-more').onclick = guard(() => loadPhotos(true));
async function applyFilters() { state.selected.clear(); if (state.mode === 'search') await runSearch(true); else if (state.mode === 'similar') await runSimilar(state.similarId); else await loadPhotos(); }
$('apply-filters').onclick = guard(applyFilters);
$('refresh').onclick = guard(async () => { await refreshOptions(); await reload(); await updateHealth(); });
$('reset-search').onclick = guard(async () => { $('search-form').reset(); selectSearchMode('text'); clearReference(); resetFilters(); state.selected.clear(); await loadPhotos(); });
$('new-album').onclick = () => openFolderEditor();
let searchMode = 'text';
function selectSearchMode(mode) {
  searchMode = mode;
  document.querySelectorAll('[data-search-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.searchMode === mode)));
  $('text-search-input').hidden = mode !== 'text'; $('reference-drop').hidden = mode !== 'image';
  $('match-range').value = '1';
  $('match-value').value = ['宽松','均衡','严格'][Number($('match-range').value)];
}
document.querySelectorAll('[data-search-mode]').forEach(button => button.onclick = () => selectSearchMode(button.dataset.searchMode));
$('match-range').oninput = () => $('match-value').value = ['宽松','均衡','严格'][Number($('match-range').value)];
$('match-range').onchange = guard(async () => { if (state.mode !== 'browse') await applyFilters(); });
function clearReference() {
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl);
  state.referenceFile = null; state.referenceUrl = null; state.similarId=null; $('reference').value = '';
  $('reference-info').hidden = true; $('reference-preview').removeAttribute('src'); $('drop-prompt').hidden = false;
}
function setReference(file) {
  if (!file) return;
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('参考图不能为空且不得超过 20 MiB');
  if (file.type && !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  clearReference(); state.referenceFile = file; state.referenceUrl = URL.createObjectURL(file);
  $('reference-preview').src = state.referenceUrl; $('reference-name').textContent = file.name;
  $('reference-info').hidden = false; $('drop-prompt').hidden = true; selectSearchMode('image');
}
$('reference').onchange = guard(() => setReference($('reference').files[0]));
$('clear-reference').onclick = event => { event.stopPropagation(); clearReference(); };
$('reference-drop').onclick = event => { if (!event.target.closest('button')) $('reference').click(); };
$('reference-drop').onkeydown = event => { if (event.target === $('reference-drop') && ['Enter',' '].includes(event.key)) { event.preventDefault(); $('reference').click(); } };
$('reference-drop').ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('reference-drop').classList.add('dragging'); };
$('reference-drop').ondragleave = event => { if (!$('reference-drop').contains(event.relatedTarget)) $('reference-drop').classList.remove('dragging'); };
$('reference-drop').ondrop = guard(event => {
  event.preventDefault(); $('reference-drop').classList.remove('dragging');
  const files = [...event.dataTransfer.files]; if (files.length !== 1) throw new Error('每次请选择一张参考图片'); setReference(files[0]);
});
for (const type of ['dragover','drop']) document.addEventListener(type, event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('search-form').onsubmit = guard(async event => { event.preventDefault(); await runSearch(); });
async function runSearch(reuse = false) {
  const version = ++resultVersion;
  const form = new FormData();
  if (reuse && state.query) { for (const [key,value] of state.query.entries()) form.append(key,value); }
  else {
    if (searchMode === 'text') { if (!$('query').value.trim()) throw new Error('请先描述想找的照片'); form.set('text',$('query').value.trim()); }
    else { if(!state.referenceFile&&state.similarId)return runSimilar(state.similarId); if (!state.referenceFile) throw new Error('请先放入一张参考图'); form.set('image',state.referenceFile); }
  }
  appendFilters(form); form.delete('min_score'); form.set('strictness',['broad','balanced','strict'][Number($('match-range').value)]); form.set('limit','100');
  $('search-button').disabled = true; $('search-button').textContent = '检索中…';
  try { const data = await api('/search', {method: 'POST', body: form}); if (version !== resultVersion) return; state.items = data.items; state.mode = 'search'; state.query = form; state.similarId = null; showSearchResult(data, data.mode === 'text' ? '文搜图' : '图搜图'); }
  finally { $('search-button').disabled = false; $('search-button').textContent = '搜索'; }
}
function showSearchResult(data, title) {
  $('result-label').textContent = `${title} · 匹配 ${data.matched_count} 张，显示 ${data.items.length} 张`;
  $('search-summary').textContent = `匹配分数 ≥ ${data.threshold.toFixed(2)} · 已过滤 ${data.filtered_count} 张低相关照片${data.elapsed_ms !== undefined ? ` · ${data.elapsed_ms} ms` : ''}。分数不是识别概率。`;
  $('search-summary').hidden = false; $('load-more').hidden = true; render();
}
async function runSimilar(id) {
  if (searchMode !== 'image') selectSearchMode('image');
  const version = ++resultVersion; const params = new URLSearchParams({strictness:['broad','balanced','strict'][Number($('match-range').value)],limit:'100'}); appendFilters(params);
  const data = await api('/photos/' + id + '/similar?' + params);
  if (version !== resultVersion) return; state.items = data.items; state.mode = 'similar'; state.similarId = id; showSearchResult(data,'相似照片（含参考图）');
}
async function reload() { if (state.mode === 'search') await runSearch(true); else if (state.mode === 'similar') await runSimilar(state.similarId); else await loadPhotos(); }
function uploadOne(file, album, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/photos'); xhr.setRequestHeader('X-AIbum-Request','1');
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded / e.total); };
    xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('上传响应异常')); } xhr.status < 300 ? resolve(data) : reject(new Error(typeof data.detail === 'string' ? data.detail : '上传失败')); };
    xhr.onerror = () => reject(new Error('网络错误')); const form = new FormData(); form.set('file',file); if (album) form.set('album_id',album); xhr.send(form);
  });
}
async function batch(action, body) {
  if (state.busy || !state.selected.size) return;
  if (action === 'DELETE' && !confirm(`将所选 ${state.selected.size} 张照片移入回收站？可以随时恢复。`)) return;
  state.busy = true; updateSelection(); let done = 0;
  try { for (const id of [...state.selected]) { await api('/photos/' + id, action === 'DELETE' ? {method: 'DELETE'} : json('PATCH', body)); state.selected.delete(id); done++; } notice(`已处理 ${done} 张照片`); }
  catch(error) { notice(`已处理 ${done} 张；${error.message}`); }
  finally { state.busy = false; await refreshOptions(); await reload(); }
}
$('batch-favorite').onclick = guard(() => batch('PATCH', {favorite: true}));
$('batch-move').onclick = guard(() => batch('PATCH', {album_id: $('batch-album').value || null}));
$('batch-delete').onclick = guard(() => batch('DELETE'));
$('batch-download').onclick = guard(async () => {
  if (!state.selected.size || $('batch-download').disabled) return;
  const version=accountVersion,button=$('batch-download'),ids=[...state.selected];state.busy=true;updateSelection();
  try {
    const response=await fetch('/api/photos/download',{method:'POST',headers:{'X-AIbum-Request':'1','Content-Type':'application/json'},body:JSON.stringify({photo_ids:ids})});
    if(version!==accountVersion)throw new Error('账户状态已更新，请重新选择照片');
    if(!response.ok){const error=await response.json().catch(()=>({}));if(response.status===401&&state.user)showAuth();throw new Error(error.detail||`下载失败 (${response.status})`);}
    const blob=await response.blob(); if(version!==accountVersion)throw new Error('账户已变更，下载已停止'); const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='aibum-photos.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);notice(`已打包下载 ${ids.length} 张照片`);
  } finally {state.busy=false;updateSelection();}
});
async function openDetail(id) {
  const photo = await api('/photos/' + id); state.detail = photo;
  prepareStoryDetail(photo);
  $('detail-image').src = photo.original_url; $('detail-image').alt = photo.name;
  $('detail-name').value = photo.name; $('detail-location').value = photo.location; $('detail-album').value = photo.album_id || '';
  $('detail-tags').value = photo.tags.map(t => t.name).join(', '); if(typeof prepareDetailExtras==='function')prepareDetailExtras(photo); $('detail-favorite').checked = photo.favorite;
  $('detail-meta').textContent = `${photo.width} × ${photo.height} · ${(photo.size/1024/1024).toFixed(2)} MiB · ${photo.camera || '无相机信息'}`;
  $('detail-auto').textContent = photo.tags.filter(t => t.source === 'auto').map(t => `${t.name}：${t.score.toFixed(3)}`).join(' / ') + '（推荐分数不是概率；修改标签后保存为人工标签）';
  $('detail-state').textContent = photo.trashed_at ? '已在回收站，恢复后可修改资料。' : photo.error || statusName(photo.status); $('detail-similar').disabled = !!photo.trashed_at || photo.status !== 'ready'; $('detail-retry').disabled = !!photo.trashed_at || !['ready','failed'].includes(photo.status);
  $('detail-download').href = '#'; $('detail-download').onclick=guard(async event=>{event.preventDefault();await downloadArchive({photo_ids:[photo.id]});}); $('detail').showModal();
}
$('close-detail').onclick = () => closeStoryDetail();
$('detail-form').onsubmit = guard(async event => {
  event.preventDefault(); const photo = state.detail;
  const body = {name: $('detail-name').value, location: $('detail-location').value, album_id: $('detail-album').value || null, favorite: $('detail-favorite').checked, story:$('detail-story').value};
  if ($('detail-date').value !== (photo.taken_at || '').slice(0,10)) body.taken_at = $('detail-date').value || null;
  await saveDetailExtras(body);
  await api('/photos/' + photo.id, json('PATCH', body)); $('detail').close(); await refreshOptions(); await reload(); notice('修改已保存');
});
$('detail-retry').onclick = guard(async () => { if (storyDirty() && !confirm('故事或日期尚未保存，确定放弃修改并重新分析？')) return; await api('/photos/' + state.detail.id + '/retry', {method: 'POST'}); $('detail').close(); await reload(); notice('已加入分析队列'); });
$('detail-similar').onclick = guard(async () => { if (storyDirty() && !confirm('故事或日期尚未保存，确定放弃修改并查找相似照片？')) return; selectSearchMode('image'); if(state.referenceUrl)URL.revokeObjectURL(state.referenceUrl);state.referenceUrl=null;state.referenceFile=null;state.similarId=state.detail.id;$('reference-preview').src=state.detail.thumbnail_url;$('reference-name').textContent=state.detail.name;$('reference-info').hidden=false;$('drop-prompt').hidden=true; await runSimilar(state.detail.id); $('detail').close(); });
async function updateHealth() {
  if (!state.user || adminPortal) return;
  const health = await api('/health'); const counts = health.photos;
  $('model-status').textContent = `${health.model.installed ? '本地图文模型' : '模型未安装：请先运行模型准备脚本'} · 已分析 ${counts.ready || 0} · 待处理 ${(counts.pending || 0)+(counts.processing || 0)} · 失败 ${counts.failed || 0}`;
  const snapshot = JSON.stringify(counts); const changed = state.health && snapshot !== state.health; state.health = snapshot;
  if (changed && !state.busy && !state.selected.size && !$('detail').open && !$('upload').disabled && !$('search-button').disabled) { await refreshOptions(); if (state.mode === 'browse') await loadPhotos(); }
}
setInterval(() => { if (state.user && !document.hidden) updateHealth().catch(() => {}); }, 4000);
function showRecovery(code) { $('recovery-code').value = code; $('recovery').showModal(); }
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('recovery').addEventListener('close', () => $('recovery-code').value = '');
$('download-code').onclick = () => {
  const url = URL.createObjectURL(new Blob(['AIbum recovery code\n' + $('recovery-code').value + '\nKeep this secret.'], {type: 'text/plain'}));
  const link = document.createElement('a'); link.href = url; link.download = 'aibum-recovery-code.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
let avatarFile = null, avatarPreview = null, avatarBusy = false;
function renderProfile() {
  if (!state.user) return;
  const name = state.user.nickname || state.user.username;
  $('username').textContent = name; if($('menu-nickname'))$('menu-nickname').textContent=name; $('profile-display-name').textContent = name;
  $('profile-account').value = state.user.username; $('profile-nickname').value = state.user.nickname || '';
  $('profile-member-since').textContent = state.user.created_at ? `从 ${state.user.created_at.slice(0,10)} 开始收藏` : '你的私人记忆档案';
  for (const prefix of ['header','profile']) {
    const source = prefix === 'profile' && avatarPreview ? avatarPreview : state.user.avatar_version ? '/api/auth/avatar?v=' + state.user.avatar_version : '';
    $(prefix + '-avatar').hidden = !source;
    if (source) $(prefix + '-avatar').src = source; else $(prefix + '-avatar').removeAttribute('src');
    $(prefix + '-initial').hidden = !!source; $(prefix + '-initial').textContent = [...name][0] || '✳';
  }
}
function clearAvatarPreview() {
  if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  avatarPreview = null; avatarFile = null; $('avatar-upload').value = '';
  $('avatar-save').hidden = true; $('avatar-cancel').hidden = true; $('avatar-status').textContent = '';
}
function profileTab(security) {
  $('profile-info-panel').hidden = security; $('profile-security-panel').hidden = !security;
  $('profile-tab-info').setAttribute('aria-pressed', String(!security));
  $('profile-tab-security').setAttribute('aria-pressed', String(security));
}
$('profile-tab-info').onclick = () => profileTab(false);
$('profile-tab-security').onclick = () => profileTab(true);
$('security-button').onclick = () => { $('password-form').reset(); clearAvatarPreview(); renderProfile(); profileTab(false); $('security').showModal(); };
$('security').addEventListener('close', () => { clearAvatarPreview(); $('password-form').reset(); });
$('profile-form').onsubmit = guard(async event => {
  event.preventDefault(); $('profile-save').disabled = true;
  try { const result = await api('/auth/profile', json('PATCH', {nickname:$('profile-nickname').value})); state.user.nickname = result.nickname; renderProfile(); notice('昵称已保存'); }
  finally { $('profile-save').disabled = false; }
});
$('avatar-upload').onchange = guard(async () => {
  const file = $('avatar-upload').files[0]; if (!file || avatarBusy) return;
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('头像不能为空且不得超过 5 MiB');
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 头像');
  clearAvatarPreview(); avatarFile = file; avatarPreview = URL.createObjectURL(file);
  $('profile-avatar').src = avatarPreview; $('profile-avatar').hidden = false; $('profile-initial').hidden = true;
  $('avatar-save').hidden = false; $('avatar-cancel').hidden = false; $('avatar-status').textContent = '预览中，点击“保存头像”后生效';
});
$('avatar-cancel').onclick = () => { clearAvatarPreview(); renderProfile(); };
$('avatar-save').onclick = guard(async () => {
  if (!avatarFile || avatarBusy) return;
  avatarBusy = true; ['avatar-save','avatar-upload','avatar-cancel'].forEach(id => $(id).disabled = true);
  const form = new FormData(); form.set('file', avatarFile); $('avatar-status').textContent = '正在保存头像…';
  try { const result = await api('/auth/avatar', {method:'POST',body:form}); state.user.avatar_version = result.avatar_version; clearAvatarPreview(); renderProfile(); notice('新头像已保存'); }
  catch (error) { $('avatar-status').textContent = '保存失败，请重新选择或重试'; throw error; }
  finally { avatarBusy = false; ['avatar-save','avatar-upload','avatar-cancel'].forEach(id => $(id).disabled = false); }
});
$('password-form').onsubmit = guard(async event => {
  event.preventDefault(); if (!$('new-password').value) throw new Error('请输入新密码');
  if ($('new-password').value !== $('confirm-password').value) throw new Error('两次输入的新密码不一致');
  await api('/auth/password', json('POST', {current_password: $('current-password').value, new_password: $('new-password').value}));
  $('password-form').reset(); showAuth(); notice('密码已修改，请重新登录');
});
$('rotate-code').onclick = guard(async () => {
  const result = await api('/auth/recovery-code', json('POST', {password: $('current-password').value}));
  $('password-form').reset(); $('security').close(); showRecovery(result.recovery_code);
});
$('forgot-button').onclick = () => { $('forgot-form').reset(); $('reset-name').value = $('auth-name').value; $('forgot').showModal(); };
$('forgot-form').onsubmit = guard(async event => {
  event.preventDefault(); const result = await api('/auth/reset-password', json('POST', {username: $('reset-name').value, recovery_code: $('reset-code').value, new_password: $('reset-password').value}));
  $('forgot-form').reset(); $('forgot').close(); showRecovery(result.recovery_code); notice('密码已重置，请保存新恢复码，然后登录');
});
async function loadUsers() {
  const [users, overview] = await Promise.all([api('/admin/users'),api('/admin/overview')]); state.users = users;
  $('stat-users').textContent = overview.users.total; $('stat-active').textContent = overview.users.active;
  $('stat-photos').textContent = overview.photos.total; $('stat-failed').textContent = overview.photos.failed;
  $('admin-model-status').textContent = overview.model.installed ? '图文模型已安装' : '图文模型尚未安装';
  $('admin-storage').textContent = `照片存储 ${(overview.photos.bytes/1024/1024).toFixed(1)} MiB`; renderUsers();
}
function renderUsers() {
  const keyword = $('admin-search').value.trim().toLowerCase(), status = $('admin-status-filter').value;
  const users = state.users.filter(u => u.username.toLowerCase().includes(keyword) && (status === 'all' || (status === 'active' ? !!u.active : !u.active)));
  $('admin-users').replaceChildren(); $('admin-empty').hidden = !!users.length;
  for (const user of users) {
    const row = document.createElement('tr');
    for (const value of [user.username + (user.is_admin ? ' · 管理员' : ''),user.created_at.slice(0,10),`${user.photo_count} / 500`,user.active ? '正常' : '已停用']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const action = document.createElement('td');
    if (!user.is_admin) { const button = document.createElement('button'); button.textContent = user.active ? '停用' : '启用'; button.className = user.active ? 'danger' : ''; button.onclick = guard(async () => { if (user.active && !confirm('停用后该用户将被退出登录，照片保留。确定继续？')) return; button.disabled = true; try { await api('/admin/users/' + user.id, json('PATCH', {active: !user.active})); await loadUsers(); } finally { button.disabled = false; } }); action.append(button); }
    else action.textContent = '—'; row.append(action); $('admin-users').append(row);
  }
}
$('admin-search').oninput = renderUsers; $('admin-status-filter').onchange = renderUsers;
$('admin-refresh').onclick = guard(loadUsers);
$('admin-button').onclick = () => location.assign('/admin');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let tiltCard = null, tiltFrame = 0;
function resetTilt() {
  cancelAnimationFrame(tiltFrame);
  if (tiltCard) { tiltCard.style.removeProperty('--tilt-x'); tiltCard.style.removeProperty('--tilt-y'); tiltCard = null; }
}
$('grid').addEventListener('pointermove', event => {
  if (motionPreference.matches || event.pointerType !== 'mouse') return;
  const wrapper = event.target.closest('.card-stage'); const card = wrapper?.querySelector('.card'); if (!card) { resetTilt(); return; }
  if (tiltCard !== card) resetTilt(); tiltCard = card;
  cancelAnimationFrame(tiltFrame);
  const x = event.clientX, y = event.clientY;
  tiltFrame = requestAnimationFrame(() => {
    const bounds = wrapper.getBoundingClientRect();
    card.style.setProperty('--tilt-x', `${(y - bounds.top - bounds.height / 2) / bounds.height * 5}deg`);
    card.style.setProperty('--tilt-y', `${-(x - bounds.left - bounds.width / 2) / bounds.width * 5}deg`);
  });
});
$('grid').addEventListener('pointerleave', resetTilt);
motionPreference.addEventListener('change', resetTilt);
if (adminPortal) {
  document.title = 'AIbum · 管理后台'; $('auth-title').textContent = '管理员登录'; $('auth-submit').textContent = '登录管理台'; $('auth-toggle').hidden = true;
  $('portal-link').textContent = '普通用户入口'; $('portal-link').href = '/';
  $('auth').querySelector('h1').textContent = '相册管理，从这里开始。';
  $('auth').querySelector('.intro').textContent = '使用已配置的管理员账号和密码登录，查看账户与服务运行情况。';
  $('auth-form').querySelector('p').textContent = '仅管理员账号可进入控制台。';
}
document.addEventListener('DOMContentLoaded', async () => { try { await showWorkspace(await api('/auth/me')); } catch(error) { showAuth(); } });
