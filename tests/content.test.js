const { test } = require('node:test');
const assert = require('node:assert/strict');

const observerRegistry = new Set();

function isDescendant(target, root) {
  let node = target;
  while (node) {
    if (node === root) return true;
    node = node.parentElement;
  }
  return false;
}

function notifyMutation(target, addedNodes = [], removedNodes = []) {
  if (addedNodes.length === 0 && removedNodes.length === 0) return;
  const record = {
    type: 'childList',
    target,
    addedNodes: Array.from(addedNodes),
    removedNodes: Array.from(removedNodes)
  };
  observerRegistry.forEach(entry => {
    const { observer, target: observedTarget, options } = entry;
    if (!options.childList) return;
    const shouldNotify = observedTarget === target
      || (options.subtree && isDescendant(target, observedTarget));
    if (shouldNotify) {
      observer.callback([record]);
    }
  });
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    const styleStore = {};
    this.style = new Proxy(styleStore, {
      get: (target, prop) => {
        if (prop === 'setProperty') {
          return (name, value) => { target[name] = value; };
        }
        if (prop === 'removeProperty') {
          return (name) => { delete target[name]; };
        }
        return target[prop];
      },
      set: (target, prop, value) => {
        target[prop] = value;
        return true;
      },
      ownKeys: (target) => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target, prop) => ({
        enumerable: true,
        configurable: true,
        value: target[prop],
        writable: true
      })
    });
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.id = '';
    this.className = '';
    this.role = '';
    this.isConnected = false;
    this._rect = null;
    this.scrollTop = 0;
    this.classList = {
      add: (...tokens) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        tokens.forEach(t => { if (t) set.add(t); });
        this.className = Array.from(set).join(' ');
      },
      remove: (...tokens) => {
        const removeSet = new Set(tokens);
        this.className = this.className
          .split(/\s+/)
          .filter(token => token && !removeSet.has(token))
          .join(' ');
      },
      contains: (token) => this.className.split(/\s+/).includes(token)
    };
  }

  addEventListener() {}

  removeEventListener() {}

  _propagateConnection(isConnected) {
    this.isConnected = isConnected;
    this.children.forEach(child => child._propagateConnection(isConnected));
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child._propagateConnection(this.isConnected);
    notifyMutation(this, [child], []);
    return child;
  }

  insertBefore(child, ref) {
    if (child.parentElement) child.parentElement.removeChild(child);
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child._propagateConnection(this.isConnected);
    notifyMutation(this, [child], []);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child._propagateConnection(false);
      notifyMutation(this, [], [child]);
    }
    return child;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'role') this.role = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id;
    if (name === 'class') return this.className;
    if (name === 'role') return this.role;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key];
    }
    return this.attributes[name];
  }

  matches(selector) {
    if (!selector) return false;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.className.split(/\s+/).includes(cls);
    }
    if (selector === 'main') return this.tagName === 'MAIN';
    if (selector === 'div') return this.tagName === 'DIV';
    if (selector === 'span') return this.tagName === 'SPAN';
    if (selector === '.cv-placeholder') return this.className === 'cv-placeholder';
    if (selector === '[data-testid="conversation-turn"]') return this.dataset.testid === 'conversation-turn';
    if (selector === '[data-testid="message-bubble"]') return this.dataset.testid === 'message-bubble';
    if (selector === '[data-message-id]') return this.dataset.messageId !== undefined;
    if (selector === 'div[role="listitem"]') return this.tagName === 'DIV' && this.role === 'listitem';
    if (selector === '[data-testid*="thinking" i]') return (this.dataset.testid || '').toLowerCase().includes('thinking');
    if (selector === '[data-testid*="spinner" i]') return (this.dataset.testid || '').toLowerCase().includes('spinner');
    if (selector === '[data-message-author-role="assistant"][data-state]') {
      return this.dataset.messageAuthorRole === 'assistant' && this.dataset.state !== undefined;
    }
    if (selector === '[data-message-author-role="assistant"][data-is-streaming]') {
      return this.dataset.messageAuthorRole === 'assistant' && this.dataset.isStreaming !== undefined;
    }
    if (selector === '[data-message-author-role]') {
      return this.dataset.messageAuthorRole !== undefined;
    }
    if (selector === 'main .group.w-full') {
      const classes = this.className.split(/\s+/);
      return classes.includes('group') && classes.includes('w-full') && this.closest('main');
    }
    return false;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    if (!selector) return [];
    const selectors = selector.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    const visit = (node) => {
      selectors.forEach(sel => {
        if (node.matches(sel)) results.push(node);
      });
      node.children.forEach(child => visit(child));
    };
    this.children.forEach(child => visit(child));
    return Array.from(new Set(results));
  }

  contains(node) {
    return isDescendant(node, this);
  }

  compareDocumentPosition(other) {
    if (this === other) return 0;
    const pathFor = (node) => {
      const path = [];
      let current = node;
      while (current) {
        path.unshift(current);
        current = current.parentElement;
      }
      return path;
    };
    const aPath = pathFor(this);
    const bPath = pathFor(other);
    const len = Math.min(aPath.length, bPath.length);
    for (let i = 0; i < len; i += 1) {
      if (aPath[i] !== bPath[i]) {
        const parent = aPath[i - 1];
        if (!parent) return global.Node.DOCUMENT_POSITION_FOLLOWING;
        const siblings = parent.children;
        const aIdx = siblings.indexOf(aPath[i]);
        const bIdx = siblings.indexOf(bPath[i]);
        return aIdx < bIdx
          ? global.Node.DOCUMENT_POSITION_FOLLOWING
          : global.Node.DOCUMENT_POSITION_PRECEDING;
      }
    }
    return aPath.length < bPath.length
      ? global.Node.DOCUMENT_POSITION_FOLLOWING
      : global.Node.DOCUMENT_POSITION_PRECEDING;
  }

  getBoundingClientRect() {
    if (this._rect) return { ...this._rect };
    if (this.className === 'cv-placeholder') {
      const storedHeight = parseFloat(this.dataset?.cvCollapsedHeight || this.dataset?.cvHeight || '0');
      const height = Number.isFinite(storedHeight) ? storedHeight : 0;
      const top = -10000;
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0 };
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  }

  setBoundingClientRect(rect) {
    this._rect = {
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      height: rect.height ?? 0,
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      width: rect.width ?? 0
    };
  }

  scrollIntoView() {}
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.entries = new Set();
  }

  observe(target, options = {}) {
    const entry = {
      observer: this,
      target,
      options: {
        childList: options.childList !== false,
        subtree: !!options.subtree
      }
    };
    observerRegistry.add(entry);
    this.entries.add(entry);
  }

  disconnect() {
    this.entries.forEach(entry => observerRegistry.delete(entry));
    this.entries.clear();
  }

  takeRecords() {
    return [];
  }
}

function createEnvironment() {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  documentElement._propagateConnection(true);
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    readyState: 'complete',
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    getElementById: (id) => documentElement.querySelector(`#${id}`),
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (...args) => documentElement.appendChild(...args),
    scrollingElement: documentElement
  };

  const window = {
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({
      marginTop: '0px',
      marginBottom: '0px',
      marginLeft: '0px',
      marginRight: '0px',
      display: 'block',
      visibility: 'visible'
    }),
    requestAnimationFrame: (cb) => cb(),
    scrollBy: (x, y) => {
      window._scrollY = (window._scrollY || 0) + y;
    },
    scrollTo: ({ top }) => {
      window._scrollY = top;
    },
    open: () => {}
  };

  Object.defineProperty(window, 'scrollY', {
    get: () => window._scrollY || 0,
    set: (value) => { window._scrollY = value; }
  });

  Object.defineProperty(window, 'pageYOffset', {
    get: () => window._scrollY || 0,
    set: (value) => { window._scrollY = value; }
  });

  return { document, window };
}

function setup() {
  global.__CHAT_BOOSTER_DISABLE_AUTOBOOT__ = true;
  global.__CHAT_BOOSTER_ENABLE_TEST_HOOKS__ = true;

  observerRegistry.clear();

  const originals = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    requestAnimationFrame: global.requestAnimationFrame
  };

  const { document, window } = createEnvironment();
  global.document = document;
  global.window = window;
  global.Node = {
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_PRECEDING: 2
  };
  global.Element = FakeElement;
  global.HTMLElement = FakeElement;
  global.location = { host: 'chat.openai.com', href: 'https://chat.openai.com' };
  global.chrome = {
    storage: {
      local: {
        get(defaults, cb) {
          if (typeof cb === 'function') cb(defaults);
        },
        set() {}
      }
    },
    runtime: {
      onMessage: {
        addListener() {},
        removeListener() {}
      }
    }
  };
  global.requestAnimationFrame = window.requestAnimationFrame;
  global.MutationObserver = FakeMutationObserver;
  global.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  let timerId = 0;
  const pendingTimeouts = new Map();
  global.setTimeout = (fn) => {
    timerId += 1;
    const id = timerId;
    if (typeof fn === 'function') {
      pendingTimeouts.set(id, fn);
      queueMicrotask(() => {
        const cb = pendingTimeouts.get(id);
        if (typeof cb === 'function') cb();
        pendingTimeouts.delete(id);
      });
    }
    return id;
  };
  global.clearTimeout = (id) => {
    pendingTimeouts.delete(id);
  };
  global.setInterval = () => 0;
  global.clearInterval = () => {};

  delete require.cache[require.resolve('../content.js')];
  require('../content.js');
  const hooks = global.__CHAT_BOOSTER_TEST_HOOKS__;

  const cleanup = () => {
    pendingTimeouts.clear();
    delete global.__CHAT_BOOSTER_DISABLE_AUTOBOOT__;
    delete global.__CHAT_BOOSTER_ENABLE_TEST_HOOKS__;
    delete global.__CHAT_BOOSTER_MANUAL_BOOT__;
    delete global.__CHAT_BOOSTER_TEST_HOOKS__;
    delete global.document;
    delete global.window;
    delete global.location;
    delete global.chrome;
    delete global.Element;
    delete global.HTMLElement;
    delete global.Node;
    delete global.requestAnimationFrame;
    delete global.MutationObserver;
    delete global.IntersectionObserver;
    global.setTimeout = originals.setTimeout;
    global.clearTimeout = originals.clearTimeout;
    global.setInterval = originals.setInterval;
    global.clearInterval = originals.clearInterval;
    observerRegistry.clear();
    try {
      delete require.cache[require.resolve('../content.js')];
    } catch {}
  };

  return { hooks, document, window, cleanup };
}

function createMessage(index, { top, streaming = false } = {}) {
  const msg = new FakeElement('div');
  msg.dataset.testid = 'conversation-turn';
  msg.textContent = `message-${index}`;
  msg.setBoundingClientRect({
    top: top ?? index * 120,
    bottom: (top ?? index * 120) + 100,
    height: 100
  });
  msg.setAttribute('data-message-id', `m-${index}`);
  if (streaming) {
    msg.setAttribute('data-message-status', 'in_progress');
    msg.dataset.messageAuthorRole = 'assistant';
    const spinner = new FakeElement('div');
    spinner.dataset.testid = 'thinking-indicator';
    msg.appendChild(spinner);
  } else {
    msg.setAttribute('data-message-status', 'finished');
  }
  return msg;
}

function buildConversation(main, count, { streamingLast = false, offsetTop = 0 } = {}) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1 && streamingLast;
    const top = i < count - 1 ? offsetTop - (count - i) * 140 : offsetTop + i * 140;
    const msg = createMessage(i, { top, streaming: isLast });
    main.appendChild(msg);
    created.push(msg);
  }
  return created;
}

async function forceVirtualize(hooks, iterations = 1) {
  for (let i = 0; i < iterations; i += 1) {
    hooks.virtualize({ force: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (hooks && typeof hooks.visibleNodes !== 'undefined') {
      hooks.visibleNodes = new WeakSet();
    }
  }
}

test('virtualization collapses older messages in strict mode', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);

    buildConversation(main, 25, { streamingLast: false, offsetTop: -400 });

    hooks.setUltraMode(false);
    const boot = global.__CHAT_BOOSTER_MANUAL_BOOT__;
    boot();
    await forceVirtualize(hooks, 3);

    const collapsedCount = hooks.getCollapsedTotal();
    assert.ok(collapsedCount >= 10, 'expected multiple collapsed messages');
    const placeholders = document.querySelectorAll('.cv-placeholder');
    assert.strictEqual(placeholders.length, collapsedCount);
    assert.strictEqual(hooks.getHudStatusText(), `Chat Booster: ${collapsedCount} optimized`);
  } finally {
    cleanup();
  }
});

test('HUD updates after expanding a collapsed message', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);
    buildConversation(main, 18, { streamingLast: false, offsetTop: -300 });

    hooks.setUltraMode(false);
    global.__CHAT_BOOSTER_MANUAL_BOOT__();
    await forceVirtualize(hooks, 3);

    const initialCount = hooks.getCollapsedTotal();
    assert.ok(initialCount > 0);

    const collapsedMessage = hooks.getMessageNodes().find(node => node.dataset.cvCollapsed === '1');
    assert.ok(collapsedMessage, 'expected a collapsed message to expand');

    hooks.expandMessage(collapsedMessage);
    const afterCount = hooks.getCollapsedTotal();
    assert.strictEqual(afterCount, initialCount - 1);
    assert.strictEqual(hooks.getHudStatusText(), `Chat Booster: ${afterCount} optimized`);
  } finally {
    cleanup();
  }
});

test('stream lock holds virtualization until release', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);

    const messages = buildConversation(main, 12, { streamingLast: true, offsetTop: -600 });
    const streamingMessage = messages[messages.length - 1];

    global.__CHAT_BOOSTER_MANUAL_BOOT__();
    await forceVirtualize(hooks, 3);

    assert.strictEqual(hooks.isStreamLockActive(), true);
    const initialCount = hooks.getCollapsedTotal();

    const extra = createMessage('extra', { top: -2400, streaming: false });
    main.insertBefore(extra, main.children[0]);

    assert.strictEqual(hooks.getCollapsedTotal(), initialCount);
    assert.strictEqual(extra.dataset.cvCollapsed, undefined);
    assert.strictEqual(hooks.isStreamLockActive(), true);

    streamingMessage.setAttribute('data-message-status', 'finished');
    const spinner = streamingMessage.querySelector('[data-testid*="thinking" i]');
    if (spinner) spinner.remove();

    hooks.updateStreamLock();
    await new Promise(resolve => setTimeout(resolve, 0));

    await forceVirtualize(hooks, 3);

    assert.strictEqual(hooks.isStreamLockActive(), false);
    const infoAfter = hooks.getDetachedInfo(extra);
    assert.strictEqual(extra.dataset.cvCollapsed, '1');
    assert.ok(infoAfter);
    assert.ok(infoAfter.placeholder);
    assert.strictEqual(infoAfter.placeholder.dataset.cvDetached, '1');
  } finally {
    cleanup();
  }
});

test('ultra mode collapses and restores detached messages', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);

    const messages = buildConversation(main, 30, { streamingLast: false, offsetTop: -800 });

    global.__CHAT_BOOSTER_MANUAL_BOOT__();
    await forceVirtualize(hooks, 3);

    const collapsedNodes = messages.filter(node => hooks.getDetachedInfo(node));
    assert.ok(collapsedNodes.length > 0, 'expected detached nodes in ultra mode');
    const sample = collapsedNodes[0];
    const info = hooks.getDetachedInfo(sample);
    assert.ok(info?.placeholder);
    assert.strictEqual(info.placeholder.dataset.cvDetached, '1');
    assert.strictEqual(sample.parentElement, null);

    const placeholderBefore = info.placeholder;
    hooks.expandMessage(sample);
    const expandedInfo = hooks.getDetachedInfo(sample);
    assert.strictEqual(expandedInfo, null);
    assert.notStrictEqual(sample.parentElement, null);
    assert.strictEqual(sample.dataset.cvCollapsed, undefined);
    const placeholder = hooks.getPlaceholderForNode(sample) || placeholderBefore;
    assert.ok(placeholder);
    assert.strictEqual(placeholder.parentElement, null);
    assert.strictEqual(placeholder.style.display, 'none');
    assert.strictEqual(placeholder.dataset.cvDetached, '0');
  } finally {
    cleanup();
  }
});

test('mutation observer incremental add/remove updates message set and HUD', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);

    buildConversation(main, 24, { streamingLast: false, offsetTop: -600 });

    hooks.setUltraMode(false);
    global.__CHAT_BOOSTER_MANUAL_BOOT__();
    await forceVirtualize(hooks, 3);

    const initialNodes = hooks.getMessageNodes().length;
    const initialCount = hooks.getCollapsedTotal();

    const injected = createMessage('injected', { top: -3200, streaming: false });
    main.insertBefore(injected, main.children[0]);
    await forceVirtualize(hooks, 3);

    const nodesAfterInsert = hooks.getMessageNodes();
    assert.ok(nodesAfterInsert.includes(injected));
    assert.strictEqual(injected.dataset.cvCollapsed, '1');
    const countAfterInsert = hooks.getCollapsedTotal();
    assert.ok(countAfterInsert >= initialCount + 1);

    injected.remove();
    await forceVirtualize(hooks, 3);

    const nodesAfterRemoval = hooks.getMessageNodes();
    assert.ok(!nodesAfterRemoval.includes(injected));
    const countAfterRemoval = hooks.getCollapsedTotal();
    assert.strictEqual(hooks.getHudStatusText(), `Chat Booster: ${countAfterRemoval} optimized`);
  } finally {
    cleanup();
  }
});

test('placeholders reflect strict mode collapse and expand cleanly', async () => {
  const { hooks, document, cleanup } = setup();
  try {
    const main = new FakeElement('main');
    document.body.appendChild(main);
    main._propagateConnection(true);

    buildConversation(main, 14, { streamingLast: false, offsetTop: -360 });

    hooks.setUltraMode(false);
    global.__CHAT_BOOSTER_MANUAL_BOOT__();
    await forceVirtualize(hooks, 2);

    const collapsed = hooks.getMessageNodes().find(node => node.dataset.cvCollapsed === '1');
    assert.ok(collapsed, 'expected a collapsed node');
    const placeholder = hooks.getPlaceholderForNode(collapsed);
    assert.ok(placeholder);
    assert.strictEqual(placeholder.dataset.cvCollapsedHeight, '12px');
    assert.strictEqual(placeholder.textContent, '…');

    const before = hooks.getCollapsedTotal();
    hooks.expandMessage(collapsed);
    const after = hooks.getCollapsedTotal();
    assert.strictEqual(after, before - 1);
    assert.strictEqual(collapsed.dataset.cvCollapsed, undefined);
    assert.strictEqual(placeholder.style.display, 'none');
  } finally {
    cleanup();
  }
});
