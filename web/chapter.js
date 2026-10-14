let detailTagItems=[];
$('sort-slot').append($('order'));$('order').onchange=guard(async()=>{renderFolders();await reload();});
const nav=document.querySelector('.collection-nav'),shell=document.createElement('div');shell.className='memory-volume';nav.before(shell);shell.append(nav,document.querySelector('.library-layout'));
function prepareDetailExtras(photo){
 detailTagItems=photo.tags.map((t,i)=>({name:t.name,color:TAG_COLORS.includes(t.color?.toUpperCase())?t.color.toUpperCase():TAG_COLORS[i%7]}));renderDetailTags();$('detail-latitude').value=photo.latitude??'';$('detail-longitude').value=photo.longitude??'';
 $('detail-date-source').textContent=({exif:'来自照片拍摄信息',manual:'手动填写的日期',upload:'缺少拍摄时间，使用入藏日期',test:'演示随机日期，不代表真实经历',unknown:'旧数据日期，来源尚未确认'}[photo.date_source]||'日期来源待确认');
}
function renderDetailTags(){
 const host=$('tag-editor');host.replaceChildren();
 for(const [index,tag]of detailTagItems.entries()){
  const group=document.createElement('div');group.className='tag-edit-group';
  const chip=document.createElement('div');chip.className='editable-tag';chip.style.backgroundColor=tag.color;
  const name=document.createElement('input');name.value=tag.name;name.maxLength=30;name.setAttribute('aria-label','标签名称');name.oninput=()=>tag.name=name.value;
  const palette=document.createElement('div');palette.className='tag-color-cards';palette.hidden=true;
  for(const hex of TAG_COLORS){const card=document.createElement('button');card.type='button';card.style.background=hex;card.title=hex;card.setAttribute('aria-label','使用色卡 '+hex);card.setAttribute('aria-pressed',String(hex===tag.color));card.onclick=()=>{tag.color=hex;chip.style.backgroundColor=hex;palette.hidden=true;};palette.append(card);}
  const color=document.createElement('button');color.type='button';color.className='tag-color-open';color.textContent='◉';color.setAttribute('aria-label',tag.name+' 色卡');color.onclick=()=>{palette.hidden=!palette.hidden;};
  const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','删除标签 '+tag.name);remove.onclick=()=>{detailTagItems.splice(index,1);renderDetailTags();};chip.append(name,color,remove);group.append(chip,palette);host.append(group);
  if(state.detail?.trashed_at)group.querySelectorAll('button,input').forEach(el=>el.disabled=true);
 }
}
function addDetailTag(){const name=$('new-detail-tag').value.trim();if(!name)return;if(detailTagItems.length>=30){notice('最多30枚标签');return;}if(detailTagItems.some(t=>t.name===name)){notice('已有这枚标签');return;}detailTagItems.push({name,color:TAG_COLORS[detailTagItems.length%7]});$('new-detail-tag').value='';renderDetailTags();}
$('add-detail-tag').onclick=addDetailTag;$('new-detail-tag').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addDetailTag();}};
async function saveDetailExtras(body){
 const names=detailTagItems.map(t=>t.name.trim());if(names.some(n=>!n)||new Set(names).size!==names.length)throw new Error('标签不能为空或重复');if(JSON.stringify(names)!==JSON.stringify(state.detail.tags.map(t=>t.name)))body.tags=names;
 const lat=$('detail-latitude').value,lon=$('detail-longitude').value;if(Boolean(lat)!==Boolean(lon))throw new Error('经纬度需要一起填写');body.latitude=lat===''?null:Number(lat);body.longitude=lon===''?null:Number(lon);
 for(const tag of detailTagItems){const previous=state.detail.tags.find(t=>t.name===tag.name.trim());if(previous?.color?.toUpperCase()!==tag.color.toUpperCase())await api('/tag-colors/'+encodeURIComponent(tag.name.trim()),json('PUT',{color:tag.color}));}
}
async function downloadArchive(scope){if(state.busy)return;state.busy=true;updateSelection();const version=accountVersion;try{notice('正在打包，请稍候…');const response=await fetch('/api/photos/download',{method:'POST',headers:{'X-AIbum-Request':'1','Content-Type':'application/json'},body:JSON.stringify(scope)});if(!response.ok){const err=await response.json();throw new Error(err.detail||'下载失败');}const blob=await response.blob();if(version!==accountVersion)throw new Error('账户已变更');const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='拾光相册.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);notice('压缩包已准备好，保留影集目录结构');}finally{state.busy=false;updateSelection();}}
$('batch-download').onclick=guard(()=>downloadArchive({photo_ids:[...state.selected]}));$('folder-download').onclick=guard(()=>downloadArchive({album_ids:[$('album-filter').value]}));
// Keep the scrolling surface inside the dialog's rounded paper edge.
for(const dialog of document.querySelectorAll('dialog')){if(dialog.id==='image-viewer')continue;const scroll=document.createElement('div');scroll.className='dialog-scroll';while(dialog.firstChild)scroll.append(dialog.firstChild);dialog.append(scroll);}
const account=$('account'),avatarMenu=document.createElement('div');avatarMenu.className='avatar-menu';const trigger=document.createElement('button');trigger.id='avatar-trigger';trigger.className='avatar-trigger';trigger.setAttribute('aria-label','打开账户菜单');trigger.setAttribute('aria-expanded','false');trigger.append(document.querySelector('.avatar-mini'));const menu=document.createElement('div');menu.className='avatar-dropdown';menu.id='avatar-dropdown';
const profile=$('security-button');profile.textContent='个人中心';const settings=document.createElement('button');settings.textContent='设置';settings.onclick=()=>$('settings-dialog').showModal();const help=document.createElement('a');help.href='/help';help.target='_blank';help.rel='noopener';help.textContent='帮助';const feedback=document.createElement('button');feedback.id='open-feedback';feedback.textContent='问题反馈';const signature=document.createElement('div');signature.className='avatar-signature';const nickname=document.createElement('strong');nickname.id='menu-nickname';const note=document.createElement('small');note.textContent='回忆的保管人 · MY ARCHIVE';signature.append(nickname,note);menu.append(signature,profile,settings,help,feedback,$('logout'));avatarMenu.append(trigger,menu);account.append(avatarMenu);$('username').hidden=true;
function avatarOpen(open){avatarMenu.classList.toggle('expanded',open);trigger.setAttribute('aria-expanded',String(open));}trigger.onclick=()=>avatarOpen(true);avatarMenu.onmouseenter=()=>avatarOpen(true);avatarMenu.onmouseleave=()=>{if(!avatarMenu.contains(document.activeElement))avatarOpen(false);};avatarMenu.onfocusout=e=>{if(!avatarMenu.contains(e.relatedTarget))avatarOpen(false);};avatarMenu.onkeydown=e=>{if(e.key==='Escape'){avatarOpen(false);trigger.focus();}};document.addEventListener('click',e=>{if(!avatarMenu.contains(e.target))avatarOpen(false);});
function setMotion(value){document.body.dataset.motion=value;try{localStorage.setItem('aibum-motion',value);}catch{}}try{$('motion-preference').value=localStorage.getItem('aibum-motion')||'full';}catch{}setMotion($('motion-preference').value);$('motion-preference').onchange=()=>setMotion($('motion-preference').value);
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
function resetChapter(){if(typeof resetCommunity==='function')resetCommunity();resetTagLogic();clearImport();$('ai-conversation').replaceChildren();$('ai-scope').replaceChildren();$('feedback-list').replaceChildren();if(typeof revokeCompanion==='function')revokeCompanion(false);}

const randomInvitation=$('random-memory');document.querySelector('.memory-volume').before(randomInvitation);
