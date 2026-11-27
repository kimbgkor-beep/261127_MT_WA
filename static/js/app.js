(() => {
  const RAIN_COLORS = ['#a0a0a0', '#64d8ff', '#2380e8', '#24aa56', '#f2cd24', '#f68b20', '#e52c35'];
  const RAIN_LABELS = ['0', '0 초과 ~ 5 미만', '5 ~ 15 미만', '15 ~ 30 미만', '30 ~ 50 미만', '50 ~ 80 미만', '80 이상'];

  const map = L.map('map', {
    center: [36.35, 127.75],
    zoom: 7,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  L.control.scale({ imperial: false }).addTo(map);

  const singleLayer = L.layerGroup().addTo(map);
  const overlapLayer = L.layerGroup().addTo(map);
  const hazardLayer = L.layerGroup().addTo(map);
  const railLayer = L.layerGroup().addTo(map);
  const weatherLayer = L.layerGroup().addTo(map);
  const trainLayer = L.layerGroup().addTo(map);

  L.control.layers(
    null,
    {
      '철도 경로': railLayer,
      '단일 영향 범위': singleLayer,
      '중복 영향 범위': overlapLayer,
      '기상관측소': weatherLayer,
      '위험기상 구역': hazardLayer,
      '열차': trainLayer,
    },
    { position: 'topleft', collapsed: window.innerWidth < 768 }
  ).addTo(map);

  const state = {
    running: true,
    speedMultiplier: 1,
    trains: [],
    stations: [],
    zones: [],
    followedTrainId: null,
    lastFrameTime: performance.now(),
    lastUiSync: 0,
  };

  // DOM elements
  const loadingEl = document.getElementById('loading-overlay');
  const rowsEl = document.getElementById('rw-rows');
  const summaryEl = document.getElementById('rw-summary');
  const timeEl = document.getElementById('rw-time');
  const metricTotalEl = document.getElementById('metric-total');
  const metricOkEl = document.getElementById('metric-ok');
  const metricWarnEl = document.getElementById('metric-warn');
  const metricWarnPillEl = document.getElementById('metric-warn-pill');
  const toggleBtn = document.getElementById('rw-toggle');
  const refreshBtn = document.getElementById('rw-refresh');
  const simBadgeEl = document.getElementById('sim-state-badge');
  const unfollowBtn = document.getElementById('btn-unfollow');
  const sidePanel = document.getElementById('rw-panel');
  const drawerToggleBtn = document.getElementById('btn-drawer-toggle');
  const sheetHandleBtn = document.getElementById('sheet-handle');

  // Render rainfall legend
  document.getElementById('rw-rain-legend').innerHTML = RAIN_LABELS.map(
    (label, idx) =>
      `<div class="rain-item"><span class="rain-dot" style="background:${RAIN_COLORS[idx]}"></span><span>${label}</span></div>`
  ).join('');

  function rainColor(r) {
    const idx = r === 0 ? 0 : r < 5 ? 1 : r < 15 ? 2 : r < 30 ? 3 : r < 50 ? 4 : r < 80 ? 5 : 6;
    return RAIN_COLORS[idx];
  }

  function createTrainIcon(bad) {
    return L.divIcon({
      className: '',
      html: `<div class="train-marker ${bad ? 'bad' : ''}">${bad ? '⚠️' : '🚆'}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function buildRouteSegments(coords) {
    const cumDist = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      cumDist.push(total);
    }
    return { coords, cumDist, totalDist: total };
  }

  function interpolateRoute(route, dist) {
    const { coords, cumDist, totalDist } = route;
    if (dist <= 0) return { lat: coords[0][0], lng: coords[0][1] };
    if (dist >= totalDist) {
      const last = coords[coords.length - 1];
      return { lat: last[0], lng: last[1] };
    }
    let lo = 0;
    let hi = cumDist.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] <= dist) lo = mid;
      else hi = mid;
    }
    const segLen = cumDist[hi] - cumDist[lo] || 1;
    const t = (dist - cumDist[lo]) / segLen;
    return {
      lat: coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
      lng: coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
    };
  }

  function renderZones(zones) {
    hazardLayer.clearLayers();
    state.zones = zones.map((z) => {
      L.circle([z.lat, z.lng], {
        radius: z.radius,
        color: z.color,
        weight: 2,
        dashArray: '5 4',
        fillColor: z.color,
        fillOpacity: 0.18,
      })
        .bindTooltip(`${z.name} 위험구역 · ${(z.radius / 1000).toFixed(1)} km`)
        .addTo(hazardLayer);
      return z;
    });
  }

  function applyRainfall(rainfallMap) {
    state.stations.forEach((st) => {
      const val = rainfallMap[st.id] ?? 0;
      st.marker.setStyle({ fillColor: rainColor(val) });
      st.marker.bindTooltip(`${st.id}: ${val.toFixed(1)} mm/h`);
    });
  }

  async function refreshZones() {
    try {
      const res = await fetch('/api/zones');
      const data = await res.json();
      renderZones(data.zones);
      evaluateAllTrains(true);
    } catch (err) {
      console.error('Failed to refresh zones:', err);
    }
  }

  async function refreshRainfall() {
    try {
      const res = await fetch('/api/rainfall');
      const data = await res.json();
      applyRainfall(data.rainfall);
    } catch (err) {
      console.error('Failed to refresh rainfall:', err);
    }
  }

  function evaluateTrainRisk(train) {
    const risks = [];
    for (const z of state.zones) {
      if (haversineMeters(train.lat, train.lng, z.lat, z.lng) <= z.radius) {
        if (!risks.includes(z.name)) risks.push(z.name);
      }
    }
    const bad = risks.length > 0;
    const statusText = bad ? `⚠ ${risks.join('·')}` : '정상';
    const changed = bad !== train.bad || statusText !== train.statusText;
    if (bad !== train.bad) {
      train.marker.setIcon(createTrainIcon(bad));
      train.bad = bad;
    }
    train.statusText = statusText;
    return changed;
  }

  function updateTrainInfoAndUI() {
    let warningCount = 0;
    const rowsHtml = [];

    for (const t of state.trains) {
      if (t.bad) warningCount++;
      const pct = Math.round((t.dist / t.route.totalDist) * 100);
      const dirLabel = t.dir > 0 ? '하행 →' : '← 상행';
      const infoHtml = `<b>${t.id}</b> (${dirLabel})<br>${t.statusText}<br>진행률 ${pct}% · ${t.displayKmh} km/h<br>위도 ${t.lat.toFixed(4)} / 경도 ${t.lng.toFixed(4)}`;

      t.marker.setTooltipContent(`${t.id} / ${t.statusText}`);
      if (t.marker.getPopup()) {
        t.marker.setPopupContent(infoHtml);
      } else {
        t.marker.bindPopup(infoHtml);
      }

      const followingClass = state.followedTrainId === t.id ? 'following' : '';
      rowsHtml.push(
        `<tr data-train-id="${t.id}" class="${followingClass}">
          <td><span class="train-name">${t.id}</span><span class="train-dir">${dirLabel} · ${t.displayKmh}km/h</span></td>
          <td class="progress-cell">${pct}%</td>
          <td class="${t.bad ? 'status-warn' : 'status-ok'}">${t.statusText}</td>
        </tr>`
      );
    }

    rowsEl.innerHTML = rowsHtml.join('');
    const total = state.trains.length;
    const okCount = total - warningCount;
    summaryEl.innerHTML = `전체 ${total}대 · 정상 ${okCount}대 · <b style="color:#b91c1c">경고 ${warningCount}대</b>`;
    metricTotalEl.textContent = String(total);
    metricOkEl.textContent = String(okCount);
    metricWarnEl.textContent = String(warningCount);
    metricWarnPillEl.classList.toggle('has-warning', warningCount > 0);
    timeEl.textContent = new Date().toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour12: false,
    });
  }

  function evaluateAllTrains(forceUi) {
    let anyChanged = false;
    for (const t of state.trains) {
      if (evaluateTrainRisk(t)) anyChanged = true;
    }
    if (forceUi || anyChanged) {
      updateTrainInfoAndUI();
    }
  }

  function animate(now) {
    const dt = Math.min((now - state.lastFrameTime) / 1000, 0.1);
    state.lastFrameTime = now;

    if (state.running && state.trains.length > 0) {
      let statusChanged = false;
      for (const t of state.trains) {
        t.dist += t.dir * t.simSpeedMps * state.speedMultiplier * dt;
        if (t.dist >= t.route.totalDist) {
          t.dist = t.route.totalDist;
          t.dir = -1;
        } else if (t.dist <= 0) {
          t.dist = 0;
          t.dir = 1;
        }
        const pos = interpolateRoute(t.route, t.dist);
        t.lat = pos.lat;
        t.lng = pos.lng;
        t.marker.setLatLng([pos.lat, pos.lng]);

        if (evaluateTrainRisk(t)) {
          statusChanged = true;
        }

        if (state.followedTrainId === t.id) {
          map.panTo([pos.lat, pos.lng], { animate: false });
        }
      }

      if (statusChanged || now - state.lastUiSync > 200) {
        updateTrainInfoAndUI();
        state.lastUiSync = now;
      }
    } else if (now - state.lastUiSync > 1000) {
      timeEl.textContent = new Date().toLocaleTimeString('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour12: false,
      });
      state.lastUiSync = now;
    }

    requestAnimationFrame(animate);
  }

  function setDrawerOpen(open) {
    sidePanel.classList.toggle('open', open);
    drawerToggleBtn.setAttribute('aria-expanded', String(open));
    drawerToggleBtn.textContent = open ? '지도 크게 보기' : '모니터링 패널';
    setTimeout(() => map.invalidateSize(), 260);
  }

  drawerToggleBtn.addEventListener('click', () => {
    setDrawerOpen(!sidePanel.classList.contains('open'));
  });

  sheetHandleBtn.addEventListener('click', () => {
    setDrawerOpen(!sidePanel.classList.contains('open'));
  });

  toggleBtn.addEventListener('click', () => {
    state.running = !state.running;
    toggleBtn.textContent = state.running ? '이동 정지' : '이동 시작';
    simBadgeEl.textContent = state.running ? '연속 운행 중' : '일시 정지';
    simBadgeEl.classList.toggle('paused', !state.running);
  });

  refreshBtn.addEventListener('click', refreshZones);

  document.querySelectorAll('.btn-speed').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-speed').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.speedMultiplier = Number(btn.dataset.speed) || 1;
    });
  });

  rowsEl.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-train-id]');
    if (!row) return;
    const train = state.trains.find((t) => t.id === row.dataset.trainId);
    if (!train) return;
    state.followedTrainId = train.id;
    unfollowBtn.classList.remove('hidden');
    map.setView([train.lat, train.lng], Math.max(map.getZoom(), 9), { animate: true });
    train.marker.openPopup();
    if (window.innerWidth <= 900) {
      setDrawerOpen(false);
    }
    updateTrainInfoAndUI();
  });

  unfollowBtn.addEventListener('click', () => {
    state.followedTrainId = null;
    unfollowBtn.classList.add('hidden');
    updateTrainInfoAndUI();
  });

  window.addEventListener('resize', () => {
    map.invalidateSize();
  });

  async function init() {
    try {
      const res = await fetch('/api/network');
      const data = await res.json();

      // Buffers
      if (data.buffers.single) {
        L.geoJSON(data.buffers.single, {
          style: { fillColor: '#0066ff', color: '#0066ff', weight: 0, fillOpacity: 0.25 },
        }).addTo(singleLayer);
      }
      if (data.buffers.overlap) {
        L.geoJSON(data.buffers.overlap, {
          style: { fillColor: '#ff0000', color: '#ff0000', weight: 0, fillOpacity: 0.45 },
        }).addTo(overlapLayer);
      }

      // Railway paths & trains
      const trainPerLine = data.config.trainCountPerLine || 3;
      Object.entries(data.paths).forEach(([lineName, routeObj]) => {
        L.polyline(routeObj.coords, {
          color: '#333333',
          weight: 2.5,
        })
          .bindTooltip(lineName)
          .addTo(railLayer);

        const route = buildRouteSegments(routeObj.coords);
        for (let i = 0; i < trainPerLine; i++) {
          // Distribute trains evenly with slight jitter so they don't overlap at start
          const ratio = (i + 0.25 + Math.random() * 0.5) / trainPerLine;
          const dist = Math.min(route.totalDist, Math.max(0, ratio * route.totalDist));
          const pos = interpolateRoute(route, dist);
          const id = `${lineName} ${i + 1}`;
          const marker = L.marker([pos.lat, pos.lng], {
            icon: createTrainIcon(false),
            zIndexOffset: 1000,
          })
            .bindTooltip(`${id} / 정상`)
            .addTo(trainLayer);

          const simSpeedMps = 1600 + Math.random() * 1200; // smooth continuous visual speed across Korea
          const displayKmh = Math.round(180 + (simSpeedMps - 1600) / 10);

          state.trains.push({
            id,
            lineName,
            route,
            dist,
            dir: Math.random() < 0.5 ? -1 : 1,
            simSpeedMps,
            displayKmh,
            lat: pos.lat,
            lng: pos.lng,
            marker,
            bad: false,
            statusText: '정상',
          });
        }
      });

      // Weather stations
      data.stations.forEach((st) => {
        const marker = L.circleMarker([st.lat, st.lng], {
          radius: 6,
          color: '#555',
          weight: 1,
          fillOpacity: 0.95,
        }).addTo(weatherLayer);
        state.stations.push({ id: st.id, marker });
      });

      renderZones(data.zones);
      applyRainfall(data.rainfall);
      evaluateAllTrains(true);

      setInterval(refreshRainfall, data.config.rainMs || 5000);
      setInterval(refreshZones, data.config.zoneMs || 30000);

      loadingEl.classList.add('hidden');
      state.lastFrameTime = performance.now();
      requestAnimationFrame(animate);
    } catch (err) {
      loadingEl.innerHTML = '<span>데이터를 불러오지 못했습니다. 새로고침해 주세요.</span>';
      console.error('Initialization failed:', err);
    }
  }

  init();
})();
