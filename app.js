/* ============================================================
   Mission Map — Prototype
   Plain JS, no build, no deps.
   Data lives in localStorage; PNGs are stored inline as base64.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- Constants ---------- */
  const STORAGE_KEY = 'missionMap.missions';
  const PRESS_NAV_DELAY_MS = 280;
  const ISLAND_PITCH = 230;          // vertical distance between island centers (px)
  const ISLAND_TOP_OFFSET = 24;      // top padding inside the map (px)
  const ISLAND_SIZE = 190;           // visual island size (px)
  const ISLAND_X_AMPLITUDE = 18;     // zig-zag half-amplitude as %  (centered at 50%)
  const ALPHA_CROP_THRESHOLD = 8;    // alpha below this counts as transparent for auto-crop
  const MAX_PNG_SIDE = 512;          // resize cap before storing
  const STATES = ['available', 'current', 'done', 'locked'];

  /* ---------- Data layer ---------- */
  const Store = {
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    },
    save(missions) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(missions));
      } catch (err) {
        alert('Storage is full. Try removing a few islands or use smaller PNGs.');
        console.error(err);
      }
    },
    clear() {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  // Manual hard-reset: visiting `?reset=1` wipes the stored roster.
  if (/[?&]reset(=|&|$)/.test(location.search)) {
    Store.clear();
  }
  let missions = Store.load();
  // Seed from sample-data.js when:
  //   a) localStorage is empty (first visit), or
  //   b) every stored mission is missing imageData — a sign that the page was
  //      opened in an older version that initialised the roster without art.
  const sample = Array.isArray(window.MISSION_MAP_SAMPLE_DATA) ? window.MISSION_MAP_SAMPLE_DATA : null;
  const everyMissionImageMissing = missions.length > 0 && missions.every(m => !m.imageData);
  if (sample && (missions.length === 0 || everyMissionImageMissing)) {
    missions = sample.map(m => ({ ...m }));
    Store.save(missions);
  }
  // Backfill sides on missions that pre-date the side-mission feature.
  missions.forEach(m => { if (!Array.isArray(m.sides)) m.sides = []; });

  /* ---------- Image processing ----------
     Alex supplies uniform-canvas transparent-bg PNGs where the visible island
     occupies a similar proportion of each canvas — auto-crop the transparent
     margins on upload so the visible art fills the display box uniformly. */
  function cropTransparentMargins(canvas) {
    const { width, height } = canvas;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (data[rowStart + x * 4 + 3] > ALPHA_CROP_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas;
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    if (cw === width && ch === height) return canvas;
    const cropped = document.createElement('canvas');
    cropped.width = cw;
    cropped.height = ch;
    cropped.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return cropped;
  }

  function resizeCanvas(canvas) {
    const longest = Math.max(canvas.width, canvas.height);
    if (longest <= MAX_PNG_SIDE) return canvas;
    const scale = MAX_PNG_SIDE / longest;
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return out;
  }

  function canvasToDataUrl(canvas) {
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/webp', 0.92);
      if (!dataUrl.startsWith('data:image/webp')) {
        dataUrl = canvas.toDataURL('image/png');
      }
    } catch {
      dataUrl = canvas.toDataURL('image/png');
    }
    return dataUrl;
  }

  function fileToResizedDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Image decode failed'));
        img.onload = () => {
          const src = document.createElement('canvas');
          src.width = img.width;
          src.height = img.height;
          src.getContext('2d').drawImage(img, 0, 0);
          const cropped = cropTransparentMargins(src);
          const sized = resizeCanvas(cropped);
          resolve(canvasToDataUrl(sized));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function recropDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.onload = () => {
        const src = document.createElement('canvas');
        src.width = img.width;
        src.height = img.height;
        src.getContext('2d').drawImage(img, 0, 0);
        const cropped = cropTransparentMargins(src);
        if (cropped === src) { resolve(dataUrl); return; }
        resolve(canvasToDataUrl(resizeCanvas(cropped)));
      };
      img.src = dataUrl;
    });
  }
  async function migrateLegacyImages() {
    let changed = false;
    for (const m of missions) {
      if (!m.imageData || m.cropped) continue;
      try {
        const cropped = await recropDataUrl(m.imageData);
        if (cropped !== m.imageData) m.imageData = cropped;
        m.cropped = true;
        changed = true;
      } catch (err) {
        console.warn('[mission-map] crop failed for mission', m.id, err);
        m.cropped = true;
      }
    }
    if (changed) {
      persist();
      renderEditor();
      renderMap();
    }
  }

  /* ---------- Helpers ---------- */
  function uid() {
    return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  /* ---------- Layout — vertical pitch + sine zig-zag (v1 style) ---------- */
  const LAST_SCALE = 1.62;           // final mission scaled + centred
  function islandXPct(i, count) {
    // Last mission is centred (50%); others follow the gentle sine zig-zag.
    if (count !== undefined && i === count - 1) return 50;
    return 50 + Math.sin((i * Math.PI) / 2) * ISLAND_X_AMPLITUDE;
  }
  function islandY(i) {
    return ISLAND_TOP_OFFSET + i * ISLAND_PITCH;
  }
  function mapHeight(count) {
    if (!count) return 0;
    const lastBoost = count > 0 ? (ISLAND_SIZE * (LAST_SCALE - 1)) : 0;
    return ISLAND_TOP_OFFSET + (count - 1) * ISLAND_PITCH + ISLAND_SIZE + lastBoost + 80;
  }
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  // Deterministic 0..1 from a string + salt — used to scatter side missions
  // chaotically but stably (same positions across re-renders / reloads).
  function pseudoRand(str, salt) {
    let h = salt >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 2654435761) >>> 0;
    }
    return (h % 10000) / 10000;
  }
  function curvedPath(x1pct, y1, x2pct, y2) {
    // x in %, y in px (SVG uses viewBox '0 0 100 mapH', preserveAspectRatio=none)
    const mx = (x1pct + x2pct) / 2;
    const my = (y1 + y2) / 2;
    const dxPct = x2pct - x1pct;
    const dy = y2 - y1;
    // perpendicular vector in (pct, px) space — scale a bit so the curve is gentle
    const lenApprox = Math.hypot(dxPct * 2, dy);
    const px = -dy / lenApprox;
    const py = (dxPct * 2) / lenApprox;
    const off = 18;
    const cx = mx + px * off;
    const cy = my + py * off;
    return `M ${x1pct} ${y1} Q ${cx} ${cy} ${x2pct} ${y2}`;
  }

  /* ---------- Header ---------- */
  const progressFill = document.getElementById('progressFill');
  const progressCounter = document.getElementById('progressCounter');
  function renderHeader() {
    const total = missions.length;
    const done = missions.filter(m => m.state === 'done').length;
    progressCounter.textContent = `${done}/${total}`;
    const pct = total > 0 ? (done / total) * 100 : 0;
    progressFill.style.width = pct + '%';
  }

  /* ---------- Map rendering ---------- */
  const islandsEl = document.getElementById('islands');
  const islandLabelsEl = document.getElementById('islandLabels');
  const trailEl = document.getElementById('trail');
  const mapEl = document.getElementById('map');
  const emptyStateEl = document.getElementById('emptyState');

  function renderMap() {
    const count = missions.length;
    const h = mapHeight(count);
    mapEl.style.minHeight = h ? `${h}px` : '100dvh';

    if (count === 0) {
      islandsEl.innerHTML = '';
      if (islandLabelsEl) islandLabelsEl.innerHTML = '';
      trailEl.innerHTML = '';
      trailEl.style.display = 'none';
      mapEl.style.minHeight = '0';
      emptyStateEl.hidden = false;
      return;
    }
    emptyStateEl.hidden = true;
    trailEl.style.display = '';

    // Trail dots — divs sampled along each pair's quadratic bezier. Each dot
    // gets a --rot var so its long axis aligns with the local tangent (the
    // "short faces" point at the next dot along the curve, like train ties).
    const DOTS_PER_SEGMENT = 14;
    const mapWidthPx = mapEl.getBoundingClientRect().width || 430;
    let trailHtml = '';
    for (let i = 0; i < count - 1; i++) {
      const a = missions[i];
      const b = missions[i + 1];
      const solid = (a.state === 'done' || a.state === 'current')
        && (b.state === 'done' || b.state === 'current');
      const cls = solid ? 'trail-dot--solid' : 'trail-dot--dashed';
      const x1 = islandXPct(i, count);
      const y1 = islandY(i) + ISLAND_SIZE / 2;
      const x2 = islandXPct(i + 1, count);
      const y2 = islandY(i + 1) + ISLAND_SIZE / 2;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dxPct = x2 - x1;
      const dy = y2 - y1;
      const lenApprox = Math.hypot(dxPct * 2, dy);
      const px = -dy / lenApprox;
      const py = (dxPct * 2) / lenApprox;
      // Alternate curve side per segment → R-L-R-L pattern between islands.
      const off = 22 * (i % 2 === 0 ? 1 : -1);
      const cx = mx + px * off;
      const cy = my + py * off;
      for (let k = 1; k <= DOTS_PER_SEGMENT; k++) {
        const t = k / (DOTS_PER_SEGMENT + 1);
        const u = 1 - t;
        const x = u * u * x1 + 2 * u * t * cx + t * t * x2;
        const y = u * u * y1 + 2 * u * t * cy + t * t * y2;
        // Tangent (derivative of quadratic bezier). dx is in percent units,
        // dy in px — convert dx to px so the rotation matches the rendered
        // geometry.
        const dxPctT = 2 * (u * (cx - x1) + t * (x2 - cx));
        const dyPxT  = 2 * (u * (cy - y1) + t * (y2 - cy));
        const dxPxT  = dxPctT * mapWidthPx / 100;
        const rot = Math.atan2(dyPxT, dxPxT) * 180 / Math.PI;
        trailHtml += `<div class="trail-dot ${cls}" style="left:${x.toFixed(2)}%;top:${y.toFixed(0)}px;--rot:${rot.toFixed(1)}deg"></div>`;
      }
    }
    // (Trail innerHTML is written AFTER side-trails are also appended below.)

    // Islands
    let html = '';
    let labelsHtml = '';
    missions.forEach((m, i) => {
      const x = islandXPct(i, count);
      const y = islandY(i);
      const isLast = i === count - 1;

      const badge = m.state === 'locked'
        ? `<span class="island-badge--locked" aria-hidden="true">
             <svg viewBox="0 0 24 24" fill="currentColor">
               <path d="M6 10V8a6 6 0 0 1 12 0v2h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1zm2 0h8V8a4 4 0 0 0-8 0v2z"/>
             </svg>
           </span>`
        : '';

      // Done state uses imageDataDone if uploaded; otherwise falls back to the
      // regular image (still gets the desaturate filter from state-done CSS).
      const imgSrc = (m.state === 'done' && m.imageDataDone) ? m.imageDataDone : m.imageData;
      const visual = imgSrc
        ? `<img src="${imgSrc}" alt="${escapeHtml(m.title || 'Mission ' + (i + 1))}" draggable="false">`
        : `<div class="island-placeholder">${i + 1}</div>`;

      const slotCls = isLast ? 'island-slot island-slot--last' : 'island-slot';
      html += `
        <li class="${slotCls}" style="left:${x}%; top:${y}px;">
          <button class="island state-${m.state}" type="button"
                  data-id="${m.id}" data-index="${i}"
                  data-state="${m.state}"
                  aria-label="${escapeHtml(m.title || 'Mission ' + (i + 1))}">
            ${visual}
            ${badge}
          </button>
        </li>
      `;

      // Wrap label + progress in one flex column anchored just below the
      // station — natural document flow keeps the gap consistent for both
      // single- and two-line titles.
      const islandH     = isLast ? ISLAND_SIZE * LAST_SCALE : ISLAND_SIZE;
      const labelOffset = isLast ? 0 : 4;
      const infoY       = y + islandH + labelOffset;
      const wantLabel   = !!m.title;
      const wantProg    = !!m.progressEnabled;
      if (wantLabel || wantProg) {
        let infoInner = '';
        if (wantLabel) {
          infoInner +=
            `<span class="island-label">` + escapeHtml(m.title) + `</span>`;
        }
        if (wantProg) {
          const progressPct = Math.max(0, Math.min(100, Number(m.progress) || 0));
          if (progressPct >= 100) {
            infoInner +=
              `<div class="island-progress island-progress--done">` +
                `<svg class="island-check" viewBox="0 0 16 16">` +
                  `<path d="M3 8 L7 12 L13 4" fill="none" stroke="currentColor" ` +
                  `stroke-width="3" stroke-linecap="square" stroke-linejoin="miter"/>` +
                `</svg>` +
              `</div>`;
          } else {
            infoInner +=
              `<div class="island-progress">` +
                `<div class="island-progress__fill" style="--p:${progressPct}%"></div>` +
              `</div>`;
          }
        }
        labelsHtml +=
          `<li class="island-info" style="left:${x}%; top:${infoY}px">` +
          infoInner +
          `</li>`;
      }

      // Side missions for this main — placed as smaller islands offset L/R,
      // with a chaotic but deterministic scatter on both axes per side id.
      const sides = Array.isArray(m.sides) ? m.sides : [];
      sides.forEach((s, sIdx) => {
        const stacksOnThisSide = sides.filter(x => x.side === s.side).indexOf(s);
        const rx = pseudoRand(s.id, 17);                           // 0..1
        const ry = pseudoRand(s.id, 53);                           // 0..1
        const xMagPct = 30 + rx * 12;                              // 30..42%
        const xOffPct = (s.side === 'L' ? -1 : 1) * xMagPct;
        const sx = x + xOffPct;
        // Y scatter: roughly -0.18..+0.55 of ISLAND_SIZE around main top.
        // Some sides float above the main, others hang below.
        const yScatterFactor = -0.18 + ry * 0.73;
        const yStaggerPx = stacksOnThisSide * 52;
        const sy = y + ISLAND_SIZE * yScatterFactor + yStaggerPx;
        const sBadge = s.state === 'locked'
          ? `<span class="island-badge--locked" aria-hidden="true">
               <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 10V8a6 6 0 0 1 12 0v2h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1zm2 0h8V8a4 4 0 0 0-8 0v2z"/></svg>
             </span>`
          : '';
        const sImg = (s.state === 'done' && s.imageDataDone) ? s.imageDataDone : s.imageData;
        const sVisual = sImg
          ? `<img src="${sImg}" alt="${escapeHtml(s.title || 'Side mission')}" draggable="false">`
          : `<div class="island-placeholder island-placeholder--side"></div>`;
        html += `
          <li class="island-slot island-slot--side" style="left:${sx}%; top:${sy}px;">
            <button class="island island--side state-${s.state}" type="button"
                    data-id="${s.id}" data-state="${s.state}"
                    aria-label="${escapeHtml(s.title || 'Side mission')}">
              ${sVisual}
              ${sBadge}
              ${s.title ? `<span class="island-label island-label--side">${escapeHtml(s.title)}</span>` : ''}
            </button>
          </li>
        `;

        // Side trail — short chain of small cubes from main centre to side centre.
        const SIDE_DOTS = 12;
        const sx1 = x;
        const sy1 = y + ISLAND_SIZE / 2;
        const sx2 = sx;
        const sy2 = sy + (ISLAND_SIZE * 0.55) / 2;
        const dxPctS = sx2 - sx1;
        const dyPxS = sy2 - sy1;
        const lenApproxS = Math.hypot(dxPctS * 2, dyPxS) || 1;
        const pxS = -dyPxS / lenApproxS;
        const pyS = (dxPctS * 2) / lenApproxS;
        const offS = 6 * (s.side === 'L' ? 1 : -1);
        const cxS = (sx1 + sx2) / 2 + pxS * offS;
        const cyS = (sy1 + sy2) / 2 + pyS * offS;
        const sideSolid = (m.state === 'done' || m.state === 'current')
          && (s.state === 'done' || s.state === 'current');
        const sideCls = sideSolid ? 'trail-dot--solid trail-dot--side' : 'trail-dot--dashed trail-dot--side';
        for (let k = 1; k <= SIDE_DOTS; k++) {
          const t = k / (SIDE_DOTS + 1);
          const u = 1 - t;
          const sxk = u * u * sx1 + 2 * u * t * cxS + t * t * sx2;
          const syk = u * u * sy1 + 2 * u * t * cyS + t * t * sy2;
          const dxT = 2 * (u * (cxS - sx1) + t * (sx2 - cxS)) * mapWidthPx / 100;
          const dyT = 2 * (u * (cyS - sy1) + t * (sy2 - cyS));
          const rot = Math.atan2(dyT, dxT) * 180 / Math.PI;
          trailHtml += `<div class="trail-dot ${sideCls}" style="left:${sxk.toFixed(2)}%;top:${syk.toFixed(0)}px;--rot:${rot.toFixed(1)}deg"></div>`;
        }
      });
    });
    islandsEl.innerHTML = html;
    if (islandLabelsEl) islandLabelsEl.innerHTML = labelsHtml;
    trailEl.innerHTML = trailHtml;
    attachIslandHandlers();
  }

  /* ---------- Press animation → open preview ----------
     Tap on an island plays the press animation for PRESS_NAV_DELAY_MS, then
     opens the mission preview overlay. The CTA inside the preview is what
     actually navigates to the mission page. Locked islands shake instead. */
  function attachIslandHandlers() {
    islandsEl.querySelectorAll('.island').forEach(el => {
      let pressTimer = null;

      const finish = () => {
        const state = el.dataset.state;
        const id = el.dataset.id;
        const index = Number(el.dataset.index);
        pressTimer = null;
        el.classList.remove('pressed');
        if (state === 'locked') {
          el.classList.add('shake');
          setTimeout(() => el.classList.remove('shake'), 360);
          console.log('[mission-map] locked island tapped:', { id, index });
          return;
        }
        const target = `https://volzokalex.github.io/shai-mission-page-v3/#mission-${encodeURIComponent(id)}`;
        console.log('[mission-map] navigating →', target);
        window.location.href = target;
      };

      const abort = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        el.classList.remove('pressed');
      };

      el.addEventListener('pointerdown', (e) => {
        if (pressTimer) return;
        if (e.button !== undefined && e.button !== 0) return;
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('pressed');
        pressTimer = setTimeout(finish, PRESS_NAV_DELAY_MS);
      });
      // Only abort on pointercancel — the browser fires this when a tap
      // converts to scroll. pointerleave was over-eager on real iOS Safari:
      // a 1-2px finger drift would cancel taps before they could resolve.
      el.addEventListener('pointercancel', abort);
    });
  }

  /* ---------- Auto-scroll to current ----------
     Place the current island just below the sticky header, not centred in the
     viewport — so the user lands at the top of the active composition. */
  function scrollToCurrent() {
    const current = islandsEl.querySelector('.island.state-current');
    if (!current) return;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      const headerEl = document.querySelector('.app-header');
      const headerH = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const buffer = 16;
      const targetTop = current.getBoundingClientRect().top + window.scrollY - headerH - buffer;
      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: prefersReducedMotion ? 'auto' : 'smooth'
      });
    });
  }

  /* ---------- Editor ---------- */
  const missionListEl = document.getElementById('missionList');
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const resetAllBtn = document.getElementById('resetAll');

  function sideRowHtml(parentId, s) {
    const thumb = s.imageData
      ? `<img src="${s.imageData}" alt="" draggable="false">`
      : `<span class="mission-thumb__hint">art</span>`;
    const thumbDone = s.imageDataDone
      ? `<img src="${s.imageDataDone}" alt="" draggable="false">`
      : `<span class="mission-thumb__hint">done</span>`;
    const stateOptions = STATES.map(st =>
      `<option value="${st}" ${st === s.state ? 'selected' : ''}>${st}</option>`
    ).join('');
    const sideToggle = (val) => `<option value="${val}" ${val === s.side ? 'selected' : ''}>${val}</option>`;
    return `
      <div class="side-row" data-parent="${parentId}" data-id="${s.id}">
        <div class="side-thumbs">
          <button class="mission-thumb mission-thumb--side mission-thumb--main" type="button" title="Tap to replace side art">${thumb}</button>
          <button class="mission-thumb mission-thumb--side mission-thumb--done ${s.imageDataDone ? 'has-img' : ''}" type="button" title="Done-state art (optional)">${thumbDone}</button>
        </div>
        <div class="side-fields">
          <input class="side-title" type="text" placeholder="Side title"
                 value="${escapeHtml(s.title || '')}" maxlength="60">
          <div class="side-fields__row">
            <select class="side-side" aria-label="Side">
              ${sideToggle('L')}${sideToggle('R')}
            </select>
            <select class="side-state">${stateOptions}</select>
          </div>
        </div>
        <button class="side-delete" type="button" aria-label="Delete side">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>
    `;
  }

  function renderEditor() {
    if (missions.length === 0) {
      missionListEl.innerHTML = `<li class="editor-empty">No islands yet. Drop a PNG above to add your first mission.</li>`;
      return;
    }
    let html = '';
    missions.forEach((m, i) => {
      const thumbMain = m.imageData
        ? `<img src="${m.imageData}" alt="" draggable="false">`
        : `<span class="mission-thumb__placeholder">${i + 1}</span>`;
      const thumbDone = m.imageDataDone
        ? `<img src="${m.imageDataDone}" alt="" draggable="false">`
        : `<span class="mission-thumb__hint">done</span>`;
      const stateOptions = STATES.map(s =>
        `<option value="${s}" ${s === m.state ? 'selected' : ''}>${s}</option>`
      ).join('');
      const sides = Array.isArray(m.sides) ? m.sides : [];
      const sidesHtml = sides.map((s) => sideRowHtml(m.id, s)).join('');
      html += `
        <li class="mission-row" data-id="${m.id}" data-index="${i}" draggable="false">
          <span class="mission-drag" aria-label="Drag to reorder" draggable="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 5h2v2H9zm0 6h2v2H9zm0 6h2v2H9zm4-12h2v2h-2zm0 6h2v2h-2zm0 6h2v2h-2z"/></svg>
          </span>
          <div class="mission-thumbs">
            <button class="mission-thumb mission-thumb--main" type="button" title="Tap to replace main art">${thumbMain}</button>
            <button class="mission-thumb mission-thumb--done ${m.imageDataDone ? 'has-img' : ''}" type="button" title="Done-state art (optional)">${thumbDone}</button>
          </div>
          <div class="mission-fields">
            <input class="mission-title" type="text" placeholder="Mission title"
                   value="${escapeHtml(m.title || '')}" maxlength="60">
            <div class="mission-fields__row">
              <label>State</label>
              <select class="mission-state">${stateOptions}</select>
            </div>
            <div class="mission-fields__row">
              <label class="mission-progress-toggle">
                <input type="checkbox" class="mission-progress-enable" ${m.progressEnabled ? 'checked' : ''}>
                <span>Progress</span>
              </label>
              <input type="number" class="mission-progress-value" min="0" max="100"
                     value="${Math.max(0, Math.min(100, Number(m.progress) || 0))}"
                     ${m.progressEnabled ? '' : 'disabled'}>
              <span class="lessons-sep">%</span>
            </div>
            <div class="mission-sides" data-parent="${m.id}">
              ${sidesHtml}
              <button class="mission-add-side" type="button" data-parent="${m.id}">+ Add side mission</button>
            </div>
          </div>
          <button class="mission-delete" type="button" aria-label="Delete mission">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </li>
      `;
    });
    missionListEl.innerHTML = html;
    attachEditorRowHandlers();
    attachDragHandlers();
  }

  function attachEditorRowHandlers() {
    missionListEl.querySelectorAll('.mission-row').forEach(row => {
      const id = row.dataset.id;
      const titleEl = row.querySelector('.mission-title');
      const stateEl = row.querySelector('.mission-state');
      const delEl = row.querySelector('.mission-delete');
      const mainThumbEl = row.querySelector('.mission-thumb--main');
      const doneThumbEl = row.querySelector('.mission-thumb--done');
      const progEnableEl = row.querySelector('.mission-progress-enable');
      const progValueEl  = row.querySelector('.mission-progress-value');

      const openPicker = (target) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/png,image/jpeg,image/webp';
        inp.style.display = 'none';
        inp.addEventListener('change', async () => {
          const file = inp.files?.[0];
          if (!file) return;
          try {
            const dataUrl = await fileToResizedDataUrl(file);
            const m = missions.find(x => x.id === id);
            if (!m) return;
            if (target === 'done') {
              m.imageDataDone = dataUrl;
            } else {
              m.imageData = dataUrl;
              m.cropped = true;
            }
            persist();
            renderEditor();
            renderMap();
          } catch (err) {
            console.error('upload failed', err);
          }
        });
        document.body.appendChild(inp);
        inp.click();
        setTimeout(() => inp.remove(), 1000);
      };
      mainThumbEl?.addEventListener('click', () => openPicker('main'));
      doneThumbEl?.addEventListener('click', () => openPicker('done'));

      titleEl.addEventListener('input', () => {
        const m = missions.find(x => x.id === id);
        if (m) { m.title = titleEl.value.trim(); persist(); }
      });
      stateEl.addEventListener('change', () => {
        const m = missions.find(x => x.id === id);
        if (!m) return;
        if (stateEl.value === 'current') {
          // Only one mission may be current — demote any previous current.
          missions.forEach(x => { if (x.id !== id && x.state === 'current') x.state = 'available'; });
        }
        m.state = stateEl.value;
        persist();
        renderEditor();
        renderMap();
        renderHeader();
      });
      progEnableEl?.addEventListener('change', () => {
        const m = missions.find(x => x.id === id);
        if (!m) return;
        m.progressEnabled = progEnableEl.checked;
        if (m.progressEnabled && (m.progress === undefined || m.progress === null)) m.progress = 0;
        persist();
        renderEditor();
        renderMap();
      });
      progValueEl?.addEventListener('input', () => {
        const m = missions.find(x => x.id === id);
        if (!m) return;
        let v = Number(progValueEl.value);
        if (!Number.isFinite(v)) v = 0;
        v = Math.max(0, Math.min(100, Math.round(v)));
        m.progress = v;
        // Progress drives state:
        //   100  → done
        //   <100 → current (active); demote any other current first
        let stateChanged = false;
        if (v >= 100) {
          if (m.state !== 'done') { m.state = 'done'; stateChanged = true; }
        } else {
          if (m.state !== 'current') {
            missions.forEach(x => {
              if (x.id !== id && x.state === 'current') x.state = 'available';
            });
            m.state = 'current';
            stateChanged = true;
          }
        }
        persist();
        if (stateChanged) renderEditor();
        renderMap();
        renderHeader();
      });
      delEl.addEventListener('click', () => {
        const idx = missions.findIndex(x => x.id === id);
        if (idx >= 0) {
          missions.splice(idx, 1);
          persist();
          renderEditor();
          renderMap();
          renderHeader();
        }
      });
    });

    // Side-mission row handlers + Add side button.
    attachSideHandlers();
  }

  function attachSideHandlers() {
    missionListEl.querySelectorAll('.mission-add-side').forEach(btn => {
      btn.addEventListener('click', () => {
        const parentId = btn.dataset.parent;
        const m = missions.find(x => x.id === parentId);
        if (!m) return;
        if (!Array.isArray(m.sides)) m.sides = [];
        if (m.sides.length >= 3) return;            // soft cap at 3
        const occupiedSides = new Set(m.sides.map(s => s.side));
        const newSide = {
          id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          title: '',
          imageData: '',
          imageDataDone: '',
          state: 'available',
          side: occupiedSides.has('L') && !occupiedSides.has('R') ? 'R' : 'L',
          lessonsCompleted: 0,
          lessonsTotal: 3
        };
        m.sides.push(newSide);
        persist();
        renderEditor();
        renderMap();
      });
    });

    missionListEl.querySelectorAll('.side-row').forEach(row => {
      const parentId = row.dataset.parent;
      const sideId = row.dataset.id;
      const m = missions.find(x => x.id === parentId);
      if (!m) return;
      const s = (m.sides || []).find(x => x.id === sideId);
      if (!s) return;

      const titleEl = row.querySelector('.side-title');
      const sideSelEl = row.querySelector('.side-side');
      const stateEl = row.querySelector('.side-state');
      const delEl = row.querySelector('.side-delete');
      const mainThumbEl = row.querySelector('.mission-thumb--main');
      const doneThumbEl = row.querySelector('.mission-thumb--done');

      const openPicker = (target) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/png,image/jpeg,image/webp';
        inp.style.display = 'none';
        inp.addEventListener('change', async () => {
          const file = inp.files?.[0];
          if (!file) return;
          try {
            const dataUrl = await fileToResizedDataUrl(file);
            if (target === 'done') s.imageDataDone = dataUrl;
            else s.imageData = dataUrl;
            persist();
            renderEditor();
            renderMap();
          } catch (err) { console.error('side upload failed', err); }
        });
        document.body.appendChild(inp);
        inp.click();
        setTimeout(() => inp.remove(), 1000);
      };
      mainThumbEl?.addEventListener('click', () => openPicker('main'));
      doneThumbEl?.addEventListener('click', () => openPicker('done'));

      titleEl.addEventListener('input', () => { s.title = titleEl.value.trim(); persist(); renderMap(); });
      sideSelEl.addEventListener('change', () => { s.side = sideSelEl.value; persist(); renderMap(); });
      stateEl.addEventListener('change', () => { s.state = stateEl.value; persist(); renderMap(); });
      delEl.addEventListener('click', () => {
        const idx = m.sides.findIndex(x => x.id === sideId);
        if (idx >= 0) {
          m.sides.splice(idx, 1);
          persist();
          renderEditor();
          renderMap();
        }
      });
    });
  }

  /* ---------- Drag-and-drop reorder ---------- */
  function attachDragHandlers() {
    let draggingId = null;
    let draggingRow = null;

    missionListEl.querySelectorAll('.mission-row').forEach(row => {
      const handle = row.querySelector('.mission-drag');

      handle.addEventListener('dragstart', (e) => {
        draggingId = row.dataset.id;
        draggingRow = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox needs setData
        try { e.dataTransfer.setData('text/plain', draggingId); } catch {}
      });
      handle.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        missionListEl.querySelectorAll('.mission-row').forEach(r => {
          r.classList.remove('drop-target-above', 'drop-target-below');
        });
        draggingId = null;
        draggingRow = null;
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggingRow || row === draggingRow) return;
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        missionListEl.querySelectorAll('.mission-row').forEach(r => {
          r.classList.remove('drop-target-above', 'drop-target-below');
        });
        row.classList.add(before ? 'drop-target-above' : 'drop-target-below');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!draggingId || row === draggingRow) return;
        const fromIdx = missions.findIndex(x => x.id === draggingId);
        const toIdxBase = missions.findIndex(x => x.id === row.dataset.id);
        if (fromIdx < 0 || toIdxBase < 0) return;
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        let toIdx = before ? toIdxBase : toIdxBase + 1;
        if (fromIdx < toIdx) toIdx--;
        const [moved] = missions.splice(fromIdx, 1);
        missions.splice(toIdx, 0, moved);
        persist();
        renderEditor();
        renderMap();
      });
    });
  }

  /* ---------- Upload ---------- */
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    for (const file of files) {
      try {
        const dataUrl = await fileToResizedDataUrl(file);
        const newMission = {
          id: uid(),
          title: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
          imageData: dataUrl,
          cropped: true,
          state: missions.length === 0 ? 'current' : 'available',
          lessonsCompleted: 0,
          lessonsTotal: 3
        };
        missions.push(newMission);
      } catch (err) {
        console.error('Failed to load file', file.name, err);
        alert(`Couldn't load ${file.name}: ${err.message || err}`);
      }
    }
    persist();
    renderEditor();
    renderMap();
    renderHeader();
  }

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(ev => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  // Stop window-level drops from navigating away when missed.
  ['dragover', 'drop'].forEach(ev => {
    window.addEventListener(ev, (e) => {
      if (e.target.closest && e.target.closest('.dropzone')) return;
      e.preventDefault();
    });
  });

  /* ---------- Editor toggles: hide titles / hide connections ----------
     State persists in localStorage so a reload keeps the chosen view. */
  const TOGGLE_KEYS = {
    hideTitles:      'missionMap.hideTitles',
    hideConnections: 'missionMap.hideConnections'
  };
  const TOGGLE_CLASSES = {
    hideTitles:      'hide-titles',
    hideConnections: 'hide-connections'
  };
  function applyToggle(key, on) {
    document.body.classList.toggle(TOGGLE_CLASSES[key], on);
    try { localStorage.setItem(TOGGLE_KEYS[key], on ? '1' : '0'); } catch {}
  }
  function readToggle(key) {
    try { return localStorage.getItem(TOGGLE_KEYS[key]) === '1'; } catch { return false; }
  }
  const hideTitlesEl      = document.getElementById('toggleHideTitles');
  const hideConnectionsEl = document.getElementById('toggleHideConnections');
  if (hideTitlesEl) {
    hideTitlesEl.checked = readToggle('hideTitles');
    applyToggle('hideTitles', hideTitlesEl.checked);
    hideTitlesEl.addEventListener('change', () => applyToggle('hideTitles', hideTitlesEl.checked));
  }
  if (hideConnectionsEl) {
    hideConnectionsEl.checked = readToggle('hideConnections');
    applyToggle('hideConnections', hideConnectionsEl.checked);
    hideConnectionsEl.addEventListener('change', () => applyToggle('hideConnections', hideConnectionsEl.checked));
  }

  resetAllBtn.addEventListener('click', () => {
    if (missions.length === 0) return;
    if (!confirm('Delete all islands? This cannot be undone.')) return;
    missions = [];
    Store.clear();
    renderEditor();
    renderMap();
    renderHeader();
  });

  // Export current roster as JSON — download a file with everything in
  // localStorage so prod state can be copied back into the repo's sample-data.
  document.getElementById('exportJson')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(missions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission-map-export-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  /* ---------- Persistence helper + cross-tab sync ---------- */
  function persist() { Store.save(missions); }
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    missions = Store.load();
    renderEditor();
    renderMap();
    renderHeader();
  });

  /* ---------- Tab switcher ---------- */
  const tabButtons = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  function activateTab(name, opts = { scrollCurrent: true }) {
    tabButtons.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    panels.forEach(p => { p.hidden = p.dataset.panel !== name; });
    history.replaceState(null, '', '#' + name);
    if (name === 'map' && opts.scrollCurrent) scrollToCurrent();
  }
  tabButtons.forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));

  // "Go to editor" link from empty state
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]');
    if (!a) return;
    activateTab(a.dataset.go);
  });

  /* ---------- Cloud parallax (rAF-driven) ----------
     Two layers (far, mid), clouds hardcoded in index.html. JS just
     translates each layer on scroll at its assigned speed. */
  const layers = {
    far: document.querySelector('.cloud-layer--far'),
    mid: document.querySelector('.cloud-layer--mid')
  };
  const speeds = { far: 0.025, mid: 0.15 };

  let parallaxFrame = null;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function tickParallax() {
    parallaxFrame = null;
    if (prefersReducedMotion) return;
    const y = window.scrollY;
    for (const key of Object.keys(layers)) {
      const el = layers[key];
      if (!el) continue;
      el.style.transform = `translate3d(0, ${(-y * speeds[key]).toFixed(2)}px, 0)`;
    }
  }
  function onScroll() {
    if (parallaxFrame === null) parallaxFrame = requestAnimationFrame(tickParallax);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Bootstrap ---------- */
  renderHeader();
  renderEditor();
  renderMap();
  const initial = (location.hash || '').replace('#', '');
  activateTab(['map', 'editor'].includes(initial) ? initial : 'map');
  // Re-crop any islands stored before auto-crop (or after it was briefly disabled).
  migrateLegacyImages();
})();
