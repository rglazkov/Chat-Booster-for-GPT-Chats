(function () {
  const MAX_ALWAYS_VISIBLE_TAIL = 6;   // keep only last 6 expanded by default
  const PLACEHOLDER_HEIGHT = 12;
  const SCAN_INTERVAL_MS = 1200;

  const STORAGE_KEYS = {
    tail: 'cv-max-tail',
    hudPos: 'cv-hud-pos'
  };

  const SELECTORS = [
    '[data-testid="conversation-turn"]',
    '[data-message-id]',
    'div[role="listitem"]',
    'main .group.w-full'
  ];

  let enabled = true;
  let initialized = false;
  let messageNodes = [];
  let io = null;
  let rootScrollEl = null;
  let lastScanAt = 0;

  let maxAlwaysVisibleTail = MAX_ALWAYS_VISIBLE_TAIL;

  const originalHTML = new WeakMap();
  const collapsedFlag = new WeakMap();
  const userExpanded = new WeakSet();
  let visibleNodes = new WeakSet();

  // HUD (fixed, bottom-right)
  let hudEl = null;
  let hudStatusEl = null;
  let hudTailLabelEl = null;
  let hudSettingsEl = null;
  let hudTailInputEl = null;
  let hudToggleBtn = null;
  let dragState = null;
  let hudPosition = null;

  function clampTail(value) {
    const num = Math.floor(Number(value));
    if (!Number.isFinite(num)) return maxAlwaysVisibleTail;
    return Math.max(1, Math.min(50, num));
  }

  function loadTailSetting() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.tail);
      if (stored != null) {
        const parsed = clampTail(parseInt(stored, 10));
        if (!Number.isNaN(parsed)) maxAlwaysVisibleTail = parsed;
      }
    } catch {}
  }

  function saveTailSetting(value) {
    try {
      localStorage.setItem(STORAGE_KEYS.tail, String(value));
    } catch {}
  }

  function loadHudPosition() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.hudPos);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
          hudPosition = { left: parsed.left, top: parsed.top };
        }
      }
    } catch {}
  }

  function saveHudPosition(pos) {
    try {
      localStorage.setItem(STORAGE_KEYS.hudPos, JSON.stringify(pos));
    } catch {}
  }

  loadTailSetting();
  loadHudPosition();
  function ensureHUD() {
    if (hudEl) return;
    if (!hudPosition) loadHudPosition();
    hudEl = document.createElement('div');
    hudEl.id = 'cv-hud';
    hudEl.style.position = 'fixed';
    hudEl.style.right = '12px';
    hudEl.style.bottom = '12px';
    hudEl.style.padding = '6px 10px';
    hudEl.style.border = '1px solid currentColor';
    hudEl.style.borderRadius = '10px';
    hudEl.style.opacity = '0.88';
    hudEl.style.font = '12px/1.2 system-ui, sans-serif';
    hudEl.style.background = 'rgba(0, 0, 0, 0.08)';
    hudEl.style.backdropFilter = 'blur(2px)';
    hudEl.style.color = 'inherit';
    hudEl.style.zIndex = '2147483647';
    hudEl.style.cursor = 'grab';
    hudEl.style.touchAction = 'none';
    hudEl.style.userSelect = 'none';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '6px';

    hudStatusEl = document.createElement('span');
    hudStatusEl.style.whiteSpace = 'nowrap';
    topRow.appendChild(hudStatusEl);

    hudTailLabelEl = document.createElement('button');
    hudTailLabelEl.type = 'button';
    hudTailLabelEl.style.background = 'transparent';
    hudTailLabelEl.style.border = '1px solid currentColor';
    hudTailLabelEl.style.borderRadius = '8px';
    hudTailLabelEl.style.padding = '2px 6px';
    hudTailLabelEl.style.font = '11px/1.2 system-ui, sans-serif';
    hudTailLabelEl.style.color = 'inherit';
    hudTailLabelEl.style.cursor = 'pointer';
    hudTailLabelEl.setAttribute('aria-haspopup', 'true');
    hudTailLabelEl.addEventListener('click', () => {
      hudSettingsVisible = !hudSettingsVisible;
      if (hudSettingsEl) hudSettingsEl.style.display = hudSettingsVisible ? 'flex' : 'none';
      updateHUD();
    });
    topRow.appendChild(hudTailLabelEl);

    hudToggleBtn = document.createElement('button');
    hudToggleBtn.type = 'button';
    hudToggleBtn.textContent = '×';
    hudToggleBtn.setAttribute('aria-label', 'Collapse menu');
    hudToggleBtn.style.display = 'none';
    hudToggleBtn.style.background = 'transparent';
    hudToggleBtn.style.border = '0';
    hudToggleBtn.style.cursor = 'pointer';
    hudToggleBtn.style.fontSize = '12px';
    hudToggleBtn.style.padding = '2px';
    hudToggleBtn.addEventListener('click', () => {
      hudSettingsVisible = false;
      if (hudSettingsEl) hudSettingsEl.style.display = 'none';
      updateHUD();
    });
    topRow.appendChild(hudToggleBtn);

    hudSettingsEl = document.createElement('div');
    hudSettingsEl.style.display = 'none';
    hudSettingsEl.style.marginTop = '6px';
    hudSettingsEl.style.gap = '6px';
    hudSettingsEl.style.alignItems = 'center';
    hudSettingsEl.style.fontSize = '11px';
    hudSettingsEl.style.flexWrap = 'wrap';
    hudSettingsEl.style.justifyContent = 'space-between';

    const label = document.createElement('label');
    label.textContent = 'Always visible messages:';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';

    hudTailInputEl = document.createElement('input');
    hudTailInputEl.type = 'number';
    hudTailInputEl.min = '1';
    hudTailInputEl.max = '50';
    hudTailInputEl.value = maxAlwaysVisibleTail;
    hudTailInputEl.style.width = '3.5em';
    hudTailInputEl.style.padding = '2px 4px';
    hudTailInputEl.style.border = '1px solid currentColor';
    hudTailInputEl.style.borderRadius = '6px';
    hudTailInputEl.addEventListener('change', () => {
      const next = clampTail(parseInt(hudTailInputEl.value, 10));
      setMaxAlwaysVisibleTail(next);
    });
    hudTailInputEl.addEventListener('blur', () => {
      hudTailInputEl.value = maxAlwaysVisibleTail;
    });

    label.appendChild(hudTailInputEl);
    hudSettingsEl.appendChild(label);

    hudEl.appendChild(topRow);
    hudEl.appendChild(hudSettingsEl);
    document.documentElement.appendChild(hudEl);

    if (hudPosition) {
      hudEl.style.left = `${hudPosition.left}px`;
      hudEl.style.top = `${hudPosition.top}px`;
      hudEl.style.right = '';
      hudEl.style.bottom = '';
    }

    hudEl.addEventListener('pointerdown', handleHudPointerDown);
    hudEl.addEventListener('pointermove', handleHudPointerMove);
    hudEl.addEventListener('pointerup', handleHudPointerUpOrCancel);
    hudEl.addEventListener('pointercancel', handleHudPointerUpOrCancel);

    updateHUD();
  }

  function updateHUD() {
    if (!hudEl) return;
    const n = document.querySelectorAll('.cv-placeholder').length;
    if (hudStatusEl) hudStatusEl.textContent = `Chat Booster: ${n} optimized`;
    if (hudTailLabelEl) {
      const indicator = hudSettingsVisible ? '▴' : '▾';
      hudTailLabelEl.textContent = `Tail: ${maxAlwaysVisibleTail} ${indicator}`;
      hudTailLabelEl.setAttribute('aria-expanded', String(hudSettingsVisible));
      if (hudSettingsVisible && hudToggleBtn) hudToggleBtn.style.display = 'inline';
      else if (hudToggleBtn) hudToggleBtn.style.display = 'none';
    }
    if (hudTailInputEl) hudTailInputEl.value = maxAlwaysVisibleTail;
  }

  function setMaxAlwaysVisibleTail(value) {
    const clamped = clampTail(value);
    if (maxAlwaysVisibleTail === clamped) {
      updateHUD();
      return;
    }
    maxAlwaysVisibleTail = clamped;
    saveTailSetting(clamped);
    lastScanAt = 0;
    virtualize();
    updateHUD();
  }

  function handleHudPointerDown(e) {
    if (!hudEl) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    const interactive = e.target?.closest?.('input, button, select, textarea, a');
    if (interactive && interactive !== hudEl) return;
    const rect = hudEl.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };
    hudEl.style.left = `${rect.left}px`;
    hudEl.style.top = `${rect.top}px`;
    hudEl.style.right = '';
    hudEl.style.bottom = '';
    hudEl.style.cursor = 'grabbing';
    try { hudEl.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  }

  function handleHudPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId || !hudEl) return;
    const maxLeft = Math.max(0, window.innerWidth - dragState.width);
    const maxTop = Math.max(0, window.innerHeight - dragState.height);
    let nextLeft = e.clientX - dragState.offsetX;
    let nextTop = e.clientY - dragState.offsetY;
    nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    nextTop = Math.max(0, Math.min(nextTop, maxTop));
    hudEl.style.left = `${nextLeft}px`;
    hudEl.style.top = `${nextTop}px`;
    hudPosition = { left: nextLeft, top: nextTop };
  }

  function handleHudPointerUpOrCancel(e) {
    if (!dragState || !hudEl || e.pointerId !== dragState.pointerId) return;
    try { hudEl.releasePointerCapture(e.pointerId); } catch {}
    hudEl.style.cursor = 'grab';
    dragState = null;
    if (hudPosition) saveHudPosition(hudPosition);
  }

  function handleIntersection(entries) {
    if (!enabled) return;
    for (const entry of entries) {
      const el = entry.target;
      const idx = messageNodes.indexOf(el);
      const nearTail = idx >= 0 && isNearTail(idx, messageNodes.length);
      if (entry.isIntersecting || entry.intersectionRatio > 0) {
        visibleNodes.add(el);
        if (collapsedFlag.get(el) && !userExpanded.has(el)) expandMessage(el);
      } else {
        visibleNodes.delete(el);
        if (!nearTail && !userExpanded.has(el)) collapseMessage(el);
      }
    }
    updateHUD();
  }

  function isChatPage() {
    return /chatgpt\.com|chat\.openai\.com/.test(location.host);
  }
  function findScrollRoot() {
    return document.querySelector('main') || document.scrollingElement || document.documentElement;
  }
  function pickMessageNodes() {
    const found = new Set();
    for (const sel of SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        if (el && el.nodeType === 1 && el.offsetParent !== null) found.add(el);
      });
      if (found.size > 0) break;
    }
    return Array.from(found);
  }
  function isNearTail(index, total) {
    return index >= total - maxAlwaysVisibleTail;
  }

  function makePlaceholder() {
    const ph = document.createElement('div');
    ph.className = 'cv-placeholder';
    ph.style.height = `${PLACEHOLDER_HEIGHT}px`;
    ph.style.borderRadius = '6px';
    ph.style.opacity = '0.55';
    ph.style.border = '1px dashed currentColor';
    ph.style.display = 'flex';
    ph.style.alignItems = 'center';
    ph.style.padding = '0 6px';
    ph.style.margin = '4px 0';
    ph.style.cursor = 'pointer';
    ph.setAttribute('title', 'Click to expand');
    ph.textContent = '…';
    return ph;
  }

  function collapseMessage(el) {
    if (collapsedFlag.get(el)) return;
    if (!originalHTML.has(el)) originalHTML.set(el, el.innerHTML);
    el.innerHTML = '';
    el.appendChild(makePlaceholder());
    el.style.contain = 'content';
    el.style.contentVisibility = 'auto';
    collapsedFlag.set(el, true);
    userExpanded.delete(el);
    visibleNodes.delete(el);
  }

  function expandMessage(el) {
    if (!collapsedFlag.get(el)) return;
    const html = originalHTML.get(el);
    if (typeof html === 'string') el.innerHTML = html;
    el.style.removeProperty('content-visibility');
    el.style.removeProperty('contain');
    collapsedFlag.set(el, false);
  }

  function rebuildObserver() {
    const root = rootScrollEl instanceof Element ? rootScrollEl : null;
    if (io) {
      if (io.root !== root) {
        io.disconnect();
        io = null;
        visibleNodes = new WeakSet();
      } else {
        io.disconnect();
      }
    }
    if (!io) {
      io = new IntersectionObserver(handleIntersection, {
        root,
        threshold: [0, 0.05]
      });
    }
  }

  function virtualize() {
    if (!isChatPage() || !enabled) return;
    ensureHUD();

    const main = document.querySelector('main');
    if (main) {
      main.style.contain = 'layout paint';
      main.style.contentVisibility = 'auto';
    }

    const now = Date.now();
    if (now - lastScanAt < SCAN_INTERVAL_MS) return;
    lastScanAt = now;

    messageNodes = pickMessageNodes();
    if (messageNodes.length === 0) return;

    rebuildObserver();

    // Only last N expanded; everything else collapsed unless visible or user expanded
    messageNodes.forEach((el, idx) => {
      const nearTail = isNearTail(idx, messageNodes.length);
      if (nearTail || userExpanded.has(el) || visibleNodes.has(el)) {
        expandMessage(el);
      } else {
        collapseMessage(el);
      }
    });

    if (io) {
      messageNodes.forEach(el => {
        try { io.observe(el); } catch {}
      });
    }
    updateHUD();
  }

  function expandAllAndDisable() {
    if (io) io.disconnect();
    visibleNodes = new WeakSet();
    messageNodes.forEach(el => {
      expandMessage(el);
      userExpanded.delete(el);
    });
    updateHUD();
  }

  document.addEventListener('click', (e) => {
    const ph = e.target.closest?.('.cv-placeholder');
    if (!ph) return;
    const container = ph.parentElement;
    if (!container) return;
    const wasCollapsed = collapsedFlag.get(container);
    expandMessage(container);
    if (wasCollapsed) userExpanded.add(container);
    container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    updateHUD();
  }, { passive: true });

  const mo = new MutationObserver(() => {
    if (!enabled) return;
    clearTimeout(mo._t); mo._t = setTimeout(() => { virtualize(); }, 180);
  });

  function boot() {
    if (initialized) return;
    initialized = true;
    rootScrollEl = findScrollRoot();
    ensureHUD();
    try {
      const root = document.querySelector('main') || document.body;
      mo.observe(root, { childList: true, subtree: true });
    } catch {}
    virtualize();
    setInterval(() => { if (enabled) virtualize(); }, SCAN_INTERVAL_MS);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") boot();
  else window.addEventListener('DOMContentLoaded', boot);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    if (msg.type === 'CV_TOGGLE') {
      enabled = !!msg.enabled;
      if (enabled) virtualize(); else expandAllAndDisable();
      updateHUD();
    }
    if (msg.type === 'CV_APPLY') {
      enabled = !!msg.enabled;
      if (enabled) virtualize(); else expandAllAndDisable();
      updateHUD();
    }
  });
})();
