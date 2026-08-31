let map;
let previewRouteLayer=null;
let pickMode=null;
const routes=new Map();
const geocodeTimers={origin:null,destination:null};
const routeState={origin:null,destination:null,points:[],distance:null,loading:false};

const $=id=>document.getElementById(id);
const val=id=>$(id)?.value?.trim()||"";

window.addEventListener("DOMContentLoaded",()=>{
  initClock();
  initNav();
  initPlanner();
  initMap();
  initChat();
  initOrderDetails();
});

function initNav(){
  document.querySelectorAll(".navmore-btn").forEach(btn=>btn.addEventListener("click",e=>{
    e.stopPropagation(); btn.parentElement.classList.toggle("open");
  }));
  document.addEventListener("click",()=>document.querySelectorAll(".navmore.open").forEach(x=>x.classList.remove("open")));
}

function initClock(){
  const tick=()=>{const el=$("liveClock");if(el)el.textContent=new Date().toLocaleTimeString([], {hour12:false});};
  tick();setInterval(tick,1000);
}

function initPlanner(){
  ["origin","destination"].forEach(type=>{
    const input=$(type);
    if(!input)return;
    input.addEventListener("input",()=>{
      clearSelection(type);
      clearTimeout(geocodeTimers[type]);
      const q=input.value.trim();
      if(q.length<2){showSuggestions(type,[]);updateRoutePreview();return;}
      setFieldState(type,"SEARCHING…");
      geocodeTimers[type]=setTimeout(()=>searchLocations(type,q),420);
    });
    input.addEventListener("focus",()=>{if(input.value.trim().length>=2 && !routeState[type])searchLocations(type,input.value.trim())});
  });
  ["traffic","weather","priority"].forEach(id=>$(id)?.addEventListener("change",()=>{if(routeState.distance)updateRoutePreview(false)}));
  $("predictBtn")?.addEventListener("click",predict);
  $("pickOriginBtn")?.addEventListener("click",()=>startMapPick("origin"));
  $("pickDestinationBtn")?.addEventListener("click",()=>startMapPick("destination"));
  $("fitRoutesBtn")?.addEventListener("click",fitActiveRoutes);
}

function initMap(){
  const el=$("map");if(!el)return;
  map=L.map("map",{zoomControl:true}).setView([17.385,78.486],11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);
  map.on("click",async e=>{
    if(pickMode){await setMapPoint(pickMode,e.latlng.lat,e.latlng.lng);pickMode=null;updatePickUI();return;}
    L.popup().setLatLng(e.latlng).setContent(`<b>Map point</b><br>${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`).openOn(map);
  });
  syncLiveOrders();
  setInterval(syncLiveOrders,10000);
}

function initChat(){
  $("chatToggle")?.addEventListener("click",()=>toggleChat(true));
  window.addEventListener("open-fleet-ai",()=>toggleChat(true));
  $("chatInput")?.addEventListener("keydown",e=>{if(e.key==="Enter")sendChat()});
}

function setFieldState(type,text){const el=$(type+"State");if(el)el.textContent=text;}
function clearSelection(type){
  routeState[type]=null;
  $(type+"Lat").value="";$(type+"Lon").value="";
  setFieldState(type,"SEARCH");
}
function showSuggestions(type,items){
  const box=$(type+"Suggestions");if(!box)return;
  box.innerHTML="";
  if(!items.length){if($(type).value.trim().length>=2)box.innerHTML='<div class="suggestion-empty">No matching places. Try a wider name.</div>';return;}
  items.forEach((item,i)=>{
    const b=document.createElement("button");b.type="button";b.className="suggestion";
    b.innerHTML=`<span class="suggestion-icon">${i===0?'⌖':'•'}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.display_name||item.name)}</small></span>`;
    b.addEventListener("click",()=>selectLocation(type,item));box.appendChild(b);
  });
}

async function searchLocations(type,q){
  try{
    const r=await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);const x=await r.json();
    showSuggestions(type,x.results||[]);setFieldState(type,(x.results||[]).length?"SUGGESTIONS":"NO MATCH");
  }catch(e){showSuggestions(type,[]);setFieldState(type,"OFFLINE")}
}

async function selectLocation(type,item){
  $(type).value=item.name;routeState[type]={lat:Number(item.lat),lon:Number(item.lon),name:item.name,display_name:item.display_name};
  $(type+"Lat").value=routeState[type].lat;$(type+"Lon").value=routeState[type].lon;
  $(type+"Suggestions").innerHTML="";setFieldState(type,"✓ SELECTED");
  map.setView([routeState[type].lat,routeState[type].lon],13);
  updateRoutePreview();
}

function startMapPick(type){pickMode=type;setFieldState(type,"CLICK MAP");$("mapPickHint").textContent=`Click the map to choose the ${type}.`;updatePickUI()}
function updatePickUI(){if(!pickMode&&$("mapPickHint"))$("mapPickHint").textContent="Or select a location suggestion above."}

async function setMapPoint(type,lat,lon){
  try{const r=await fetch(`/api/reverse?lat=${lat}&lon=${lon}`);const x=await r.json();selectLocation(type,x)}
  catch(e){selectLocation(type,{name:`Map point ${lat.toFixed(4)}, ${lon.toFixed(4)}`,display_name:"Selected map point",lat,lon})}
}

async function updateRoutePreview(showError=true){
  const o=routeState.origin,d=routeState.destination;
  if(!o||!d){$("distanceDisplay").textContent="—";$("routeStatus").textContent="Select both locations to calculate road distance.";$("routeChip").textContent="WAITING FOR LOCATIONS";return;}
  routeState.loading=true;$("routeStatus").textContent="Calculating road distance…";$("routeChip").textContent="ROUTING";
  try{
    const r=await fetch("/api/route",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({origin_lat:o.lat,origin_lon:o.lon,destination_lat:d.lat,destination_lon:d.lon})});
    const x=await r.json();if(!r.ok)throw new Error(x.error||"Route unavailable");
    routeState.distance=Number(x.distance_km);routeState.points=x.points||[[o.lat,o.lon],[d.lat,d.lon]];
    $("distanceDisplay").textContent=`${routeState.distance.toFixed(2)} km`;
    $("routeStatus").textContent="Automatic road distance · routing service connected";$("routeChip").textContent="ROUTE READY";
    drawPreview(routeState.points);
    $("predictBtn").disabled=false;
  }catch(e){
    routeState.distance=null;$("distanceDisplay").textContent="—";$("routeStatus").textContent=showError?"Could not calculate this route. Try selecting the locations again.":"Route recalculation unavailable.";$("routeChip").textContent="ROUTE ERROR";
    $("predictBtn").disabled=true;
  }finally{routeState.loading=false}
}

function drawPreview(points){
  if(previewRouteLayer)map.removeLayer(previewRouteLayer);
  previewRouteLayer=L.polyline(points,{className:"preview-route",weight:5,opacity:.7,dashArray:"8 8"}).addTo(map);
  map.fitBounds(L.latLngBounds(points),{padding:[35,35]});
}

async function predict(){
  if(!routeState.origin||!routeState.destination){alert("Select an Origin and Destination from the suggestions first.");return}
  if(!routeState.distance){await updateRoutePreview();if(!routeState.distance)return}
  const data=plannerData();
  const btn=$("predictBtn");btn.disabled=true;btn.textContent="Calculating AI ETA…";
  try{
    const r=await fetch("/api/predict",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const x=await r.json();
    if(!r.ok)throw new Error(x.error||"Prediction failed");
    const allocation=x.allocation?`<small>Fleet match: <b>${escapeHtml(x.allocation.vehicle_no)}</b> · ${escapeHtml(x.allocation.driver)} · ${escapeHtml(x.allocation.vehicle_type)} · ${x.allocation.capacity} kg</small>`:`<small>No compatible vehicle is available right now.</small>`;
    const box=$("prediction");box.classList.remove("hidden");box.innerHTML=`<div class="prediction-grid"><div><span>ROUTE</span><strong>${x.distance_km} km</strong></div><div><span>AI ETA</span><strong>${escapeHtml(formatLocal(x.eta))}</strong></div><div><span>DURATION</span><strong>${x.predicted_minutes} min</strong></div></div><small>Created now · delivery status will follow the stored ETA timestamp.</small>${allocation}<button type="button" class="btn" id="saveDeliveryBtn">Place order & start live tracking →</button>`;
    $("saveDeliveryBtn").onclick=()=>saveOrder(data,x);
  }catch(e){const box=$("prediction");box.classList.remove("hidden");box.innerHTML=`<strong>Prediction unavailable</strong><small>${escapeHtml(e.message)}</small>`}
  finally{btn.disabled=false;btn.textContent="Predict ETA & Allocate Fleet →"}
}

function plannerData(){return {customer:val("customer"),origin:routeState.origin.name,destination:routeState.destination.name,distance:routeState.distance,traffic:val("traffic"),weather:val("weather"),priority:val("priority"),vehicle_type:val("vehicle_type"),origin_lat:routeState.origin.lat,origin_lon:routeState.origin.lon,destination_lat:routeState.destination.lat,destination_lon:routeState.destination.lon}}

async function saveOrder(data,prediction){
  const r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const x=await r.json();
  if(!r.ok||!x.ok){alert(x.error||"Could not create order.");return}
  const box=$("prediction");box.innerHTML=`<div class="success-order"><span>ORDER #${x.order_id} IS LIVE</span><strong>ETA ${escapeHtml(formatLocal(x.eta_at))}</strong><small>${x.distance_km} km · ${x.minutes} min predicted · status: In Transit</small><b>The vehicle will move using the real clock and automatically become Delivered at ETA.</b></div>`;
  await syncLiveOrders(true);document.location.hash="activity";
}

async function syncLiveOrders(force=false){
  try{
    const r=await fetch("/api/orders/live",{cache:"no-store"});if(!r.ok)return;const x=await r.json();
    const serverNow=Date.parse(x.now);
    const liveIds=new Set();
    for(const order of x.orders){
      const key=String(order.id);if(order.status==="In Transit"){
        liveIds.add(key);
        if(!routes.has(key))await createRouteVisual(order);
        updateRouteVisual(order,serverNow);
      }else if(routes.has(key)){
        updateRouteVisual(order,serverNow);if(order.status==="Delivered"||order.status==="Cancelled")removeRouteVisual(key,order.status==="Delivered");
      }
      updateOrderRow(order);
    }
    [...routes.keys()].forEach(k=>{if(!liveIds.has(k)){
      const order=x.orders.find(o=>String(o.id)===k);if(order)removeRouteVisual(k,order.status==="Delivered");
    }});
    renderTracking(x.orders);
    const sync=$("lastSync");if(sync)sync.textContent=`Synced ${new Date().toLocaleTimeString()}`;
  }catch(e){const sync=$("lastSync");if(sync)sync.textContent="Sync retrying…"}
}

function vehicleVisual(type){
  const t=String(type||"Any").toLowerCase();
  if(t.includes("mini")||t.includes("truck")) return {glyph:"🚚",label:"Mini Truck",className:"vehicle-mini-truck"};
  if(t.includes("ev")&&t.includes("van")) return {glyph:"⚡🚐",label:"EV Van",className:"vehicle-ev-van"};
  if(t.includes("van")) return {glyph:"🚐",label:"Van",className:"vehicle-van"};
  if(t.includes("bike")||t.includes("scooter")) return {glyph:"🏍️",label:"Bike",className:"vehicle-bike"};
  return {glyph:"🚚",label:"Fleet Vehicle",className:"vehicle-default"};
}

function makeVehicleIcon(vehicleType,bearing=0){
  const v=vehicleVisual(vehicleType);
  return L.divIcon({
    className:`moving-vehicle ${v.className}`,
    html:`<div class="vehicle-glyph" title="${escapeHtml(v.label)}" style="--vehicle-bearing:${Number(bearing)||0}deg">${v.glyph}</div><span class="vehicle-label">${escapeHtml(v.label)}</span>`,
    iconSize:[52,52],
    iconAnchor:[26,26]
  });
}

function bearingBetween(a,b){
  if(!a||!b)return 0;
  const lat1=a[0]*Math.PI/180, lat2=b[0]*Math.PI/180, dLon=(b[1]-a[1])*Math.PI/180;
  const y=Math.sin(dLon)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function updateVehicleIcon(item,order,index){
  const next=item.points[Math.min(item.points.length-1,index+1)]||item.points[index];
  const current=item.points[index];
  const bearing=bearingBetween(current,next);
  const type=order.vehicle_type||"Any";
  item.vehicle.setIcon(makeVehicleIcon(type,bearing));
}

async function createRouteVisual(order){
  const points=await getRoutePoints(order);if(!points.length)return;
  const layer=L.polyline(points,{className:"transit-route",weight:5,opacity:.78}).addTo(map);
  const origin=L.circleMarker(points[0],{radius:7,className:"origin-marker"}).addTo(map).bindTooltip(`Origin · #${order.id}`);
  const dest=L.circleMarker(points[points.length-1],{radius:7,className:"destination-marker"}).addTo(map).bindTooltip(`Destination · #${order.id}`);
  const vehicle=L.marker(points[0],{icon:makeVehicleIcon(order.vehicle_type,0),zIndexOffset:1000}).addTo(map);
  vehicle.bindTooltip(`${escapeHtml(vehicleVisual(order.vehicle_type).label)} · Order #${order.id}`,{direction:"top",offset:[0,-22]});
  routes.set(String(order.id),{points,layer,origin,dest,vehicle,vehicleType:order.vehicle_type||"Any"});
  if(routes.size===1)map.fitBounds(L.latLngBounds(points),{padding:[35,35]});
}

async function getRoutePoints(order){
  try{const r=await fetch("/api/route",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({origin_lat:order.origin_lat,origin_lon:order.origin_lon,destination_lat:order.destination_lat,destination_lon:order.destination_lon})});const x=await r.json();return x.points||[[order.origin_lat,order.origin_lon],[order.destination_lat,order.destination_lon]]}catch(e){return [[order.origin_lat,order.origin_lon],[order.destination_lat,order.destination_lon]]}
}

function updateRouteVisual(order,serverNow){
  const item=routes.get(String(order.id));if(!item)return;
  let progress=Number(order.progress||0);if(order.status==="Delivered")progress=1;
  const index=Math.min(item.points.length-1,Math.floor(progress*(item.points.length-1)));
  item.vehicle.setLatLng(item.points[index]);
  if(item.vehicleType!==String(order.vehicle_type||"Any")){
    item.vehicleType=String(order.vehicle_type||"Any");
  }
  updateVehicleIcon(item,order,index);
  if(order.status==="Delivered")item.vehicle.setOpacity(1);
}

function removeRouteVisual(id,keepMarker=false){
  const item=routes.get(String(id));if(!item)return;
  [item.layer,item.origin,item.dest].forEach(x=>{if(x)map.removeLayer(x)});
  if(!keepMarker&&item.vehicle)map.removeLayer(item.vehicle);
  if(keepMarker)item.vehicle.setLatLng(item.points[item.points.length-1]);
  routes.delete(String(id));
}

function renderTracking(orders){
  const wrap=$("trackingCards");if(!wrap)return;
  const active=orders.filter(o=>o.status==="In Transit"||o.status==="Processing");
  $("activeCount").textContent=`${active.length} live route${active.length===1?'':'s'} · server clock synced`;
  if(!active.length){wrap.innerHTML='<div class="empty">No active transit routes. Create a delivery to start a real-time route.</div>';return}
  wrap.innerHTML="";
  orders.filter(o=>o.status!=="Cancelled").slice(0,12).forEach(o=>{
    const progress=o.status==="Delivered"?1:Number(o.progress||0);const pct=Math.round(progress*100);const eta=o.eta_at?formatLocal(o.eta_at):"—";const remaining=o.status==="Delivered"?"Delivered":timeRemaining(o.eta_at);
    const card=document.createElement("article");card.className="tracking-card";card.id=`tracking-${o.id}`;
    card.innerHTML=`<div class="track-top"><div><b>#${o.id} · ${escapeHtml(o.customer)}</b><span>${escapeHtml(o.origin)} → ${escapeHtml(o.destination)}</span></div><span class="track-status ${statusClass(o.status)}">${escapeHtml(o.status)}</span></div><div class="track-meta"><span>ETA <b>${escapeHtml(eta)}</b></span><span>Distance <b>${Number(o.distance||0).toFixed(2)} km</b></span><span>Remaining <b>${escapeHtml(remaining)}</b></span></div><div class="track-bar"><div class="track-progress" style="width:${pct}%"></div></div><div class="track-bottom"><span>${o.status==="Delivered"?'✓ Delivered at '+escapeHtml(formatLocal(o.delivered_at||o.eta_at)):pct+'% route progress'}</span><b>${pct}%</b></div>`;
    wrap.appendChild(card);
  });
}

function updateOrderRow(order){
  const row=document.querySelector(`tr[data-order-id="${order.id}"]`);if(!row)return;
  const tag=row.querySelector(".tag");if(tag){tag.textContent=order.status;tag.className=`tag ${statusClass(order.status)}`}
  const eta=row.querySelector("[data-eta]");if(eta&&order.eta_at)eta.textContent=`${formatLocal(order.eta_at)}`;
}

function initOrderDetails(){
  const modal=$("orderDetailModal");
  if(!modal)return;
  let currentOrder=null;
  let selectedStars=0;
  let hoverStars=0;
  const isAdmin=document.body.dataset.role==="admin";

  function paintStars(stars){
    const value=Number(stars)||0;
    document.querySelectorAll("#starRating [data-stars]").forEach(btn=>{
      const n=Number(btn.dataset.stars);
      btn.classList.toggle("selected",n<=value);
      btn.classList.toggle("hovered",hoverStars>0 && n<=hoverStars);
      btn.setAttribute("aria-checked",n===selectedStars?"true":"false");
    });
  }

  async function loadRating(order){
    const box=$("deliveryRating"); if(!box)return;
    const delivered=order.status==="Delivered";
    box.classList.toggle("hidden",!delivered);
    if(!delivered)return;
    selectedStars=0; hoverStars=0; paintStars(0);
    if($("ratingComment"))$("ratingComment").value="";
    if($("ratingMessage"))$("ratingMessage").textContent="";
    try{
      const r=await fetch(`/api/orders/${order.id}/rating`,{cache:"no-store"});
      const x=await r.json();
      if(x.rating){selectedStars=Number(x.rating.stars)||0;paintStars(selectedStars);if($("ratingComment"))$("ratingComment").value=x.rating.comment||"";if($("ratingMessage"))$("ratingMessage").textContent="Rating saved — you can update it anytime.";}
    }catch(e){if($("ratingMessage"))$("ratingMessage").textContent="Rating could not be loaded.";}
  }

  function applyOrderToModal(order){
    currentOrder=order;
    $("orderDetailTitle").textContent=`Order #${order.id}`;
    $("orderDetailSubtitle").textContent=`${order.customer||"Delivery"} · ${order.origin||"—"} → ${order.destination||"—"}`;
    $("detailStatus").textContent=order.status||"—";
    $("detailStatus").className=statusClass(order.status);
    $("detailVehicle").textContent=order.vehicle_type||"Any";
    $("detailDistance").textContent=order.distance!=null?`${Number(order.distance).toFixed(2)} km`:"—";
    $("detailEta").textContent=order.eta_at?formatLocal(order.eta_at):"—";
    $("detailOrigin").textContent=order.origin||"—";
    $("detailDestination").textContent=order.destination||"—";
    $("orderActionMessage").textContent="";
    $("adminEditPanel")?.classList.add("hidden");
    const cancel=$("cancelOrderBtn");
    if(cancel){
      const locked=["Cancelled","Delivered"].includes(order.status);
      cancel.disabled=locked;
      cancel.classList.toggle("hidden",locked);
      cancel.setAttribute("aria-hidden",locked?"true":"false");
    }
    loadRating(order);
  }

  async function openOrder(order){
    document.body.classList.add("modal-open");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden","false");
    // Fetch the authoritative server state so an order that just reached its ETA
    // is immediately shown as Delivered instead of using stale table data.
    try{
      const r=await fetch(`/api/orders/${order.id}`,{cache:"no-store"});
      const x=await r.json();
      if(r.ok&&x.order) order=x.order;
    }catch(e){}
    applyOrderToModal(order);
  }
  function closeOrder(){modal.classList.add("hidden");modal.setAttribute("aria-hidden","true");document.body.classList.remove("modal-open");currentOrder=null;}
  function setMessage(text,ok=false){const el=$("orderActionMessage");if(el){el.textContent=text;el.className=`action-message ${ok?'success-message':''}`}}
  function updateRowAfterAction(order){
    const row=document.querySelector(`tr[data-order-id="${order.id}"]`);if(!row)return;
    const tag=row.querySelector(".tag");if(tag){tag.textContent=order.status;tag.className=`tag ${statusClass(order.status)}`}
    const eta=row.querySelector("[data-eta]");if(eta)eta.textContent=order.eta_at?`${formatLocal(order.eta_at)}`:"—";
    row.dataset.order=JSON.stringify(order).replace(/</g,"\\u003c");
  }

  document.addEventListener("click",e=>{
    const row=e.target.closest(".order-row");
    const detail=e.target.closest(".open-order");
    if(row&&!e.target.closest("a")&&!e.target.closest("button")){e.preventDefault();try{openOrder(JSON.parse(row.dataset.order))}catch(err){setMessage("This order could not be opened.")}}
    if(detail){e.preventDefault();const r=detail.closest(".order-row");if(r)try{openOrder(JSON.parse(r.dataset.order))}catch(err){setMessage("This order could not be opened.")}}
  });
  document.querySelectorAll(".order-row").forEach(row=>row.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();try{openOrder(JSON.parse(row.dataset.order))}catch(err){}}}));
  document.querySelectorAll("[data-close-order]").forEach(el=>el.addEventListener("click",closeOrder));
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.classList.contains("hidden"))closeOrder()});

  document.querySelectorAll("#starRating [data-stars]").forEach(btn=>{
    btn.addEventListener("mouseenter",()=>{hoverStars=Number(btn.dataset.stars);paintStars(hoverStars)});
    btn.addEventListener("mouseleave",()=>{hoverStars=0;paintStars(selectedStars)});
    btn.addEventListener("click",()=>{selectedStars=Number(btn.dataset.stars);hoverStars=0;paintStars(selectedStars)});
  });

  $("submitRating")?.addEventListener("click",async()=>{
    if(!currentOrder||currentOrder.status!=="Delivered")return;
    if(!selectedStars){if($("ratingMessage"))$("ratingMessage").textContent="Please choose a star rating first.";return;}
    const btn=$("submitRating");btn.disabled=true;btn.textContent="Saving…";
    try{
      const r=await fetch(`/api/orders/${currentOrder.id}/rating`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({stars:selectedStars,comment:$("ratingComment")?.value||""})});
      const x=await r.json();
      if(!r.ok||!x.ok){if($("ratingMessage"))$("ratingMessage").textContent=x.error||"Unable to save rating.";return;}
      selectedStars=Number(x.rating.stars);paintStars(selectedStars);if($("ratingMessage"))$("ratingMessage").textContent="Thanks! Your rating is saved.";
    }finally{btn.disabled=false;btn.textContent="Update Rating";}
  });

  $("cancelOrderBtn")?.addEventListener("click",async()=>{
    if(!currentOrder)return;
    if(currentOrder.status==="Delivered"){setMessage("A delivered order cannot be cancelled.");return}
    if(["Cancelled"].includes(currentOrder.status)){return}
    if(!confirm(`Cancel Order #${currentOrder.id}?`))return;
    const r=await fetch(`/api/orders/${currentOrder.id}/status`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"Cancelled"})});
    const x=await r.json();
    if(!r.ok||!x.ok){setMessage(x.error||"Unable to cancel this order.");return}
    currentOrder.status="Cancelled";updateRowAfterAction(currentOrder);setMessage("Order cancelled successfully.",true);
    $("detailStatus").textContent="Cancelled";$("detailStatus").className=statusClass("Cancelled");
    const cancel=$("cancelOrderBtn");if(cancel){cancel.disabled=true;cancel.classList.add("hidden");}
    $("deliveryRating")?.classList.add("hidden");
    removeRouteVisual(String(currentOrder.id),false);
  });

  if(isAdmin){
    $("deleteOrderBtn")?.addEventListener("click",async()=>{
      if(!currentOrder)return;
      if(!confirm(`Permanently delete Order #${currentOrder.id}?`))return;
      const r=await fetch(`/api/admin/orders/${currentOrder.id}`,{method:"DELETE"});const x=await r.json();
      if(!r.ok||!x.ok){setMessage(x.error||"Unable to delete order.");return}
      document.querySelector(`tr[data-order-id="${currentOrder.id}"]`)?.remove();closeOrder();
    });
    $("editOrderBtn")?.addEventListener("click",()=>{
      if(!currentOrder)return;
      $("adminEditPanel")?.classList.remove("hidden");
      $("editCustomer").value=currentOrder.customer||"";
      $("editOrigin").value=currentOrder.origin||"";
      $("editDestination").value=currentOrder.destination||"";
      $("editOrigin").dataset.lat=currentOrder.origin_lat||"";$("editOrigin").dataset.lon=currentOrder.origin_lon||"";
      $("editDestination").dataset.lat=currentOrder.destination_lat||"";$("editDestination").dataset.lon=currentOrder.destination_lon||"";
      $("editVehicle").value=currentOrder.vehicle_type||"Any";
      $("editStatus").value=currentOrder.status||"Processing";
    });

    async function findEditLocation(type){
      const input=$(type==="origin"?"editOrigin":"editDestination"),box=$(type==="origin"?"originSuggestions":"destinationSuggestions");
      const q=input.value.trim();if(q.length<2)return;
      box.innerHTML='<span>Searching locations…</span>';
      try{
        const r=await fetch(`/api/geocode?q=${encodeURIComponent(q)}`),x=await r.json();box.innerHTML="";
        (x.results||[]).slice(0,6).forEach(item=>{
          const b=document.createElement("button");b.type="button";b.textContent=item.display_name||item.name;b.dataset.lat=item.lat;b.dataset.lon=item.lon;b.dataset.name=item.name;
          b.onclick=()=>{input.value=item.name;input.dataset.lat=item.lat;input.dataset.lon=item.lon;box.innerHTML='<span class="picked">✓ Location selected</span>';};
          box.appendChild(b);
        });
        if(!x.results?.length)box.innerHTML='<span>No matching locations.</span>';
      }catch(err){box.innerHTML='<span>Location search unavailable.</span>'}
    }
    $("editOrigin")?.addEventListener("input",()=>{clearTimeout(window.__editOriginTimer);window.__editOriginTimer=setTimeout(()=>findEditLocation("origin"),350)});
    $("editDestination")?.addEventListener("input",()=>{clearTimeout(window.__editDestTimer);window.__editDestTimer=setTimeout(()=>findEditLocation("destination"),350)});
    document.querySelectorAll("[data-resolve]").forEach(btn=>btn.addEventListener("click",()=>findEditLocation(btn.dataset.resolve)));
    $("saveOrderEdit")?.addEventListener("click",async()=>{
      if(!currentOrder)return;
      const olat=Number($("editOrigin").dataset.lat||currentOrder.origin_lat),olon=Number($("editOrigin").dataset.lon||currentOrder.origin_lon);
      const dlat=Number($("editDestination").dataset.lat||currentOrder.destination_lat),dlon=Number($("editDestination").dataset.lon||currentOrder.destination_lon);
      const payload={customer:val("editCustomer"),origin:val("editOrigin"),destination:val("editDestination"),origin_lat:olat,origin_lon:olon,destination_lat:dlat,destination_lon:dlon,vehicle_type:val("editVehicle"),status:val("editStatus")};
      if(!payload.customer||!payload.origin||!payload.destination||![olat,olon,dlat,dlon].every(Number.isFinite)){setMessage("Select valid customer and locations first.");return}
      if(currentOrder.status==="Delivered"&&payload.status==="Cancelled"){setMessage("A delivered order cannot be cancelled.");return}
      const btn=$("saveOrderEdit");btn.disabled=true;btn.textContent="Saving…";
      try{
        const r=await fetch(`/api/admin/orders/${currentOrder.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),x=await r.json();
        if(!r.ok||!x.ok){setMessage(x.error||"Unable to save changes.");return}
        Object.assign(currentOrder,payload,{distance:x.distance_km,eta_at:x.eta_at,origin_lat:x.origin_lat,origin_lon:x.origin_lon,destination_lat:x.destination_lat,destination_lon:x.destination_lon,status:x.status});
        updateRowAfterAction(currentOrder);
        $("detailStatus").textContent=x.status;$("detailStatus").className=statusClass(x.status);$("detailVehicle").textContent=payload.vehicle_type;$("detailDistance").textContent=`${Number(x.distance_km).toFixed(2)} km`;$("detailEta").textContent=x.eta_at?formatLocal(x.eta_at):"—";$("detailOrigin").textContent=payload.origin;$("detailDestination").textContent=payload.destination;
        const cancel=$("cancelOrderBtn");if(cancel){const locked=["Cancelled","Delivered"].includes(x.status);cancel.disabled=locked;cancel.classList.toggle("hidden",locked);}
        $("deliveryRating")?.classList.toggle("hidden",x.status!=="Delivered");
        $("adminEditPanel")?.classList.add("hidden");setMessage("Order updated successfully.",true);
        if(x.status==="Delivered")loadRating(currentOrder);
      }finally{btn.disabled=false;btn.textContent="Save Changes"}
    });
  }
}

function statusClass(s){return `status-${String(s||'').toLowerCase().replaceAll(' ','-')}`}
function timeRemaining(eta){if(!eta)return"—";const ms=Date.parse(eta)-Date.now();if(ms<=0)return"Due now";const m=Math.floor(ms/60000),h=Math.floor(m/60),min=m%60;return h?`${h}h ${min}m`:`${min}m`}
function formatLocal(iso){if(!iso)return"—";const d=new Date(iso);return isNaN(d)?iso:d.toLocaleString([], {hour:'2-digit',minute:'2-digit',hour12:true})}
function fitActiveRoutes(){if(!map||!routes.size)return;const all=[];routes.forEach(r=>r.points.forEach(p=>all.push(p)));if(all.length)map.fitBounds(L.latLngBounds(all),{padding:[40,40]})}

function toggleChat(force){const modal=$("chatModal");if(!modal)return;const open=typeof force==="boolean"?force:modal.classList.contains("hidden");modal.classList.toggle("hidden",!open);modal.setAttribute("aria-hidden",String(!open));if(open)setTimeout(()=>$("chatInput")?.focus(),80)}
function askSuggestion(text){$("chatInput").value=text;sendChat()}
async function sendChat(){const input=$("chatInput"),msg=input.value.trim();if(!msg)return;const log=$("chatlog");log.innerHTML+=`<div class="user">${escapeHtml(msg)}</div>`;input.value="";const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});const x=await r.json();log.innerHTML+=`<div class="bot">${escapeHtml(x.reply)}</div>`;log.scrollTop=log.scrollHeight}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}


/* =========================
   FLEETFLOW V6 INTERACTION MOTION
   ========================= */
(function(){
  function ripple(e){
    const r=document.createElement("span");
    r.className="ui-ripple";r.style.left=e.clientX+"px";r.style.top=e.clientY+"px";
    document.body.appendChild(r);setTimeout(()=>r.remove(),700);
  }
  document.addEventListener("click",e=>{
    if(e.target.closest("button,.btn,.pill,.navlinks a")) ripple(e);
  },true);

  // Animated page-to-page transition. The browser still performs the normal
  // navigation, while the wipe gives every click a distinct visual transition.
  const wipe=document.createElement("div");wipe.className="route-wipe";document.body.appendChild(wipe);
  document.addEventListener("click",e=>{
    const a=e.target.closest("a");
    if(!a||a.target==="_blank"||a.hasAttribute("download")||a.origin!==location.origin)return;
    const href=a.getAttribute("href")||"";
    if(href.startsWith("#")||href.startsWith("javascript:"))return;
    e.preventDefault();
    wipe.classList.remove("play");void wipe.offsetWidth;wipe.classList.add("play");
    setTimeout(()=>location.href=a.href,290);
  },true);

  // Reveal elements as they enter the viewport.
  if("IntersectionObserver" in window){
    const io=new IntersectionObserver(entries=>{
      entries.forEach(x=>{if(x.isIntersecting){x.target.classList.add("in-view");io.unobserve(x.target)}})
    },{threshold:.08});
    document.querySelectorAll(".panel,.fleetcard,.tracking-card,.stats>div").forEach(x=>io.observe(x));
  }
})();
