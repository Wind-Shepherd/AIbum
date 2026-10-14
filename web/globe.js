/* Orthographic globe; vendored Natural Earth public-domain land, no map API key. */
let globeLand=null,globePhotos=[],globeLon=105,globeLat=25,globeZoom=1,globePointer=null,globePick=null,globeEditing=false,globeFrame=0;
const globeCanvas=$('globe-canvas'),gc=globeCanvas.getContext('2d'),rad=Math.PI/180;
function globeProject(lon,lat,height=1){const a=(lon-globeLon)*rad,b=lat*rad,c=globeLat*rad;const z=Math.sin(c)*Math.sin(b)+Math.cos(c)*Math.cos(b)*Math.cos(a);return{x:360+240*globeZoom*height*Math.cos(b)*Math.sin(a),y:280-240*globeZoom*height*(Math.cos(c)*Math.sin(b)-Math.sin(c)*Math.cos(b)*Math.cos(a)),z};}
let globeTexture=null,globeSurface=null,globeSurfaceKey='',globeSelected=new Map(),globePinTime=0;
// Inverse projection samples one continuous texture; polygons never close across the horizon.
function prepareGlobeTexture(){
 const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1024;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#ABC3B1';ctx.fillRect(0,0,2048,1024);ctx.fillStyle='#EAD8B8';
 for(const feature of globeLand.features){const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;for(const polygon of polygons){ctx.beginPath();for(const ring of polygon){ring.forEach(([lon,lat],index)=>{const x=(lon+180)/360*2048,y=(90-lat)/180*1024;index?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();}ctx.fill('evenodd');}}
 globeTexture=ctx.getImageData(0,0,2048,1024).data;
}
function globeBase(){
 const key=[globeLon,globeLat,globeZoom].join(':');if(key===globeSurfaceKey&&globeSurface)return;
 const width=540,height=420,scale=.75,radius=240*globeZoom*scale;
 if(!globeSurface){globeSurface=document.createElement('canvas');globeSurface.width=width;globeSurface.height=height;}
 const ctx=globeSurface.getContext('2d'),image=ctx.createImageData(width,height),pixels=image.data;
 const lat=globeLat*rad,lon=globeLon*rad,sl=Math.sin(lat),cl=Math.cos(lat),so=Math.sin(lon),co=Math.cos(lon);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const nx=(x-width/2+.5)/radius,ny=-(y-height/2+.5)/radius,r2=nx*nx+ny*ny;if(r2>=1)continue;
  const z=Math.sqrt(1-r2),wy=ny*cl+z*sl,front=z*cl-ny*sl,wx=front*co-nx*so,wz=front*so+nx*co;
  const u=((Math.atan2(wz,wx)/Math.PI+1)*1024|0)%2048,v=Math.max(0,Math.min(1023,(.5-Math.asin(Math.max(-1,Math.min(1,wy)))/Math.PI)*1024|0));
  const from=(v*2048+u)*4,to=(y*width+x)*4,light=.73+.24*z-.035*nx+.025*ny;
  for(let k=0;k<3;k++)pixels[to+k]=globeTexture[from+k]*light;
  pixels[to+3]=Math.min(255,(1-Math.sqrt(r2))*radius*255);
 }
 ctx.putImageData(image,0,0);globeSurfaceKey=key;
}
function pinKey(photo){return photo.latitude==null?'unlocated':photo.latitude.toFixed(5)+','+photo.longitude.toFixed(5);}
function drawGlobePin(point,selected,stamp,inserted=false){
 const gentle=document.body.dataset.motion==='gentle'||matchMedia('(prefers-reduced-motion: reduce)').matches;
 const progress=gentle?1:Math.min(1,(stamp-globePinTime)/650),drop=inserted?(1-progress)*(1-progress)*65:0;
 const pulse=gentle?0:Math.sin(stamp/240)*.5+.5;
 if(selected){gc.beginPath();gc.ellipse(point.x,point.y,11+pulse*5,4+pulse*2,0,0,Math.PI*2);gc.strokeStyle='#984F39';gc.globalAlpha=.45+.3*pulse;gc.lineWidth=2;gc.stroke();gc.globalAlpha=1;}
 gc.save();gc.translate(point.x,point.y-drop);if(inserted&&progress<1)gc.rotate(-.25*(1-progress));
 gc.beginPath();gc.moveTo(0,0);gc.bezierCurveTo(-3,-8,-12,-13,-12,-22);gc.arc(0,-22,12,Math.PI,0);gc.bezierCurveTo(12,-13,3,-8,0,0);gc.closePath();gc.fillStyle=selected?'#9D513B':'#C59161';gc.shadowColor='#3e2e2555';gc.shadowBlur=5;gc.shadowOffsetY=3;gc.fill();gc.shadowBlur=0;gc.shadowOffsetY=0;gc.strokeStyle='#FFF1D8';gc.lineWidth=1.8;gc.stroke();gc.beginPath();gc.arc(0,-22,4.3,0,Math.PI*2);gc.fillStyle='#FFF1D8';gc.fill();gc.restore();
}
function drawGlobe(stamp=performance.now()){
 gc.clearRect(0,0,720,560);if(!globeTexture)return;globeBase();gc.drawImage(globeSurface,0,0,720,560);
 const radius=240*globeZoom;gc.save();gc.beginPath();gc.arc(360,280,radius,0,Math.PI*2);gc.clip();
 gc.strokeStyle='#FFF5DD30';gc.lineWidth=.7;
 for(let lat=-60;lat<=60;lat+=30){gc.beginPath();let start=true;for(let lon=-180;lon<=180;lon+=3){const p=globeProject(lon,lat);if(p.z<0){start=true;continue;}if(start)gc.moveTo(p.x,p.y);else gc.lineTo(p.x,p.y);start=false;}gc.stroke();}
 for(let lon=-180;lon<180;lon+=30){gc.beginPath();let start=true;for(let lat=-90;lat<=90;lat+=3){const p=globeProject(lon,lat);if(p.z<0){start=true;continue;}if(start)gc.moveTo(p.x,p.y);else gc.lineTo(p.x,p.y);start=false;}gc.stroke();}gc.restore();
 const dated=globePhotos.filter(p=>p.latitude!=null&&p.longitude!=null&&p.taken_at&&['exif','manual'].includes(p.date_source)).sort((a,b)=>a.taken_at.localeCompare(b.taken_at));
 gc.strokeStyle='#bc8250';gc.lineWidth=1.4;gc.setLineDash([4,7]);gc.lineDashOffset=document.body.dataset.motion==='gentle'?0:-stamp/140;
 for(let i=1;i<dated.length;i++){const a=dated[i-1],b=dated[i];if(Math.abs(a.latitude-b.latitude)+Math.abs(a.longitude-b.longitude)<.01)continue;const av=toVector(a),bv=toVector(b),angle=Math.acos(Math.max(-1,Math.min(1,av.reduce((n,v,j)=>n+v*bv[j],0))));if(angle<.001||Math.abs(Math.sin(angle))<.001)continue;gc.beginPath();let started=false;for(let k=0;k<=50;k++){const t=k/50,u=Math.sin((1-t)*angle)/Math.sin(angle),v=Math.sin(t*angle)/Math.sin(angle),point=av.map((x,j)=>u*x+v*bv[j]);const p=globeProject(Math.atan2(point[1],point[0])/rad,Math.asin(Math.max(-1,Math.min(1,point[2])))/rad,1+.12*Math.sin(t*Math.PI));if(p.z<0){started=false;continue;}if(!started)gc.moveTo(p.x,p.y);else gc.lineTo(p.x,p.y);started=true;}gc.stroke();}gc.setLineDash([]);
 const pins=new Map();for(const photo of globePhotos.filter(p=>p.latitude!=null&&p.longitude!=null))pins.set(pinKey(photo),photo);
 for(const [key,photo]of pins){const point=globeProject(photo.longitude,photo.latitude);if(point.z<.025)continue;drawGlobePin(point,globeSelected.has(key),stamp);}
 if(globePick){const point=globeProject(globePick.longitude,globePick.latitude);if(point.z>0)drawGlobePin(point,true,stamp,true);}
 if($('globe-dialog').open)globeFrame=requestAnimationFrame(drawGlobe);
}
function toVector(p){return[Math.cos(p.latitude*rad)*Math.cos(p.longitude*rad),Math.cos(p.latitude*rad)*Math.sin(p.longitude*rad),Math.sin(p.latitude*rad)];}
async function openGlobe(edit=false){globeEditing=edit;globePick=null;globeSelected.clear();$('globe-confirm').hidden=edit;$('globe-selection').replaceChildren();$('globe-mark').hidden=!edit;$('globe-mark').disabled=true;$('globe-photos').replaceChildren();$('globe-search').value='';const photos=[];for(let page=1;;page++){const data=await api('/photos?page_size=100&page='+page);photos.push(...data.items);if(photos.length>=data.total)break;}globePhotos=photos;if(!globeLand){const response=await fetch('/static/world-land.json');if(!response.ok)throw new Error('地图素材加载失败');globeLand=await response.json();prepareGlobeTexture();}if(edit&&state.detail.latitude!=null){globeLon=state.detail.longitude;globeLat=state.detail.latitude;}$('globe-hint').textContent=edit?'点击地球选择坐标，再确认填入；照片保存后才生效。':'拖动旋转 · 点击定位针多选 · 确定后放入条件画布';renderGlobeList();renderGlobeSelection();$('globe-dialog').showModal();cancelAnimationFrame(globeFrame);drawGlobe();}
$('open-globe').onclick=guard(()=>openGlobe());$('detail-place').onclick=guard(()=>openGlobe(true));$('globe-dialog').addEventListener('close',()=>cancelAnimationFrame(globeFrame));
function showGlobePhotos(photos){const host=$('globe-photos');host.replaceChildren();for(const photo of photos){const b=document.createElement('button');const img=document.createElement('img');img.src=photo.thumbnail_url;img.alt=photo.name;b.append(img,document.createTextNode(photo.name));b.onclick=guard(async()=>{if(globeEditing){globePick={latitude:photo.latitude,longitude:photo.longitude};$('globe-mark').disabled=photo.latitude==null;}else{$('globe-dialog').close();await openDetail(photo.id);}});host.append(b);}}
function toggleGlobePlace(photo){
 const key=pinKey(photo);if(globeSelected.has(key))globeSelected.delete(key);else globeSelected.set(key,photo);
 globePinTime=performance.now();renderGlobeList();renderGlobeSelection();showGlobePhotos(globePhotos.filter(p=>pinKey(p)===key));
}
function renderGlobeSelection(){
 const host=$('globe-selection');host.replaceChildren();
 for(const [key,photo]of globeSelected){const b=document.createElement('button');b.className='selected-place';b.textContent=(photo.latitude==null?'尚未定位':photo.location||key)+' ×';b.onclick=()=>{globeSelected.delete(key);renderGlobeList();renderGlobeSelection();};host.append(b);}
 $('globe-confirm').disabled=!globeSelected.size;
}
function renderGlobeList(){
 const host=$('globe-list');host.replaceChildren();const groups=new Map();
 for(const p of globePhotos){const key=pinKey(p);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
 for(const [key,photos]of groups){const name=photos[0].latitude==null?'尚未定位':(photos[0].location||key);if(!name.toLowerCase().includes($('globe-search').value.toLowerCase()))continue;const b=document.createElement('button');b.textContent=(globeSelected.has(key)?'☑ ':'☐ ')+name+' · '+photos.length;b.setAttribute('aria-pressed',String(globeSelected.has(key)));b.onclick=()=>{if(photos[0].latitude!=null){globeLon=photos[0].longitude;globeLat=photos[0].latitude;}if(globeEditing)showGlobePhotos(photos);else toggleGlobePlace(photos[0]);};host.append(b);}
}
$('globe-confirm').onclick=()=>{const conditions=[...globeSelected.values()].map(p=>p.latitude==null?{field:'unlocated',value:true}:{field:'place',value:[p.latitude,p.longitude]});addPlaceConditions(conditions);$('globe-dialog').close();};
$('globe-search').oninput=renderGlobeList;
globeCanvas.onpointerdown=e=>{if(e.button!==0)return;globePointer={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};globeCanvas.setPointerCapture(e.pointerId);};globeCanvas.onpointermove=e=>{if(globePointer?.id!==e.pointerId)return;const dx=e.clientX-globePointer.x,dy=e.clientY-globePointer.y;if(Math.hypot(e.clientX-globePointer.startX,e.clientY-globePointer.startY)>4)globePointer.moved=true;globeLon=((globeLon-dx*.35+180)%360+360)%360-180;globeLat=Math.max(-85,Math.min(85,globeLat+dy*.35));globePointer.x=e.clientX;globePointer.y=e.clientY;};
globeCanvas.onpointerup=e=>{if(!globePointer||globePointer.moved){globePointer=null;return;}globePointer=null;const rect=globeCanvas.getBoundingClientRect(),x=(e.clientX-rect.left)*720/rect.width,y=(e.clientY-rect.top)*560/rect.height;if(!globeEditing){let closest=null,distance=20;for(const photo of globePhotos.filter(p=>p.latitude!=null)){const p=globeProject(photo.longitude,photo.latitude),d=Math.hypot(x-p.x,y-(p.y-18));if(p.z>0&&d<distance){closest=photo;distance=d;}}if(closest)toggleGlobePlace(closest);return;}const nx=(x-360)/(240*globeZoom),ny=-(y-280)/(240*globeZoom),rho=Math.hypot(nx,ny);if(rho>1)return;const c=Math.asin(rho),base=globeLat*rad;globePick={latitude:(rho<1e-8?base:Math.asin(Math.cos(c)*Math.sin(base)+ny*Math.sin(c)*Math.cos(base)/rho))/rad,longitude:globeLon+(rho<1e-8?0:Math.atan2(nx*Math.sin(c),rho*Math.cos(base)*Math.cos(c)-ny*Math.sin(base)*Math.sin(c))/rad)};globePick.longitude=((globePick.longitude+180)%360+360)%360-180;globePinTime=performance.now();$('globe-mark').disabled=false;$('globe-hint').textContent=`已选 ${globePick.latitude.toFixed(4)}, ${globePick.longitude.toFixed(4)}`;};globeCanvas.onpointercancel=()=>globePointer=null;
globeCanvas.addEventListener('wheel',e=>{e.preventDefault();globeZoom=Math.max(.65,Math.min(1.65,globeZoom*Math.exp(-e.deltaY*.001)));},{passive:false});
$('globe-mark').onclick=()=>{if(!globePick)return;$('detail-latitude').value=globePick.latitude.toFixed(5);$('detail-longitude').value=globePick.longitude.toFixed(5);$('globe-dialog').close();};
