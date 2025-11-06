const test = require('node:test');
const assert = require('node:assert');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.id = '';
    this.className = '';
    this.role = '';
    this.isConnected = false;
    this._rect = null;
  }

  _propagateConnection(isConnected) {
    this.isConnected = isConnected;
    this.children.forEach(child => child._propagateConnection(isConnected));
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child._propagateConnection(this.isConnected);
    return child;
  }

  insertBefore(child, ref) {
    if (child.parentElement) child.parentElement.removeChild(child);
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child._propagateConnection(this.isConnected);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child._propagateConnection(false);
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
    if (selector === '.cv-placeholder') return this.className === 'cv-placeholder';
    if (selector === '[data-testid="conversation-turn"]') return this.dataset.testid === 'conversation-turn';
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
    if (selector === '.group.w-full') {
      const classes = this.className.split(/\s+/);
      return classes.includes('group') && classes.includes('w-full');
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

  getBoundingClientRect() {
    if (this._rect) return { ...this._rect };
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
    querySelector: (selector) => {
      if (selector === 'main') {
        return documentElement.querySelector(selector);
      }
      return documentElement.querySelector(selector);
    },
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    getElementById: (id) => documentElement.querySelector('#' + id),
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (...args) => documentElement.appendChild(...args),
    prepend: (...args) => documentElement.prepend?.(...args),
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
  global.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
  global.IntersectionObserver = class {
    constructor(callback, options = {}) {
      this.root = options.root || null;
      this.callback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  delete require.cache[require.resolve('../content.js')];
  require('../content.js');
  const hooks = global.__CHAT_BOOSTER_TEST_HOOKS__;
  return { hooks, document, window };
}

function teardown() {
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
  try {
    delete require.cache[require.resolve('../content.js')];
  } catch {}
}

function createMessage() {
  const msg = new FakeElement('div');
  msg.setAttribute('data-message-status', 'in_progress');
  msg.dataset.messageAuthorRole = 'assistant';
  const thinking = new FakeElement('div');
  thinking.dataset.testid = 'thinking-indicator';
  msg.appendChild(thinking);
  return msg;
}

test('detects streaming assistant message', () => {
  const { hooks } = setup();
  try {
    const msg = createMessage();
    assert.strictEqual(hooks.isMessageStreaming(msg), true);
  } finally {
    teardown();
  }
});

test('does not collapse streaming messages', () => {
  const { hooks } = setup();
  try {
    const container = new FakeElement('div');
    const msg = createMessage();
    container.appendChild(msg);
    container._propagateConnection(true);

    hooks.setUltraMode(true);
    hooks.collapseMessage(msg);

    assert.strictEqual(msg.dataset.cvCollapsed, undefined);
    assert.strictEqual(hooks.isMessageStreaming(msg), true);
  } finally {
    teardown();
  }
});

test('collapsing a node above the viewport keeps scroll anchored and zero-height placeholder', () => {
  const { hooks, document } = setup();
  try {
    const scroller = new FakeElement('div');
    scroller.style.height = '200px';
    scroller.style.overflow = 'auto';
    scroller.scrollTop = 300;
    scroller.setBoundingClientRect({ top: 0, bottom: 200, height: 200 });
    document.body.appendChild(scroller);
    scroller._propagateConnection(true);

    const msg = new FakeElement('div');
    msg.textContent = 'old message';
    msg.setBoundingClientRect({ top: -150, bottom: -50, height: 100 });
    scroller.appendChild(msg);

    hooks.setUltraMode(true);
    hooks.setRootScrollEl(scroller);

    hooks.collapseMessage(msg);

    const placeholder = hooks.getPlaceholderForNode(msg);
    assert.ok(placeholder);
    assert.strictEqual(placeholder.dataset.cvDetached, '1');
    assert.strictEqual(placeholder.style.height, '0px');
    assert.strictEqual(scroller.scrollTop, 200);
  } finally {
    teardown();
  }
});
