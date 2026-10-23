/* Dive Current v0.9.8 — RunTime map engine reliability update */
'use strict';

const BUILD='0.9.8';
const FT_PER_M=3.280839895;
const KTS_PER_MPS=1.943844492;
const STORE='dive-current-state-v097';
const OLD_STORE='dive-current-state-v096';

// Local development uses same-origin /api. A GitHub Pages frontend can later
// point at an independently deployed HTTPS Python backend (CORS required there)
// by defining window.DIVE_CURRENT_API_BASE before this script is loaded.
const API_BASE=(typeof window.DIVE_CURRENT_API_BASE==='string'
  ?window.DIVE_CURRENT_API_BASE.trim().replace(/\/$/,''):'');
const apiPath=path=>`${API_BASE}${path}`;
const DNR_DEPTH=apiPath('/api/dnr/depth');
const DNR_BATHY=apiPath('/api/dnr/bathy');
const DNR_CONTOURS=apiPath('/api/dnr/contours');
const NOAA_DATA=apiPath('/api/noaa/data');
const NOAA_META=apiPath('/api/noaa/stations');
const SSCOFS_INFO=apiPath('/api/sscofs/info');
const SSCOFS_GRID=apiPath('/api/sscofs/grid');
const SSCOFS_POINT=apiPath('/api/sscofs/point');

const map=L.map('map',{zoomControl:true,preferCanvas:true,zoomAnimation:true,fadeAnimation:true}).setView([47.285,-122.53],13);
// Keep a continuously visible basemap. Raster overlays must never replace it.
// This matches the working RunTime DPV approach: independent image and map layers.
const baseLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
  maxZoom:19,attribution:'© OpenStreetMap contributors',updateWhenIdle:true,
  keepBuffer:4,detectRetina:false,pane:'tilePane'
}).addTo(map);
baseLayer.on('tileerror',()=>{
  if(!baseLayer._warned){baseLayer._warned=true;console.warn('An OpenStreetMap basemap tile did not load.');}
});
map.getContainer().style.backgroundColor='#b2d8e4';
const runTimeMapCSS=document.createElement('style');
runTimeMapCSS.textContent=`
  .leaflet-container{background:#b2d8e4}
  .rt-ocean-fallback img{filter:grayscale(1) contrast(1.15) brightness(1.04)}
  .rt-lake-bathy img{image-rendering:auto}
`;
document.head.appendChild(runTimeMapCSS);

// Never let contours or relief block clicks on the map or drawn routes.
map.createPane('oceanRelief');map.getPane('oceanRelief').style.zIndex=245;
map.createPane('bathy');      map.getPane('bathy').style.zIndex=260;
map.createPane('lakeBathy');  map.getPane('lakeBathy').style.zIndex=275;
map.createPane('contours');   map.getPane('contours').style.zIndex=290;
for(const p of ['oceanRelief','bathy','lakeBathy','contours']){
  map.getPane(p).style.pointerEvents='none';
}

// Independent optional fallback for Puget Sound. Unlike the old app, failed
// DNR requests will leave both the base map and route markers visible.
const oceanRelief=L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
  {maxNativeZoom:16,maxZoom:19,opacity:.80,pane:'oceanRelief',
    attribution:'Ocean relief © Esri / GEBCO / NOAA',className:'rt-ocean-fallback'});
let oceanWarningShown=false;
oceanRelief.on('tileerror',()=>{
  if(!oceanWarningShown){oceanWarningShown=true;console.warn('Regional ocean-relief fallback tiles unavailable.');}
});

// Same public-domain TMS bathymetry tiles used by the working DPV Planner.
// Leaflet tms:true is essential: Archie’s archive uses flipped Y coordinates.
const LAKE_WASHINGTON_BOUNDS=L.latLngBounds([[47.501782126,-122.395111],[47.751406,-122.194449057]]);
const lakeBathymetry=L.tileLayer(
  'https://archisgore.github.io/lake-washington-bathymetry/tiles/{z}/{x}/{y}.png',
  {tms:true,minZoom:0,maxNativeZoom:19,maxZoom:20,opacity:.94,
    bounds:LAKE_WASHINGTON_BOUNDS,pane:'lakeBathy',className:'rt-lake-bathy',
    attribution:'Lake Washington bathymetry © survey contributors (CC0)'});
lakeBathymetry.on('tileerror',()=>{
  if(!lakeBathymetry._warned){lakeBathymetry._warned=true;console.warn('Lake Washington bathymetry tile unavailable or outside survey coverage.');}
});

let mapStyle='bathy'; // bathy | standard
let currentsVisible=true;
let bathyOverlay=null;
let bathyPending=null;
let contourLayer=L.layerGroup().addTo(map);
let contourAbort=null;
let surfaceGeneration=0;
let dnrOverlayOk=false;
let dnrFallbackTimer=null;

function isLakeWashingtonView(){return LAKE_WASHINGTON_BOUNDS.contains(map.getCenter());}
function showOceanFallback(){
  if(mapStyle!=='bathy'||isLakeWashingtonView())return;
  if(!map.hasLayer(oceanRelief))oceanRelief.addTo(map);
}
function hideOceanFallback(){if(map.hasLayer(oceanRelief))map.removeLayer(oceanRelief);}
function syncLakeBathymetry(){
  const enabled=mapStyle==='bathy'&&isLakeWashingtonView();
  if(enabled&&!map.hasLayer(lakeBathymetry))lakeBathymetry.addTo(map);
  if(!enabled&&map.hasLayer(lakeBathymetry))map.removeLayer(lakeBathymetry);
  return enabled;
}
// Existing map element can change size when panels or orientation change.
if(typeof ResizeObserver!=='undefined'){
  let layoutFrame=0;
  const obs=new ResizeObserver(()=>{
    cancelAnimationFrame(layoutFrame);
    layoutFrame=requestAnimationFrame(()=>map.invalidateSize({pan:false,animate:false}));
  });
  obs.observe(map.getContainer());
}

function showMapMessage(msg,ms=3200){
  const el=document.getElementById('mapMessage');
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(showMapMessage._t);
  showMapMessage._t=setTimeout(()=>el.classList.add('hidden'),ms);
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function fmtTime(d){return new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(d)}
function roundHour(d){const x=new Date(d);x.setMinutes(0,0,0);if(d.getMinutes()>=30)x.setHours(x.getHours()+1);return x}
function pad3(n){return String(Math.round(n)).padStart(3,'0')}
function fmtDist(ft){return ft>=5280?`${(ft/5280).toFixed(2)} mi`:`${Math.round(ft)} ft`}
function debounce(fn,delay){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),delay)}}

let mode='pan';
const modeButtons=[...document.querySelectorAll('[data-mode]')];
modeButtons.forEach(b=>b.addEventListener('click',()=>{
  mode=b.dataset.mode;
  modeButtons.forEach(x=>x.classList.toggle('active',x===b));
  map.getContainer().style.cursor=mode==='pan'?'grab':'crosshair';
}));

function viewportParams(){
  const b=map.getBounds(),s=map.getSize();
  const dpr=Math.max(1,Math.min(2.5,window.devicePixelRatio||1));
  const width=Math.max(700,Math.min(3600,Math.round(s.x*dpr)));
  const height=Math.max(500,Math.min(2600,Math.round(s.y*dpr)));
  return {
    bounds:[[b.getSouth(),b.getWest()],[b.getNorth(),b.getEast()]],
    west:b.getWest(),south:b.getSouth(),east:b.getEast(),north:b.getNorth(),
    width,height,zoom:map.getZoom(),dpr
  };
}
function imageUrl(base,v,extra={}){
  const q=new URLSearchParams({
    west:String(v.west),south:String(v.south),east:String(v.east),north:String(v.north),
    width:String(v.width),height:String(v.height),...extra
  });
  return `${base}?${q}`;
}
function clearBathyOverlay(){
  if(bathyPending&&map.hasLayer(bathyPending))map.removeLayer(bathyPending);
  bathyPending=null;
  if(bathyOverlay&&map.hasLayer(bathyOverlay))map.removeLayer(bathyOverlay);
  bathyOverlay=null;
}
function replaceBathyOverlay(url,bounds,{opacity=1,onError}={}){
  const generation=surfaceGeneration;
  if(bathyPending&&map.hasLayer(bathyPending))map.removeLayer(bathyPending);
  bathyPending=null;
  const pending=L.imageOverlay(url,bounds,{pane:'bathy',opacity:0,interactive:false}).addTo(map);
  bathyPending=pending;
  pending.once('load',()=>{
    if(generation!==surfaceGeneration){if(map.hasLayer(pending))map.removeLayer(pending);return}
    if(bathyOverlay&&map.hasLayer(bathyOverlay))map.removeLayer(bathyOverlay);
    pending.setOpacity(opacity);
    bathyOverlay=pending;bathyPending=null;
    dnrOverlayOk=true;
    clearTimeout(dnrFallbackTimer);
    hideOceanFallback();
  });
  pending.once('error',()=>{
    if(map.hasLayer(pending))map.removeLayer(pending);
    if(bathyPending===pending)bathyPending=null;
    if(generation===surfaceGeneration)onError?.();
  });
}
function setMapStyle(style){
  // Invalidate pending bitmap loads so switching to Streets cannot revive an
  // old bathymetry image after it completes.
  surfaceGeneration++;
  mapStyle=style;
  document.getElementById('bathyMode').classList.toggle('active',style==='bathy');
  document.getElementById('standardMode').classList.toggle('active',style==='standard');
  if(!map.hasLayer(baseLayer))baseLayer.addTo(map);
  baseLayer.setOpacity(1); // Crucial: never make the basemap mostly transparent.
  clearTimeout(dnrFallbackTimer);
  if(style==='bathy'){
    refreshBathymetry();
    refreshContours();
  }else{
    if(contourAbort){contourAbort.abort();contourAbort=null}
    clearBathyOverlay();
    hideOceanFallback();
    syncLakeBathymetry();
    contourLayer.clearLayers();
  }
}
document.getElementById('bathyMode').addEventListener('click',()=>setMapStyle('bathy'));
document.getElementById('standardMode').addEventListener('click',()=>setMapStyle('standard'));

async function refreshBathymetry(){
  if(mapStyle!=='bathy'){
    clearBathyOverlay();hideOceanFallback();syncLakeBathymetry();return;
  }
  if(syncLakeBathymetry()){
    clearBathyOverlay();hideOceanFallback();return;
  }
  const v=viewportParams();
  if(v.zoom<10){clearBathyOverlay();hideOceanFallback();return;}
  dnrOverlayOk=false;
  replaceBathyOverlay(imageUrl(DNR_BATHY,v,{zoom:String(v.zoom)}),v.bounds,{
    opacity:v.zoom>=15?.93:v.zoom>=13?.88:.80,
    onError:()=>{
      showOceanFallback();
      showMapMessage('Local DNR relief unavailable; displaying regional ocean relief.',3000);
    }
  });
  // A server that never responds should not leave users with an empty bathy view.
  clearTimeout(dnrFallbackTimer);
  const generation=surfaceGeneration;
  dnrFallbackTimer=setTimeout(()=>{
    if(mapStyle==='bathy'&&generation===surfaceGeneration&&!dnrOverlayOk)showOceanFallback();
  },5000);
}

async function refreshContours(){
  contourLayer.clearLayers();
  if(contourAbort){contourAbort.abort();contourAbort=null}
  if(mapStyle!=='bathy'||isLakeWashingtonView())return;

  const v=viewportParams();
  if(v.zoom<12)return;

  const layer=v.zoom>=13?4:3; // 20 ft at dive-planning zoom, 100 ft farther out
  contourAbort=new AbortController();
  const generation=surfaceGeneration;
  const q=new URLSearchParams({
    layer:String(layer),
    west:String(v.west),south:String(v.south),east:String(v.east),north:String(v.north),
    zoom:String(v.zoom)
  });
  try{
    const r=await fetch(`${DNR_CONTOURS}?${q}`,{signal:contourAbort.signal,cache:'no-store'});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||String(r.status));
    if(mapStyle!=='bathy'||generation!==surfaceGeneration)return;

    const labelDepths=new Set();
    L.geoJSON(data,{
      pane:'contours',
      interactive:false,
      style:f=>{
        const raw=Number(f.properties?.CONTOUR);
        const depth=Math.abs(raw);
        const major=depth%100===0;
        return {
          color:major?'#eeeeee':'#a7a7a7',
          weight:major?1.10:.62,
          opacity:major?.94:.76,
          dashArray:null
        };
      },
      onEachFeature:(f,layerObj)=>{
        const depth=Math.abs(Number(f.properties?.CONTOUR));
        if(depth>0 && depth%100===0 && !labelDepths.has(depth)){
          labelDepths.add(depth);
          layerObj.bindTooltip(`${Math.round(depth)} ft`,{
            permanent:true,direction:'center',className:'contour-depth-label',opacity:.92
          });
        }
      }
    }).addTo(contourLayer);
  }catch(e){
    if(e.name==='AbortError')return;
    console.error(e);
    showMapMessage('DNR contour geometry could not load.',2200);
  }
}

const refreshMapSurfaces=debounce(()=>{
  surfaceGeneration++;
  if(mapStyle==='bathy'){
    refreshBathymetry();
    refreshContours();
  }
  if(currentsVisible&&currentModel)loadCurrentField();
},420);

map.on('moveend zoomend',refreshMapSurfaces);

// ---------- Route planner ----------
const route={points:[],markers:[],line:null,labels:[]};
const depthPins=[];
function distFt(a,b){return a.distanceTo(b)*FT_PER_M}
function bearing(a,b){
  const p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,d=(b.lng-a.lng)*Math.PI/180;
  const y=Math.sin(d)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(d);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
function midpoint(a,b){return L.latLng((a.lat+b.lat)/2,(a.lng+b.lng)/2)}
function clearRouteVisuals(){
  route.markers.forEach(m=>map.removeLayer(m));
  route.labels.forEach(l=>map.removeLayer(l));
  if(route.line)map.removeLayer(route.line);
  route.markers=[];route.labels=[];route.line=null;
}
function redrawRoute(){
  clearRouteVisuals();
  if(!route.points.length){renderRouteInfo();return}
  route.markers=route.points.map((p,i)=>{
    const m=L.marker(p,{draggable:true,title:`Route point ${i+1}`}).addTo(map);
    // 'drag' previously replaced the dragged marker on every frame, breaking
    // normal drag behavior. Recompute after the pointer is released.
    m.on('dragend',e=>{route.points[i]=e.target.getLatLng();redrawRoute();saveState()});
    return m;
  });
  if(route.points.length>1){
    route.line=L.polyline(route.points,{color:'#ffcf55',weight:3,opacity:.96}).addTo(map);
    for(let i=1;i<route.points.length;i++){
      const a=route.points[i-1],b=route.points[i],ft=distFt(a,b),brg=bearing(a,b);
      const icon=L.divIcon({className:'',html:`<div class="route-label">${Math.round(ft)} ft · ${pad3(brg)}°T</div>`,iconSize:null});
      route.labels.push(L.marker(midpoint(a,b),{icon,interactive:false}).addTo(map));
    }
  }
  renderRouteInfo();
}
function renderRouteInfo(){
  let total=0,html='';
  const kts=parseFloat(document.getElementById('dpvSpeed').value||'');
  const fpm=kts>0?kts*6076.11549/60:0;
  for(let i=1;i<route.points.length;i++){
    const ft=distFt(route.points[i-1],route.points[i]);
    total+=ft;
    const brg=bearing(route.points[i-1],route.points[i]);
    const minutes=fpm>0?ft/fpm:null;
    html+=`<div class="leg-row"><span>${i}</span><strong>${Math.round(ft)} ft · ${pad3(brg)}°T</strong><span>${minutes===null?'Leg '+i:minutes.toFixed(1)+' min'}</span></div>`;
  }
  document.getElementById('routeTotal').textContent=fmtDist(total);
  document.getElementById('legs').innerHTML=html||'Tap Measure route, then add route points.';
  document.getElementById('travelTime').textContent=(fpm>0&&total>0)?`${(total/fpm).toFixed(1)} min`:'—';
}
document.getElementById('dpvSpeed').addEventListener('input',()=>{renderRouteInfo();saveState()});
document.getElementById('undoLeg').addEventListener('click',()=>{
  if(route.points.length){route.points.pop();redrawRoute();saveState()}
});
document.getElementById('clearRoute').addEventListener('click',()=>{
  route.points=[];redrawRoute();saveState()
});

// ---------- DNR depth markers ----------
function numericDepthFromIdentify(data){
  const candidates=[
    data?.value,
    data?.properties?.Value,
    data?.properties?.value,
    data?.properties?.Values,
    data?.catalogItems?.features?.[0]?.attributes?.PixelValue
  ];
  for(const c of candidates){
    if(Array.isArray(c)){
      for(const x of c){const n=Number(x);if(Number.isFinite(n))return n}
    }else{
      const n=Number(c);if(Number.isFinite(n))return n;
      if(typeof c==='string'){
        const m=c.match(/-?\d+(?:\.\d+)?/);if(m)return Number(m[0]);
      }
    }
  }
  return NaN;
}
async function queryDnrDepth(latlng){
  const q=new URLSearchParams({lat:String(latlng.lat),lng:String(latlng.lng)});
  const r=await fetch(`${DNR_DEPTH}?${q}`);
  if(!r.ok){
    const msg=await r.text().catch(()=>String(r.status));
    throw new Error(`DNR depth ${r.status}: ${msg.slice(0,160)}`);
  }
  const data=await r.json();
  if(!Number.isFinite(Number(data.depth_ft)))throw new Error(data.error||'No raster value');
  return Number(data.depth_ft);
}
async function addDepthPin(latlng){
  showMapMessage('Reading WA DNR depth…',10000);
  try{
    const depth=await queryDnrDepth(latlng);
    const pin={id:(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():String(Date.now()+Math.random())),lat:latlng.lat,lng:latlng.lng,depth,source:'DNR CoNED MLLW'};
    depthPins.push(pin);drawDepthPins();saveState();
    showMapMessage(`Depth marker: ${Math.round(depth)} ft MLLW`,1800);
  }catch(e){
    console.error(e);
    showMapMessage('No DNR MLLW depth was returned at that point.',3000);
  }
}
function drawDepthPins(){
  depthPins.forEach(p=>p.marker&&map.removeLayer(p.marker));
  depthPins.forEach(p=>{
    const icon=L.divIcon({className:'',html:`<div class="depth-label">${Math.round(p.depth)} ft ×</div>`,iconSize:null});
    const m=L.marker([p.lat,p.lng],{icon}).addTo(map);
    m.on('click',()=>{
      const idx=depthPins.findIndex(x=>x.id===p.id);
      if(idx>=0){map.removeLayer(m);depthPins.splice(idx,1);drawDepthPins();saveState()}
    });
    p.marker=m;
  });
  const el=document.getElementById('depthList');
  el.innerHTML=depthPins.length?depthPins.map(p=>`<div class="depth-row"><div><strong>${Math.round(p.depth)} ft</strong><small>${escapeHtml(p.source||'saved marker')}</small></div><button class="delete" data-id="${p.id}">Delete</button></div>`).join(''):'No depth markers.';
  el.querySelectorAll?.('[data-id]').forEach(b=>b.addEventListener('click',()=>{
    const i=depthPins.findIndex(p=>p.id===b.dataset.id);
    if(i>=0){if(depthPins[i].marker)map.removeLayer(depthPins[i].marker);depthPins.splice(i,1);drawDepthPins();saveState()}
  }));
}
map.on('click',e=>{
  if(mode==='route'){route.points.push(e.latlng);redrawRoute();saveState()}
  else if(mode==='depth')addDepthPin(e.latlng);
  else if(mode==='pan'&&currentsVisible&&currentModel)readCurrentAt(e.latlng,'Selected point');
});

// ---------- NOAA tides ----------
let tideData=[];
let tideEvents=[];
let tideStationId='9446484';
let tideStationName='Tacoma, Commencement Bay, Sitcum Waterway';

function apiDate(d){
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}
function parseNoaaLocal(s){return new Date(s.replace(' ','T'))}
async function loadStations(){
  const select=document.getElementById('tideStation');
  try{
    const r=await fetch(`${NOAA_META}`);
    if(!r.ok)throw new Error(String(r.status));
    const d=await r.json();
    const wa=(d.stations||[]).filter(s=>{
      const lat=Number(s.lat),lng=Number(s.lng);
      return lat>=46.0&&lat<=49.1&&lng>=-124.9&&lng<=-121.8;
    }).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    if(wa.length){
      const saved=loadRawState().tideStation||'9446484';
      select.innerHTML=wa.map(s=>`<option value="${escapeHtml(s.id)}"${String(s.id)===String(saved)?' selected':''}>${escapeHtml(s.name)}</option>`).join('');
      tideStationId=select.value;
      tideStationName=select.options[select.selectedIndex]?.text||tideStationName;
    }
  }catch(e){console.warn('NOAA station metadata unavailable; using Tacoma fallback',e)}
}
async function loadTides(){
  const graph=document.getElementById('tideGraph');
  graph.innerHTML='<div class="loading">Loading NOAA tide predictions…</div>';
  const start=new Date();start.setHours(0,0,0,0);
  const end=new Date(start);end.setDate(end.getDate()+2);
  const common={
    application:'DiveCurrent',
    begin_date:apiDate(start),end_date:apiDate(end),
    datum:'MLLW',station:tideStationId,time_zone:'lst_ldt',units:'english',format:'json'
  };
  const q1=new URLSearchParams({...common,product:'predictions',interval:'6'});
  const q2=new URLSearchParams({...common,product:'predictions',interval:'hilo'});
  try{
    const [a,b]=await Promise.all([fetch(`${NOAA_DATA}?${q1}`),fetch(`${NOAA_DATA}?${q2}`)]);
    if(!a.ok||!b.ok)throw new Error(`NOAA ${a.status}/${b.status}`);
    const da=await a.json(),db=await b.json();
    if(da.error||db.error)throw new Error(da.error?.message||db.error?.message||'NOAA error');
    tideData=(da.predictions||[]).map(p=>({time:parseNoaaLocal(p.t),value:Number(p.v)})).filter(p=>Number.isFinite(p.value));
    tideEvents=(db.predictions||[]).map(p=>({time:parseNoaaLocal(p.t),value:Number(p.v),type:p.type}));
    renderTideGraph();renderTideEvents();
  }catch(e){
    console.error(e);graph.innerHTML='<div class="loading">NOAA tide data unavailable.</div>';
  }
}
function currentTideSample(){
  if(!tideData.length)return null;
  return tideData.reduce((best,p)=>Math.abs(p.time-currentTime)<Math.abs(best.time-currentTime)?p:best,tideData[0]);
}
function renderTideGraph(){
  const el=document.getElementById('tideGraph');
  if(tideData.length<2){el.innerHTML='<div class="loading">No tide predictions.</div>';return}
  const w=340,h=168,pad={l:33,r:10,t:10,b:22};
  const minT=tideData[0].time.getTime(),maxT=tideData.at(-1).time.getTime();
  let minV=Math.min(...tideData.map(d=>d.value)),maxV=Math.max(...tideData.map(d=>d.value));
  const vr=Math.max(1,maxV-minV);minV-=vr*.08;maxV+=vr*.08;
  const x=t=>pad.l+(t-minT)/(maxT-minT)*(w-pad.l-pad.r);
  const y=v=>pad.t+(maxV-v)/(maxV-minV)*(h-pad.t-pad.b);
  const pts=tideData.map(d=>`${x(d.time.getTime()).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const area=`${x(minT)},${h-pad.b} ${pts} ${x(maxT)},${h-pad.b}`;
  const cursorX=Math.max(pad.l,Math.min(w-pad.r,x(currentTime.getTime())));
  const sample=currentTideSample();
  const cursorY=sample?y(sample.value):h/2;
  const grid=[0,.25,.5,.75,1].map(q=>{
    const yy=pad.t+q*(h-pad.t-pad.b);
    const vv=maxV-q*(maxV-minV);
    return `<line class="tide-grid" x1="${pad.l}" y1="${yy}" x2="${w-pad.r}" y2="${yy}"/><text class="tide-axis" x="3" y="${yy+3}">${vv.toFixed(1)}</text>`;
  }).join('');
  const labels=[0,.5,1].map(q=>{
    const tt=new Date(minT+q*(maxT-minT));
    return `<text class="tide-axis" x="${x(tt.getTime())}" y="${h-6}" text-anchor="${q===0?'start':q===1?'end':'middle'}">${tt.toLocaleString(undefined,{weekday:'short',hour:'numeric'})}</text>`;
  }).join('');
  el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="NOAA tide graph">
    ${grid}<polygon class="tide-fill" points="${area}"/><polyline class="tide-line" points="${pts}"/>
    <line class="tide-cursor" x1="${cursorX}" y1="${pad.t}" x2="${cursorX}" y2="${h-pad.b}"/>
    ${sample?`<circle class="tide-dot" cx="${cursorX}" cy="${cursorY}" r="4"/>`:''}${labels}
  </svg>`;
  document.getElementById('tideSummary').innerHTML=sample
    ?`<span>${escapeHtml(tideStationName)}</span><strong>${sample.value.toFixed(1)} ft</strong>`:'';
}
function renderTideEvents(){
  const now=Date.now();
  const list=tideEvents.filter(e=>e.time.getTime()>now-6*3600e3).slice(0,6);
  document.getElementById('tideEvents').innerHTML=list.map(e=>
    `<div class="tide-event"><span>${e.type==='H'?'High':'Low'} · ${e.time.toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit'})}</span><strong>${e.value.toFixed(1)} ft</strong></div>`
  ).join('');
}
document.getElementById('tideStation').addEventListener('change',e=>{
  tideStationId=e.target.value;tideStationName=e.target.options[e.target.selectedIndex]?.text||tideStationId;
  saveState();loadTides();
});

// ---------- NOAA SSCOFS animated surface flow ----------
let currentTime=roundHour(new Date());
let currentModel=null;
let playTimer=null;
let currentField=null;
let currentFieldAbort=null;
let currentAnimationFrame=null;
let currentParticles=[];
let currentBuckets=new Map();
let currentBounds=null;

const flowCanvas=document.createElement('canvas');
flowCanvas.className='current-flow-canvas';
map.getContainer().appendChild(flowCanvas);
const flowCtx=flowCanvas.getContext('2d');

function resizeFlowCanvas(){
  const size=map.getSize(),dpr=Math.min(2,window.devicePixelRatio||1);
  flowCanvas.width=Math.round(size.x*dpr);flowCanvas.height=Math.round(size.y*dpr);
  flowCanvas.style.width=`${size.x}px`;flowCanvas.style.height=`${size.y}px`;
  flowCtx.setTransform(dpr,0,0,dpr,0,0);
}
function clearFlowCanvas(){
  const size=map.getSize();flowCtx.clearRect(0,0,size.x,size.y);
}
function stopFlowAnimation(){
  if(currentAnimationFrame)cancelAnimationFrame(currentAnimationFrame);
  currentAnimationFrame=null;clearFlowCanvas();
}
function speedColor(kn){
  if(kn<.5)return 'rgba(75,185,255,.82)';
  if(kn<1.0)return 'rgba(92,218,216,.84)';
  if(kn<2.0)return 'rgba(218,226,102,.86)';
  if(kn<3.0)return 'rgba(255,157,72,.88)';
  return 'rgba(255,94,94,.90)';
}
function bucketKey(lat,lng){
  const cell=.025;
  return `${Math.floor(lat/cell)},${Math.floor(lng/cell)}`;
}
function buildCurrentBuckets(points){
  currentBuckets=new Map();
  for(const p of points){
    const key=bucketKey(p.lat,p.lng);
    if(!currentBuckets.has(key))currentBuckets.set(key,[]);
    currentBuckets.get(key).push(p);
  }
}
function vectorAt(lat,lng){
  if(!currentField?.points?.length)return null;
  const cell=.025,iy=Math.floor(lat/cell),ix=Math.floor(lng/cell);
  const candidates=[];
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const arr=currentBuckets.get(`${iy+dy},${ix+dx}`);
    if(arr)candidates.push(...arr);
  }
  if(!candidates.length)return null;
  let best=[];
  for(const p of candidates){
    const d2=(p.lat-lat)**2+((p.lng-lng)*Math.cos(lat*Math.PI/180))**2;
    if(d2>.012)continue;
    best.push({p,d2});
  }
  best=best.filter(Boolean).sort((a,b)=>a.d2-b.d2).slice(0,4);
  if(!best.length)return null;
  let sw=0,u=0,v=0;
  for(const x of best){const w=1/Math.max(1e-8,x.d2);sw+=w;u+=x.p.u*w;v+=x.p.v*w}
  if(!sw)return null;
  u/=sw;v/=sw;
  if(!Number.isFinite(u)||!Number.isFinite(v)||Math.abs(u)>10||Math.abs(v)>10)return null;
  return {u,v,speedKn:Math.hypot(u,v)*KTS_PER_MPS,direction:(Math.atan2(u,v)*180/Math.PI+360)%360};
}
function randomParticle(){
  if(!currentBounds)return null;
  for(let tries=0;tries<30;tries++){
    const lat=currentBounds.south+Math.random()*(currentBounds.north-currentBounds.south);
    const lng=currentBounds.west+Math.random()*(currentBounds.east-currentBounds.west);
    if(vectorAt(lat,lng))return {lat,lng,age:Math.random()*80,maxAge:90+Math.random()*100};
  }
  return null;
}
function resetParticles(){
  const count=Math.max(90,Math.min(260,Math.round(map.getSize().x*map.getSize().y/4500)));
  currentParticles=[];
  for(let i=0;i<count;i++){const p=randomParticle();if(p)currentParticles.push(p)}
}
function animateCurrents(){
  stopFlowAnimation();
  if(!currentsVisible||!currentField?.points?.length)return;
  resizeFlowCanvas();resetParticles();
  let last=performance.now();
  function frame(now){
    if(!currentsVisible||!currentField){stopFlowAnimation();return}
    const dt=Math.min(.06,Math.max(.012,(now-last)/1000));last=now;
    const size=map.getSize();
    flowCtx.globalCompositeOperation='destination-in';
    flowCtx.fillStyle='rgba(0,0,0,.91)';flowCtx.fillRect(0,0,size.x,size.y);
    flowCtx.globalCompositeOperation='source-over';
    const visualSeconds=55;
    for(let i=0;i<currentParticles.length;i++){
      let p=currentParticles[i];
      if(!p||p.age++>p.maxAge){currentParticles[i]=randomParticle();continue}
      const vec=vectorAt(p.lat,p.lng);
      if(!vec){currentParticles[i]=randomParticle();continue}
      const old=L.latLng(p.lat,p.lng);const a=map.latLngToContainerPoint(old);
      const dy=(vec.v*dt*visualSeconds)/111320;
      const dx=(vec.u*dt*visualSeconds)/(111320*Math.max(.2,Math.cos(p.lat*Math.PI/180)));
      p.lat+=dy;p.lng+=dx;
      const b=map.latLngToContainerPoint([p.lat,p.lng]);
      if(b.x<-20||b.y<-20||b.x>size.x+20||b.y>size.y+20){currentParticles[i]=randomParticle();continue}
      flowCtx.beginPath();flowCtx.moveTo(a.x,a.y);flowCtx.lineTo(b.x,b.y);
      flowCtx.strokeStyle=speedColor(vec.speedKn);flowCtx.globalAlpha=.86;
      flowCtx.lineWidth=vec.speedKn>2?1.45:1.05;flowCtx.stroke();
    }
    flowCtx.globalAlpha=1;
    currentAnimationFrame=requestAnimationFrame(frame);
  }
  currentAnimationFrame=requestAnimationFrame(frame);
}
async function loadCurrentModel(){
  const status=document.getElementById('currentStatus');
  document.getElementById('currentTimeLabel').textContent=fmtTime(currentTime);
  try{
    const r=await fetch(`${SSCOFS_INFO}?time=${encodeURIComponent(currentTime.toISOString())}`,{cache:'no-store'});
    const d=await r.json();if(!r.ok||!d.available)throw new Error(d.error||`SSCOFS ${r.status}`);
    currentModel=d;
    status.textContent=`SSCOFS · ${d.cycle_label||''} · model valid ${fmtTime(new Date(d.valid_time))}`;
    document.getElementById('currentSourceBadge').textContent='SSCOFS';
    await loadCurrentField();
  }catch(e){
    console.error(e);currentModel=null;currentField=null;stopFlowAnimation();
    document.getElementById('currentSpeed').textContent='Unavailable';
    document.getElementById('currentDirection').textContent='';
    status.textContent=`SSCOFS unavailable: ${e.message}`;
  }
}
async function loadCurrentField(){
  if(!currentsVisible||!currentModel){stopFlowAnimation();return}
  if(currentFieldAbort)currentFieldAbort.abort();
  currentFieldAbort=new AbortController();
  const b=map.getBounds().pad(.25);
  const q=new URLSearchParams({
    time:currentTime.toISOString(),west:String(b.getWest()),south:String(b.getSouth()),
    east:String(b.getEast()),north:String(b.getNorth()),rows:map.getZoom()>=15?'16':map.getZoom()>=13?'14':'10'
  });
  const status=document.getElementById('currentStatus');
  status.textContent='Loading SSCOFS surface flow…';
  try{
    const r=await fetch(`${SSCOFS_GRID}?${q}`,{signal:currentFieldAbort.signal,cache:'no-store'});
    const d=await r.json();if(!r.ok)throw new Error(d.error||String(r.status));
    currentField={...d,points:(d.points||[]).map(p=>({lat:p[0],lng:p[1],u:p[2],v:p[3]}))};
    currentBounds={west:b.getWest(),south:b.getSouth(),east:b.getEast(),north:b.getNorth()};
    buildCurrentBuckets(currentField.points);
    status.textContent=`SSCOFS animated surface flow · ${currentField.points.length.toLocaleString()} vectors · valid ${fmtTime(new Date(d.valid_time))}`;
    animateCurrents();readCurrentAt(map.getCenter(),'Map center');
  }catch(e){
    if(e.name==='AbortError')return;
    console.error(e);currentField=null;stopFlowAnimation();
    status.textContent=`SSCOFS flow field unavailable: ${e.message}`;
  }
}
function refreshCurrentMap(){loadCurrentField()}
async function readCurrentAt(latlng,label='Selected point'){
  const speedEl=document.getElementById('currentSpeed'),dirEl=document.getElementById('currentDirection');
  document.getElementById('currentLocationLabel').textContent=label;
  const vec=vectorAt(latlng.lat,latlng.lng);
  if(vec){speedEl.textContent=`${vec.speedKn.toFixed(2)} kn`;dirEl.textContent=`→ ${pad3(vec.direction)}°T`;return}
  speedEl.textContent=currentField?'No modeled water':'Loading…';dirEl.textContent='';
}
const scheduleCurrentRead=debounce(()=>readCurrentAt(map.getCenter(),'Map center'),300);
map.on('moveend',scheduleCurrentRead);
map.on('movestart zoomstart',()=>{stopFlowAnimation()});
map.on('resize',()=>{resizeFlowCanvas();if(currentField)animateCurrents()});

function changeTime(hours){currentTime=new Date(currentTime.getTime()+hours*3600e3);renderTideGraph();loadCurrentModel()}
document.getElementById('timeBack').addEventListener('click',()=>changeTime(-1));
document.getElementById('timeForward').addEventListener('click',()=>changeTime(1));
document.getElementById('timeNow').addEventListener('click',()=>{currentTime=roundHour(new Date());renderTideGraph();loadCurrentModel()});
document.getElementById('timePlay').addEventListener('click',e=>{
  if(playTimer){clearInterval(playTimer);playTimer=null;e.currentTarget.textContent='▶ Play';return}
  e.currentTarget.textContent='❚❚ Pause';playTimer=setInterval(()=>changeTime(1),1350);
});
document.getElementById('toggleCurrents').addEventListener('click',e=>{
  currentsVisible=!currentsVisible;e.currentTarget.classList.toggle('active',currentsVisible);
  if(currentsVisible)loadCurrentField();else stopFlowAnimation();
});

async function checkLocalDataServer(){
  try{
    const r=await fetch(apiPath('/api/health'),{cache:'no-store'});
    if(!r.ok)throw new Error(String(r.status));
    const d=await r.json();
    if(!d.ok)throw new Error('not ready');
    return true;
  }catch(e){
    showMapMessage('Live current/tide/depth data requires the Dive Current API server (serve.py). Map and saved routes remain available.',8000);
    document.getElementById('currentStatus').textContent='Local data server not detected.';
    return false;
  }
}

// ---------- Persistence ----------
function loadRawState(){
  try{return JSON.parse(localStorage.getItem(STORE)||localStorage.getItem(OLD_STORE)||'{}')}catch{return{}}
}
function saveState(){
  localStorage.setItem(STORE,JSON.stringify({
    route:route.points.map(p=>({lat:p.lat,lng:p.lng})),
    depthPins:depthPins.map(({id,lat,lng,depth,source})=>({id,lat,lng,depth,source})),
    dpvSpeed:document.getElementById('dpvSpeed').value||'',
    tideStation:tideStationId
  }));
}
function loadState(){
  const s=loadRawState();
  route.points=(s.route||[]).map(p=>L.latLng(p.lat,p.lng));
  (s.depthPins||[]).forEach(p=>depthPins.push({...p,source:p.source||'saved marker'}));
  document.getElementById('dpvSpeed').value=s.dpvSpeed||'';
  tideStationId=s.tideStation||'9446484';
  redrawRoute();drawDepthPins();
}
loadState();

(async function init(){
  // Map renders independently of the Python API. Missing backend must not
  // prevent base tiles, Lake Washington bathymetry, or saved routes from working.
  setMapStyle('bathy');
  const serverOk=await checkLocalDataServer();
  if(!serverOk)return;
  await loadStations();
  const sel=document.getElementById('tideStation');
  if([...sel.options].some(o=>o.value===tideStationId))sel.value=tideStationId;
  tideStationId=sel.value;
  tideStationName=sel.options[sel.selectedIndex]?.text||tideStationName;
  await loadTides();
  loadCurrentModel();
})();

// Read-only diagnostic API for local QA; no operational data is fabricated.
window.__diveCurrentMap={getStyle:()=>mapStyle,hasBase:()=>map.hasLayer(baseLayer),hasLake:()=>map.hasLayer(lakeBathymetry),hasOcean:()=>map.hasLayer(oceanRelief),getRoutePoints:()=>route.points.slice(),setStyle:setMapStyle,map};
