/* RunTime Dive Current v1.0 • Static GitHub Pages deployment. NOAA model currents and tide forecasts are populated only by validated scheduled source data. */
'use strict';
const BUILD='1.1.0';
const FT_PER_M=3.280839895, KTS_PER_MPS=1.943844492;
const STORE='dive-current-state-v097', OLD_STORE='dive-current-state-v096';
const DNR_DEPTH='https://gis.dnr.wa.gov/image/rest/services/Aquatics/WA_bathymetry_CoNED_MLLW/ImageServer';
const DNR_BATHY='https://gis.dnr.wa.gov/image/rest/services/Aquatics/WA_bathymetry_CoNED_hillshade/ImageServer';
const DNR_CONTOURS='https://gis.dnr.wa.gov/site3/rest/services/Aquatics/AQ_Bathymetry/MapServer';
const SSCOFS_MANIFEST='data/sscofs/manifest.json';
const TIDE_STATIONS='data/stations.json';
// These endpoints are only read through static GitHub Pages; no Python service or API keys needed.

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
function imageUrl(base,v){
  // ArcGIS image pixels must be generated in the SAME EPSG:3857 projection
  // as Leaflet. EPSG:4326 images warped when projected into a Leaflet rectangle,
  // with increasing shoreline misregistration at wider map extents.
  const lowerLeft=L.CRS.EPSG3857.project(L.latLng(v.south,v.west));
  const upperRight=L.CRS.EPSG3857.project(L.latLng(v.north,v.east));
  const commonScale=Math.min(1,3000/v.width,3000/v.height);
  const width=Math.round(v.width*commonScale),height=Math.round(v.height*commonScale);
  const q=new URLSearchParams({
    f:'image',bbox:`${lowerLeft.x},${lowerLeft.y},${upperRight.x},${upperRight.y}`,
    bboxSR:'3857',imageSR:'3857',size:`${width},${height}`,
    format:'png32',transparent:'true',interpolation:'RSP_BilinearInterpolation'
  });
  return `${base}/exportImage?${q}`;
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
  replaceBathyOverlay(imageUrl(DNR_BATHY,v),v.bounds,{
    opacity:v.zoom>=15?.70:v.zoom>=13?.63:.52,
    onError:()=>{
      showOceanFallback();
      showMapMessage('DNR relief unavailable; regional ocean map displayed.',3000);
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
    where:'1=1', geometry:`${v.west},${v.south},${v.east},${v.north}`,
    geometryType:'esriGeometryEnvelope', inSR:'4326', spatialRel:'esriSpatialRelIntersects',
    outFields:'CONTOUR',returnGeometry:'true',outSR:'4326',
    resultRecordCount:'2000',f:'geojson'
  });
  try{
    const r=await fetch(`${DNR_CONTOURS}/${layer}/query?${q}`,{signal:contourAbort.signal,cache:'no-store'});
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
  const q=new URLSearchParams({
    geometry:JSON.stringify({x:latlng.lng,y:latlng.lat,spatialReference:{wkid:4326}}),
    geometryType:'esriGeometryPoint',returnFirstValueOnly:'true',
    interpolation:'RSP_BilinearInterpolation',f:'json'
  });
  const r=await fetch(`${DNR_DEPTH}/getSamples?${q}`,{cache:'no-store'});
  if(!r.ok)throw new Error(`DNR depth HTTP ${r.status}`);
  const data=await r.json();
  if(data.error)throw new Error(data.error.message||'DNR error');
  const sample=String(data.samples?.[0]?.value??'').split(',')[0];
  const elevation=Number(sample);
  if(!Number.isFinite(elevation)||elevation>=0||elevation<=-9990)throw new Error('No measured marine depth at this position');
  return -elevation*FT_PER_M;
}

async function addDepthPin(latlng){
  showMapMessage('Reading WA DNR depth…',10000);
  try{
    if(isLakeWashingtonView())throw new Error('Marine CoNED depth does not cover Lake Washington');
    const depth=await queryDnrDepth(latlng);
    const pin={id:(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():String(Date.now()+Math.random())),lat:latlng.lat,lng:latlng.lng,depth,source:'DNR CoNED MLLW'};
    depthPins.push(pin);drawDepthPins();saveState();
    showMapMessage(`Depth marker: ${Math.round(depth)} ft MLLW`,1800);
  }catch(e){
    console.error(e);
    showMapMessage('Depth unavailable here: marine DNR CoNED coverage only.',3500);
  }
}
function drawDepthPins(){
  depthPins.forEach(p=>p.marker&&map.removeLayer(p.marker));
  depthPins.forEach(p=>{
    const icon=L.divIcon({className:'',html:`<div class="depth-label">${Math.round(p.depth)} ft ×</div>`,iconSize:null});
    const m=L.marker([p.lat,p.lng],{icon}).addTo(map);
    m.on('click',event=>{
      L.DomEvent.stopPropagation(event);
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

function parseNoaaUTC(s){
  // GitHub Action requests NOAA tide times explicitly in GMT; no local-time ambiguity.
  return new Date(String(s).replace(' ','T')+'Z');
}
async function loadStations(){
  const select=document.getElementById('tideStation');
  try{
    const response=await fetch(TIDE_STATIONS,{cache:'no-store'});
    if(!response.ok)throw new Error(`stations ${response.status}`);
    const body=await response.json();
    const stations=(body.stations||[]).filter(x=>/^\d{7}$/.test(String(x.id))).sort((a,b)=>a.name.localeCompare(b.name));
    if(stations.length){
      const saved=loadRawState().tideStation||'9446484';
      select.innerHTML=stations.map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
      if(stations.some(x=>String(x.id)===String(saved)))select.value=String(saved);
      tideStationId=select.value;
      tideStationName=select.selectedOptions[0]?.text||tideStationId;
    }
  }catch(e){console.warn('Cached tide-station list unavailable:',e)}
}
async function fetchOfficialTidesDirect(stationId){
  // Browser fallback only. If the NOAA API blocks cross-origin requests, keep
  // the unavailable state rather than fill in missing data.
  const now=new Date(),start=new Date(now.getTime()-86400000),end=new Date(now.getTime()+3*86400000);
  const date=d=>d.toISOString().slice(0,10).replace(/-/g,'');
  const query=new URLSearchParams({product:'predictions',application:'RunTimeDiveCurrent',
    begin_date:date(start),end_date:date(end),station:String(stationId),
    datum:'MLLW',units:'english',time_zone:'gmt',format:'json',interval:'6'});
  const response=await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?'+query);
  if(!response.ok)throw new Error(`NOAA direct API HTTP ${response.status}`);
  const raw=await response.json();
  if(raw.error||!Array.isArray(raw.predictions)||raw.predictions.length<2)
    throw new Error(raw.error?.message||'NOAA returned no tide predictions');
  return {generated_at:new Date().toISOString(),predictions:raw.predictions,events:[]};
}
async function loadTides(){
  const graph=document.getElementById('tideGraph');
  graph.innerHTML='<div class="loading">Loading published NOAA tide predictions…</div>';
  try{
    // Station names are discovered from data/stations.json. Forecasts are updated by a daily Action.
    const r=await fetch(`data/tides/${encodeURIComponent(tideStationId)}.json`,{cache:'no-store'});
    let data=r.ok?await r.json():await fetchOfficialTidesDirect(tideStationId);
    let generated=new Date(data.generated_at);
    if(!Number.isFinite(generated.getTime())||Date.now()-generated.getTime()>72*3600e3){
      data=await fetchOfficialTidesDirect(tideStationId);
      generated=new Date(data.generated_at);
    }
    if(!Number.isFinite(generated.getTime()))throw new Error('Tide data missing generated_at');
    if(Date.now()-generated.getTime()>72*3600e3)throw new Error('Tide predictions are stale (older than 72 h)');
    tideData=(data.predictions||[]).map(x=>({time:parseNoaaUTC(x.t),value:Number(x.v)}))
      .filter(x=>Number.isFinite(x.time.getTime())&&Number.isFinite(x.value))
      .sort((a,b)=>a.time-b.time);
    tideEvents=(data.events||[]).map(x=>({time:parseNoaaUTC(x.t),value:Number(x.v),type:x.type}))
      .filter(x=>Number.isFinite(x.time.getTime())&&Number.isFinite(x.value));
    if(tideData.length<2)throw new Error('No valid NOAA tide predictions were published');
    renderTideGraph();renderTideEvents();syncMapSliders();
  }catch(e){
    tideData=[];tideEvents=[];
    console.warn('Tide cache unavailable:',e);
    document.getElementById('tideSummary').textContent='';
    document.getElementById('tideEvents').textContent='';
    graph.innerHTML=`<div class="loading">Tide predictions unavailable: ${escapeHtml(e.message)}</div>`;
    document.getElementById('mapTideChip').textContent='NOAA tide data unavailable';
    syncMapSliders();
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
  el.innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="slider" tabindex="0" aria-label="NOAA tide predictions. Click graph to scrub time">
    ${grid}<polygon class="tide-fill" points="${area}"/><polyline class="tide-line" points="${pts}"/>
    <line class="tide-cursor" x1="${cursorX}" y1="${pad.t}" x2="${cursorX}" y2="${h-pad.b}"/>
    ${sample?`<circle class="tide-dot" cx="${cursorX}" cy="${cursorY}" r="4"/>`:''}${labels}
  </svg>`;
  el.querySelector('svg')?.addEventListener('click',event=>{
    const rect=event.currentTarget.getBoundingClientRect();
    const position=(event.clientX-rect.left)/Math.max(1,rect.width);
    setSelectedTime(new Date(minT+Math.max(0,Math.min(1,position))*(maxT-minT)));
  });
  document.getElementById('tideSummary').innerHTML=sample
    ?`<span>${escapeHtml(tideStationName)}</span><strong>${sample.value.toFixed(1)} ft</strong>`:'';
  document.getElementById('mapTideChip').textContent=sample?`NOAA tide · ${tideStationName} · ${sample.value.toFixed(1)} ft MLLW`:'Tides unavailable';
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
let flowDisplay='flow'; // 'flow' | 'arrows'
let visibleWaterSeeds=[];

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
  const cell=.018;
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
  const cell=.018,iy=Math.floor(lat/cell),ix=Math.floor(lng/cell);
  const candidates=[];
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const arr=currentBuckets.get(`${iy+dy},${ix+dx}`);
    if(arr)candidates.push(...arr);
  }
  if(!candidates.length)return null;
  let best=[];
  for(const p of candidates){
    const d2=(p.lat-lat)**2+((p.lng-lng)*Math.cos(lat*Math.PI/180))**2;
    // Limit interpolation to about one model cell. This is spatial model guidance,
    // NOT a precise in-channel measurement and should never extrapolate miles.
    const stride=Number(sscofsManifest?.grid_stride)||9;
    const radius=Math.min(.031,Math.max(.010,stride*.0055));
    if(d2>radius*radius)continue;
    best.push({p,d2});
  }
  best=best.filter(Boolean).sort((a,b)=>a.d2-b.d2).slice(0,4);
  if(!best.length)return null;
  const nearestKm=Math.sqrt(best[0].d2)*111.32;
  let sw=0,u=0,v=0;
  for(const x of best){const w=1/Math.max(1e-8,x.d2);sw+=w;u+=x.p.u*w;v+=x.p.v*w}
  if(!sw)return null;
  u/=sw;v/=sw;
  if(!Number.isFinite(u)||!Number.isFinite(v)||Math.abs(u)>10||Math.abs(v)>10)return null;
  return {u,v,speedKn:Math.hypot(u,v)*KTS_PER_MPS,direction:(Math.atan2(u,v)*180/Math.PI+360)%360,nearestKm};
}
function prepareVisibleWaterSeeds(){
  if(!currentField?.points?.length)return [];
  const bounds=map.getBounds().pad(.05);
  return currentField.points.filter(p=>bounds.contains([p.lat,p.lng]));
}
function randomParticle(){
  // Start only at actual NOAA wet cells. Do not seed randomly on shore or inland.
  if(!visibleWaterSeeds.length)return null;
  const seed=visibleWaterSeeds[Math.floor(Math.random()*visibleWaterSeeds.length)];
  return {lat:seed.lat,lng:seed.lng,age:Math.random()*22,maxAge:45+Math.random()*65};
}
function resetParticles(){
  visibleWaterSeeds=prepareVisibleWaterSeeds();
  const target=Math.max(70,Math.min(320,visibleWaterSeeds.length*6));
  currentParticles=[];
  for(let i=0;i<target;i++){const p=randomParticle();if(p)currentParticles.push(p)}
}
function drawArrowMap(){
  clearFlowCanvas();
  if(!currentsVisible||!currentField?.points?.length)return;
  const size=map.getSize();
  const shown=new Set();
  for(const p of prepareVisibleWaterSeeds()){
    const pos=map.latLngToContainerPoint([p.lat,p.lng]);
    if(pos.x<0||pos.y<0||pos.x>size.x||pos.y>size.y)continue;
    const key=`${Math.floor(pos.x/32)},${Math.floor(pos.y/32)}`;
    if(shown.has(key))continue;shown.add(key);
    const speed=Math.hypot(p.u,p.v)*KTS_PER_MPS;
    if(speed<.02)continue;
    const heading=Math.atan2(p.u,p.v);
    const len=10+Math.min(16,speed*7);
    const dx=Math.sin(heading),dy=-Math.cos(heading);
    const tipX=pos.x+dx*len/2,tipY=pos.y+dy*len/2;
    flowCtx.beginPath();flowCtx.moveTo(pos.x-dx*len/2,pos.y-dy*len/2);
    flowCtx.lineTo(tipX,tipY);
    flowCtx.moveTo(tipX,tipY);
    flowCtx.lineTo(tipX-dx*7+dy*4,tipY-dy*7-dx*4);
    flowCtx.moveTo(tipX,tipY);
    flowCtx.lineTo(tipX-dx*7-dy*4,tipY-dy*7+dx*4);
    flowCtx.strokeStyle=speedColor(speed);flowCtx.lineWidth=1.6;flowCtx.globalAlpha=.95;flowCtx.stroke();
  }
  flowCtx.globalAlpha=1;
}
function animateCurrents(){
  stopFlowAnimation();
  if(!currentsVisible||!currentField?.points?.length)return;
  resizeFlowCanvas();
  if(flowDisplay==='arrows'){drawArrowMap();return}
  resetParticles();
  if(!visibleWaterSeeds.length)return;
  let last=performance.now();
  function frame(now){
    if(!currentsVisible||!currentField||flowDisplay!=='flow'){stopFlowAnimation();return}
    const dt=Math.min(.06,Math.max(.012,(now-last)/1000));last=now;
    const size=map.getSize();
    flowCtx.globalCompositeOperation='destination-in';
    flowCtx.fillStyle='rgba(0,0,0,.91)';flowCtx.fillRect(0,0,size.x,size.y);
    flowCtx.globalCompositeOperation='source-over';
    const visualSeconds=80;
    for(let i=0;i<currentParticles.length;i++){
      const p=currentParticles[i];
      if(!p||p.age++>p.maxAge){currentParticles[i]=randomParticle();continue}
      const vec=vectorAt(p.lat,p.lng);
      if(!vec){currentParticles[i]=randomParticle();continue}
      const a=map.latLngToContainerPoint([p.lat,p.lng]);
      p.lat+=(vec.v*dt*visualSeconds)/111320;
      p.lng+=(vec.u*dt*visualSeconds)/(111320*Math.max(.2,Math.cos(p.lat*Math.PI/180)));
      const b=map.latLngToContainerPoint([p.lat,p.lng]);
      if(b.x<-20||b.y<-20||b.x>size.x+20||b.y>size.y+20){currentParticles[i]=randomParticle();continue}
      flowCtx.beginPath();flowCtx.moveTo(a.x,a.y);flowCtx.lineTo(b.x,b.y);
      flowCtx.strokeStyle=speedColor(vec.speedKn);flowCtx.globalAlpha=.95;
      flowCtx.lineWidth=vec.speedKn>2?1.7:1.3;flowCtx.stroke();
    }
    flowCtx.globalAlpha=1;
    currentAnimationFrame=requestAnimationFrame(frame);
  }
  currentAnimationFrame=requestAnimationFrame(frame);
}
function setFlowDisplay(next){
  flowDisplay=next;
  document.getElementById('flowMode')?.classList.toggle('active',next==='flow');
  document.getElementById('arrowMode')?.classList.toggle('active',next==='arrows');
  if(currentsVisible&&currentField)animateCurrents();
}
document.getElementById('flowMode').addEventListener('click',()=>setFlowDisplay('flow'));
document.getElementById('arrowMode').addEventListener('click',()=>setFlowDisplay('arrows'));

let sscofsManifest=null;
let fieldLoadSequence=0;
const MAX_MODEL_AGE_HOURS=18; // cycle age, not forecast lead time
async function loadCurrentModel(){
  const status=document.getElementById('currentStatus');
  document.getElementById('currentTimeLabel').textContent=fmtTime(currentTime);
  const requestId=++fieldLoadSequence;
  stopFlowAnimation();currentField=null;currentModel=null;
  document.getElementById('currentSpeed').textContent='Unavailable';
  document.getElementById('currentDirection').textContent='';
  try{
    const r=await fetch(SSCOFS_MANIFEST,{cache:'no-store'});
    if(!r.ok)throw new Error(`manifest HTTP ${r.status}`);
    const manifest=await r.json();
    const frames=manifest.frames||[];
    const cycleDate=new Date(manifest.cycle_time);
    if(manifest.status!=='ok'||!frames.length)throw new Error(manifest.message||'No verified forecast published yet');
    if(!Number.isFinite(cycleDate.getTime())||Date.now()-cycleDate.getTime()>MAX_MODEL_AGE_HOURS*3600e3)
      throw new Error('The latest processed NOAA model run is stale');
    // Near-surface current time must correspond to an actually published model frame.
    const target=currentTime.getTime();
    const nearest=frames.map(f=>({...f,delta:Math.abs(new Date(f.valid_time).getTime()-target)}))
      .sort((a,b)=>a.delta-b.delta)[0];
    if(!nearest||nearest.delta>2.25*3600e3)
      throw new Error('No model frame near the selected hour');
    if(requestId!==fieldLoadSequence)return;
    currentModel={...manifest,selected:nearest};
    syncMapSliders();
    sscofsManifest=manifest;
    syncMapSliders();
    document.getElementById('currentSourceBadge').textContent='SSCOFS forecast';
    status.textContent=`NOAA SSCOFS · cycle ${fmtTime(cycleDate)} · near-surface ${fmtTime(new Date(nearest.valid_time))}`;
    if(currentsVisible)await loadCurrentField();
  }catch(e){
    if(requestId!==fieldLoadSequence)return;
    console.warn('NOAA model not available:',e);
    currentModel=null;currentField=null;stopFlowAnimation();
    document.getElementById('currentSourceBadge').textContent='Unavailable';
    status.textContent=`No verified surface forecast: ${e.message}`;
  }
}
async function loadCurrentField(){
  if(!currentsVisible||!currentModel?.selected){stopFlowAnimation();return}
  if(currentFieldAbort)currentFieldAbort.abort();
  currentFieldAbort=new AbortController();
  const selected=currentModel.selected;
  const modelToken=fieldLoadSequence;
  const status=document.getElementById('currentStatus');
  status.textContent='Loading verified NOAA surface-current vectors…';
  try{
    const r=await fetch(selected.file,{signal:currentFieldAbort.signal,cache:'no-store'});
    if(!r.ok)throw new Error(`frame HTTP ${r.status}`);
    const d=await r.json();
    if(modelToken!==fieldLoadSequence)return;
    if(d.source!=='NOAA SSCOFS'||d.valid_time!==selected.valid_time||!Array.isArray(d.points)||!d.points.length)
      throw new Error('Forecast frame failed integrity checks');
    const all=d.points.map(p=>({lat:Number(p[0]),lng:Number(p[1]),u:Number(p[2]),v:Number(p[3])}))
      .filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Number.isFinite(p.u)&&Number.isFinite(p.v)&&Math.hypot(p.u,p.v)<8);
    if(all.length<50)throw new Error('Insufficient valid model vectors');
    currentField={points:all,valid_time:d.valid_time};
    const b=map.getBounds().pad(.3);
    currentBounds={west:b.getWest(),south:b.getSouth(),east:b.getEast(),north:b.getNorth()};
    buildCurrentBuckets(all);
    status.textContent=`NOAA modeled near-surface flow · ${all.length.toLocaleString()} grid vectors · valid ${fmtTime(new Date(d.valid_time))}`;
    animateCurrents();readCurrentAt(map.getCenter(),'Map center');
    syncMapSliders();
  }catch(e){
    if(e.name==='AbortError')return;
    console.warn('Model-frame error:',e);currentField=null;stopFlowAnimation();
    document.getElementById('currentSpeed').textContent='Unavailable';
    status.textContent=`Forecast vectors unavailable: ${e.message}`;
  }
}

function refreshCurrentMap(){loadCurrentField()}
async function readCurrentAt(latlng,label='Selected point'){
  const speedEl=document.getElementById('currentSpeed'),dirEl=document.getElementById('currentDirection');
  document.getElementById('currentLocationLabel').textContent=label;
  const vec=vectorAt(latlng.lat,latlng.lng);
  if(vec){speedEl.textContent=`${vec.speedKn.toFixed(2)} kn`;dirEl.textContent=`→ ${pad3(vec.direction)}°T · ~${Math.round(vec.nearestKm*3280.84).toLocaleString()} ft from NOAA cell`;return}
  speedEl.textContent=currentField?'No grid cell near point':'Unavailable';dirEl.textContent='';
}
const scheduleCurrentRead=debounce(()=>readCurrentAt(map.getCenter(),'Map center'),300);
map.on('moveend',()=>{scheduleCurrentRead();if(currentField&&currentsVisible)animateCurrents()});
map.on('movestart zoomstart',()=>{stopFlowAnimation()});
map.on('resize',()=>{resizeFlowCanvas();if(currentField)animateCurrents()});

// Current and tide time scrubbing share one absolute time so the selected NOAA
// model frame and predicted tide level represent the same instant.
const currentRange=document.getElementById('currentTimeline');
const tideRange=document.getElementById('tideTimeline');
const timeDebounced=debounce(()=>loadCurrentModel(),160);
function syncMapSliders(){
  const frames=(sscofsManifest?.frames||[]);
  const currentLabel=document.getElementById('currentTimelineValue');
  if(frames.length){
    currentRange.disabled=false;currentRange.max=String(frames.length-1);
    let best=0;
    frames.forEach((f,i)=>{if(Math.abs(new Date(f.valid_time)-currentTime)<Math.abs(new Date(frames[best].valid_time)-currentTime))best=i});
    currentRange.value=String(best);
    currentLabel.textContent=fmtTime(new Date(frames[best].valid_time));
  }else{currentRange.disabled=true;currentLabel.textContent='No verified forecast'}
  const tideLabel=document.getElementById('tideTimelineValue');
  if(tideData.length>1){
    tideRange.disabled=false;tideRange.max=String(tideData.length-1);
    let best=0;
    tideData.forEach((f,i)=>{if(Math.abs(f.time-currentTime)<Math.abs(tideData[best].time-currentTime))best=i});
    tideRange.value=String(best);
    tideLabel.textContent=`${tideData[best].value.toFixed(1)} ft · ${fmtTime(tideData[best].time)}`;
  }else{tideRange.disabled=true;tideLabel.textContent='No verified tides'}
  document.getElementById('selectedTimeValue').textContent=fmtTime(currentTime);
}
function setSelectedTime(time){
  currentTime=new Date(time);
  if(!Number.isFinite(currentTime.getTime()))return;
  document.getElementById('currentTimeLabel').textContent=fmtTime(currentTime);
  renderTideGraph();syncMapSliders();timeDebounced();
}
currentRange.addEventListener('input',e=>{
  const frame=sscofsManifest?.frames?.[Number(e.target.value)];
  if(frame)setSelectedTime(new Date(frame.valid_time));
});
tideRange.addEventListener('input',e=>{
  const datum=tideData[Number(e.target.value)];
  if(datum)setSelectedTime(datum.time);
});
function changeTime(hours){setSelectedTime(new Date(currentTime.getTime()+hours*3600e3));}
document.getElementById('timeBack').addEventListener('click',()=>changeTime(-1));
document.getElementById('timeForward').addEventListener('click',()=>changeTime(1));
document.getElementById('timeNow').addEventListener('click',()=>setSelectedTime(roundHour(new Date())));
document.getElementById('timePlay').addEventListener('click',e=>{
  if(playTimer){clearInterval(playTimer);playTimer=null;e.currentTarget.textContent='▶ Play';return}
  e.currentTarget.textContent='❚❚ Pause';
  playTimer=setInterval(()=>{
    const frames=sscofsManifest?.frames||[];
    const next=frames.find(x=>new Date(x.valid_time).getTime()>currentTime.getTime()+30000);
    if(next)setSelectedTime(new Date(next.valid_time));
    else changeTime(1);
  },1650);
});
document.getElementById('toggleCurrents').addEventListener('click',e=>{
  currentsVisible=!currentsVisible;e.currentTarget.classList.toggle('active',currentsVisible);
  e.currentTarget.textContent=currentsVisible?'Currents ON':'Currents OFF';
  if(currentsVisible)loadCurrentModel();else stopFlowAnimation();
});

async function checkStaticAssets(){
  // Static hosting requires only HTML/JS/CSS. Data files are independently monitored.
  try{
    const r=await fetch('data/stations.json',{cache:'no-store'});
    if(!r.ok)showMapMessage('Tide data not published yet; map and routes still work.',4500);
  }catch(e){showMapMessage('Map available; NOAA cache may not be published yet.',4500)}
  return true;
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
  setMapStyle('bathy');
  await checkStaticAssets();
  await loadStations();
  const sel=document.getElementById('tideStation');
  if([...sel.options].some(o=>o.value===tideStationId))sel.value=tideStationId;
  tideStationId=sel.value;
  tideStationName=sel.options[sel.selectedIndex]?.text||tideStationName;
  loadTides();loadCurrentModel();
})();

// Read-only diagnostic API for local QA; no operational data is fabricated.
window.__diveCurrentMap={getStyle:()=>mapStyle,hasBase:()=>map.hasLayer(baseLayer),hasLake:()=>map.hasLayer(lakeBathymetry),hasOcean:()=>map.hasLayer(oceanRelief),getRoutePoints:()=>route.points.slice(),setStyle:setMapStyle,map};
