let musicTracks = [], musicIndex = -1;
const musicAudio = $('music-audio');
musicAudio.volume = 0.7;

function resetMusic() {
  musicAudio.pause(); musicAudio.removeAttribute('src'); musicAudio.load();
  musicTracks = []; musicIndex = -1;
  $('music-list').replaceChildren(); $('music-panel').hidden = true; $('music-player').hidden = true;
  $('music-play-disc').classList.remove('playing'); $('music-tonearm').classList.remove('playing');
  $('music-menu-button').setAttribute('aria-expanded', 'false');
  $('music-menu-title').textContent = '拾光唱片'; $('music-menu-subtitle').textContent = '点此打开歌单';
  $('music-current').textContent = '歌单里还没有音乐';
}
async function loadMusic() {
  const tracks = await api('/music/tracks');
  musicTracks = tracks; $('music-player').hidden = false;
  if (musicIndex >= tracks.length) musicIndex = tracks.length - 1;
  renderMusic();
}
function renderMusic() {
  $('music-list').replaceChildren();
  for (const [index, track] of musicTracks.entries()) {
    const row = document.createElement('li'); row.classList.toggle('current', index === musicIndex);
    const play = document.createElement('button'); play.type = 'button'; play.className = 'music-track';
    play.textContent = `${String(index + 1).padStart(2, '0')}  ${track.name}`;
    play.onclick = guard(() => playMusic(index));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet';
    remove.textContent = '移除'; remove.setAttribute('aria-label', '移除歌曲 ' + track.name);
    remove.onclick = guard(async () => {
      await api('/music/tracks/' + track.id, { method: 'DELETE' });
      if (index === musicIndex) { musicAudio.pause(); musicAudio.removeAttribute('src'); musicAudio.load(); musicIndex = -1; }
      else if (index < musicIndex) musicIndex--;
      musicTracks.splice(index, 1); updateMusicState(); renderMusic();
    });
    row.append(play, remove); $('music-list').append(row);
  }
  $('music-current').textContent = musicTracks[musicIndex]?.name || (musicTracks.length ? `${musicTracks.length} 首歌，选一首开始` : '歌单里还没有音乐');
  $('music-play').disabled = !musicTracks.length;
  $('music-previous').disabled = !musicTracks.length; $('music-next').disabled = !musicTracks.length;
  updateMusicState();
}
function updateMusicState() {
  const playing = !musicAudio.paused && !!musicAudio.src;
  $('music-play-disc').classList.toggle('playing', playing);
  $('music-tonearm').classList.toggle('playing', playing);
  const icon=playing?'M7 5h3v14H7zM14 5h3v14h-3z':'M8 5l11 7-11 7z';for(const id of ['music-play','music-menu-subtitle']){const host=$(id);host.replaceChildren();const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.classList.add('playback-icon');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',icon);svg.append(path);host.append(svg);host.setAttribute('aria-label',playing?'暂停音乐':'播放音乐');} $('music-play').title=playing?'暂停':'播放';
  $('music-play-disc').setAttribute('aria-label', playing ? '暂停音乐' : '播放音乐');
  $('music-menu-title').textContent = musicTracks[musicIndex]?.name || '拾光唱片';

}
async function playMusic(index) {
  if (!musicTracks.length) { notice('请点唱片旁的文字，打开歌单并添加歌曲'); return; }
  const next = (index + musicTracks.length) % musicTracks.length;
  if (next !== musicIndex || !musicAudio.src) {
    musicIndex = next;
    musicAudio.src = '/api/music/tracks/' + musicTracks[next].id + '/file';
  }
  await musicAudio.play(); renderMusic();
}
function togglePlayback() {
  if (!musicTracks.length) { notice('请点唱片旁的文字，打开歌单并添加歌曲'); return; }
  if (musicAudio.paused) return playMusic(musicIndex < 0 ? 0 : musicIndex).catch(error => notice(error.message));
  musicAudio.pause(); updateMusicState();
}
$('music-play-disc').onclick = guard(togglePlayback);
$('music-menu-button').onclick = () => {
  const opening = $('music-panel').hidden;
  $('music-panel').hidden = !opening;
  $('music-menu-button').setAttribute('aria-expanded', String(opening));
};
$('music-play').onclick = guard(togglePlayback);
$('music-close').onclick = () => { $('music-panel').hidden = true; $('music-menu-button').setAttribute('aria-expanded', 'false'); };
$('music-previous').onclick = guard(() => playMusic((musicIndex - 1 + musicTracks.length) % musicTracks.length));
$('music-next').onclick = guard(() => playMusic((musicIndex + 1) % musicTracks.length));
$('music-volume').oninput = () => { musicAudio.volume = Number($('music-volume').value); };
musicAudio.onplay = updateMusicState; musicAudio.onpause = updateMusicState;
musicAudio.onended = () => { if (musicTracks.length) playMusic((musicIndex + 1) % musicTracks.length).catch(error => notice(error.message)); };
musicAudio.onerror = () => { musicAudio.pause(); updateMusicState(); notice('这首歌曲无法播放，请检查文件格式'); };

async function uploadMusicFiles(files) {
  const audioFiles = [...files].filter(file => file.type.startsWith('audio/') || /\.(mp3|wav|ogg)$/i.test(file.name));
  if (!audioFiles.length) { notice('请拖入 MP3、WAV 或 OGG 音频'); return; }
  const input = $('music-upload'); if (input.disabled) return; input.disabled = true; let done = 0; const errors = [];
  try {
    for (const file of audioFiles) {
      if (file.size > 15 * 1024 * 1024) { errors.push(file.name + ' 超过 15 MiB'); continue; }
      const form = new FormData(); form.set('file', file);
      try { await api('/music/tracks', { method: 'POST', body: form }); done++; }
      catch (error) { errors.push(file.name + '：' + error.message); }
    }
    await loadMusic(); notice(`已加入 ${done} 首歌曲${errors.length ? '；' + errors.slice(0, 2).join('；') : ''}`);
  } finally { input.value = ''; input.disabled = false; }
}
$('music-upload').onchange = guard(() => uploadMusicFiles($('music-upload').files));
const musicDrop = $('music-drop');
musicDrop.onclick = () => $('music-upload').click();
musicDrop.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('music-upload').click(); } };
musicDrop.ondragover = event => { event.preventDefault(); musicDrop.classList.add('dragging'); };
musicDrop.ondragleave = () => musicDrop.classList.remove('dragging');
musicDrop.ondrop = guard(event => {
  event.preventDefault(); musicDrop.classList.remove('dragging');
  return uploadMusicFiles(event.dataTransfer.files);
});

function updateMusicProgress(){const valid=Number.isFinite(musicAudio.duration)&&musicAudio.duration>0;$('music-seek').disabled=!valid;$('music-seek').value=valid?String(musicAudio.currentTime/musicAudio.duration*1000):'0';}
musicAudio.addEventListener('timeupdate',updateMusicProgress);musicAudio.addEventListener('loadedmetadata',updateMusicProgress);musicAudio.addEventListener('emptied',updateMusicProgress);
$('music-seek').oninput=()=>{if(Number.isFinite(musicAudio.duration))musicAudio.currentTime=Number($('music-seek').value)/1000*musicAudio.duration;};
