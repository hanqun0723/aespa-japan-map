(() => {
  "use strict";

  const STORAGE_KEYS = {
    PLACES_OVERRIDE: "aespa_places_override_v1",
    PLACES_DIRTY: "aespa_places_dirty_v1",
    BOOKMARKS: "aespa_bookmarks_v1",
    VISITED: "aespa_visited_v1",
    GH_CONFIG: "aespa_gh_config_v1",
  };

  const DEFAULT_GH_REPO = "hanqun0723/aespa-japan-map";

  const REGIONS = [
    { id: "東京・關東", label: "東京・關東" },
    { id: "ALL", label: "全日本" },
    { id: "大阪・京都", label: "大阪・京都" },
    { id: "沖繩", label: "沖繩" },
    { id: "福岡", label: "福岡" },
    { id: "北海道", label: "北海道" },
  ];

  const MEMBERS = [
    { id: "ALL", label: "全部" },
    { id: "Karina", label: "Karina" },
    { id: "Giselle", label: "Giselle" },
    { id: "Winter", label: "Winter" },
    { id: "Ningning", label: "Ningning" },
    { id: "GROUP", label: "多人同行" },
  ];

  const CATEGORIES = [
    { id: "ALL", label: "全部類型" },
    { id: "餐廳", label: "🍽️ 餐廳" },
    { id: "咖啡廳", label: "☕ 咖啡甜點" },
    { id: "購物", label: "🛍️ 購物選物" },
    { id: "景點", label: "📸 景點街拍" },
    { id: "MV取景", label: "🎬 MV取景" },
    { id: "演出場館", label: "🎤 演出場館" },
  ];

  const CURATED_ROUTES = [
    {
      id: "tokyo-harajuku-omotesando",
      label: "東京：原宿—表參道—澀谷線",
      region: "東京・關東",
    },
    {
      id: "tokyo-roppongi-akasaka",
      label: "東京：六本木—麻布台—赤坂線",
      region: "東京・關東",
    },
    {
      id: "shinjuku-hot-mess",
      label: "新宿：《Hot Mess》MV 線",
      region: "東京・關東",
    },
    {
      id: "osaka-shinsaibashi",
      label: "大阪：心齋橋—美國村—梅田線",
      region: "大阪・京都",
    },
  ];

  const MEMBER_COLORS = {
    Karina: "#2563EB",
    Giselle: "#EC4899",
    Winter: "#0891B2",
    Ningning: "#7C3AED",
  };

  const MEMBER_INITIAL = {
    Karina: "K",
    Giselle: "G",
    Winter: "W",
    Ningning: "N",
  };

  const state = {
    places: [],
    localApiAvailable: false,
    hasUnsyncedLocalEdits: false,
    region: "東京・關東",
    member: "ALL",
    category: "ALL",
    search: "",
    onlyHasIg: false,
    onlySaved: false,
    onlyVisited: false,
    hideClosed: false,
    activeRoute: null,
    selectedId: null,
    pickingMapCoords: false,
    bookmarks: new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.BOOKMARKS) || "[]")),
    visited: new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.VISITED) || "[]")),
  };

  let map = null;
  let clusterGroup = null;
  let routePolyline = null;
  let userLocationMarker = null;
  let baseLayers = {};
  const markerById = new Map();

  // ==================== UTILITIES ====================
  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  let toastTimer = null;
  function showToast(msg, duration = 2600) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
  }

  function buildGoogleMapsSearchUrl(place) {
    const q = [place.name_ja || place.name || "", place.address || ""].filter(Boolean).join(" ").trim();
    const encodedQ = encodeURIComponent(q || `${place.lat},${place.lng}`);
    const pid = (place.place_id || "").trim();
    if (pid.startsWith("ChIJ")) {
      return `https://www.google.com/maps/search/?api=1&query=${encodedQ}&query_place_id=${encodeURIComponent(pid)}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodedQ}`;
  }

  function buildGoogleMapsDirUrl(place) {
    const dest = encodeURIComponent(place.address || `${place.lat},${place.lng}`);
    const pid = (place.place_id || "").trim();
    if (pid.startsWith("ChIJ")) {
      return `https://www.google.com/maps/dir/?api=1&destination=${dest}&destination_place_id=${encodeURIComponent(pid)}`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  }

  function saveUserSets() {
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify([...state.bookmarks]));
    localStorage.setItem(STORAGE_KEYS.VISITED, JSON.stringify([...state.visited]));
  }

  // ==================== MAP INITIALIZATION ====================
  function initMap() {
    map = L.map("mapContainer", {
      center: [35.6685, 139.715],
      zoom: 13,
      zoomControl: false,
      tap: false,
    });

    L.tileLayer("https://mt1.google.com/vt/lyrs=m&hl=zh-TW&gl=JP&x={x}&y={y}&z={z}", {
      attribution: "&copy; Google Maps",
      maxZoom: 20,
    }).addTo(map);

    // Prevent touch/wheel gestures on bottom sheets from panning/zooming the map underneath
    const sidebarEl = document.getElementById("sidebarPanel");
    const detailEl = document.getElementById("detailCard");
    if (sidebarEl) {
      L.DomEvent.disableClickPropagation(sidebarEl);
      L.DomEvent.disableScrollPropagation(sidebarEl);
    }
    if (detailEl) {
      L.DomEvent.disableClickPropagation(detailEl);
      L.DomEvent.disableScrollPropagation(detailEl);
    }

    clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 38,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        const size = count >= 20 ? 44 : count >= 8 ? 38 : 34;
        return L.divIcon({
          html: `<div class="aespa-cluster" style="width:${size}px;height:${size}px;">${count}</div>`,
          className: "aespa-pin-wrapper",
          iconSize: L.point(size, size),
        });
      },
    });
    map.addLayer(clusterGroup);

    map.on("click", (ev) => {
      if (state.pickingMapCoords) {
        const lat = Number(ev.latlng.lat.toFixed(6));
        const lng = Number(ev.latlng.lng.toFixed(6));
        document.getElementById("editLat").value = lat;
        document.getElementById("editLng").value = lng;
        exitMapPickMode(true);
        showToast(`已帶入座標：${lat}, ${lng}`);
        return;
      }
      if (window.innerWidth <= 860 && state.selectedId) {
        closeDetailCard();
      }
    });
  }

  function createPinIcon(place, isSelected, routeOrderIndex = null) {
    const members = place.members || [];
    const isClosed = place.business_status === "CLOSED_PERMANENTLY";
    const isGroup = members.length > 1;

    let fillDef = "";
    let fillRef = "";
    let badgeText = "";

    if (isClosed) {
      fillRef = "#94A3B8";
      badgeText = "閉";
    } else if (isGroup) {
      const gradId = `grad-${place.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      fillDef = `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#2563EB"/>
        <stop offset="36%" stop-color="#0891B2"/>
        <stop offset="72%" stop-color="#EC4899"/>
        <stop offset="100%" stop-color="#7C3AED"/>
      </linearGradient></defs>`;
      fillRef = `url(#${gradId})`;
      badgeText = members.length === 4 ? "ALL" : `${members.length}`;
    } else {
      const m = members[0] || "Karina";
      fillRef = MEMBER_COLORS[m] || "#2563EB";
      badgeText = MEMBER_INITIAL[m] || "A";
    }

    if (routeOrderIndex !== null) {
      badgeText = String(routeOrderIndex + 1);
    }

    const fontSize = badgeText.length >= 3 ? "7.5" : badgeText.length === 2 ? "9" : "10.5";
    const html = `
      <div class="aespa-pin ${isSelected ? "is-active" : ""} ${isClosed ? "closed-pin" : ""}">
        <svg viewBox="0 0 36 44" width="34" height="42" xmlns="http://www.w3.org/2000/svg">
          ${fillDef}
          <path d="M18 1.5C9.44 1.5 2.5 8.44 2.5 17c0 10.9 15.5 25 15.5 25s15.5-14.1 15.5-25c0-8.56-6.94-15.5-15.5-15.5z"
                fill="${fillRef}" stroke="#FFFFFF" stroke-width="2.2"/>
          <circle cx="18" cy="16.8" r="9.6" fill="#FFFFFF"/>
          <text x="18" y="20.4" text-anchor="middle" fill="#121521" font-family="Plus Jakarta Sans, sans-serif" font-weight="800" font-size="${fontSize}">${esc(badgeText)}</text>
        </svg>
      </div>
    `;

    return L.divIcon({
      html,
      className: "aespa-pin-wrapper",
      iconSize: [34, 42],
      iconAnchor: [17, 41],
    });
  }

  // ==================== DATA LOADING & PERSISTENCE ====================
  async function loadInitialData() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1400);
      const healthRes = await fetch("./api/health", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (health && health.editable) {
          state.localApiAvailable = true;
        }
      }
    } catch (_) {
      state.localApiAvailable = false;
    }

    if (state.localApiAvailable) {
      const res = await fetch("./api/places", { cache: "no-store" });
      state.places = await res.json();
      state.hasUnsyncedLocalEdits = false;
    } else {
      const res = await fetch(`./data/places.json?t=${Date.now()}`, { cache: "no-store" });
      const remotePlaces = await res.json();
      const dirty = localStorage.getItem(STORAGE_KEYS.PLACES_DIRTY) === "1";
      const overrideRaw = localStorage.getItem(STORAGE_KEYS.PLACES_OVERRIDE);
      if (dirty && overrideRaw) {
        try {
          state.places = JSON.parse(overrideRaw);
          state.hasUnsyncedLocalEdits = true;
        } catch (_) {
          state.places = remotePlaces;
        }
      } else {
        state.places = remotePlaces;
      }
    }

    updateSyncIndicators();
    renderAll(true);

    // Check URL hash for deep-linked spot (#spot=jp-tokyo-001)
    const hashMatch = location.hash.match(/spot=([A-Za-z0-9_-]+)/);
    if (hashMatch) {
      const target = state.places.find((p) => p.id === hashMatch[1]);
      if (target) {
        if (state.region !== "ALL" && target.region !== state.region) {
          state.region = target.region || "ALL";
        }
        renderAll(false);
        selectPlace(target.id, true);
      }
    }
  }

  async function persistPlaces(toastMessage = "已儲存變更") {
    if (state.localApiAvailable) {
      const res = await fetch("./api/places", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.places),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) {
        throw new Error(out.error || "寫入本地伺服器失敗");
      }
      localStorage.removeItem(STORAGE_KEYS.PLACES_DIRTY);
      localStorage.removeItem(STORAGE_KEYS.PLACES_OVERRIDE);
      state.hasUnsyncedLocalEdits = false;
      updateSyncIndicators();
      showToast(`${toastMessage}（已寫入 data/places.json）`);
    } else {
      localStorage.setItem(STORAGE_KEYS.PLACES_OVERRIDE, JSON.stringify(state.places));
      localStorage.setItem(STORAGE_KEYS.PLACES_DIRTY, "1");
      state.hasUnsyncedLocalEdits = true;
      updateSyncIndicators();

      // If user configured GitHub Token, offer or auto-push
      const gh = getGhConfig();
      if (gh.token && gh.repo) {
        try {
          await pushPlacesToGithubApi(false);
          showToast(`${toastMessage}（已同步寫入 GitHub 雲端！）`);
          return;
        } catch (err) {
          showToast(`${toastMessage}（已暫存於手機；GitHub 同步失敗：${err.message}）`, 4000);
          return;
        }
      }
      showToast(`${toastMessage}（已保存於此瀏覽器，可點右上 ☁️ 同步至 GitHub）`, 3400);
    }
  }

  function updateSyncIndicators() {
    const badge = document.getElementById("syncStatusBadge");
    const mobileDot = document.getElementById("mobileSyncDot");
    const localGitSec = document.getElementById("localGitSection");
    const banner = document.getElementById("syncModeBanner");

    if (state.localApiAvailable) {
      badge.textContent = "● 本機直存連線中 (places.json)";
      badge.className = "sync-status-badge local";
      mobileDot.className = "sync-dot";
      localGitSec.classList.remove("hidden");
      banner.innerHTML =
        "🟢 <strong>本機伺服器直連模式</strong>：你在 Safari 的所有新增與修改都會直接寫入電腦上的 <code>data/places.json</code> 與 <code>aespa-japan.kml</code>。";
    } else if (state.hasUnsyncedLocalEdits) {
      badge.textContent = "● Safari 已有本機修改（待推雲端）";
      badge.className = "sync-status-badge dirty";
      mobileDot.className = "sync-dot dirty";
      localGitSec.classList.add("hidden");
      banner.innerHTML =
        "🟠 <strong>Safari 遠端編輯暫存中</strong>：你的變更已安全保存在目前裝置瀏覽器。綁定下方 GitHub Token 即可一鍵寫回雲端 <code>places.json</code>，或下載 JSON 備份。";
    } else {
      badge.textContent = "☁️ 雲端同步版（支援遠端編輯）";
      badge.className = "sync-status-badge";
      mobileDot.className = "sync-dot";
      localGitSec.classList.add("hidden");
      banner.innerHTML =
        "☁️ <strong>雲端網頁模式 (PWA)</strong>：可直接點擊任一地點進行遠端編輯或新增打卡點；設定一次 GitHub Token 後即可從手機 Safari 直接推回 GitHub！";
    }
  }

  // ==================== FILTERING ====================
  function matchesBaseWithoutMember(place) {
    if (state.region !== "ALL" && place.region !== state.region) return false;
    if (state.category !== "ALL" && place.category !== state.category) return false;
    if (state.onlyHasIg && !place.ig_url) return false;
    if (state.onlySaved && !state.bookmarks.has(place.id)) return false;
    if (state.onlyVisited && !state.visited.has(place.id)) return false;
    if (state.hideClosed && place.business_status === "CLOSED_PERMANENTLY") return false;
    if (state.activeRoute && !(place.route_tags || []).includes(state.activeRoute)) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = [
        place.name,
        place.name_ja,
        place.city,
        place.area,
        place.category,
        place.sub_category,
        place.address,
        place.same_order,
        place.note,
        ...(place.members || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function matchesMember(place, memberFilter) {
    if (memberFilter === "ALL") return true;
    const ms = place.members || [];
    if (memberFilter === "GROUP") return ms.length > 1;
    return ms.includes(memberFilter);
  }

  function getFilteredPlaces() {
    return state.places.filter((p) => matchesBaseWithoutMember(p) && matchesMember(p, state.member));
  }

  function hasNonDefaultFilter() {
    return (
      state.member !== "ALL" ||
      state.category !== "ALL" ||
      state.search !== "" ||
      state.onlyHasIg ||
      state.onlySaved ||
      state.onlyVisited ||
      state.hideClosed ||
      Boolean(state.activeRoute)
    );
  }

  // ==================== RENDERING ====================
  function renderRegionControls() {
    const tabsEl = document.getElementById("desktopRegionTabs");
    tabsEl.innerHTML = REGIONS.map((r) => {
      const cnt =
        r.id === "ALL" ? state.places.length : state.places.filter((p) => p.region === r.id).length;
      return `<button type="button" class="region-tab ${state.region === r.id ? "active" : ""}" data-region="${esc(r.id)}">${esc(r.label)} (${cnt})</button>`;
    }).join("");

    const mobileSelect = document.getElementById("mobileRegionSelect");
    mobileSelect.value = state.region;
  }

  function renderMemberControls() {
    const basePool = state.places.filter(matchesBaseWithoutMember);
    const renderButtons = () =>
      MEMBERS.map((m) => {
        const cnt = basePool.filter((p) => matchesMember(p, m.id)).length;
        return `<button type="button" class="member-pill ${state.member === m.id ? "active" : ""}" data-member="${esc(m.id)}">
          <span>${esc(m.label)}</span>
          <span class="count">${cnt}</span>
        </button>`;
      }).join("");

    document.getElementById("desktopMemberBar").innerHTML = renderButtons();
    document.getElementById("mobileMemberBar").innerHTML = renderButtons();
  }

  function renderCategoryControls() {
    const html = CATEGORIES.map(
      (c) =>
        `<button type="button" class="cat-chip ${state.category === c.id ? "active" : ""}" data-cat="${esc(c.id)}">${esc(c.label)}</button>`
    ).join("");
    document.getElementById("desktopCategoryBar").innerHTML = html;
    document.getElementById("mobileCategoryBar").innerHTML = html;

    document.getElementById("filterHasIgBtn").classList.toggle("active", state.onlyHasIg);
    document.getElementById("filterSavedBtn").classList.toggle("active", state.onlySaved);
    document.getElementById("filterVisitedBtn").classList.toggle("active", state.onlyVisited);
    document.getElementById("filterHideClosedBtn").classList.toggle("active", state.hideClosed);

    const routesEl = document.getElementById("routeChips");
    routesEl.innerHTML = CURATED_ROUTES.map(
      (rt) =>
        `<button type="button" class="route-chip ${state.activeRoute === rt.id ? "active" : ""}" data-route="${esc(rt.id)}">${esc(rt.label)}</button>`
    ).join("");
  }

  function renderList(filtered) {
    const regionLabel = REGIONS.find((r) => r.id === state.region)?.label || "全日本";
    document.getElementById("resultsCountText").textContent = `${regionLabel} · 顯示 ${filtered.length} 個打卡點`;
    document.getElementById("mobileSheetSummary").textContent = `${regionLabel} · ${filtered.length} 個打卡點`;
    document.getElementById("resetFiltersBtn").classList.toggle("hidden", !hasNonDefaultFilter());

    const listEl = document.getElementById("placesList");
    if (!filtered.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p>找不到符合目前篩選條件的打卡點</p>
          <button type="button" class="btn btn-outline btn-sm" id="emptyResetBtn">清除篩選條件</button>
        </div>
      `;
      document.getElementById("emptyResetBtn")?.addEventListener("click", resetFilters);
      return;
    }

    listEl.innerHTML = filtered
      .map((p, idx) => {
        const isClosed = p.business_status === "CLOSED_PERMANENTLY";
        const isReloc = p.business_status === "RELOCATED";
        const isSaved = state.bookmarks.has(p.id);
        const isVisited = state.visited.has(p.id);
        const memberTags = (p.members || [])
          .map((m) => `<span class="member-tag ${esc(m)}">${esc(m)}</span>`)
          .join("");
        const routePrefix = state.activeRoute ? `<span class="status-pill ig">#${idx + 1}</span> ` : "";

        return `
          <article class="place-row ${state.selectedId === p.id ? "selected" : ""} ${isClosed ? "is-closed" : ""}" data-id="${esc(p.id)}" role="listitem">
            <div class="place-row-top">
              <div class="place-row-title">${routePrefix}${esc(p.name)}</div>
              <div class="place-row-badges">
                ${isVisited ? '<span title="已踩點">✅</span>' : ""}
                ${isSaved ? '<span title="想去清單">⭐</span>' : ""}
                ${isClosed ? '<span class="status-pill closed">已歇業</span>' : ""}
                ${isReloc ? '<span class="status-pill relocated">已搬遷</span>' : ""}
                ${p.ig_url ? '<span class="status-pill ig">IG/影片</span>' : ""}
              </div>
            </div>
            <div class="place-row-meta">
              ${memberTags}
              <span>${esc(p.city || "")}${p.area ? `・${esc(p.area)}` : ""}</span>
              <span>· ${esc(p.sub_category || p.category)}</span>
              ${p.visit_date ? `<span>· ${esc(p.visit_date)}</span>` : ""}
            </div>
            ${p.same_order ? `<div class="place-row-order">${esc(p.same_order)}</div>` : ""}
          </article>
        `;
      })
      .join("");
  }

  function renderMapMarkers(filtered, fitMap = false) {
    clusterGroup.clearLayers();
    markerById.clear();

    if (routePolyline) {
      map.removeLayer(routePolyline);
      routePolyline = null;
    }

    const latlngs = [];
    filtered.forEach((p, idx) => {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return;
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      latlngs.push([lat, lng]);

      const marker = L.marker([lat, lng], {
        icon: createPinIcon(p, state.selectedId === p.id, state.activeRoute ? idx : null),
        title: p.name,
      });

      marker.on("click", () => {
        selectPlace(p.id, false);
      });

      markerById.set(p.id, marker);
      clusterGroup.addLayer(marker);
    });

    if (state.activeRoute && latlngs.length >= 2) {
      routePolyline = L.polyline(latlngs, {
        color: "#7C3AED",
        weight: 3.5,
        dashArray: "7, 7",
        opacity: 0.82,
      }).addTo(map);
    }

    if (fitMap && latlngs.length > 0) {
      const bounds = L.latLngBounds(latlngs);
      const padBottom = window.innerWidth <= 860 ? 90 : 40;
      const padTop = window.innerWidth <= 860 ? 130 : 40;
      map.fitBounds(bounds, {
        paddingTopLeft: [36, padTop],
        paddingBottomRight: [36, padBottom],
        maxZoom: 16,
      });
    }
  }

  function renderAll(fitMap = false) {
    const filtered = getFilteredPlaces();
    renderRegionControls();
    renderMemberControls();
    renderCategoryControls();
    renderList(filtered);
    renderMapMarkers(filtered, fitMap);

    if (state.selectedId) {
      const stillExists = state.places.find((p) => p.id === state.selectedId);
      if (stillExists) {
        renderDetailCard(stillExists);
      } else {
        closeDetailCard();
      }
    }
  }

  // ==================== SPOT SELECTION & DETAIL SHEET ====================
  function selectPlace(id, panToPin = true) {
    const prevId = state.selectedId;
    state.selectedId = id;
    const place = state.places.find((p) => p.id === id);
    if (!place) return;

    // Refresh active state on markers
    const filtered = getFilteredPlaces();
    if (prevId && markerById.has(prevId)) {
      const prevPlace = state.places.find((x) => x.id === prevId);
      const prevIdx = filtered.findIndex((x) => x.id === prevId);
      if (prevPlace) {
        markerById.get(prevId).setIcon(createPinIcon(prevPlace, false, state.activeRoute && prevIdx >= 0 ? prevIdx : null));
      }
    }
    if (markerById.has(id)) {
      const curIdx = filtered.findIndex((x) => x.id === id);
      const mk = markerById.get(id);
      mk.setIcon(createPinIcon(place, true, state.activeRoute && curIdx >= 0 ? curIdx : null));
      if (panToPin) {
        clusterGroup.zoomToShowLayer(mk, () => {
          const targetZoom = Math.max(map.getZoom(), 15);
          const latOffset = window.innerWidth <= 860 ? -0.0022 : 0;
          map.flyTo([Number(place.lat) + latOffset, Number(place.lng)], targetZoom, { duration: 0.45 });
        });
      } else if (window.innerWidth <= 860) {
        const z = map.getZoom();
        const offset = 0.0022 * Math.pow(2, 15 - Math.min(z, 17));
        map.panTo([Number(place.lat) - offset, Number(place.lng)], { animate: true });
      }
    }

    // Highlight selected list row
    document.querySelectorAll(".place-row").forEach((el) => {
      el.classList.toggle("selected", el.dataset.id === id);
    });
    const rowEl = document.querySelector(`.place-row[data-id="${CSS.escape(id)}"]`);
    if (rowEl && window.innerWidth > 860) {
      rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    // Collapse mobile list drawer so detail card shows cleanly
    document.getElementById("sidebarPanel").classList.remove("sheet-open");
    updateMobileSheetHint();

    renderDetailCard(place);
    history.replaceState(null, "", `#spot=${encodeURIComponent(id)}`);
  }

  function renderDetailCard(place) {
    const card = document.getElementById("detailCard");
    const box = document.getElementById("detailContent");

    const isClosed = place.business_status === "CLOSED_PERMANENTLY";
    const isReloc = place.business_status === "RELOCATED";
    const isSaved = state.bookmarks.has(place.id);
    const isVisited = state.visited.has(place.id);

    const memberTags = (place.members || [])
      .map((m) => `<span class="member-tag ${esc(m)}">${esc(m)}</span>`)
      .join("");

    // Primary Left Button: IG / YouTube / Source fallback per user spec
    const hasIg = Boolean(place.ig_url);
    const isVideo = hasIg && (place.ig_url.includes("youtube.com") || place.ig_url.includes("youtu.be"));
    const primarySourceHref = place.ig_url || place.source_url || "";
    const primarySourceLabel = hasIg
      ? isVideo
        ? "🎬 觀看官方影片"
        : "📸 查看 IG 貼文"
      : "📖 查看考據來源";
    const primarySourceClass = hasIg ? "cta-ig" : "cta-source";

    const gmapsUrl = place.google_maps_url || buildGoogleMapsSearchUrl(place);
    const gmapsDirUrl = buildGoogleMapsDirUrl(place);

    let statusBanner = "";
    if (isClosed) {
      statusBanner = `<div class="status-alert closed">⚠️ 此店已永久歇業：${esc(place.status_note || "出發前請留意避免撲空")}</div>`;
    } else if (isReloc) {
      statusBanner = `<div class="status-alert relocated">📍 店鋪已搬遷：${esc(place.status_note || "地圖已定位至最新現址")}</div>`;
    } else if (place.status_note) {
      statusBanner = `<div class="status-alert relocated">💡 提醒：${esc(place.status_note)}</div>`;
    }

    box.innerHTML = `
      <div class="detail-header-tags">
        ${memberTags}
        <span class="status-pill" style="background:#EEF1F7;color:#535B70;">${esc(place.category)}${place.sub_category ? ` · ${esc(place.sub_category)}` : ""}</span>
        ${place.visit_date ? `<span class="status-pill" style="background:#EEF1F7;color:#535B70;">🗓️ ${esc(place.visit_date)}</span>` : ""}
      </div>

      <h3 class="detail-title">${esc(place.name)}</h3>
      <div class="detail-ja-row">
        <span>${esc(place.name_ja || place.name)}</span>
        <button type="button" class="copy-chip" data-copy="${esc(place.name_ja || place.name)}">複製店名</button>
      </div>

      ${statusBanner}

      <div class="detail-info-box">
        ${
          place.same_order
            ? `<div class="detail-info-row"><span class="detail-info-label">同款亮點</span><span>${esc(place.same_order)}</span></div>`
            : ""
        }
        ${
          place.note
            ? `<div class="detail-info-row"><span class="detail-info-label">巡禮備註</span><span>${esc(place.note)}</span></div>`
            : ""
        }
        <div class="detail-info-row">
          <span class="detail-info-label">日文地址</span>
          <span>
            ${esc(place.address || "未提供詳細番號")}
            ${place.address ? `<button type="button" class="copy-chip" data-copy="${esc(place.address)}">複製地址</button>` : ""}
          </span>
        </div>
      </div>

      <div class="dual-cta-grid">
        ${
          primarySourceHref
            ? `<a class="cta-btn ${primarySourceClass}" href="${esc(primarySourceHref)}" target="_blank" rel="noopener noreferrer">${primarySourceLabel}</a>`
            : `<button class="cta-btn cta-source" type="button" id="detailAddIgPromptBtn">＋ 補上 IG／來源</button>`
        }
        <a class="cta-btn cta-gmaps" href="${esc(gmapsUrl)}" target="_blank" rel="noopener noreferrer">🗺️ 開啟 Google Maps</a>
      </div>

      <div class="secondary-links-row">
        <div class="util-btn-group">
          <button type="button" class="util-btn ${isSaved ? "active-star" : ""}" id="toggleBookmarkBtn">
            ${isSaved ? "⭐ 已加入想去" : "☆ 想去"}
          </button>
          <button type="button" class="util-btn ${isVisited ? "active-visited" : ""}" id="toggleVisitedBtn">
            ${isVisited ? "✅ 已踩點" : "○ 標記已去"}
          </button>
          ${
            hasIg && place.source_url
              ? `<a class="util-btn" href="${esc(place.source_url)}" target="_blank" rel="noopener noreferrer">📖 考據文</a>`
              : ""
          }
          <a class="util-btn" href="${esc(gmapsDirUrl)}" target="_blank" rel="noopener noreferrer">🧭 路線規劃</a>
        </div>
        <button type="button" class="util-btn" id="editCurrentPlaceBtn">✏️ 編輯</button>
      </div>
    `;

    card.classList.remove("hidden");

    box.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        navigator.clipboard?.writeText(btn.dataset.copy || "");
        showToast(`已複製：${btn.dataset.copy}`);
      });
    });

    document.getElementById("toggleBookmarkBtn")?.addEventListener("click", () => {
      if (state.bookmarks.has(place.id)) state.bookmarks.delete(place.id);
      else state.bookmarks.add(place.id);
      saveUserSets();
      renderAll(false);
    });

    document.getElementById("toggleVisitedBtn")?.addEventListener("click", () => {
      if (state.visited.has(place.id)) state.visited.delete(place.id);
      else state.visited.add(place.id);
      saveUserSets();
      renderAll(false);
    });

    document.getElementById("editCurrentPlaceBtn")?.addEventListener("click", () => openEditorModal(place));
    document.getElementById("detailAddIgPromptBtn")?.addEventListener("click", () => openEditorModal(place));
  }

  function closeDetailCard() {
    const prevId = state.selectedId;
    state.selectedId = null;
    document.getElementById("detailCard").classList.add("hidden");
    if (prevId && markerById.has(prevId)) {
      const p = state.places.find((x) => x.id === prevId);
      const idx = getFilteredPlaces().findIndex((x) => x.id === prevId);
      if (p) markerById.get(prevId).setIcon(createPinIcon(p, false, state.activeRoute && idx >= 0 ? idx : null));
    }
    document.querySelectorAll(".place-row.selected").forEach((el) => el.classList.remove("selected"));
    history.replaceState(null, "", location.pathname + location.search);
  }

  // ==================== PLACE EDITOR (REMOTE EDITING IN SAFARI) ====================
  function openEditorModal(place = null) {
    const modal = document.getElementById("editorModal");
    const title = document.getElementById("editorModalTitle");
    const delBtn = document.getElementById("deletePlaceBtn");

    document.getElementById("smartGmapsUrl").value = "";

    if (place) {
      title.textContent = "✏️ 編輯打卡地點";
      delBtn.classList.remove("hidden");
      document.getElementById("editId").value = place.id;
      document.getElementById("editName").value = place.name || "";
      document.getElementById("editNameJa").value = place.name_ja || "";
      document.getElementById("editRegion").value = place.region || "東京・關東";
      document.getElementById("editCity").value = place.city || "東京";
      document.getElementById("editArea").value = place.area || "";
      document.getElementById("editCategory").value = place.category || "餐廳";
      document.getElementById("editSubCategory").value = place.sub_category || "";
      document.getElementById("editVisitDate").value = place.visit_date || "";
      document.getElementById("editAddress").value = place.address || "";
      document.getElementById("editLat").value = place.lat ?? "";
      document.getElementById("editLng").value = place.lng ?? "";
      document.getElementById("editPlaceId").value = place.place_id || "";
      document.getElementById("editBusinessStatus").value = place.business_status || "OPERATIONAL";
      document.getElementById("editStatusNote").value = place.status_note || "";
      document.getElementById("editIgUrl").value = place.ig_url || "";
      document.getElementById("editSourceUrl").value = place.source_url || "";
      document.getElementById("editSameOrder").value = place.same_order || "";
      document.getElementById("editNote").value = place.note || "";

      const mSet = new Set(place.members || []);
      document.querySelectorAll("#editMembersGroup input[type=checkbox]").forEach((cb) => {
        cb.checked = mSet.has(cb.value);
      });
    } else {
      title.textContent = "＋ 新增 aespa 打卡地點";
      delBtn.classList.add("hidden");
      const center = map.getCenter();
      document.getElementById("editId").value = "";
      document.getElementById("editName").value = "";
      document.getElementById("editNameJa").value = "";
      document.getElementById("editRegion").value = state.region === "ALL" ? "東京・關東" : state.region;
      document.getElementById("editCity").value = state.region === "大阪・京都" ? "大阪" : state.region === "ALL" || state.region === "東京・關東" ? "東京" : state.region;
      document.getElementById("editArea").value = "";
      document.getElementById("editCategory").value = "餐廳";
      document.getElementById("editSubCategory").value = "";
      document.getElementById("editVisitDate").value = new Date().toISOString().slice(0, 7);
      document.getElementById("editAddress").value = "";
      document.getElementById("editLat").value = center.lat.toFixed(6);
      document.getElementById("editLng").value = center.lng.toFixed(6);
      document.getElementById("editPlaceId").value = "";
      document.getElementById("editBusinessStatus").value = "OPERATIONAL";
      document.getElementById("editStatusNote").value = "";
      document.getElementById("editIgUrl").value = "";
      document.getElementById("editSourceUrl").value = "";
      document.getElementById("editSameOrder").value = "";
      document.getElementById("editNote").value = "";

      const defaultMember = ["Karina", "Giselle", "Winter", "Ningning"].includes(state.member) ? state.member : "Karina";
      document.querySelectorAll("#editMembersGroup input[type=checkbox]").forEach((cb) => {
        cb.checked = cb.value === defaultMember;
      });
    }

    modal.classList.remove("hidden");
  }

  function closeEditorModal() {
    document.getElementById("editorModal").classList.add("hidden");
  }

  function parseGoogleMapsUrlInput() {
    const raw = document.getElementById("smartGmapsUrl").value.trim();
    if (!raw) {
      showToast("請先貼上 Google Maps 網址或座標");
      return;
    }

    // Match !3dLAT!4dLNG (exact pin) or @LAT,LNG or q=LAT,LNG or plain "35.66, 139.71"
    const exactMatch = raw.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const atMatch = raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const qMatch = raw.match(/[?&](?:q|ll|query)=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/i);
    const plainMatch = raw.match(/^\s*(-?\d{2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)\s*$/);

    const coords = exactMatch || qMatch || atMatch || plainMatch;
    if (coords) {
      document.getElementById("editLat").value = Number(coords[1]).toFixed(6);
      document.getElementById("editLng").value = Number(coords[2]).toFixed(6);
    }

    const placeNameMatch = raw.match(/\/maps\/place\/([^/@?]+)/);
    if (placeNameMatch) {
      const decoded = decodeURIComponent(placeNameMatch[1].replace(/\+/g, " "));
      if (!document.getElementById("editName").value) {
        document.getElementById("editName").value = decoded;
      }
      if (!document.getElementById("editNameJa").value) {
        document.getElementById("editNameJa").value = decoded;
      }
    }

    const pidMatch = raw.match(/(ChIJ[A-Za-z0-9_-]{15,40})/);
    if (pidMatch) {
      document.getElementById("editPlaceId").value = pidMatch[1];
    }

    if (coords || placeNameMatch) {
      showToast("已自動解析 Google Maps 資訊！");
    } else {
      showToast("未偵測到內嵌座標（短網址請開啟後複製完整網址，或用下方地址自動算座標）", 3600);
    }
  }

  async function autoGeocodeFromForm() {
    const address = document.getElementById("editAddress").value.trim();
    const nameJa = document.getElementById("editNameJa").value.trim() || document.getElementById("editName").value.trim();
    if (!address && !nameJa) {
      showToast("請先輸入日文地址或店名");
      return;
    }

    showToast("正在定位座標…");
    if (state.localApiAvailable) {
      try {
        const res = await fetch("./api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name_ja: nameJa, address }),
        });
        const data = await res.json();
        if (res.ok && data.ok && data.lat) {
          document.getElementById("editLat").value = data.lat;
          document.getElementById("editLng").value = data.lng;
          if (data.place_id) document.getElementById("editPlaceId").value = data.place_id;
          showToast(`定位成功：${data.lat}, ${data.lng}`);
          return;
        }
      } catch (_) {
        // Fallback to browser geocoders below
      }
    }

    // Browser-direct Japan GSI AddressSearch (HTTPS CORS) + Nominatim fallback
    try {
      if (address) {
        const gsiRes = await fetch(
          `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`
        );
        if (gsiRes.ok) {
          const items = await gsiRes.json();
          if (items && items.length > 0) {
            const [lng, lat] = items[0].geometry.coordinates;
            document.getElementById("editLat").value = Number(lat).toFixed(6);
            document.getElementById("editLng").value = Number(lng).toFixed(6);
            showToast(`日本國土地理院定位成功：${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`);
            return;
          }
        }
      }

      const nomQ = [nameJa, address].filter(Boolean).join(" ");
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&countrycodes=jp&limit=1&q=${encodeURIComponent(nomQ)}`
      );
      if (nomRes.ok) {
        const nomItems = await nomRes.json();
        if (nomItems && nomItems.length > 0) {
          document.getElementById("editLat").value = Number(nomItems[0].lat).toFixed(6);
          document.getElementById("editLng").value = Number(nomItems[0].lon).toFixed(6);
          showToast(`定位成功：${Number(nomItems[0].lat).toFixed(5)}, ${Number(nomItems[0].lon).toFixed(5)}`);
          return;
        }
      }
      showToast("找不到精準地址座標，可使用「📍 在地圖點選座標」直接點選");
    } catch (err) {
      showToast("自動定位失敗，請直接點擊「在地圖點選座標」");
    }
  }

  function enterMapPickMode() {
    state.pickingMapCoords = true;
    document.getElementById("editorModal").classList.add("hidden");
    document.getElementById("mapPickBanner").classList.remove("hidden");
    document.getElementById("mapContainer").style.cursor = "crosshair";
  }

  function exitMapPickMode(reopenEditor = true) {
    state.pickingMapCoords = false;
    document.getElementById("mapPickBanner").classList.add("hidden");
    document.getElementById("mapContainer").style.cursor = "";
    if (reopenEditor) {
      document.getElementById("editorModal").classList.remove("hidden");
    }
  }

  async function handleSavePlaceForm(ev) {
    ev.preventDefault();
    const checkedMembers = [...document.querySelectorAll("#editMembersGroup input[type=checkbox]:checked")].map(
      (cb) => cb.value
    );
    if (!checkedMembers.length) {
      showToast("請至少勾選一位造訪成員");
      return;
    }

    const lat = Number(document.getElementById("editLat").value);
    const lng = Number(document.getElementById("editLng").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      showToast("請填入有效的緯度與經度");
      return;
    }

    const existingId = document.getElementById("editId").value.trim();
    const id = existingId || `jp-custom-${Date.now()}`;
    const prevObj = state.places.find((p) => p.id === id) || {};

    const updatedPlace = {
      ...prevObj,
      id,
      name: document.getElementById("editName").value.trim(),
      name_ja: document.getElementById("editNameJa").value.trim() || document.getElementById("editName").value.trim(),
      members: checkedMembers,
      region: document.getElementById("editRegion").value,
      city: document.getElementById("editCity").value.trim(),
      area: document.getElementById("editArea").value.trim(),
      category: document.getElementById("editCategory").value,
      sub_category: document.getElementById("editSubCategory").value.trim(),
      visit_date: document.getElementById("editVisitDate").value.trim(),
      address: document.getElementById("editAddress").value.trim(),
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      place_id: document.getElementById("editPlaceId").value.trim(),
      business_status: document.getElementById("editBusinessStatus").value,
      status_note: document.getElementById("editStatusNote").value.trim(),
      source_type: document.getElementById("editIgUrl").value.includes("youtube") ? "Vlog" : "IG",
      ig_url: document.getElementById("editIgUrl").value.trim(),
      source_url: document.getElementById("editSourceUrl").value.trim(),
      same_order: document.getElementById("editSameOrder").value.trim(),
      note: document.getElementById("editNote").value.trim(),
      route_tags: prevObj.route_tags || [],
    };
    updatedPlace.google_maps_url = buildGoogleMapsSearchUrl(updatedPlace);

    const idx = state.places.findIndex((p) => p.id === id);
    if (idx >= 0) {
      state.places[idx] = updatedPlace;
    } else {
      state.places.unshift(updatedPlace);
    }

    if (state.region !== "ALL" && state.region !== updatedPlace.region) {
      state.region = updatedPlace.region;
    }

    closeEditorModal();
    renderAll(false);
    selectPlace(id, true);

    try {
      await persistPlaces(existingId ? "已更新打卡地點" : "已新增打卡地點");
    } catch (err) {
      showToast(`儲存失敗：${err.message}`, 3500);
    }
  }

  async function handleDeletePlace() {
    const id = document.getElementById("editId").value.trim();
    const target = state.places.find((p) => p.id === id);
    if (!target) return;
    if (!window.confirm(`確定要刪除「${target.name}」嗎？`)) return;

    state.places = state.places.filter((p) => p.id !== id);
    closeEditorModal();
    if (state.selectedId === id) closeDetailCard();
    renderAll(false);

    try {
      await persistPlaces("已刪除地點");
    } catch (err) {
      showToast(`刪除儲存失敗：${err.message}`, 3500);
    }
  }

  // ==================== GITHUB CLOUD SYNC & EXPORT ====================
  function getGhConfig() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.GH_CONFIG) || "{}");
      return {
        repo: parsed.repo || DEFAULT_GH_REPO,
        branch: parsed.branch || "main",
        token: parsed.token || "",
      };
    } catch (_) {
      return { repo: DEFAULT_GH_REPO, branch: "main", token: "" };
    }
  }

  function openSyncModal() {
    const gh = getGhConfig();
    document.getElementById("ghRepoInput").value = gh.repo;
    document.getElementById("ghBranchInput").value = gh.branch;
    document.getElementById("ghTokenInput").value = gh.token;
    document.getElementById("openGithubWebEditLink").href = `https://github.com/${gh.repo}/edit/${gh.branch}/data/places.json`;
    updateSyncIndicators();
    document.getElementById("syncModal").classList.remove("hidden");
  }

  function saveGhConfigFromInputs() {
    const cfg = {
      repo: document.getElementById("ghRepoInput").value.trim() || DEFAULT_GH_REPO,
      branch: document.getElementById("ghBranchInput").value.trim() || "main",
      token: document.getElementById("ghTokenInput").value.trim(),
    };
    localStorage.setItem(STORAGE_KEYS.GH_CONFIG, JSON.stringify(cfg));
    document.getElementById("openGithubWebEditLink").href = `https://github.com/${cfg.repo}/edit/${cfg.branch}/data/places.json`;
    return cfg;
  }

  async function pushPlacesToGithubApi(showFeedback = true) {
    const cfg = saveGhConfigFromInputs();
    if (!cfg.token) {
      if (showFeedback) showToast("請先填入 GitHub Personal Access Token");
      throw new Error("未設定 Token");
    }

    if (showFeedback) showToast("正在寫入 GitHub data/places.json…");
    const apiUrl = `https://api.github.com/repos/${cfg.repo}/contents/data/places.json`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
    };

    // 1. Get current file SHA
    let sha = undefined;
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: "no-store" });
    if (getRes.ok) {
      const meta = await getRes.json();
      sha = meta.sha;
    } else if (getRes.status !== 404) {
      const errBody = await getRes.json().catch(() => ({}));
      throw new Error(errBody.message || `HTTP ${getRes.status}`);
    }

    // 2. PUT updated places.json
    const contentStr = JSON.stringify(state.places, null, 2) + "\n";
    const putBody = {
      message: `Update places.json via Safari Web Editor (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
      content: utf8ToBase64(contentStr),
      branch: cfg.branch,
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });

    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `PUT HTTP ${putRes.status}`);
    }

    localStorage.removeItem(STORAGE_KEYS.PLACES_DIRTY);
    localStorage.removeItem(STORAGE_KEYS.PLACES_OVERRIDE);
    state.hasUnsyncedLocalEdits = false;
    updateSyncIndicators();
    if (showFeedback) {
      showToast("✅ 已成功寫入 GitHub！GitHub Pages 約 30–60 秒後自動更新全網地圖", 4000);
    }
  }

  function downloadBlob(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportKmlClient() {
    const escXml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      "  <Document>",
      "    <name>aespa 日本聖地巡禮地圖</name>",
    ];

    state.places.forEach((p) => {
      if (!p.lat || !p.lng) return;
      const members = (p.members || []).join(" / ");
      const desc = [
        `成員：${members}`,
        `分類：${p.category}（${p.sub_category || ""}）`,
        `地址：${p.address || ""}`,
        p.same_order ? `同款：${p.same_order}` : "",
        p.note ? `備註：${p.note}` : "",
        p.ig_url ? `IG／影片：${p.ig_url}` : "",
        p.source_url ? `來源：${p.source_url}` : "",
      ]
        .filter(Boolean)
        .join("<br/>");
      lines.push(
        "    <Placemark>",
        `      <name>${escXml(`${p.name} (${members})`)}</name>`,
        `      <description><![CDATA[${desc}]]></description>`,
        `      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>`,
        "    </Placemark>"
      );
    });

    lines.push("  </Document>", "</kml>");
    downloadBlob("aespa-japan-places.kml", lines.join("\n"), "application/vnd.google-earth.kml+xml;charset=utf-8");
    showToast("已下載 KML 檔！可匯入 Google 我的地圖 (Google My Maps)");
  }

  // ==================== EVENT BINDINGS ====================
  function resetFilters() {
    state.member = "ALL";
    state.category = "ALL";
    state.search = "";
    state.onlyHasIg = false;
    state.onlySaved = false;
    state.onlyVisited = false;
    state.hideClosed = false;
    state.activeRoute = null;
    document.getElementById("desktopSearchInput").value = "";
    document.getElementById("mobileSearchInput").value = "";
    document.getElementById("desktopSearchClear").classList.add("hidden");
    document.getElementById("mobileSearchClear").classList.add("hidden");
    renderAll(true);
  }

  function updateMobileSheetHint() {
    const isOpen = document.getElementById("sidebarPanel").classList.contains("sheet-open");
    document.getElementById("mobileSheetToggleLabel").textContent = isOpen ? "下滑收合 ▼" : "上滑展開 ▲";
  }

  function initMobileSheetGestures() {
    const panel = document.getElementById("sidebarPanel");
    const handle = document.getElementById("sheetDragHandle");
    const listEl = document.getElementById("placesList");
    const detailCard = document.getElementById("detailCard");

    const getCollapsedOffset = () => {
      const handleHeight = handle.offsetHeight || 68;
      return Math.max(0, panel.offsetHeight - handleHeight);
    };

    const setSheetOpen = (open) => {
      panel.style.transform = "";
      panel.classList.toggle("sheet-open", open);
      updateMobileSheetHint();
    };

    // Click fallback on the peek header
    let suppressNextClick = false;
    handle.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      setSheetOpen(!panel.classList.contains("sheet-open"));
    });

    let startY = 0;
    let startTranslateY = 0;
    let currentTranslateY = 0;
    let startTime = 0;
    let tracking = false;
    let dragged = false;

    panel.addEventListener(
      "touchstart",
      (ev) => {
        if (window.innerWidth > 860 || ev.touches.length !== 1) return;
        const isOpen = panel.classList.contains("sheet-open");
        const onHandle = Boolean(ev.target.closest("#sheetDragHandle") || ev.target.closest(".sidebar-filters"));
        const atListTop = isOpen && listEl.contains(ev.target) && listEl.scrollTop <= 0;

        // Always allow dragging when collapsed OR touching handle/filters OR pulling down from top of list
        if (!isOpen || onHandle || atListTop) {
          startY = ev.touches[0].clientY;
          startTime = Date.now();
          const collapsedY = getCollapsedOffset();
          startTranslateY = isOpen ? 0 : collapsedY;
          currentTranslateY = startTranslateY;
          tracking = true;
          dragged = false;
        }
        ev.stopPropagation();
      },
      { passive: true }
    );

    panel.addEventListener(
      "touchmove",
      (ev) => {
        ev.stopPropagation();
        if (!tracking || window.innerWidth > 860) return;
        const dy = ev.touches[0].clientY - startY;
        const isOpen = panel.classList.contains("sheet-open");
        const onHandle = Boolean(ev.target.closest("#sheetDragHandle"));

        // If open and user scrolls upward inside the list, let native list scroll take over
        if (isOpen && !onHandle && listEl.contains(ev.target) && dy < 0) {
          tracking = false;
          panel.classList.remove("is-dragging");
          panel.style.transform = "";
          return;
        }

        // Prevent horizontal chip scroll from triggering sheet drag unless mostly vertical
        if (!dragged && Math.abs(dy) < 6) return;

        if (ev.cancelable) ev.preventDefault();
        dragged = true;
        panel.classList.add("is-dragging");

        const collapsedY = getCollapsedOffset();
        currentTranslateY = Math.min(collapsedY, Math.max(0, startTranslateY + dy));
        panel.style.transform = `translateY(${currentTranslateY}px)`;
      },
      { passive: false }
    );

    const finishPanelDrag = (ev) => {
      if (ev) ev.stopPropagation();
      if (!tracking) return;
      tracking = false;
      panel.classList.remove("is-dragging");

      if (!dragged) {
        panel.style.transform = "";
        return;
      }

      suppressNextClick = true;
      setTimeout(() => {
        suppressNextClick = false;
      }, 250);

      const collapsedY = getCollapsedOffset();
      const totalDy = currentTranslateY - startTranslateY;
      const elapsed = Math.max(1, Date.now() - startTime);
      const velocity = totalDy / elapsed; // px per ms

      if (velocity < -0.28 || totalDy < -36) {
        setSheetOpen(true);
      } else if (velocity > 0.28 || totalDy > 42) {
        setSheetOpen(false);
      } else {
        setSheetOpen(currentTranslateY < collapsedY * 0.5);
      }
    };

    panel.addEventListener("touchend", finishPanelDrag, { passive: true });
    panel.addEventListener("touchcancel", finishPanelDrag, { passive: true });

    // Swipe-down to dismiss Spot Detail Bottom Sheet on mobile
    let detailStartY = 0;
    let detailDy = 0;
    let detailTracking = false;

    detailCard.addEventListener(
      "touchstart",
      (ev) => {
        ev.stopPropagation();
        if (window.innerWidth > 860 || ev.touches.length !== 1) return;
        if (detailCard.scrollTop <= 0) {
          detailStartY = ev.touches[0].clientY;
          detailDy = 0;
          detailTracking = true;
        }
      },
      { passive: true }
    );

    detailCard.addEventListener(
      "touchmove",
      (ev) => {
        ev.stopPropagation();
        if (!detailTracking || window.innerWidth > 860) return;
        const dy = ev.touches[0].clientY - detailStartY;
        if (dy > 6) {
          if (ev.cancelable) ev.preventDefault();
          detailDy = dy;
          detailCard.classList.add("is-dragging");
          detailCard.style.transform = `translateY(${dy}px)`;
        } else if (dy < -6) {
          detailTracking = false;
        }
      },
      { passive: false }
    );

    const finishDetailDrag = (ev) => {
      if (ev) ev.stopPropagation();
      if (!detailTracking) return;
      detailTracking = false;
      detailCard.classList.remove("is-dragging");
      detailCard.style.transform = "";
      if (detailDy > 65) {
        closeDetailCard();
      }
      detailDy = 0;
    };

    detailCard.addEventListener("touchend", finishDetailDrag, { passive: true });
    detailCard.addEventListener("touchcancel", finishDetailDrag, { passive: true });
  }

  function bindEvents() {
    // Region Tabs (Desktop & Mobile)
    document.getElementById("desktopRegionTabs").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-region]");
      if (!btn) return;
      state.region = btn.dataset.region;
      state.activeRoute = null;
      closeDetailCard();
      renderAll(true);
    });

    document.getElementById("mobileRegionSelect").addEventListener("change", (ev) => {
      state.region = ev.target.value;
      state.activeRoute = null;
      closeDetailCard();
      renderAll(true);
    });

    // Member Filters
    const onMemberClick = (ev) => {
      const btn = ev.target.closest("[data-member]");
      if (!btn) return;
      state.member = btn.dataset.member;
      renderAll(false);
    };
    document.getElementById("desktopMemberBar").addEventListener("click", onMemberClick);
    document.getElementById("mobileMemberBar").addEventListener("click", onMemberClick);

    // Category Filters
    const onCatClick = (ev) => {
      const btn = ev.target.closest("[data-cat]");
      if (!btn) return;
      state.category = btn.dataset.cat;
      renderAll(false);
    };
    document.getElementById("desktopCategoryBar").addEventListener("click", onCatClick);
    document.getElementById("mobileCategoryBar").addEventListener("click", onCatClick);

    // Quick Toggles
    document.getElementById("filterHasIgBtn").addEventListener("click", () => {
      state.onlyHasIg = !state.onlyHasIg;
      renderAll(false);
    });
    document.getElementById("filterSavedBtn").addEventListener("click", () => {
      state.onlySaved = !state.onlySaved;
      renderAll(false);
    });
    document.getElementById("filterVisitedBtn").addEventListener("click", () => {
      state.onlyVisited = !state.onlyVisited;
      renderAll(false);
    });
    document.getElementById("filterHideClosedBtn").addEventListener("click", () => {
      state.hideClosed = !state.hideClosed;
      renderAll(false);
    });

    // Curated 1-Day Routes
    document.getElementById("routeChips").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-route]");
      if (!btn) return;
      const routeId = btn.dataset.route;
      if (state.activeRoute === routeId) {
        state.activeRoute = null;
        renderAll(true);
      } else {
        const rt = CURATED_ROUTES.find((r) => r.id === routeId);
        if (rt) state.region = rt.region;
        state.member = "ALL";
        state.category = "ALL";
        state.activeRoute = routeId;
        closeDetailCard();
        renderAll(true);
        showToast(`已開啟一日動線：${rt?.label || ""}`);
      }
    });

    // Search Inputs
    const syncSearch = (val) => {
      state.search = val.trim();
      document.getElementById("desktopSearchInput").value = val;
      document.getElementById("mobileSearchInput").value = val;
      document.getElementById("desktopSearchClear").classList.toggle("hidden", !val);
      document.getElementById("mobileSearchClear").classList.toggle("hidden", !val);
      renderAll(false);
    };
    document.getElementById("desktopSearchInput").addEventListener("input", (e) => syncSearch(e.target.value));
    document.getElementById("mobileSearchInput").addEventListener("input", (e) => syncSearch(e.target.value));
    document.getElementById("desktopSearchClear").addEventListener("click", () => syncSearch(""));
    document.getElementById("mobileSearchClear").addEventListener("click", () => syncSearch(""));
    document.getElementById("resetFiltersBtn").addEventListener("click", resetFilters);

    // List Item Click
    document.getElementById("placesList").addEventListener("click", (ev) => {
      const row = ev.target.closest(".place-row");
      if (!row) return;
      selectPlace(row.dataset.id, true);
    });

    // Mobile Bottom Drawer Touch Swipe + Tap Gesture
    initMobileSheetGestures();

    // Detail Card Close
    document.getElementById("closeDetailBtn").addEventListener("click", closeDetailCard);

    document.getElementById("fitBoundsBtn").addEventListener("click", () => renderAll(true));
    document.getElementById("zoomInBtn")?.addEventListener("click", () => map.zoomIn());
    document.getElementById("zoomOutBtn")?.addEventListener("click", () => map.zoomOut());

    document.getElementById("locateMeBtn").addEventListener("click", () => {
      if (!navigator.geolocation) {
        showToast("此瀏覽器不支援 GPS 定位");
        return;
      }
      showToast("正在取得你目前的位置…");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          if (userLocationMarker) map.removeLayer(userLocationMarker);
          userLocationMarker = L.circleMarker([latitude, longitude], {
            radius: 8,
            fillColor: "#2563EB",
            color: "#FFFFFF",
            weight: 3,
            fillOpacity: 1,
          })
            .addTo(map)
            .bindPopup("📍 你目前的位置");
          map.flyTo([latitude, longitude], 15, { duration: 0.6 });
          showToast("已定位至你目前的位置");
        },
        () => showToast("無法取得定位，請確認 Safari 已允許位置權限")
      );
    });

    // Editor Modal Actions
    document.getElementById("desktopAddBtn").addEventListener("click", () => openEditorModal(null));
    document.getElementById("mobileAddBtn").addEventListener("click", () => openEditorModal(null));
    document.getElementById("closeEditorBtn").addEventListener("click", closeEditorModal);
    document.getElementById("cancelEditorBtn").addEventListener("click", closeEditorModal);
    document.getElementById("parseGmapsBtn").addEventListener("click", parseGoogleMapsUrlInput);
    document.getElementById("autoGeocodeBtn").addEventListener("click", autoGeocodeFromForm);
    document.getElementById("pickOnMapBtn").addEventListener("click", enterMapPickMode);
    document.getElementById("cancelMapPickBtn").addEventListener("click", () => exitMapPickMode(true));
    document.getElementById("selectAllMembersBtn").addEventListener("click", () => {
      document.querySelectorAll("#editMembersGroup input[type=checkbox]").forEach((cb) => {
        cb.checked = true;
      });
    });
    document.getElementById("placeEditorForm").addEventListener("submit", handleSavePlaceForm);
    document.getElementById("deletePlaceBtn").addEventListener("click", handleDeletePlace);

    // Sync / Export Modal Actions
    document.getElementById("desktopSyncBtn").addEventListener("click", openSyncModal);
    document.getElementById("mobileSyncBtn").addEventListener("click", openSyncModal);
    document.getElementById("closeSyncBtn").addEventListener("click", () => {
      document.getElementById("syncModal").classList.add("hidden");
    });

    document.getElementById("saveGhConfigBtn").addEventListener("click", () => {
      saveGhConfigFromInputs();
      showToast("已儲存 GitHub 同步設定（僅存於此瀏覽器）");
    });

    document.getElementById("pushToGithubApiBtn").addEventListener("click", async () => {
      try {
        await pushPlacesToGithubApi(true);
      } catch (err) {
        if (err.message !== "未設定 Token") {
          showToast(`GitHub 同步失敗：${err.message}`, 4000);
        }
      }
    });

    document.getElementById("localGitPushBtn").addEventListener("click", async () => {
      showToast("正在將最新 places.json 推送至 GitHub…");
      try {
        const res = await fetch("./api/git-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          showToast(data.pushed ? "✅ 已推送至 GitHub Pages！" : data.message, 3500);
        } else {
          showToast(`推送失敗：${data.error || "未知錯誤"}`, 4000);
        }
      } catch (err) {
        showToast(`連線失敗：${err.message}`);
      }
    });

    document.getElementById("exportJsonBtn").addEventListener("click", () => {
      downloadBlob("places.json", JSON.stringify(state.places, null, 2) + "\n", "application/json;charset=utf-8");
      showToast("已下載最新 places.json");
    });

    document.getElementById("exportKmlBtn").addEventListener("click", exportKmlClient);

    document.getElementById("importJsonInput").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!Array.isArray(imported)) throw new Error("JSON 格式須為陣列");
        state.places = imported;
        renderAll(true);
        await persistPlaces(`已匯入 ${imported.length} 筆地點`);
      } catch (err) {
        showToast(`匯入失敗：${err.message}`, 3500);
      } finally {
        ev.target.value = "";
      }
    });

    document.getElementById("resetLocalEditsBtn").addEventListener("click", async () => {
      if (!window.confirm("確定要清除此瀏覽器的暫存修改，重新載入伺服器／雲端的 places.json 嗎？")) return;
      localStorage.removeItem(STORAGE_KEYS.PLACES_DIRTY);
      localStorage.removeItem(STORAGE_KEYS.PLACES_OVERRIDE);
      state.hasUnsyncedLocalEdits = false;
      document.getElementById("syncModal").classList.add("hidden");
      await loadInitialData();
      showToast("已還原為雲端最新 places.json");
    });

    // Register Service Worker for PWA Add-to-Home-Screen
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  // ==================== BOOT ====================
  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    bindEvents();
    loadInitialData().catch((err) => {
      console.error(err);
      showToast(`載入 places.json 失敗：${err.message}`, 4500);
    });
  });
})();
