// Skipi Map lightweight module v0.1.0
// Extracted from skipi-broker dist/index.html; global functions intentionally preserved.
// Leaflet library assets remain in the broker host and expose global L.

// --- extracted from skipi-broker dist/index.html:6675 (vizToggleFilters) ---
function vizToggleFilters(){
    var v = document.getElementById('view-viz');
    if(v) v.classList.toggle('viz-filters-open');
}

// --- extracted from skipi-broker dist/index.html:7097 (_miniRouteSvg) ---
function _miniRouteSvg(loadCoord, dischCoord){
    if(!loadCoord && !dischCoord){
        return '<div style="color:var(--text3); font-size:10px; text-align:center; padding:32px 0;">порты без координат</div>';
    }
    var w = 320, h = 90, pad = 10;
    function proj(c){
        if(!c) return null;
        // lat = c[0], lon = c[1]; map to SVG: lon → x, -lat → y
        var x = pad + ((c[1] + 180) / 360) * (w - 2*pad);
        var y = pad + ((90 - c[0]) / 180) * (h - 2*pad);
        return [x, y];
    }
    var p1 = proj(loadCoord), p2 = proj(dischCoord);
    var parts = [];
    parts.push('<rect x="0" y="0" width="'+w+'" height="'+h+'" fill="transparent"/>');
    if(p1 && p2){
        parts.push('<line x1="'+p1[0]+'" y1="'+p1[1]+'" x2="'+p2[0]+'" y2="'+p2[1]+'"'
            + ' stroke="#004564" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7"/>');
    }
    if(p1){
        parts.push('<circle cx="'+p1[0]+'" cy="'+p1[1]+'" r="5" fill="#4ec970" stroke="#fff" stroke-width="1.2"/>');
    }
    if(p2){
        parts.push('<circle cx="'+p2[0]+'" cy="'+p2[1]+'" r="4" fill="#e55561" stroke="#fff" stroke-width="1"/>');
    }
    return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMid meet">'+parts.join('')+'</svg>';
}

// --- extracted from skipi-broker dist/index.html:7170 (showLeadOnMap) ---
function showLeadOnMap(leadId){
    var l = _getLeads().filter(function(x){ return x.id === leadId; })[0];
    if(!l) return;
    state._vizFocusLead = l;
    showView('viz');
    setTimeout(function(){
        if(!state.viz || !state.viz.map) return;
        var loadC = _portCoords((l.cargo_signal || {}).load_port);
        var dischC = _portCoords((l.cargo_signal || {}).disch_port);
        if(loadC && dischC){
            state.viz.map.fitBounds([loadC, dischC], { padding:[60,60] });
        } else if(loadC){
            state.viz.map.setView(loadC, 5);
        }
    }, 200);
}

// --- extracted from skipi-broker dist/index.html:8854 (PORT_COORDS) ---
var PORT_COORDS = {
    "constanta":[44.17,28.65], "constantza":[44.17,28.65], "burgas":[42.50,27.47],
    "varna":[43.21,27.92], "odessa":[46.49,30.74], "odesa":[46.49,30.74], "yuzhny":[46.62,31.10],
    "chornomorsk":[46.27,30.65], "illichevsk":[46.31,30.66], "pivdennyi":[46.62,31.10],
    "kandla":[22.97,70.22], "mundra":[22.83,69.72], "paradip":[20.27,86.61], "visakhapatnam":[17.69,83.30],
    "chennai":[13.08,80.27], "tuticorin":[8.78,78.13], "krishnapatnam":[14.27,80.13], "mumbai":[18.94,72.84],
    "dar es salaam":[-6.80,39.30], "tanga":[-5.07,39.10], "mtwara":[-10.27,40.18],
    "fos":[43.43,4.95], "marseille":[43.30,5.36],
    "novorossiysk":[44.72,37.78], "tuapse":[44.10,39.07], "kavkaz":[45.34,36.69],
    "yeisk":[46.71,38.27], "rostov":[47.23,39.72], "taganrog":[47.22,38.91],
    "mariupol":[47.10,37.55], "kerch":[45.36,36.47], "sevastopol":[44.62,33.53],
    "sulina":[45.16,29.65], "braila":[45.27,27.96], "galati":[45.43,28.04],
    "izmail":[45.35,28.84], "reni":[45.45,28.28], "samsun":[41.29,36.33],
    "trabzon":[41.00,39.72], "zonguldak":[41.45,31.80],
    "marmara":[40.97,28.95], "istanbul":[41.01,28.97], "izmit":[40.77,29.94],
    "tekirdag":[40.98,27.51], "bandirma":[40.35,27.97], "gemlik":[40.43,29.16],
    "aliaga":[38.80,26.95], "izmir":[38.42,27.14], "piraeus":[37.94,23.65],
    "thessaloniki":[40.63,22.95], "limassol":[34.67,33.04], "larnaca":[34.92,33.63],
    "mersin":[36.79,34.62], "iskenderun":[36.59,36.18], "aegean":[38.50,25.50],
    "alexandria":[31.21,29.92], "damietta":[31.42,31.81], "portsaid":[31.26,32.30],
    "port said":[31.26,32.30], "suez":[29.97,32.55], "haifa":[32.82,35.00],
    "ashdod":[31.81,34.65],
    "trieste":[45.65,13.78], "venice":[45.43,12.34], "ravenna":[44.42,12.20],
    "ancona":[43.62,13.51], "civitavecchia":[42.10,11.79], "augusta":[37.21,15.22],
    "cagliari":[39.21,9.11], "naples":[40.83,14.25], "valletta":[35.90,14.51],
    "tarragona":[41.11,1.25], "barcelona":[41.34,2.17], "valencia":[39.45,-0.32],
    "cartagena":[37.60,-0.98], "algeciras":[36.13,-5.45], "sagunto":[39.65,-0.21],
    "sibenik":[43.74,15.89], "split":[43.51,16.43], "koper":[45.55,13.73],
    "rijeka":[45.32,14.45], "ploce":[43.06,17.43], "bar":[42.09,19.10],
    "tunis":[36.79,10.30], "sfax":[34.73,10.76], "bejaia":[36.75,5.07],
    "algiers":[36.78,3.06], "oran":[35.71,-0.65], "annaba":[36.90,7.77],
    "casablanca":[33.61,-7.62], "agadir":[30.42,-9.59], "med":[37.00,18.00],
    "lisbon":[38.71,-9.14], "sines":[37.95,-8.87], "setubal":[38.52,-8.89],
    "la coruna":[43.37,-8.40], "bilbao":[43.34,-3.04], "rotterdam":[51.92,4.48],
    "amsterdam":[52.40,4.85], "antwerp":[51.22,4.42], "ghent":[51.10,3.74],
    "hamburg":[53.55,9.99], "bremen":[53.10,8.74], "gdansk":[54.36,18.65],
    "klaipeda":[55.71,21.13], "riga":[57.00,24.05], "tallinn":[59.44,24.75],
    "ust luga":[59.66,28.27], "primorsk":[60.36,28.61],
    "spb":[59.94,30.31], "st petersburg":[59.94,30.31], "saint petersburg":[59.94,30.31],
    "petersburg":[59.94,30.31], "leningrad":[59.94,30.31],
    "azov":[47.11,39.42], "vyborg":[60.71,28.75],
    "kaliningrad":[54.71,20.51], "baltiysk":[54.65,19.91],
    "vladivostok":[43.12,131.89], "nakhodka":[42.82,132.88],
    "vostochny":[42.74,133.07], "korsakov":[46.63,142.78],
    "murmansk":[68.97,33.08], "arkhangelsk":[64.55,40.54],
    "vanino":[49.10,140.27], "magadan":[59.57,150.80], "sakhalin":[47.00,142.50],
    "taman":[45.21,36.71], "temryuk":[45.27,37.39],
    "dakar":[14.69,-17.45], "abidjan":[5.33,-4.03], "tema":[5.62,0.00],
    "lome":[6.13,1.22], "cotonou":[6.36,2.43], "lagos":[6.45,3.40],
    "onne":[4.74,7.16], "douala":[4.05,9.69], "pointe noire":[-4.78,11.86],
    "pointenoire":[-4.78,11.86], "luanda":[-8.79,13.24], "walvis bay":[-22.95,14.50],
    "waf":[5.00,3.00],
    "kandla":[22.99,70.22], "mundra":[22.84,69.71], "pipavav":[20.93,71.50],
    "mumbai":[18.95,72.83], "jnpt":[18.95,72.95], "navasheva":[18.95,72.95],
    "mormugao":[15.41,73.81], "mangalore":[12.89,74.84], "cochin":[9.97,76.27],
    "tuticorin":[8.78,78.20], "chennai":[13.10,80.30], "kakinada":[16.97,82.25],
    "kakinada anchor":[16.97,82.25], "visakhapatnam":[17.69,83.22],
    "visakhapatnam outer":[17.68,83.30], "paradip":[20.27,86.69],
    "haldia":[22.04,88.07], "kolkata":[22.55,88.34], "krishnapatnam":[14.25,80.10],
    "wci":[20.00,72.00], "eci":[15.00,82.00],
    "fujairah":[25.13,56.34], "khor fakkan":[25.34,56.36], "jebel ali":[25.02,55.06],
    "dubai":[25.27,55.30], "bahrain":[26.20,50.59], "dammam":[26.45,50.10],
    "jubail":[27.00,49.66], "jeddah":[21.49,39.16], "yanbu":[24.09,38.06],
    "aqaba":[29.53,35.00], "muscat":[23.61,58.59], "sohar":[24.36,56.71],
    "salalah":[16.94,54.01],
    "djibouti":[11.59,43.15], "berbera":[10.43,45.02], "mombasa":[-4.04,39.66],
    "dar es salaam":[-6.80,39.30], "maputo":[-25.96,32.59], "durban":[-29.87,31.04],
    "richards bay":[-28.79,32.07], "cape town":[-33.92,18.42],
    "singapore":[1.29,103.85], "port kelang":[2.95,101.40], "port klang":[2.95,101.40],
    "tanjung pelepas":[1.36,103.55], "manila":[14.60,120.97], "subic bay":[14.79,120.27],
    "ho chi minh":[10.78,106.70], "haiphong":[20.86,106.69], "bangkok":[13.72,100.49],
    "laem chabang":[13.07,100.88],
    "shanghai":[31.23,121.47], "ningbo":[29.87,121.55], "zhoushan":[30.00,122.10],
    "zhousan":[30.00,122.10], "qingdao":[36.07,120.38], "tianjin":[39.13,117.20],
    "dalian":[38.92,121.61], "yantai":[37.46,121.45], "rizhao":[35.42,119.46],
    "qinhuangdao":[39.93,119.62], "lianyungang":[34.60,119.16],
    "guangzhou":[23.13,113.27], "shenzhen":[22.55,114.06], "xiamen":[24.48,118.08],
    "fuzhou":[26.07,119.32], "hong kong":[22.32,114.17], "hongkong":[22.32,114.17],
    "dung quat":[15.38,108.79], "north china":[38.00,120.00], "ne china":[39.00,121.00],
    "south china":[23.00,113.00],
    "yokohama":[35.45,139.65], "tokyo":[35.66,139.79], "nagoya":[35.10,136.88],
    "osaka":[34.65,135.43], "kobe":[34.69,135.20], "chiba":[35.60,140.10],
    "kashima":[35.93,140.69], "busan":[35.10,129.04], "incheon":[37.46,126.62],
    "ulsan":[35.50,129.39], "pohang":[36.04,129.38], "gwangyang":[34.90,127.74],
    "japan":[35.50,139.00],
    "newcastle":[-32.92,151.78], "port hedland":[-20.31,118.58],
    "dampier":[-20.66,116.71], "fremantle":[-32.05,115.74],
    "gladstone":[-23.84,151.25], "townsville":[-19.27,146.83],
    "abbot point":[-19.87,148.07], "kembla":[-34.48,150.92],
    "west black sea":[42.50,28.00], "east black sea":[43.50,38.00],
    "north black sea":[46.00,32.00], "south black sea":[42.00,33.00],
    "houston":[29.74,-95.30], "corpus christi":[27.81,-97.40], "new orleans":[29.95,-90.07],
    "nola":[29.95,-90.07], "tampa":[27.95,-82.46], "savannah":[32.08,-81.10],
    "charleston":[32.78,-79.93], "norfolk":[36.85,-76.29], "baltimore":[39.29,-76.61],
    "new york":[40.71,-74.01], "santos":[-23.97,-46.33], "itaqui":[-2.57,-44.37],
    "vitoria":[-20.32,-40.31], "praia mole":[-20.28,-40.23], "tubarao":[-20.27,-40.24],
    "ponta da madeira":[-2.57,-44.36], "buenos aires":[-34.61,-58.38],
    "rosario":[-32.95,-60.66], "san lorenzo":[-32.74,-60.74], "necochea":[-38.55,-58.74],
    "bahia blanca":[-38.72,-62.27], "paranagua":[-25.51,-48.51],
    "gibraltar":[36.14,-5.35], "canaries":[28.10,-15.50], "azores":[37.74,-25.66],
};

// --- extracted from skipi-broker dist/index.html:8956 (_portCoords) ---
function _portCoords(raw){
    if(!raw) return null;
    var key = String(raw).toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
    if(!key) return null;
    if(PORT_COORDS[key]) return PORT_COORDS[key];
    var tokens = key.split(' ');
    for(var n = tokens.length; n > 0; n--){
        var head = tokens.slice(0, n).join(' ');
        if(PORT_COORDS[head]) return PORT_COORDS[head];
        var compact = head.replace(/\s+/g,'');
        if(PORT_COORDS[compact]) return PORT_COORDS[compact];
    }
    if(PORT_COORDS[tokens[0]]) return PORT_COORDS[tokens[0]];
    return null;
}

// --- extracted from skipi-broker dist/index.html:8973 (_leadPorts) ---
function _leadPorts(m){
    var out = {
        cargo_load: null, cargo_disch: null, vessel_open: null,
        cargo_summary: '', vessel_summary: '',
    };
    var cargoSrc = m.cargo_listing || m.bazaar_cargo_signal;
    var tonSrc = m.tonnage_listing || m.bazaar_tonnage_signal;
    if(cargoSrc){
        out.cargo_load = cargoSrc.load_port;
        out.cargo_disch = cargoSrc.disch_port;
        var parts = [];
        if(cargoSrc.cargo_type) parts.push(cargoSrc.cargo_type);
        if(cargoSrc.quantity_mt) parts.push(cargoSrc.quantity_mt + ' MT');
        if(cargoSrc.laycan_from || cargoSrc.laycan_to){
            parts.push('laycan ' + (cargoSrc.laycan_from || '').slice(5,10) + '–' + (cargoSrc.laycan_to || '').slice(5,10));
        }
        out.cargo_summary = parts.join(' · ');
    }
    if(tonSrc){
        out.vessel_open = tonSrc.open_port;
        var parts2 = [];
        if(tonSrc.vessel_name) parts2.push(tonSrc.vessel_name);
        if(tonSrc.vessel_type) parts2.push(tonSrc.vessel_type);
        if(tonSrc.dwt) parts2.push(tonSrc.dwt + ' DWT');
        if(tonSrc.open_from || tonSrc.open_to){
            parts2.push('open ' + (tonSrc.open_from || '').slice(5,10) + '–' + (tonSrc.open_to || '').slice(5,10));
        }
        out.vessel_summary = parts2.join(' · ');
    }
    return out;
}

// --- extracted from skipi-broker dist/index.html:9067 (_renderLeadMap) ---
function _renderLeadMap(m, ports){
    if(typeof L === 'undefined'){
        // Leaflet failed to load (offline first launch?). Show stub.
        document.getElementById('lead-map').innerHTML = '<div class="col-empty">Leaflet не загрузился. Перезапусти приложение.</div>';
        return;
    }
    if(state.leadMap){
        try { state.leadMap.remove(); } catch(_) {}
        state.leadMap = null;
    }
    var mapEl = document.getElementById('lead-map');
    mapEl.innerHTML = ''; // wipe stub
    var map = L.map('lead-map', { worldCopyJump:true });
    state.leadMap = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 12,
    }).addTo(map);

    var bounds = [];
    function addMarker(coord, kind, label, sub){
        if(!coord) return;
        var color = kind === 'cargo_load' ? '#4ec970'
                  : kind === 'cargo_disch' ? '#e55561'
                  : '#004564';
        var icon = L.divIcon({
            className: 'lead-marker',
            html: '<div style="width:18px; height:18px; border-radius:50%; background:'+color+'; border:3px solid white; box-shadow:0 0 0 1px '+color+'; opacity:.95"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        });
        var marker = L.marker(coord, { icon: icon }).addTo(map);
        var tip = '<b>'+esc(label)+'</b>' + (sub ? '<br><span style="color:#888">'+esc(sub)+'</span>' : '');
        marker.bindTooltip(tip, {
            permanent: true,
            direction: 'top',
            offset: [0, -8],
            className: 'lead-label ' + kind.replace('_','-'),
        });
        bounds.push(coord);
    }

    var coordLoad = _portCoords(ports.cargo_load);
    var coordDisch = _portCoords(ports.cargo_disch);
    var coordOpen = _portCoords(ports.vessel_open);

    if(coordOpen) addMarker(coordOpen, 'vessel_open', '🚢 ' + (ports.vessel_open || ''), ports.vessel_summary);
    if(coordLoad) addMarker(coordLoad, 'cargo_load', '📦 ' + (ports.cargo_load || '') + ' (load)', ports.cargo_summary);
    if(coordDisch) addMarker(coordDisch, 'cargo_disch', '📦 ' + (ports.cargo_disch || '') + ' (discharge)', '');

    // Connect points with subtle great-circle-ish polyline (Leaflet auto-handles antimeridian via worldCopyJump).
    var line = [];
    if(coordOpen) line.push(coordOpen);
    if(coordLoad) line.push(coordLoad);
    if(coordDisch) line.push(coordDisch);
    if(line.length >= 2){
        L.polyline(line, { color:'#004564', weight:2, opacity:0.5, dashArray:'6 6' }).addTo(map);
    }

    if(bounds.length >= 2){
        map.fitBounds(bounds, { padding:[60,60] });
    } else if(bounds.length === 1){
        map.setView(bounds[0], 4);
    } else {
        // No coords resolved — show world.
        map.setView([20, 40], 2);
        var sidebar = document.getElementById('lead-sidebar');
        if(sidebar){
            sidebar.insertAdjacentHTML('afterbegin',
                '<div class="sub" style="color:var(--red); margin-bottom:10px;">⚠ Порты не найдены в базе координат — добавь в PORT_COORDS если нужно: '
                + esc([ports.cargo_load, ports.cargo_disch, ports.vessel_open].filter(Boolean).join(', '))
                + '</div>');
        }
    }
    // Tauri's WebView may stall layout on first map render — force refresh.
    setTimeout(function(){ if(state.leadMap) state.leadMap.invalidateSize(); }, 50);
}

// --- extracted from skipi-broker dist/index.html:9147 (setVizMode) ---
function setVizMode(mode){
    if(!state.viz) state.viz = {};
    state.viz.mode = mode;
    var s = document.getElementById('viz-mode-signals');
    var f = document.getElementById('viz-mode-flows');
    var t = document.getElementById('viz-mode-timeline');
    var sectS = document.getElementById('viz-section-signals');
    var sectF = document.getElementById('viz-section-flows');
    var sectT = document.getElementById('viz-section-timeline');
    var strip = document.getElementById('viz-timeline-strip');
    if(s) s.classList.toggle('active', mode === 'signals');
    if(f) f.classList.toggle('active', mode === 'flows');
    if(t) t.classList.toggle('active', mode === 'timeline');
    if(sectS) sectS.style.display = (mode === 'signals') ? '' : 'none';
    if(sectF) sectF.style.display = (mode === 'flows') ? '' : 'none';
    if(sectT) sectT.style.display = (mode === 'timeline') ? '' : 'none';
    if(strip) strip.style.display = (mode === 'timeline') ? '' : 'none';
    if(state.viz && state.viz.layer){
        try { state.viz.layer.clearLayers(); } catch(_){}
    }
    // Stop any running playback when leaving timeline mode.
    if(mode !== 'timeline') _tlStopPlay();
    if(mode === 'flows') renderVizFlows();
    else if(mode === 'timeline') renderVizTimeline(true);
    else renderVizMap();
}

// --- extracted from skipi-broker dist/index.html:9183 (_TL_DAY_MS) ---
const _TL_DAY_MS = 86400000;

// --- extracted from skipi-broker dist/index.html:9185 (_tlState) ---
function _tlState(){
    if(!state.viz) state.viz = {};
    if(!state.viz.tl) state.viz.tl = { days: 30, cargo: [], tonnage: [], t: new Date(), playing: false, raf: null };
    return state.viz.tl;
}

// --- extracted from skipi-broker dist/index.html:9191 (renderVizTimeline) ---
async function renderVizTimeline(reload){
    if(!state.viz || !state.viz.map) return;
    var tl = _tlState();
    var daysSel = document.getElementById('viz-tl-days');
    tl.days = parseInt((daysSel && daysSel.value) || 30, 10);
    if(reload){
        await _tlFetchSignals(tl.days);
    }
    var slider = document.getElementById('viz-tl-slider');
    if(slider){
        slider.min = 0;
        slider.max = tl.days;
        slider.step = 1;
        if(slider.value === undefined || slider.value === '' || +slider.value > +slider.max) slider.value = tl.days;
    }
    var stepFromNow = slider ? (tl.days - parseInt(slider.value, 10)) : 0;
    tl.t = new Date(Date.now() - stepFromNow * _TL_DAY_MS);
    _tlRedraw();
}

// --- extracted from skipi-broker dist/index.html:9211 (_tlFetchSignals) ---
async function _tlFetchSignals(days){
    var tl = _tlState();
    // Reuse the existing signal-list command (no server change needed).
    // Pull a large window and filter client-side by first_seen_at.
    var cutoff = new Date(Date.now() - days * _TL_DAY_MS);
    function inWindow(s){
        if(!s.first_seen_at) return false;
        return new Date(s.first_seen_at) >= cutoff;
    }
    try {
        var cargo = await invoke('fetch_bazaar_signal_list', { kind: 'cargo', limit: 2000 });
        tl.cargo = (Array.isArray(cargo) ? cargo : []).filter(inWindow);
    } catch(e){
        console.warn('tl cargo fetch failed', e);
        tl.cargo = [];
    }
    try {
        var tonn = await invoke('fetch_bazaar_signal_list', { kind: 'tonnage', limit: 2000 });
        tl.tonnage = (Array.isArray(tonn) ? tonn : []).filter(inWindow);
    } catch(e){
        console.warn('tl tonnage fetch failed', e);
        tl.tonnage = [];
    }
}

// --- extracted from skipi-broker dist/index.html:9236 (_tlSliderInput) ---
function _tlSliderInput(val){
    var tl = _tlState();
    var step = tl.days - parseInt(val, 10);
    tl.t = new Date(Date.now() - step * _TL_DAY_MS);
    _tlRedraw();
}

// --- extracted from skipi-broker dist/index.html:9243 (_tlStep) ---
function _tlStep(delta){
    var slider = document.getElementById('viz-tl-slider');
    if(!slider) return;
    var v = parseInt(slider.value, 10) + delta;
    if(v < +slider.min) v = +slider.min;
    if(v > +slider.max) v = +slider.max;
    slider.value = v;
    _tlSliderInput(v);
}

// --- extracted from skipi-broker dist/index.html:9253 (_tlJumpToNow) ---
function _tlJumpToNow(){
    var slider = document.getElementById('viz-tl-slider');
    if(!slider) return;
    slider.value = slider.max;
    _tlSliderInput(slider.value);
}

// --- extracted from skipi-broker dist/index.html:9260 (_tlTogglePlay) ---
function _tlTogglePlay(){
    var tl = _tlState();
    if(tl.playing) _tlStopPlay();
    else _tlStartPlay();
}

// --- extracted from skipi-broker dist/index.html:9266 (_tlStartPlay) ---
function _tlStartPlay(){
    var tl = _tlState();
    var btn = document.getElementById('viz-tl-play');
    if(btn){ btn.classList.add('playing'); btn.textContent = '⏸'; btn.title = 'Pause'; }
    tl.playing = true;
    var lastTick = 0;
    var DAY_DURATION_MS = 700; // 700ms per day
    function frame(ts){
        if(!tl.playing) return;
        if(!lastTick) lastTick = ts;
        if(ts - lastTick >= DAY_DURATION_MS){
            lastTick = ts;
            var slider = document.getElementById('viz-tl-slider');
            if(!slider){ _tlStopPlay(); return; }
            var v = parseInt(slider.value, 10) + 1;
            if(v > +slider.max){
                _tlStopPlay();
                return;
            }
            slider.value = v;
            _tlSliderInput(v);
        }
        tl.raf = requestAnimationFrame(frame);
    }
    tl.raf = requestAnimationFrame(frame);
}

// --- extracted from skipi-broker dist/index.html:9293 (_tlStopPlay) ---
function _tlStopPlay(){
    var tl = _tlState();
    tl.playing = false;
    if(tl.raf){ try { cancelAnimationFrame(tl.raf); } catch(_){} tl.raf = null; }
    var btn = document.getElementById('viz-tl-play');
    if(btn){ btn.classList.remove('playing'); btn.textContent = '▶'; btn.title = 'Play'; }
}

// --- extracted from skipi-broker dist/index.html:9301 (_tlActiveAt) ---
function _tlActiveAt(sig, t){
    var first = sig.first_seen_at ? new Date(sig.first_seen_at) : null;
    if(!first || first > t) return false;
    if(sig.status === 'active') return true;
    // resolved/dismissed: only show if it was still active at T
    var resolved = sig.resolved_at ? new Date(sig.resolved_at) : null;
    if(resolved && resolved > t) return true;
    var dismissed = sig.dismissed_at ? new Date(sig.dismissed_at) : null;
    if(dismissed && dismissed > t) return true;
    return false;
}

// --- extracted from skipi-broker dist/index.html:9313 (_tlRedraw) ---
function _tlRedraw(){
    if(!state.viz || !state.viz.map || !state.viz.layer) return;
    var tl = _tlState();
    var t = tl.t || new Date();
    try { state.viz.layer.clearLayers(); } catch(_){}
    var showCargo = (document.getElementById('viz-tl-cargo') || {}).checked !== false;
    var showTonn = (document.getElementById('viz-tl-tonn') || {}).checked !== false;
    var nCargo = 0, nTonn = 0;
    if(showCargo){
        (tl.cargo || []).forEach(function(c){
            if(!_tlActiveAt(c, t)) return;
            var loadC = _portCoords(c.load_port);
            if(!loadC) return;
            nCargo++;
            var color = _flowColor(c.cargo_type);
            var marker = L.circleMarker(loadC, {
                radius: 6, color: color, weight: 2, fillColor: color, fillOpacity: 0.55,
            });
            var tip = (c.cargo_type || 'cargo') + ' · ' + (c.quantity_mt || '?') + 'mt'
                    + ' · ' + (c.load_port || '?') + '→' + (c.disch_port || '?');
            marker.bindTooltip(tip, { className: 'viz-cargo-label' });
            state.viz.layer.addLayer(marker);
            var dischC = _portCoords(c.disch_port);
            if(dischC){
                state.viz.layer.addLayer(L.polyline([loadC, dischC], {
                    color: color, weight: 1.2, opacity: 0.55, dashArray: '4,3',
                }));
            }
        });
    }
    if(showTonn){
        (tl.tonnage || []).forEach(function(v){
            if(!_tlActiveAt(v, t)) return;
            var openC = _portCoords(v.open_port);
            if(!openC) return;
            nTonn++;
            var marker = L.circleMarker(openC, {
                radius: 5, color: '#004564', weight: 2, fillColor: '#004564', fillOpacity: 0.55,
            });
            var tip = (v.vessel_name || v.vessel_type || 'tonnage')
                    + (v.dwt ? ' · ' + v.dwt + 'DWT' : '')
                    + ' @ ' + (v.open_port || '?');
            marker.bindTooltip(tip, { className: 'viz-cargo-label' });
            state.viz.layer.addLayer(marker);
        });
    }
    var dateEl = document.getElementById('viz-tl-date');
    var countsEl = document.getElementById('viz-tl-counts');
    if(dateEl) dateEl.textContent = t.toISOString().slice(0,10);
    if(countsEl) countsEl.textContent = nCargo + ' cargo · ' + nTonn + ' tonnage';
}

// --- extracted from skipi-broker dist/index.html:9366 (_rgba) ---
function _rgba(hex, alpha){
    var m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if(!m) return hex;
    var i = parseInt(m[1], 16);
    return 'rgba(' + ((i>>16)&255) + ',' + ((i>>8)&255) + ',' + (i&255) + ',' + alpha + ')';
}

// --- extracted from skipi-broker dist/index.html:9376 (_flowColor) ---
function _flowColor(cargo){
    var c = (cargo || '').toLowerCase();
    // grains, oilseeds, sugar — желтые
    if(/grain|wheat|corn|barley|rice|soy|rapeseed|sun|oats|rye|sorghum|maize|sugar|millet|pea\b|bean|seed/.test(c)) return '#e2b93d';
    // minerals & ores — чёрные (per Тимур)
    if(/coal|iron|ore|bauxite|manganese|chrome|alumina|nickel|zinc|copper|lead|magnetite|hematite|pellet|sinter|slag|petcoke/.test(c)) return '#1a1a1a';
    // steel products — orange
    if(/steel|hrc|crc|rebar|billet|wire|pig\s?iron|coil|plate|slab|beam|pipe|tube|girder/.test(c)) return '#d89b65';
    // fertilizers — purple
    if(/urea|npk|dap|map|potash|sulph|sulf|fertil|ammonium|nitrate|phosphate|kcl|nitrogen|amms/.test(c)) return '#004564';
    // cement / clinker — light grey
    if(/cement|clinker|gypsum|lime|chalk/.test(c)) return '#9aa0a6';
    // bagged / project / container — blue
    if(/big[\s-]?bag|bag\b|project|container|crate|pallet|woodpulp|paper/.test(c)) return '#004564';
    // wood / logs / lumber — brown
    if(/wood|log|lumber|timber|pulp/.test(c)) return '#8b5a3c';
    // scrap / metal scrap — dark red
    if(/scrap|hms\b/.test(c)) return '#8b3a47';
    // default — green
    return '#4ec970';
}

// --- extracted from skipi-broker dist/index.html:9398 (renderVizFlows) ---
async function renderVizFlows(){
    if(!state.viz || !state.viz.map) return;
    try { state.viz.layer.clearLayers(); } catch(_){}
    var days = (document.getElementById('viz-flow-days') || {}).value || 30;
    // T3a: via Rust failover (RU↔origin) so «Грузопотоки» загружаются и на РФ-сети.
    var rows = [];
    try {
        rows = await invoke('fetch_analytics_flows', { days: parseInt(days, 10) || 30 });
    } catch(e){ console.warn('flows fetch failed', e); return; }
    if(!Array.isArray(rows)) rows = [];
    var maxSig = rows.reduce(function(m, r){ return Math.max(m, r.signals || 0); }, 1);
    var drawn = 0;
    rows.forEach(function(flow){
        var loadC = _portCoords(flow.top_load_port);
        var dischC = _portCoords(flow.top_disch_port);
        if(!loadC || !dischC) return;
        drawn++;
        // Weight: log-scale so dominant flows don't drown out the rest.
        var weight = 1 + Math.log(1 + flow.signals) * 1.6;
        var color = _flowColor(flow.top_cargo);
        var line = L.polyline([loadC, dischC], {
            color: color, weight: weight, opacity: 0.78,
        });
        var tip = '<b>'+esc(flow.from_country)+' → '+esc(flow.to_country)+'</b>'
            + '<br>сигналов: '+flow.signals
            + '<br>объём: '+(flow.total_mt ? (flow.total_mt > 1e6 ? (flow.total_mt/1e6).toFixed(1)+'M MT' : (flow.total_mt/1000).toFixed(0)+'k MT') : '—')
            + '<br>топ-груз: '+esc(flow.top_cargo || '?')
            + '<br>'+esc(flow.top_load_port || '?')+' → '+esc(flow.top_disch_port || '?');
        var br = flow.cargo_breakdown || {};
        var brKeys = Object.keys(br).slice(0, 5);
        if(brKeys.length){
            tip += '<br><span style="color:#888; font-size:10px;">распределение: ' + brKeys.map(function(k){ return esc(k)+' '+br[k]; }).join(', ') + '</span>';
        }
        line.bindTooltip(tip, { className:'viz-cargo-label', direction:'top', sticky:true });
        state.viz.layer.addLayer(line);
        // Origin dot — small green; destination — small red.
        state.viz.layer.addLayer(L.circleMarker(loadC, {
            radius: 4, color: color, weight: 1.2, fillColor: color, fillOpacity: 0.85,
        }).bindTooltip('load: '+esc(flow.top_load_port || '?'), { className:'viz-cargo-label' }));
        state.viz.layer.addLayer(L.circleMarker(dischC, {
            radius: 3.5, color: '#e55561', weight: 1.2, fillColor: '#e55561', fillOpacity: 0.7,
        }).bindTooltip('disch: '+esc(flow.top_disch_port || '?'), { className:'viz-cargo-label' }));
    });
    var cnt = document.getElementById('viz-visible-count');
    if(cnt) cnt.textContent = drawn;
    var hint = document.getElementById('viz-empty-hint');
    if(hint){
        hint.innerHTML = drawn === 0
            ? 'Нет грузопотоков с известными портами в выборке. Расширь период.'
            : '🌊 ' + drawn + ' пар порт↔порт за '+days+' дн. Толщина линии — лог. от объёма сигналов; цвет — топ-груз.';
    }
}

// --- extracted from skipi-broker dist/index.html:9459 (_vizFilterCargo) ---
function _vizFilterCargo(s){
    var region = (document.getElementById('viz-region') || {}).value || '';
    var size = (document.getElementById('viz-size') || {}).value || '';
    var age = (document.getElementById('viz-age') || {}).value || '';
    if(region && !_signalsRegionMatch(s, region)) return false;
    if(size && !_signalsSizeMatch(s, 'cargo', size)) return false;
    if(age && s.first_seen_at){
        var hrs = (Date.now() - Date.parse(s.first_seen_at)) / 3600000;
        if(age === '6h' && hrs > 6) return false;
        if(age === '24h' && hrs > 24) return false;
        if(age === '72h' && hrs > 72) return false;
    }
    return true;
}

// --- extracted from skipi-broker dist/index.html:9474 (_vizInitMap) ---
function _vizInitMap(){
    if(typeof L === 'undefined'){
        document.getElementById('viz-map').innerHTML = '<div class="col-empty">Leaflet не загрузился.</div>';
        return null;
    }
    if(state.viz.map) return state.viz.map;
    // Solid sea + country contours only — no OSM tiles, no landscape.
    // The "wow effect" geography Тимур wants for Posidonia demos.
    var map = L.map('viz-map', {
        worldCopyJump:true, preferCanvas:true,
        zoomControl:true, attributionControl:false,
        minZoom:2, maxZoom:8,
    });
    map.getContainer().classList.add('viz-mapbg');
    map.setView([25, 30], 2);
    state.viz.map = map;
    state.viz.countries = L.layerGroup().addTo(map);
    state.viz.layer = L.layerGroup().addTo(map);
    // Land polygons — subtle fill + crisp border. Loaded once, cached.
    fetch('leaflet/world.geojson').then(function(r){ return r.json(); }).then(function(gj){
        var isLight = (document.documentElement.getAttribute('data-theme') === 'light');
        var landFill   = isLight ? '#f4f7fb' : '#1a2535';
        var landStroke = isLight ? '#8a9bb0' : '#3d5775';
        L.geoJSON(gj, {
            style: function(){ return {
                fillColor: landFill, fillOpacity: 1,
                color: landStroke, weight: 0.7, opacity: 0.9,
                interactive: false,
            }; },
        }).addTo(state.viz.countries);
        try { map.invalidateSize(); } catch(_){}
    }).catch(function(e){ console.warn('world.geojson load failed', e); });
    // Tauri WebView occasionally stalls layout on first map render —
    // fire invalidateSize multiple times so contoured layout settles
    // even if the initial paint happened before the container had
    // its final width/height (Тимур 03.06: «сперва грузится коряво»).
    [50, 150, 350, 800].forEach(function(d){
        setTimeout(function(){ try { map.invalidateSize(); } catch(_){} }, d);
    });
    return map;
}

// --- extracted from skipi-broker dist/index.html:9519 (_vizCargoSignalMatchIndex) ---
function _vizCargoSignalMatchIndex(){
    // Primary source: state.bazaarPairs (bazaar × bazaar pairs, the global
    // signal index). state.inbox.bazaar_matches is broker-scoped own×bazaar
    // and returns nothing if the broker has no own listings — which leaves
    // the map empty. bxb pairs is what makes the map a market dashboard.
    var idx = {};
    var pairs = (state.bazaarPairs || []);
    pairs.forEach(function(p){
        var cs = p.cargo_signal;
        if(!cs || !cs.id) return;
        if(!idx[cs.id]) idx[cs.id] = [];
        idx[cs.id].push({
            id: p.id,
            score: p.score,
            bazaar_cargo_signal: cs,
            bazaar_tonnage_signal: p.tonnage_signal,
            reasons: p.reasons,
        });
    });
    // Fallback merge: also include own × bazaar matches if any are present —
    // they participate in the same map view for brokers that have listings.
    var bm = (state.inbox && state.inbox.bazaar_matches) || [];
    bm.forEach(function(m){
        var cs = m.bazaar_cargo_signal;
        if(!cs || !cs.id) return;
        if(!idx[cs.id]) idx[cs.id] = [];
        idx[cs.id].push(m);
    });
    return idx;
}

// --- extracted from skipi-broker dist/index.html:9550 (renderVizMap) ---
function renderVizMap(){
    var map = _vizInitMap();
    if(!map) return;
    state.viz.layer.clearLayers();
    var showCargo = (document.getElementById('viz-show-cargo') || {}).checked;
    // IMPORTANT: build the cargo set from bazaar_matches directly, NOT from
    // state.signalsBrowse.cargo. signalsBrowse is the "active feed" — a
    // matched cargo signal may have aged out of it (snapshot in match still
    // valid). Iterating signalsBrowse silently drops valid matches.
    var matchIdx = _vizCargoSignalMatchIndex();
    var seen = {};
    var cargoes = [];
    Object.keys(matchIdx).forEach(function(sigId){
        var first = matchIdx[sigId][0];
        var snap = (first && first.bazaar_cargo_signal) || null;
        if(!snap) return;
        if(seen[snap.id]) return;
        seen[snap.id] = 1;
        cargoes.push(snap);
    });
    var visible = [];
    if(showCargo){
        cargoes.forEach(function(s){
            var matches = matchIdx[s.id] || [];
            if(matches.length === 0) return;
            if(!_vizFilterCargo(s)) return;
            var loadC = _portCoords(s.load_port);
            var dischC = _portCoords(s.disch_port);
            if(!loadC) return;
            s._vizMatches = matches;       // cache for list + click navigation
            visible.push(s);
            var hot = matches.some(function(m){ return (m.score || 0) >= 80; });
            // Cargo-type color: жёлтый зерно, чёрный минералы, ...
            var cargoColor = _flowColor(s.cargo_type);
            var glow = hot
                ? '0 0 10px '+cargoColor+', 0 0 20px '+_rgba(cargoColor, 0.7)
                : '0 0 6px '+_rgba(cargoColor, 0.55);
            // Pulsing origin dot — divIcon с inline color чтобы каждая точка
            // светилась цветом своего груза.
            var icon = L.divIcon({
                className:'',
                html:'<div class="viz-pulse'+(hot?' hot':'')+'">'
                   + '<div class="ring" style="border-color:'+cargoColor+';"></div>'
                   + '<div class="core" style="background:'+cargoColor+'; box-shadow:'+glow+';"></div>'
                   + '</div>',
                iconSize:[14,14], iconAnchor:[7,7],
            });
            var marker = L.marker(loadC, { icon:icon, riseOnHover:true });
            var label = (s.cargo_type || s.title || '?')
                      + (s.quantity_mt ? ' · '+s.quantity_mt+' MT' : '')
                      + ' <span class="vz-badge">' + matches.length + '</span>';
            marker.bindTooltip(label, { className:'viz-cargo-label', direction:'top', offset:[0,-10] });
            marker.on('click', function(){ vizOpenSignalMatches(s.id); });
            state.viz.layer.addLayer(marker);
            // Route line to destination — cargo-colored.
            if(dischC){
                var line = L.polyline([loadC, dischC], {
                    color:cargoColor, weight:1.6, opacity:0.55, dashArray:'4 6',
                });
                state.viz.layer.addLayer(line);
                var dischDot = L.circleMarker(dischC, {
                    radius: 3.5, color:cargoColor, weight:1.2,
                    fillColor:cargoColor, fillOpacity:0.45,
                });
                dischDot.bindTooltip('↓ ' + (s.disch_port || '?'), { className:'viz-cargo-label', direction:'top', offset:[0,-4] });
                dischDot.on('click', function(){ vizOpenSignalMatches(s.id); });
                state.viz.layer.addLayer(dischDot);
            }
        });
    }
    document.getElementById('viz-visible-count').textContent = visible.length;
    _vizRenderList(visible);
    // Demo-friendly empty-state hint: if we have matched cargoes but none
    // resolved to a port coordinate, surface that explicitly so the broker
    // doesn't think the module is broken.
    var hintHost = document.getElementById('viz-empty-hint');
    if(hintHost){
        if(cargoes.length === 0){
            hintHost.style.display = 'none';
        } else if(visible.length === 0){
            hintHost.style.display = '';
            hintHost.innerHTML = '<b>'+cargoes.length+'</b> совпадений в базе,<br>'
                + 'но порты ('+esc((cargoes[0] && cargoes[0].load_port) || '?')+'…)<br>'
                + 'не распознаны в каталоге координат.';
        } else {
            hintHost.style.display = 'none';
        }
    }
}

// --- extracted from skipi-broker dist/index.html:9642 (vizOpenSignalMatches) ---
function vizOpenSignalMatches(signalId){
    var matches = (_vizCargoSignalMatchIndex()[signalId] || []).slice();
    // Right view name is 'match' (single) — showView('matches') was a typo
    // that hit the guard and returned silently, so clicking pulse dots
    // looked dead. Тимур 03.06: «при нажатии ничего не происходит».
    if(matches.length === 0){ showView('match'); return; }
    matches.sort(function(a, b){ return (b.score || 0) - (a.score || 0); });
    var pick = matches[0];
    showView('match');
    setTimeout(function(){
        try { selectMatch('bazaar', pick.id); } catch(e){ console.warn('selectMatch failed', e); }
    }, 40);
}

// --- extracted from skipi-broker dist/index.html:9656 (_vizCargoPopup) ---
function _vizCargoPopup(s){
    var lines = [];
    lines.push('<b>'+esc(s.cargo_type || s.title || 'Cargo')+'</b>');
    if(s.quantity_mt) lines.push('Кол-во: '+s.quantity_mt+' MT');
    lines.push('Маршрут: '+esc(s.load_port || '?')+' → '+esc(s.disch_port || '?'));
    if(s.laycan_from || s.laycan_to) lines.push('Laycan: '+(s.laycan_from||'').slice(0,10)+' — '+(s.laycan_to||'').slice(0,10));
    if(s.rate_indication) lines.push('Рейт: '+esc(s.rate_indication));
    lines.push('<span style="font-size:10px; color:#888;">id '+esc((s.id||'').slice(0,8))+'</span>');
    return lines.join('<br>');
}

// --- extracted from skipi-broker dist/index.html:9667 (_vizRenderList) ---
function _vizRenderList(visible){
    var host = document.getElementById('viz-visible-list');
    if(!host) return;
    if(visible.length === 0){
        host.innerHTML = '<div class="viz-list-item" style="cursor:default;">Под фильтр ничего.</div>';
        return;
    }
    // Sort: freshest first.
    visible.sort(function(a, b){
        return Date.parse(b.first_seen_at || '') - Date.parse(a.first_seen_at || '');
    });
    host.innerHTML = visible.slice(0, 50).map(function(s){
        var title = (s.cargo_type || s.title || '?').slice(0, 30);
        var meta = (s.quantity_mt ? s.quantity_mt+' MT · ' : '') + (s.load_port || '?')+' → '+(s.disch_port || '?');
        var nMatches = (s._vizMatches && s._vizMatches.length) || 0;
        var badge = nMatches ? ' <span class="vz-badge" style="background:#004564;color:#fff;padding:0 5px;border-radius:8px;font-size:9px;">'+nMatches+'</span>' : '';
        return '<div class="viz-list-item" onclick="vizOpenSignalMatches(\''+esc(s.id)+'\')">'
             + '<div class="vli-title">'+esc(title)+badge+'</div>'
             + '<div class="vli-meta">'+esc(meta)+'</div>'
             + '</div>';
    }).join('');
}

// --- extracted from skipi-broker dist/index.html:9690 (vizFocusSignal) ---
function vizFocusSignal(id){
    var s = (state.signalsBrowse.cargo || []).filter(function(x){ return x.id === id; })[0];
    if(!s || !state.viz.map) return;
    var loadC = _portCoords(s.load_port);
    var dischC = _portCoords(s.disch_port);
    if(loadC && dischC){
        state.viz.map.fitBounds([loadC, dischC], { padding:[60,60] });
    } else if(loadC){
        state.viz.map.setView(loadC, 6);
    }
}
