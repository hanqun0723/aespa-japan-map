# aespa 日本聖地巡禮地圖 (2022–2026)

收錄 **aespa（Karina / Giselle / Winter / Ningning）** 於東京、大阪、京都、沖繩、福岡、北海道親身造訪之餐廳、咖啡甜點、潮流選物、觀光地標、《Hot Mess》MV 取景街角與巨蛋巡演場館共 **89 處精準定位點位**，支援 iPhone Safari 加入主畫面（PWA）與遠端視覺化編輯。

## 專案結構

- `data/places.json` — 單一真相來源（Single Source of Truth），包含成員、分類、日文地址、經緯度、營業狀態（含已歇業／已搬遷標記）、`ig_url` 與 `source_url`。
- `data/aespa-japan.kml` — 可直接匯入 Google Maps「你的地點 → 地圖 (Google My Maps)」之 KML 檔。
- `scripts/verify_places.py` — 自動批次補齊座標、檢查營業狀態與去重腳本（支援 Google Places API (New) 及日本國土地理院 GSI 免費街區定位雙模式）。
- `server.py` — 本地靜態網頁與即時寫檔 API 伺服器（支援網頁端直接修改並寫回 `data/places.json` 及一鍵 `git push`）。
- `index.html` / `styles.css` / `app.js` — 行動優先輕量地圖 Web App / PWA。

## 本地啟動與驗證指令

```bash
# 1. 啟動本地可編輯地圖伺服器（預設 http://127.0.0.1:8766）
python3 server.py --port 8766

# 2. 批次驗證並更新座標／去重（未設金鑰時自動使用日本國土地理院 GSI + Nominatim）
python3 scripts/verify_places.py

# 3. 若有 Google Places API (New) 金鑰，可補齊官方 ChIJ... place_id 與即時營業狀態
GOOGLE_PLACES_API_KEY="你的API_KEY" python3 scripts/verify_places.py --force-geocode
```

## 手機 Safari 遠端使用與編輯方式

1. **直接瀏覽與導航**：在 iPhone Safari 開啟 GitHub Pages 網址，點選「分享 → 加入主畫面」即可像原生 App 全螢幕使用；點擊任一地點可一鍵喚起 **Instagram App 看原貼文** 或 **Google Maps App 開始導航**。
2. **遠端新增／編輯地點**：點擊右上角 `＋` 或地點卡片上的 `✏️ 編輯`，可隨時修改 IG 連結、同款菜單、備註或貼上 Google Maps 連結新增地點：
   - **遠端連線回家中電腦 Safari (`http://127.0.0.1:8766`)**：儲存後直接寫入電腦硬碟 `data/places.json`，點右上 `☁️` 可一鍵推上 GitHub。
   - **在外直接用手機 Safari 開啟 GitHub Pages**：儲存後先自動保存在手機瀏覽器；於右上 `☁️` 填入一次 GitHub Personal Access Token（僅存於手機 Safari 本機），即可在手機上一鍵直接寫回 GitHub `data/places.json` 更新全網地圖！
