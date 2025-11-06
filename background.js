const ENABLED_BY_TAB = new Map();

function setBadge(tabId, enabled) {
  chrome.action.setBadgeText({ tabId, text: enabled ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? "#2ecc71" : "#95a5a6" });
  chrome.action.setIcon({
    tabId,
    path: enabled ? {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png"
    } : {
      16: "icons/icon16-gray.png",
      32: "icons/icon32-gray.png",
      48: "icons/icon48-gray.png",
      128: "icons/icon128-gray.png"
    }
  });
}

async function send(tabId, msg) { try { await chrome.tabs.sendMessage(tabId, msg); } catch {} }

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const current = ENABLED_BY_TAB.get(tab.id) ?? true;
  const next = !current;
  ENABLED_BY_TAB.set(tab.id, next);
  setBadge(tab.id, next);
  await send(tab.id, { type: "CV_TOGGLE", enabled: next });
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-virtualizer") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const current = ENABLED_BY_TAB.get(tab.id) ?? true;
  const next = !current;
  ENABLED_BY_TAB.set(tab.id, next);
  setBadge(tab.id, next);
  await send(tab.id, { type: "CV_TOGGLE", enabled: next });
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "complete") {
    const enabled = ENABLED_BY_TAB.get(tabId) ?? true;
    setBadge(tabId, enabled);
    await send(tabId, { type: "CV_APPLY", enabled });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id) setBadge(t.id, true);
});
