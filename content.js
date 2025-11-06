(function () {
  const MAX_ALWAYS_VISIBLE_TAIL = 6;   // keep only last 6 expanded by default
  const PLACEHOLDER_HEIGHT = 12;
  const SCAN_INTERVAL_MS = 1200;

  const STORAGE_KEYS = {
    tail: 'cv-max-tail',
    hudPos: 'cv-hud-pos',
    hudCollapsed: 'cv-hud-collapsed'
  };

  const SELECTORS = [
    '[data-testid="conversation-turn"]',
    '[data-message-id]',
    'div[role="listitem"]',
    'main .group.w-full',
    '[data-testid="message-bubble"]',
    '[data-message-author-role]'
  ];

  let enabled = true;
  let initialized = false;
  let messageNodes = [];
  let io = null;
  let rootScrollEl = null;
  let scrollTarget = null;
  let scrollTicking = false;
  let lastScanAt = 0;

  let maxAlwaysVisibleTail = MAX_ALWAYS_VISIBLE_TAIL;

  const originalHTML = new WeakMap();
  const collapsedFlag = new WeakMap();
  const userExpanded = new WeakSet();
  let visibleNodes = new WeakSet();
  const placeholderForNode = new WeakMap();
  const nodeForPlaceholder = new WeakMap();

  // HUD (fixed, bottom-right)
  let hudEl = null;
  let hudStatusEl = null;
  let hudTailLabelEl = null;
  let hudSettingsEl = null;
  let hudTailInputEl = null;
  let hudCollapseBtn = null;
  let hudCollapsedIndicatorEl = null;
  let hudContentWrapperEl = null;
  let dragState = null;
  let hudPosition = null;
  let hudSettingsVisible = false;
  let hudCollapsed = false;

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

  function loadHudCollapsed() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.hudCollapsed);
      if (stored != null) hudCollapsed = stored === '1';
    } catch {}
  }

  function saveHudCollapsed(value) {
    try {
      localStorage.setItem(STORAGE_KEYS.hudCollapsed, value ? '1' : '0');
    } catch {}
  }

  loadTailSetting();
  loadHudPosition();
  loadHudCollapsed();
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

    hudContentWrapperEl = document.createElement('div');
    hudContentWrapperEl.style.display = 'flex';
    hudContentWrapperEl.style.flexDirection = 'column';
    hudContentWrapperEl.style.gap = '6px';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';

    hudStatusEl = document.createElement('span');
    hudStatusEl.style.whiteSpace = 'nowrap';
    topRow.appendChild(hudStatusEl);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.gap = '8px';
    controlsRow.style.marginTop = '0';

    hudTailLabelEl = document.createElement('button');
    hudTailLabelEl.type = 'button';
    hudTailLabelEl.style.background = 'transparent';
    hudTailLabelEl.style.border = '0';
    hudTailLabelEl.style.borderRadius = '8px';
    hudTailLabelEl.style.padding = '0';
    hudTailLabelEl.style.font = '11px/1.2 system-ui, sans-serif';
    hudTailLabelEl.style.color = 'inherit';
    hudTailLabelEl.style.cursor = 'pointer';
    hudTailLabelEl.style.textDecoration = 'underline';
    hudTailLabelEl.setAttribute('aria-haspopup', 'true');
    hudTailLabelEl.addEventListener('click', () => {
      hudSettingsVisible = !hudSettingsVisible;
      if (hudSettingsEl) hudSettingsEl.style.display = hudSettingsVisible ? 'flex' : 'none';
      updateHUD();
    });
    controlsRow.appendChild(hudTailLabelEl);

    hudCollapseBtn = document.createElement('button');
    hudCollapseBtn.type = 'button';
    hudCollapseBtn.textContent = 'Hide';
    hudCollapseBtn.style.marginLeft = 'auto';
    hudCollapseBtn.style.padding = '2px 6px';
    hudCollapseBtn.style.border = '1px solid currentColor';
    hudCollapseBtn.style.borderRadius = '6px';
    hudCollapseBtn.style.background = 'rgba(255, 255, 255, 0.08)';
    hudCollapseBtn.style.font = '11px/1.2 system-ui, sans-serif';
    hudCollapseBtn.style.color = 'inherit';
    hudCollapseBtn.style.cursor = 'pointer';
    hudCollapseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHudCollapsed(!hudCollapsed);
    });
    controlsRow.appendChild(hudCollapseBtn);

    hudSettingsEl = document.createElement('div');
    hudSettingsEl.style.display = 'none';
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

    hudContentWrapperEl.appendChild(topRow);
    hudContentWrapperEl.appendChild(controlsRow);
    hudContentWrapperEl.appendChild(hudSettingsEl);
    hudEl.appendChild(hudContentWrapperEl);

    hudCollapsedIndicatorEl = document.createElement('button');
    hudCollapsedIndicatorEl.type = 'button';
    hudCollapsedIndicatorEl.textContent = 'C';
    hudCollapsedIndicatorEl.style.display = 'none';
    hudCollapsedIndicatorEl.style.padding = '0';
    hudCollapsedIndicatorEl.style.alignItems = 'center';
    hudCollapsedIndicatorEl.style.justifyContent = 'center';
    hudCollapsedIndicatorEl.style.fontWeight = '600';
    hudCollapsedIndicatorEl.style.fontSize = '12px';
    hudCollapsedIndicatorEl.style.cursor = 'pointer';
    hudCollapsedIndicatorEl.style.minWidth = '18px';
    hudCollapsedIndicatorEl.style.height = '18px';
    hudCollapsedIndicatorEl.style.border = '1px solid currentColor';
    hudCollapsedIndicatorEl.style.borderRadius = '50%';
    hudCollapsedIndicatorEl.style.background = 'rgba(255, 255, 255, 0.12)';
    hudCollapsedIndicatorEl.title = 'Show Chat Booster';
    hudCollapsedIndicatorEl.setAttribute('aria-label', 'Show Chat Booster');
    hudCollapsedIndicatorEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHudCollapsed(false);
    });
    hudEl.appendChild(hudCollapsedIndicatorEl);

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

    applyHudCollapsedState();
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
    }
    if (hudSettingsEl) hudSettingsEl.style.display = hudSettingsVisible ? 'flex' : 'none';
    if (hudTailInputEl) hudTailInputEl.value = maxAlwaysVisibleTail;
    if (hudCollapseBtn) {
      hudCollapseBtn.textContent = hudCollapsed ? 'Show' : 'Hide';
      hudCollapseBtn.setAttribute('aria-pressed', hudCollapsed ? 'true' : 'false');
    }
  }

  function setHudCollapsed(value) {
    const next = !!value;
    if (hudCollapsed === next) return;
    hudCollapsed = next;
    saveHudCollapsed(hudCollapsed);
    applyHudCollapsedState();
    updateHUD();
    lastScanAt = 0;
    virtualize();
  }

  function applyHudCollapsedState() {
    if (!hudEl) return;
    if (hudContentWrapperEl) {
      hudContentWrapperEl.style.display = hudCollapsed ? 'none' : 'flex';
      hudContentWrapperEl.setAttribute('aria-hidden', hudCollapsed ? 'true' : 'false');
    }
    if (hudCollapsedIndicatorEl) {
      hudCollapsedIndicatorEl.style.display = hudCollapsed ? 'flex' : 'none';
      hudCollapsedIndicatorEl.setAttribute('aria-hidden', hudCollapsed ? 'false' : 'true');
    }
    hudEl.style.padding = hudCollapsed ? '6px 8px' : '6px 10px';
    hudEl.style.cursor = hudCollapsed ? 'pointer' : 'grab';
    hudEl.style.minWidth = hudCollapsed ? '32px' : '';
    hudEl.style.minHeight = hudCollapsed ? '32px' : '';
    hudEl.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('.cv-placeholder').forEach(ph => {
      stylePlaceholderAppearance(ph);
    });
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
      const el = nodeForPlaceholder.get(entry.target) || entry.target;
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
  function normalizeMessageNode(el) {
    if (!el) return null;
    const candidates = [
      el.closest('[data-testid="conversation-turn"]'),
      el.closest('[data-message-id]'),
      el.closest('div[role="listitem"]'),
      el.closest('main .group.w-full')
    ];
    for (const cand of candidates) {
      if (cand) return cand;
    }
    return el;
  }

  function byDomOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function pickMessageNodes() {
    const seen = new Set();
    const result = [];
    const root = document.querySelector('main') || document.body || document.documentElement;
    if (!root) return result;
    for (const sel of SELECTORS) {
      root.querySelectorAll(sel).forEach(node => {
        const container = normalizeMessageNode(node);
        if (!container || seen.has(container)) return;
        if (container.classList?.contains('cv-placeholder')) return;
        const style = container instanceof Element ? window.getComputedStyle(container) : null;
        const isCollapsed = container?.dataset?.cvCollapsed === '1';
        if (style && (style.display === 'none' || style.visibility === 'hidden') && !isCollapsed) return;
        seen.add(container);
        result.push(container);
      });
    }
    if (result.length > 1) result.sort(byDomOrder);
    return result;
  }
  function isNearTail(index, total) {
    return index >= total - maxAlwaysVisibleTail;
  }

  function stylePlaceholderAppearance(ph) {
    if (!(ph instanceof HTMLElement)) return;
    ph.style.opacity = hudCollapsed ? '0' : '0.55';
    ph.style.pointerEvents = hudCollapsed ? 'none' : 'auto';
    ph.style.border = hudCollapsed ? '0' : '1px dashed currentColor';
    ph.style.background = hudCollapsed ? 'transparent' : 'rgba(0, 0, 0, 0.04)';
    ph.style.color = hudCollapsed ? 'transparent' : 'inherit';
    ph.textContent = hudCollapsed ? '' : (ph.dataset.cvLabel || '…');
  }

  function ensurePlaceholder(el, height) {
    let ph = placeholderForNode.get(el);
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'cv-placeholder';
      ph.dataset.cvLabel = '…';
      ph.style.boxSizing = 'border-box';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.style.borderRadius = '10px';
      ph.style.padding = '0 6px';
      ph.style.cursor = 'pointer';
      ph.setAttribute('title', 'Click to expand');
      ph.style.width = '100%';
      placeholderForNode.set(el, ph);
      nodeForPlaceholder.set(ph, el);
    }
    const appliedHeight = Math.max(height, PLACEHOLDER_HEIGHT);
    ph.style.height = `${appliedHeight}px`;
    const style = el instanceof Element ? window.getComputedStyle(el) : null;
    if (style) {
      ph.style.marginTop = style.marginTop;
      ph.style.marginBottom = style.marginBottom;
      ph.style.marginLeft = style.marginLeft;
      ph.style.marginRight = style.marginRight;
    }
    ph.dataset.cvHeight = String(appliedHeight);
    stylePlaceholderAppearance(ph);
    return ph;
  }

  function observeForNode(el) {
    if (!io) return;
    const placeholder = placeholderForNode.get(el);
    try { io.unobserve(el); } catch {}
    if (placeholder) {
      try { io.unobserve(placeholder); } catch {}
    }
    const target = (collapsedFlag.get(el) && placeholder) ? placeholder : el;
    if (target) {
      try { io.observe(target); } catch {}
    }
  }

  function cleanupOrphanPlaceholders() {
    document.querySelectorAll('.cv-placeholder').forEach(ph => {
      const container = nodeForPlaceholder.get(ph);
      if (!container || !container.isConnected) {
        nodeForPlaceholder.delete(ph);
        if (container) placeholderForNode.delete(container);
        ph.remove();
      }
    });
  }

  function collapseMessage(el) {
    if (collapsedFlag.get(el)) return;
    if (!(el instanceof HTMLElement) || !el.parentElement) return;
    originalHTML.set(el, el.innerHTML);
    const rect = el.getBoundingClientRect();
    let height = Math.max(rect.height || 0, PLACEHOLDER_HEIGHT);
    const existingPlaceholder = placeholderForNode.get(el);
    if (height <= PLACEHOLDER_HEIGHT && existingPlaceholder?.dataset?.cvHeight) {
      const stored = parseFloat(existingPlaceholder.dataset.cvHeight);
      if (Number.isFinite(stored)) height = Math.max(height, stored);
    }
    const placeholder = ensurePlaceholder(el, height);
    const parent = el.parentElement;
    if (placeholder.parentElement !== parent) {
      parent.insertBefore(placeholder, el);
    }
    placeholder.style.display = 'flex';
    el.innerHTML = '';
    el.style.display = 'none';
    el.dataset.cvCollapsed = '1';
    collapsedFlag.set(el, true);
    userExpanded.delete(el);
    visibleNodes.delete(el);
    if (io) observeForNode(el);
  }

  function expandMessage(el) {
    if (!collapsedFlag.get(el)) return;
    const html = originalHTML.get(el);
    if (typeof html === 'string') el.innerHTML = html;
    const placeholder = placeholderForNode.get(el);
    if (placeholder?.parentElement) {
      placeholder.parentElement.removeChild(placeholder);
    }
    if (placeholder) placeholder.style.display = 'none';
    el.style.removeProperty('display');
    delete el.dataset.cvCollapsed;
    collapsedFlag.set(el, false);
    if (io) observeForNode(el);
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

  function ensureScrollTarget() {
    const nextRoot = rootScrollEl instanceof Element ? rootScrollEl : null;
    const nextTarget = nextRoot || window;
    if (scrollTarget === nextTarget) return;
    if (scrollTarget) {
      try { scrollTarget.removeEventListener('scroll', handleScroll); }
      catch {}
    }
    scrollTarget = nextTarget;
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
  }

  function expandVisibleCollapsed() {
    if (!enabled) return;
    const placeholders = document.querySelectorAll('.cv-placeholder');
    if (placeholders.length === 0) return;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    placeholders.forEach(ph => {
      const container = nodeForPlaceholder.get(ph);
      if (!container || !collapsedFlag.get(container)) return;
      const rect = ph.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > viewportHeight) return;
      const wasCollapsed = collapsedFlag.get(container);
      expandMessage(container);
      if (wasCollapsed) visibleNodes.add(container);
    });
    updateHUD();
  }

  function handleScroll() {
    if (!enabled) return;
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      expandVisibleCollapsed();
    });
  }

  function virtualize() {
    if (!isChatPage() || !enabled) return;
    ensureHUD();
    cleanupOrphanPlaceholders();

    const main = document.querySelector('main');
    if (main) {
      main.style.contain = 'layout paint';
      main.style.contentVisibility = 'auto';
    }

    const nextRoot = findScrollRoot();
    if (nextRoot !== rootScrollEl) {
      rootScrollEl = nextRoot;
      ensureScrollTarget();
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
        observeForNode(el);
      });
    }
    expandVisibleCollapsed();
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
    const container = nodeForPlaceholder.get(ph);
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
    ensureScrollTarget();
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
