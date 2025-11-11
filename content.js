(function () {
  const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;
  const ENABLE_TEST_HOOKS = !!globalObj.__CHAT_BOOSTER_ENABLE_TEST_HOOKS__;
  const AUTO_BOOT_DISABLED = !!globalObj.__CHAT_BOOSTER_DISABLE_AUTOBOOT__;
  const MAX_ALWAYS_VISIBLE_TAIL = 10;  // keep only last 10 expanded by default
  const PLACEHOLDER_HEIGHT = 12;
  const SCAN_INTERVAL_MS = 2000;
  const MUTATION_DEBOUNCE_MS = 650;
  const STREAM_LOCK_RELEASE_DELAY_MS = 420;

  const scheduleIdle = typeof globalObj.requestIdleCallback === 'function'
    ? (cb) => globalObj.requestIdleCallback(cb, { timeout: 500 })
    : (cb) => setTimeout(cb, 120);

  const STORAGE_KEYS = {
    tail: 'cv-max-tail',
    hudPos: 'cv-hud-pos',
    hudCollapsed: 'cv-hud-collapsed'
  };

  const ULTRA_STORAGE_KEY = 'cb.ultra';
  const DEFAULT_ULTRA_MODE = true;

  const SELECTORS = [
    '[data-testid="conversation-turn"]',
    '[data-testid*="conversation-turn"]',
    '[data-testid="conversation-message"]',
    '[data-testid*="conversation-message"]',
    '[data-testid="chat-message"]',
    '[data-testid*="chat-message"]',
    '[data-testid="message-bubble"]',
    '[data-message-id]',
    '[data-entry-id]',
    '[data-message-author-role]',
    'div[role="listitem"]',
    'li[role="listitem"]',
    'section[role="listitem"]',
    'article[role="listitem"]',
    'main .group.w-full'
  ];

  let enabled = true;
  let ultraMode = DEFAULT_ULTRA_MODE;
  let initialized = false;
  let messageNodes = [];
  let messageSet = new WeakSet();
  let messageNodesDirty = true;
  let messageRevision = 0;
  let lastVirtualizedRevision = -1;
  let virtualizationDirty = true;
  let streamLock = false;
  let streamLockTimer = null;
  let streamMutationHintActive = false;
  let streamMutationHintTimer = null;
  const measurementQueue = new Set();
  let measurementHandle = null;
  let rootScrollEl = null;
  let scrollTarget = null;
  let scrollTicking = false;
  let lastScanAt = 0;

  let maxAlwaysVisibleTail = MAX_ALWAYS_VISIBLE_TAIL;
  let virtualizationInProgress = false;

  const originalHTML = new WeakMap();
  const collapsedFlag = new WeakMap();
  const collapsedNodes = new Set();
  const userExpanded = new WeakSet();
  let visibleNodes = new WeakSet();
  let collapsedTotal = 0;
  let collapsedCountDirty = true;
  let lastHudOptimizedCount = null;
  const placeholderForNode = new WeakMap();
  const nodeForPlaceholder = new WeakMap();
  const detachedInfo = new WeakMap();

  // HUD (fixed, bottom-right)
  let hudEl = null;
  let hudStatusEl = null;
  let hudTailLabelEl = null;
  let hudSettingsEl = null;
  let hudUltraBtn = null;
  let hudReopenBtn = null;
  let hudTailInputEl = null;
  let hudCollapseBtn = null;
  let hudCollapsedIndicatorEl = null;
  let hudContentWrapperEl = null;
  let dragState = null;
  let hudPosition = null;
  let hudSettingsVisible = false;
  let hudCollapsed = false;
  let hudTailInputFocused = false;
  let ultraMotionStyleEl = null;

  function markCollapsed(el) {
    if (!el) return false;
    const wasCollapsed = collapsedFlag.get(el) === true;
    if (wasCollapsed) return false;
    collapsedFlag.set(el, true);
    collapsedNodes.add(el);
    collapsedTotal = collapsedNodes.size;
    return true;
  }

  function markExpanded(el) {
    if (!el) return false;
    const wasCollapsed = collapsedFlag.get(el) === true;
    if (!wasCollapsed) return false;
    collapsedFlag.delete(el);
    collapsedNodes.delete(el);
    collapsedTotal = collapsedNodes.size;
    return true;
  }

  function forgetCollapsed(el) {
    if (!el) return false;
    const wasCollapsed = collapsedFlag.get(el) === true;
    if (wasCollapsed) {
      collapsedNodes.delete(el);
      collapsedTotal = collapsedNodes.size;
    }
    collapsedFlag.delete(el);
    return wasCollapsed;
  }

  function syncCollapsedCount(options) {
    const opts = typeof options === 'object' && options !== null ? options : {};
    const force = opts.force === true;
    const silent = opts.silent === true;
    if (!collapsedCountDirty && !force) return collapsedTotal;
    let next = 0;
    for (const el of messageNodes) {
      if (collapsedFlag.get(el)) next += 1;
    }
    if (collapsedNodes.size > next) next = collapsedNodes.size;
    collapsedCountDirty = false;
    const changed = collapsedTotal !== next;
    collapsedTotal = next;
    if (changed && !virtualizationInProgress && !silent) {
      updateHUD();
    }
    return collapsedTotal;
  }

  function clampTail(value) {
    const num = Math.floor(Number(value));
    if (!Number.isFinite(num)) return maxAlwaysVisibleTail;
    return Math.max(1, Math.min(50, num));
  }

  function getRootViewportRect() {
    if (rootScrollEl instanceof Element) {
      return rootScrollEl.getBoundingClientRect();
    }
    return { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight || 0 };
  }

  function shiftScrollBy(delta) {
    if (!delta) return;
    if (rootScrollEl instanceof Element) {
      rootScrollEl.scrollTop = (rootScrollEl.scrollTop || 0) - delta;
    } else {
      window.scrollBy(0, -delta);
    }
  }

  function isMessageStreaming(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (collapsedFlag.get(el)) return false;
    const explicitLock = el.dataset?.cvLock === '1';
    if (explicitLock) return true;
    const status = el.getAttribute?.('data-message-status') || el.dataset?.messageStatus || '';
    if (status) {
      const normalized = status.toLowerCase();
      if (!/(finished|success|done|complete|resolved)/.test(normalized)) {
        return true;
      }
    }
    const streamingAttr = el.getAttribute?.('data-streaming') || el.dataset?.streaming;
    if (typeof streamingAttr === 'string' && /^(1|true|yes)$/i.test(streamingAttr)) {
      return true;
    }
    const ariaBusy = el.getAttribute?.('aria-busy');
    if (ariaBusy === 'true') return true;
    if (el.querySelector?.('[data-testid*="thinking" i]')) return true;
    if (el.querySelector?.('[data-testid*="spinner" i]')) return true;
    const pendingRole = el.querySelector?.('[data-message-author-role="assistant"][data-state], [data-message-author-role="assistant"][data-is-streaming]');
    if (pendingRole) {
      const dataState = pendingRole.getAttribute('data-state') || pendingRole.getAttribute('data-is-streaming');
      if (typeof dataState === 'string' && /pending|loading|true|1/i.test(dataState)) return true;
    }
    const text = el.textContent || '';
    if (!status && /thinking\u2026|thinking\.\.\.|processing/i.test(text)) {
      return true;
    }
    return false;
  }

  function shouldSkipVirtualization(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (userExpanded.has(el)) return false;
    if (isMessageStreaming(el)) return true;
    return false;
  }

  const ULTRA_MOTION_STYLE = `
    *, *::before, *::after {
      animation: none !important;
      animation-play-state: paused !important;
      transition: none !important;
    }
    html, body, body * {
      scroll-behavior: auto !important;
    }
  `;

  function ensureUltraMotionStyle() {
    if (typeof document === 'undefined') return null;
    if (ultraMotionStyleEl && ultraMotionStyleEl.isConnected) {
      if (!ultraMotionStyleEl.textContent) ultraMotionStyleEl.textContent = ULTRA_MOTION_STYLE;
      return ultraMotionStyleEl;
    }
    const style = ultraMotionStyleEl || document.createElement('style');
    style.textContent = ULTRA_MOTION_STYLE;
    const target = document.head || document.documentElement || document.body;
    if (target && style.parentElement !== target) {
      target.appendChild(style);
    }
    ultraMotionStyleEl = style;
    return ultraMotionStyleEl;
  }

  function removeUltraMotionStyle() {
    if (ultraMotionStyleEl && ultraMotionStyleEl.parentElement) {
      ultraMotionStyleEl.parentElement.removeChild(ultraMotionStyleEl);
    }
    ultraMotionStyleEl = null;
  }

  function applyUltraScrollBehavior(enabledOnly) {
    if (typeof document === 'undefined') return;
    const candidates = new Set();
    if (document.documentElement instanceof HTMLElement) candidates.add(document.documentElement);
    if (document.body instanceof HTMLElement) candidates.add(document.body);
    if (document.scrollingElement instanceof HTMLElement) candidates.add(document.scrollingElement);
    if (rootScrollEl instanceof HTMLElement) candidates.add(rootScrollEl);
    candidates.forEach(el => {
      try {
        if (enabledOnly) el.style.setProperty('scroll-behavior', 'auto', 'important');
        else el.style.removeProperty('scroll-behavior');
      } catch {}
    });
  }

  function updateUltraMotionPreferences() {
    if (ultraMode && enabled) {
      ensureUltraMotionStyle();
      applyUltraScrollBehavior(true);
    } else {
      removeUltraMotionStyle();
      applyUltraScrollBehavior(false);
    }
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

  function loadUltraPreference() {
    try {
      if (!chrome?.storage?.local?.get) {
        setUltraMode(DEFAULT_ULTRA_MODE, false);
        return;
      }
      chrome.storage.local.get({ [ULTRA_STORAGE_KEY]: DEFAULT_ULTRA_MODE }, (result) => {
        if (chrome.runtime?.lastError) {
          setUltraMode(DEFAULT_ULTRA_MODE, false);
          return;
        }
        const stored = result?.[ULTRA_STORAGE_KEY];
        setUltraMode(typeof stored === 'boolean' ? stored : DEFAULT_ULTRA_MODE, false);
      });
    } catch {
      setUltraMode(DEFAULT_ULTRA_MODE, false);
    }
  }

  function setUltraMode(value, persist) {
    const next = !!value;
    const shouldPersist = !!persist;
    const changed = ultraMode !== next;
    ultraMode = next;
    updateUltraMotionPreferences();
    if (shouldPersist && chrome?.storage?.local?.set) {
      try { chrome.storage.local.set({ [ULTRA_STORAGE_KEY]: next }); }
      catch {}
    }
    if (!initialized) {
      updateHUD();
      return;
    }
    if (changed) {
      const prevState = virtualizationInProgress;
      virtualizationInProgress = true;
      try {
        messageNodes.forEach(el => { expandMessage(el); });
        document.querySelectorAll('.cv-placeholder').forEach(ph => {
          const container = nodeForPlaceholder.get(ph);
          if (container) expandMessage(container);
        });
      } finally {
        virtualizationInProgress = prevState;
      }
      syncCollapsedCount({ force: true });
      lastScanAt = 0;
      virtualizationDirty = true;
      virtualize();
    }
    updateHUD();
  }

  loadTailSetting();
  loadHudCollapsed();
  loadUltraPreference();
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
    hudEl.style.opacity = '0.88';
    hudEl.style.font = '12px/1.2 system-ui, sans-serif';
    hudEl.style.background = 'rgba(0, 0, 0, 0.08)';
    hudEl.style.backdropFilter = 'blur(2px)';
    hudEl.style.color = 'inherit';
    hudEl.style.zIndex = '2147483647';
    hudEl.style.cursor = 'default';
    hudEl.style.touchAction = 'auto';
    hudEl.style.userSelect = 'none';

    hudContentWrapperEl = document.createElement('div');
    hudContentWrapperEl.style.display = 'flex';
    hudContentWrapperEl.style.flexDirection = 'column';
    hudContentWrapperEl.style.gap = '6px';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '8px';

    hudStatusEl = document.createElement('span');
    hudStatusEl.style.whiteSpace = 'nowrap';
    topRow.appendChild(hudStatusEl);

    hudUltraBtn = document.createElement('button');
    hudUltraBtn.type = 'button';
    hudUltraBtn.style.padding = '2px 8px';
    hudUltraBtn.style.border = '1px solid currentColor';
    hudUltraBtn.style.borderRadius = '6px';
    hudUltraBtn.style.background = 'rgba(255, 255, 255, 0.08)';
    hudUltraBtn.style.font = '11px/1.2 system-ui, sans-serif';
    hudUltraBtn.style.color = 'inherit';
    hudUltraBtn.style.cursor = 'pointer';
    hudUltraBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setUltraMode(!ultraMode, true);
    });
    topRow.appendChild(hudUltraBtn);

    hudReopenBtn = document.createElement('button');
    hudReopenBtn.type = 'button';
    hudReopenBtn.textContent = 'Reopen in tab';
    hudReopenBtn.style.padding = '2px 8px';
    hudReopenBtn.style.border = '1px solid currentColor';
    hudReopenBtn.style.borderRadius = '6px';
    hudReopenBtn.style.background = 'rgba(255, 255, 255, 0.08)';
    hudReopenBtn.style.font = '11px/1.2 system-ui, sans-serif';
    hudReopenBtn.style.color = 'inherit';
    hudReopenBtn.style.cursor = 'pointer';
    hudReopenBtn.title = 'Open this chat in a new tab';
    hudReopenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.open(location.href, '_blank', 'noopener');
      } catch {}
    });

    const reopenRow = document.createElement('div');
    reopenRow.style.display = 'flex';
    reopenRow.style.alignItems = 'center';
    reopenRow.style.justifyContent = 'flex-start';
    reopenRow.style.gap = '8px';
    reopenRow.appendChild(hudReopenBtn);

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
    hudTailInputEl.addEventListener('focus', () => {
      hudTailInputFocused = true;
    });
    hudTailInputEl.addEventListener('change', () => {
      const next = clampTail(parseInt(hudTailInputEl.value, 10));
      setMaxAlwaysVisibleTail(next);
    });
    hudTailInputEl.addEventListener('blur', () => {
      hudTailInputFocused = false;
      hudTailInputEl.value = maxAlwaysVisibleTail;
    });

    label.appendChild(hudTailInputEl);
    hudSettingsEl.appendChild(label);

    hudContentWrapperEl.appendChild(topRow);
    hudContentWrapperEl.appendChild(reopenRow);
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

    applyHudCollapsedState();
    updateHUD();
  }

  function updateHUD() {
    if (!hudEl) return;
    const optimizedCount = Math.max(0, syncCollapsedCount({ silent: true }));
    if (hudStatusEl && (lastHudOptimizedCount === null || lastHudOptimizedCount !== optimizedCount || !hudStatusEl.textContent)) {
      hudStatusEl.textContent = `Chat Booster: ${optimizedCount} optimized`;
    }
    lastHudOptimizedCount = optimizedCount;
    if (hudUltraBtn) {
      hudUltraBtn.textContent = `Ultra: ${ultraMode ? 'ON' : 'OFF'}`;
      hudUltraBtn.setAttribute('aria-pressed', ultraMode ? 'true' : 'false');
    }
    if (hudTailLabelEl) {
      const indicator = hudSettingsVisible ? '▴' : '▾';
      hudTailLabelEl.textContent = `Tail: ${maxAlwaysVisibleTail} ${indicator}`;
      hudTailLabelEl.setAttribute('aria-expanded', String(hudSettingsVisible));
    }
    if (hudSettingsEl) hudSettingsEl.style.display = hudSettingsVisible ? 'flex' : 'none';
    if (hudTailInputEl && !hudTailInputFocused) hudTailInputEl.value = maxAlwaysVisibleTail;
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
    virtualizationDirty = true;
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
    hudEl.style.cursor = hudCollapsed ? 'pointer' : 'default';
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
    virtualizationDirty = true;
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

  function isChatPage() {
    const host = (location?.hostname || location?.host || '').toLowerCase();
    if (!host) return false;
    return host === 'chat.openai.com'
      || host.endsWith('.chat.openai.com')
      || host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com');
  }
  function getScrollTop() {
    if (rootScrollEl instanceof Element) {
      return rootScrollEl.scrollTop || 0;
    }
    return window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  function findScrollRoot() {
    const candidates = [
      document.querySelector('[data-testid="conversation-scroll-container"]'),
      document.querySelector('[data-testid="conversation-scroll"]'),
      document.querySelector('[data-testid="scroll-container"]'),
      document.querySelector('[data-testid="page"]'),
      document.querySelector('main'),
      document.scrollingElement,
      document.documentElement,
      document.body
    ];
    for (const node of candidates) {
      if (node) return node;
    }
    return document.documentElement;
  }
  function normalizeMessageNode(el) {
    if (!el) return null;
    const candidates = [
      el.closest('[data-testid="conversation-turn"]'),
      el.closest('[data-testid*="conversation-turn"]'),
      el.closest('[data-testid="conversation-message"]'),
      el.closest('[data-testid*="conversation-message"]'),
      el.closest('[data-testid="chat-message"]'),
      el.closest('[data-testid*="chat-message"]'),
      el.closest('[data-message-id]'),
      el.closest('[data-entry-id]'),
      el.closest('[data-message-author-role]'),
      el.closest('article[role="listitem"]'),
      el.closest('section[role="listitem"]'),
      el.closest('li[role="listitem"]'),
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
    const selectors = [...SELECTORS, '.cv-placeholder'];
    root.querySelectorAll(selectors.join(',')).forEach(node => {
      let container = null;
      if (node.classList?.contains('cv-placeholder')) {
        container = nodeForPlaceholder.get(node) || null;
      } else {
        container = normalizeMessageNode(node);
      }
      if (!container || seen.has(container)) return;
      if (container.classList?.contains?.('cv-placeholder')) return;
      const isCollapsed = container?.dataset?.cvCollapsed === '1';
      if (container instanceof Element && container.isConnected) {
        const style = window.getComputedStyle(container);
        if (style && (style.display === 'none' || style.visibility === 'hidden') && !isCollapsed) return;
      }
      seen.add(container);
      result.push(container);
    });
    return result;
  }

  function rebuildMessageNodes() {
    const next = pickMessageNodes();
    messageNodes = next;
    messageSet = new WeakSet();
    next.forEach(node => {
      if (node instanceof HTMLElement) messageSet.add(node);
    });
    messageNodesDirty = false;
    messageRevision += 1;
    collapsedCountDirty = true;
  }

  function addMessageNode(node) {
    const container = normalizeMessageNode(node);
    if (!(container instanceof HTMLElement)) {
      messageNodesDirty = true;
      return false;
    }
    if (messageSet.has(container)) return false;
    messageNodes.push(container);
    messageSet.add(container);
    messageNodes.sort(byDomOrder);
    messageRevision += 1;
    virtualizationDirty = true;
    collapsedCountDirty = true;
    return true;
  }

  function removeMessageNode(node) {
    const container = normalizeMessageNode(node);
    if (!(container instanceof HTMLElement)) {
      messageNodesDirty = true;
      return false;
    }
    if (!messageSet.has(container)) return false;
    messageSet.delete(container);
    const idx = messageNodes.indexOf(container);
    if (idx >= 0) messageNodes.splice(idx, 1);
    measurementQueue.delete(container);
    const placeholder = placeholderForNode.get(container);
    if (placeholder) {
      placeholderForNode.delete(container);
      nodeForPlaceholder.delete(placeholder);
      if (placeholder.parentElement) {
        placeholder.remove();
      }
    }
    detachedInfo.delete(container);
    const removedCollapsed = forgetCollapsed(container);
    userExpanded.delete(container);
    visibleNodes.delete(container);
    virtualizationDirty = true;
    messageRevision += 1;
    if (!virtualizationInProgress && removedCollapsed) syncCollapsedCount();
    collapsedCountDirty = true;
    return true;
  }
  function isNearTail(index, total) {
    return index >= total - maxAlwaysVisibleTail;
  }

  function stylePlaceholderAppearance(ph) {
    if (!(ph instanceof HTMLElement)) return;
    const detached = ph.dataset?.cvDetached === '1';
    if (detached) {
      ph.style.opacity = '0';
      ph.style.pointerEvents = 'none';
      ph.style.border = '0';
      ph.style.background = 'transparent';
      ph.style.color = 'transparent';
      ph.style.contentVisibility = 'hidden';
      ph.textContent = '';
      const collapsedHeight = ph.dataset?.cvCollapsedHeight || '0px';
      ph.style.minHeight = collapsedHeight;
      ph.style.height = collapsedHeight;
      return;
    }
    ph.style.contentVisibility = 'auto';
    ph.style.opacity = hudCollapsed ? '0' : '0.55';
    ph.style.pointerEvents = hudCollapsed ? 'none' : 'auto';
    ph.style.border = hudCollapsed ? '0' : '1px dashed currentColor';
    ph.style.background = hudCollapsed ? 'transparent' : 'rgba(0, 0, 0, 0.04)';
    ph.style.color = hudCollapsed ? 'transparent' : 'inherit';
    ph.textContent = hudCollapsed ? '' : (ph.dataset.cvLabel || '…');
    const collapsedHeight = ph.dataset?.cvCollapsedHeight;
    if (collapsedHeight) {
      ph.style.height = collapsedHeight;
      ph.style.minHeight = collapsedHeight;
    }
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
    ph.dataset.cvHeight = String(appliedHeight);
    ph.style.contain = 'layout paint size';
    ph.style.contentVisibility = 'auto';
    ph.style.height = `${appliedHeight}px`;
    ph.dataset.cvCollapsedHeight = `${appliedHeight}px`;
    const style = el instanceof Element ? window.getComputedStyle(el) : null;
    if (style) {
      ph.style.marginTop = style.marginTop;
      ph.style.marginBottom = style.marginBottom;
      ph.style.marginLeft = style.marginLeft;
      ph.style.marginRight = style.marginRight;
    }
    stylePlaceholderAppearance(ph);
    return ph;
  }

  function getStoredHeight(el) {
    if (!(el instanceof HTMLElement)) return PLACEHOLDER_HEIGHT;
    const info = detachedInfo.get(el);
    if (info && typeof info.height === 'number' && Number.isFinite(info.height)) {
      return Math.max(PLACEHOLDER_HEIGHT, info.height);
    }
    const placeholder = placeholderForNode.get(el);
    if (placeholder?.dataset?.cvHeight) {
      const stored = parseFloat(placeholder.dataset.cvHeight);
      if (Number.isFinite(stored)) return Math.max(PLACEHOLDER_HEIGHT, stored);
    }
    if (el.dataset?.cvHeight) {
      const stored = parseFloat(el.dataset.cvHeight);
      if (Number.isFinite(stored)) return Math.max(PLACEHOLDER_HEIGHT, stored);
    }
    return PLACEHOLDER_HEIGHT;
  }

  function hasMeasuredHeight(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.dataset?.cvMeasured === '1') return true;
    const placeholder = placeholderForNode.get(el);
    if (placeholder?.dataset?.cvMeasured === '1') return true;
    const info = detachedInfo.get(el);
    return !!(info && typeof info.height === 'number');
  }

  function ensureMeasured(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (collapsedFlag.get(el)) return true;
    if (hasMeasuredHeight(el)) return true;
    if (measurementQueue.has(el)) return false;
    measurementQueue.add(el);
    if (!measurementHandle) {
      measurementHandle = scheduleIdle(processMeasurementQueue);
    }
    return false;
  }

  function processMeasurementQueue(deadline) {
    measurementHandle = null;
    let processed = 0;
    const iterator = measurementQueue.values();
    const queue = [];
    for (const el of iterator) {
      queue.push(el);
    }
    measurementQueue.clear();
    while (queue.length > 0) {
      const el = queue.shift();
      if (!(el instanceof HTMLElement)) continue;
      if (!el.isConnected) continue;
      if (collapsedFlag.get(el)) continue;
      const viewport = getRootViewportRect();
      const scrollTop = getScrollTop();
      const rect = el.getBoundingClientRect();
      const height = Math.max(rect.height || 0, PLACEHOLDER_HEIGHT);
      const placeholder = ensurePlaceholder(el, height);
      placeholder.dataset.cvMeasured = '1';
      placeholder.dataset.cvHeight = String(height);
      placeholder.dataset.cvCollapsedHeight = placeholder.dataset.cvCollapsedHeight || `${height}px`;
      placeholder.style.height = placeholder.dataset.cvCollapsedHeight;
      placeholder.style.minHeight = placeholder.dataset.cvCollapsedHeight;
      el.dataset.cvMeasured = '1';
      el.dataset.cvHeight = String(height);
      el.dataset.cvMeasuredScrollTop = String(scrollTop);
      el.dataset.cvMeasuredViewportTop = String(viewport.top || 0);
      el.dataset.cvMeasuredBottom = String(rect.bottom || 0);
      el.dataset.cvMeasuredTop = String(rect.top || 0);
      processed += 1;
      if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 1) {
        break;
      }
      if (!deadline && processed >= 4) {
        break;
      }
    }
    if (queue.length > 0) {
      queue.forEach(el => {
        if (el instanceof HTMLElement && !collapsedFlag.get(el)) measurementQueue.add(el);
      });
      if (!measurementHandle) {
        measurementHandle = scheduleIdle(processMeasurementQueue);
      }
    } else if (measurementQueue.size > 0 && !measurementHandle) {
      measurementHandle = scheduleIdle(processMeasurementQueue);
    }
    if (processed > 0) {
      virtualizationDirty = true;
      if (!enabled) return;
      if (!streamLock) {
        virtualize({ force: true });
      }
    }
  }

  function restoreUltraBackfill() {
    if (!ultraMode || messageNodes.length === 0) return;
    const threshold = 120;
    if (getScrollTop() > threshold) return;
    let restored = 0;
    const maxToRestore = Math.max(3, Math.min(10, maxAlwaysVisibleTail));
    for (let i = 0; i < messageNodes.length; i++) {
      const el = messageNodes[i];
      if (shouldSkipVirtualization(el)) continue;
      if (!collapsedFlag.get(el)) continue;
      const info = detachedInfo.get(el);
      if (!info) continue;
      const placeholder = info.placeholder || placeholderForNode.get(el);
      if (!placeholder || placeholder.dataset?.cvDetached !== '1') continue;
      const wasCollapsed = collapsedFlag.get(el);
      expandMessage(el);
      if (wasCollapsed) visibleNodes.add(el);
      restored++;
      if (restored >= maxToRestore) break;
    }
    if (restored > 0) updateHUD();
  }

  function cleanupOrphanPlaceholders() {
    let touched = false;
    document.querySelectorAll('.cv-placeholder').forEach(ph => {
      const container = nodeForPlaceholder.get(ph);
      const info = container ? detachedInfo.get(container) : null;
      if (!container || (!container.isConnected && !info)) {
        nodeForPlaceholder.delete(ph);
        if (container) {
          placeholderForNode.delete(container);
          if (forgetCollapsed(container)) touched = true;
        }
        ph.remove();
      }
    });
    if (touched && !virtualizationInProgress) syncCollapsedCount();
  }

  function collapseMessage(el) {
    if (!(el instanceof HTMLElement)) return;
    if (shouldSkipVirtualization(el)) {
      expandMessage(el);
      visibleNodes.add(el);
      return;
    }
    if (ultraMode) collapseMessageUltra(el);
    else collapseMessageStrict(el);
  }

  function collapseMessageStrict(el) {
    if (collapsedFlag.get(el) && !detachedInfo.has(el)) return;
    if (!(el instanceof HTMLElement) || !el.parentElement) return;
    originalHTML.set(el, el.innerHTML);
    const height = getStoredHeight(el);
    const placeholder = ensurePlaceholder(el, height);
    const parent = el.parentElement;
    if (placeholder.parentElement !== parent) {
      parent.insertBefore(placeholder, el);
    }
    placeholder.style.display = 'flex';
    placeholder.dataset.cvDetached = '0';
    const collapsedHeight = PLACEHOLDER_HEIGHT;
    placeholder.dataset.cvCollapsedHeight = `${collapsedHeight}px`;
    placeholder.style.height = `${collapsedHeight}px`;
    placeholder.style.minHeight = `${collapsedHeight}px`;
    stylePlaceholderAppearance(placeholder);
    el.innerHTML = '';
    el.style.display = 'none';
    el.style.contain = 'layout paint size';
    el.style.contentVisibility = 'hidden';
    el.dataset.cvCollapsed = '1';
    detachedInfo.delete(el);
    const changed = markCollapsed(el);
    userExpanded.delete(el);
    visibleNodes.delete(el);
    if (!virtualizationInProgress && changed) syncCollapsedCount();
  }

  function collapseMessageUltra(el) {
    if (!(el instanceof HTMLElement)) return;
    const info = detachedInfo.get(el);
    const parent = el.parentElement || info?.parent || placeholderForNode.get(el)?.parentElement;
    if (!parent) return;
    if (detachedInfo.has(el) && collapsedFlag.get(el)) return;
    const height = getStoredHeight(el);
    const placeholder = ensurePlaceholder(el, height);
    if (placeholder.parentElement !== parent) {
      parent.insertBefore(placeholder, el.isConnected ? el : null);
    }
    placeholder.style.display = 'block';
    placeholder.dataset.cvCollapsedHeight = '0px';
    placeholder.style.height = '0px';
    placeholder.style.minHeight = '0px';
    placeholder.style.marginTop = '0';
    placeholder.style.marginBottom = '0';
    placeholder.style.marginLeft = '0';
    placeholder.style.marginRight = '0';
    placeholder.style.padding = '0';
    placeholder.style.opacity = '0';
    placeholder.style.pointerEvents = 'none';
    placeholder.dataset.cvDetached = '1';
    stylePlaceholderAppearance(placeholder);
    const measuredScrollTop = parseFloat(el.dataset?.cvMeasuredScrollTop || 'NaN');
    const measuredViewportTop = parseFloat(el.dataset?.cvMeasuredViewportTop || 'NaN');
    const measuredBottom = parseFloat(el.dataset?.cvMeasuredBottom || 'NaN');
    const currentScrollTop = getScrollTop();
    const viewport = getRootViewportRect();
    const scrollDelta = Number.isFinite(measuredScrollTop) ? currentScrollTop - measuredScrollTop : 0;
    const viewportDelta = Number.isFinite(measuredViewportTop) ? viewport.top - measuredViewportTop : 0;
    const projectedBottom = Number.isFinite(measuredBottom)
      ? measuredBottom + viewportDelta - scrollDelta
      : Infinity;
    const isAboveViewport = Number.isFinite(projectedBottom) && projectedBottom <= viewport.top;
    if (el.parentElement === parent) {
      parent.removeChild(el);
    }
    if (isAboveViewport && height > 0) {
      shiftScrollBy(height);
    }
    el.dataset.cvCollapsed = '1';
    detachedInfo.set(el, { parent, placeholder, height });
    const changed = markCollapsed(el);
    userExpanded.delete(el);
    visibleNodes.delete(el);
    if (!virtualizationInProgress && changed) syncCollapsedCount();
  }

  function expandMessage(el) {
    if (!collapsedFlag.get(el)) return;
    const info = detachedInfo.get(el);
    let placeholder = placeholderForNode.get(el);
    if (!placeholder && info?.placeholder instanceof HTMLElement) {
      placeholder = info.placeholder;
      placeholderForNode.set(el, placeholder);
      nodeForPlaceholder.set(placeholder, el);
    }
    const parent = placeholder?.parentElement || info?.parent || null;
    if (parent) {
      parent.insertBefore(el, placeholder || info?.placeholder?.nextSibling || null);
    } else if (info?.parent) {
      info.parent.insertBefore(el, info.placeholder?.nextSibling || null);
    } else {
      const html = originalHTML.get(el);
      if (typeof html === 'string') el.innerHTML = html;
    }
    if (placeholder?.parentElement) {
      placeholder.parentElement.removeChild(placeholder);
    } else if (info?.placeholder?.parentElement) {
      info.placeholder.parentElement.removeChild(info.placeholder);
    }
    if (placeholder) {
      placeholder.style.display = 'none';
      placeholder.dataset.cvDetached = '0';
      stylePlaceholderAppearance(placeholder);
    }
    el.style.removeProperty('display');
    el.style.removeProperty('contain');
    el.style.removeProperty('content-visibility');
    delete el.dataset.cvCollapsed;
    detachedInfo.delete(el);
    const changed = markExpanded(el);
    if (!virtualizationInProgress) {
      if (!ultraMode) userExpanded.add(el);
      visibleNodes.add(el);
    }
    if (!virtualizationInProgress && changed) {
      syncCollapsedCount();
      updateHUD();
    }
    if (!hasMeasuredHeight(el)) ensureMeasured(el);
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

  function noteStreamMutation() {
    if (streamMutationHintTimer) {
      clearTimeout(streamMutationHintTimer);
      streamMutationHintTimer = null;
    }
    streamMutationHintActive = true;
    streamMutationHintTimer = setTimeout(() => {
      streamMutationHintTimer = null;
      streamMutationHintActive = false;
      updateStreamLock();
    }, STREAM_LOCK_RELEASE_DELAY_MS);
    updateStreamLock();
  }

  function trackStreamMutationTarget(target) {
    if (!target) return;
    const element = target instanceof HTMLElement ? target : target.parentElement;
    if (!(element instanceof HTMLElement)) return;
    if (element.classList?.contains?.('cv-placeholder')) return;
    const container = normalizeMessageNode(element);
    if (!container) return;
    const last = messageNodes.length > 0 ? messageNodes[messageNodes.length - 1] : null;
    if (container === last) noteStreamMutation();
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
      if (ultraMode) restoreUltraBackfill();
    });
  }

  function virtualize(options) {
    const opts = typeof options === 'boolean'
      ? { force: options }
      : (typeof options === 'object' && options !== null ? options : {});
    const force = !!opts.force;
    if (!isChatPage() || !enabled) return;
    ensureHUD();
    cleanupOrphanPlaceholders();

    if (!force && streamLock) {
      updateStreamLock();
      updateHUD();
      return;
    }

    const main = document.querySelector('main');
    if (main) {
      main.style.contain = 'layout paint';
      main.style.contentVisibility = 'auto';
    }

    const nextRoot = findScrollRoot();
    if (nextRoot !== rootScrollEl) {
      rootScrollEl = nextRoot;
      ensureScrollTarget();
      updateUltraMotionPreferences();
    }

    const now = Date.now();
    const hasChanges = virtualizationDirty || messageNodesDirty || messageRevision !== lastVirtualizedRevision;
    if (!force && !hasChanges) {
      if (lastScanAt && now - lastScanAt < SCAN_INTERVAL_MS) {
        updateStreamLock();
        updateHUD();
        return;
      }
      lastScanAt = now;
      updateStreamLock();
      updateHUD();
      return;
    }

    lastScanAt = now;

    if (messageNodesDirty || messageNodes.length === 0) {
      rebuildMessageNodes();
    }

    if (messageNodes.length === 0) {
      collapsedNodes.clear();
      collapsedTotal = 0;
      collapsedCountDirty = false;
      virtualizationDirty = false;
      messageNodesDirty = false;
      lastVirtualizedRevision = messageRevision;
      updateHUD();
      updateStreamLock();
      return;
    }

    virtualizationInProgress = true;
    try {
      const guardCount = Math.max(0, maxAlwaysVisibleTail + 2);
      const guardStart = Math.max(0, messageNodes.length - guardCount);

      messageNodes.forEach((el, idx) => {
        if (!(el instanceof HTMLElement)) return;
        if (idx >= guardStart) {
          expandMessage(el);
          visibleNodes.add(el);
          return;
        }
        if (shouldSkipVirtualization(el)) {
          expandMessage(el);
          visibleNodes.add(el);
          return;
        }
        const nearTail = isNearTail(idx, messageNodes.length);
        if (nearTail || userExpanded.has(el) || visibleNodes.has(el)) {
          expandMessage(el);
          return;
        }
        if (!collapsedFlag.get(el)) {
          if (!ensureMeasured(el)) {
            visibleNodes.add(el);
            return;
          }
        }
        collapseMessage(el);
      });

      expandVisibleCollapsed();
      if (ultraMode) restoreUltraBackfill();
      syncCollapsedCount({ force: true, silent: true });
    } finally {
      virtualizationInProgress = false;
    }

    updateHUD();

    virtualizationDirty = false;
    messageNodesDirty = false;
    lastVirtualizedRevision = messageRevision;
    updateStreamLock();
  }

  function updateStreamLock() {
    if (messageNodes.length === 0) {
      streamLock = false;
      if (streamLockTimer) {
        clearTimeout(streamLockTimer);
        streamLockTimer = null;
      }
      return;
    }
    const last = messageNodes[messageNodes.length - 1];
    if (!(last instanceof HTMLElement)) {
      streamLock = false;
      if (streamLockTimer) {
        clearTimeout(streamLockTimer);
        streamLockTimer = null;
      }
      return;
    }
    const streaming = streamMutationHintActive || isMessageStreaming(last);
    if (streaming) {
      if (!streamLock) streamLock = true;
      if (streamLockTimer) {
        clearTimeout(streamLockTimer);
        streamLockTimer = null;
      }
      return;
    }
    if (!streamLock) return;
    if (streamLockTimer) return;
    streamLockTimer = setTimeout(() => {
      streamLockTimer = null;
      streamLock = false;
      virtualizationDirty = true;
      if (!enabled) return;
      virtualize({ force: true });
    }, STREAM_LOCK_RELEASE_DELAY_MS);
  }

  function expandAllAndDisable() {
    visibleNodes = new WeakSet();
    if (streamLockTimer) {
      clearTimeout(streamLockTimer);
      streamLockTimer = null;
    }
    streamLock = false;
    if (streamMutationHintTimer) {
      clearTimeout(streamMutationHintTimer);
      streamMutationHintTimer = null;
    }
    streamMutationHintActive = false;
    const prevState = virtualizationInProgress;
    virtualizationInProgress = true;
    try {
      messageNodes.forEach(el => {
        expandMessage(el);
        userExpanded.delete(el);
      });
      document.querySelectorAll('.cv-placeholder').forEach(ph => {
        const container = nodeForPlaceholder.get(ph);
        if (container) expandMessage(container);
      });
    } finally {
      virtualizationInProgress = prevState;
    }
    syncCollapsedCount({ force: true });
    updateHUD();
  }

  document.addEventListener('click', (e) => {
    const ph = e.target.closest?.('.cv-placeholder');
    if (!ph) return;
    const container = nodeForPlaceholder.get(ph);
    if (!container) return;
    const wasCollapsed = collapsedFlag.get(container);
    expandMessage(container);
    if (wasCollapsed && !ultraMode) userExpanded.add(container);
    try {
      const behavior = ultraMode ? 'auto' : 'smooth';
      container.scrollIntoView({ block: 'nearest', behavior });
    } catch {
      try { container.scrollIntoView(); } catch {}
    }
    updateHUD();
  }, { passive: true });

  const mo = new MutationObserver((records) => {
    if (!enabled) return;
    let touched = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        trackStreamMutationTarget(record.target);
        continue;
      }
      record.addedNodes?.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (addMessageNode(node)) touched = true;
        trackStreamMutationTarget(node);
      });
      record.removedNodes?.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        if (removeMessageNode(node)) touched = true;
      });
      if (!touched) {
        trackStreamMutationTarget(record.target);
      }
      if (!touched && record.type === 'childList' && record.target && record.addedNodes?.length === 0 && record.removedNodes?.length === 0) {
        // Structural change we didn't catch
        messageNodesDirty = true;
      }
    }
    if (touched) updateStreamLock();
    if (streamLock) return;
    if (touched || messageNodesDirty) {
      clearTimeout(mo._t);
      mo._t = setTimeout(() => { virtualize(); }, MUTATION_DEBOUNCE_MS);
    }
  });

  function boot() {
    if (initialized) return;
    initialized = true;
    rootScrollEl = findScrollRoot();
    ensureScrollTarget();
    updateUltraMotionPreferences();
    ensureHUD();
    try {
      const root = document.querySelector('main') || document.body;
      mo.observe(root, { childList: true, subtree: true, characterData: true });
    } catch {}
    virtualize();
    setInterval(() => {
      if (!enabled) return;
      if (!virtualizationDirty && !messageNodesDirty) {
        updateStreamLock();
        return;
      }
      virtualize();
    }, SCAN_INTERVAL_MS);
  }

  if (!AUTO_BOOT_DISABLED) {
    if (document.readyState === "complete" || document.readyState === "interactive") boot();
    else window.addEventListener('DOMContentLoaded', boot);
  } else {
    globalObj.__CHAT_BOOSTER_MANUAL_BOOT__ = boot;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg?.type) return;
      if (msg.type === 'CV_TOGGLE') {
        enabled = !!msg.enabled;
        if (enabled) {
          virtualizationDirty = true;
          virtualize();
        } else {
          expandAllAndDisable();
        }
        updateUltraMotionPreferences();
        updateHUD();
      }
      if (msg.type === 'CV_APPLY') {
        enabled = !!msg.enabled;
        if (enabled) {
          virtualizationDirty = true;
          virtualize();
        } else {
          expandAllAndDisable();
        }
        updateUltraMotionPreferences();
        updateHUD();
      }
    });
  }

  if (ENABLE_TEST_HOOKS) {
    const testHooks = {
      collapseMessage,
      collapseMessageStrict,
      collapseMessageUltra,
      expandMessage,
      isMessageStreaming,
      shouldSkipVirtualization,
      setUltraMode: (value) => setUltraMode(value, false),
      setRootScrollEl: (el) => { rootScrollEl = el; updateUltraMotionPreferences(); },
      getPlaceholderForNode: (el) => placeholderForNode.get(el),
      getDetachedInfo: (el) => detachedInfo.get(el) || null,
      getMessageNodes: () => messageNodes.slice(),
      getCollapsedTotal: () => syncCollapsedCount({ silent: true }),
      getHudStatusText: () => hudStatusEl?.textContent || '',
      isStreamLockActive: () => streamLock,
      updateStreamLock,
      syncCollapsedCount: (opts) => syncCollapsedCount(opts),
      getScrollTop,
      setEnabled: (value) => { enabled = !!value; updateUltraMotionPreferences(); },
      virtualize,
      boot,
      get visibleNodes() { return visibleNodes; },
      set visibleNodes(next) { if (next instanceof WeakSet) visibleNodes = next; }
    };
    Object.defineProperty(globalObj, '__CHAT_BOOSTER_TEST_HOOKS__', {
      value: testHooks,
      configurable: true,
      writable: false
    });
  }
})();
