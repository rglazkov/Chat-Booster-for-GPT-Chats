(function () {
  const MAX_ALWAYS_VISIBLE_TAIL = 10;   // keep only last 10 expanded
  const PLACEHOLDER_HEIGHT = 12;
  const SCAN_INTERVAL_MS = 1200;

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

  const originalHTML = new WeakMap();
  const collapsedFlag = new WeakMap();
  const userExpanded = new WeakSet();

  // HUD (fixed, bottom-right)
  let hudEl = null;
  function ensureHUD() {
    if (hudEl) return;
    hudEl = document.createElement('div');
    hudEl.id = 'cv-hud';
    hudEl.style.position = 'fixed';
    hudEl.style.right = '12px';
    hudEl.style.bottom = '12px';
    hudEl.style.padding = '6px 10px';
    hudEl.style.border = '1px solid currentColor';
    hudEl.style.borderRadius = '10px';
    hudEl.style.opacity = '0.78';
    hudEl.style.font = '12px/1.2 system-ui, sans-serif';
    hudEl.style.background = 'transparent';
    hudEl.style.zIndex = '2147483647';
    hudEl.textContent = 'Chat Booster: 0 optimized';
    document.documentElement.appendChild(hudEl);
  }
  function updateHUD() {
    if (!hudEl) return;
    const n = document.querySelectorAll('.cv-placeholder').length;
    hudEl.textContent = `Chat Booster: ${n} optimized`;
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
    return index >= total - MAX_ALWAYS_VISIBLE_TAIL;
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
  }

  function expandMessage(el) {
    if (!collapsedFlag.get(el)) return;
    const html = originalHTML.get(el);
    if (typeof html === 'string') el.innerHTML = html;
    el.style.removeProperty('content-visibility');
    el.style.removeProperty('contain');
    collapsedFlag.set(el, false);
  }

  // In strict mode we do not need IntersectionObserver
  function rebuildObserver() {
    if (io) { io.disconnect(); io = null; }
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

    // Only last N expanded; everything else collapsed
    messageNodes.forEach((el, idx) => {
      if (isNearTail(idx, messageNodes.length)) {
        expandMessage(el);
      } else if (!userExpanded.has(el)) {
        collapseMessage(el);
      }
    });
    updateHUD();
  }

  function expandAllAndDisable() {
    if (io) io.disconnect();
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
