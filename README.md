# Chat Booster for GPT Chats

Boost performance on **very long** GPT chats by aggressively collapsing off-screen messages.
Keeps only the last 10 messages expanded; everything else turns into ultra-light placeholders (detached from the DOM in Ultra mode).

**Features**
- Massive DOM reduction → smoother scrolling
- ON/OFF badge & HUD (`Chat Booster: N optimized`)
- Minimal permissions, MV3, no data collection

## Ultra mode

Ultra mode applies the most aggressive virtualization: everything outside the last 10 messages is removed from the DOM and replaced with compact placeholders to minimize lag while GPT is generating new replies.

- Toggle it via the HUD button `Ultra: ON/OFF` in the bottom-right corner (enabled by default).
- The last 10 messages always stay expanded; older ones rehydrate only when they return into the visible tail.
- Clicking a placeholder briefly restores a message; media inside reloaded messages may reset, which is expected.
- The toggle state is stored locally with `chrome.storage.local`; no remote data collection occurs.

**Install (unpacked)**
1. Open `chrome://extensions` → enable *Developer mode*.
2. Click *Load unpacked* → select the project folder.

**Keyboard**
- `Ctrl + Shift + V` — toggle ON/OFF.

**Known limits**
- If OpenAI changes the DOM, selectors might need an update (open an Issue).
- Media inside expanded messages still costs performance (Roadmap: lazy media).

**License**
MIT
