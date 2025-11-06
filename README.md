# Chat Booster for GPT Chats

Boost performance on **very long** GPT chats by aggressively collapsing off-screen messages.  
Keeps only the last 10 messages expanded; everything else turns into ultra-light placeholders.

**Features**
- Massive DOM reduction → smoother scrolling
- ON/OFF badge & HUD (`Chat Booster: N optimized`)
- Minimal permissions, MV3, no data collection

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
