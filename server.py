#!/usr/bin/env python3
"""
server.py — aespa 日本聖地巡禮地圖 本地＋遠端編輯 API 伺服器

提供：
- 靜態網頁與 PWA 服務 (/, /index.html, /app.js, /styles.css, /data/places.json, ...)
- GET  /api/health        -> 回報本地伺服器可寫入狀態與 Git 狀態
- GET  /api/places        -> 讀取最新 data/places.json
- PUT  /api/places        -> 覆寫儲存完整 places 陣列（含自動備份與更新 KML）
- POST /api/places/item   -> 新增或更新單筆地點
- POST /api/places/delete -> 刪除指定 id 地點
- POST /api/geocode       -> 透過日本國土地理院 / Nominatim / Google Places 自動查詢座標
- POST /api/git-sync      -> 一鍵將最新 data/places.json commit 並 push 至 GitHub Pages
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT_DIR = Path(__file__).resolve().parent
DATA_FILE = ROOT_DIR / "data" / "places.json"
BACKUP_DIR = ROOT_DIR / "data" / "backups"

sys.path.insert(0, str(ROOT_DIR / "scripts"))
import verify_places  # noqa: E402


def write_kml(places: list[dict], kml_path: Path) -> None:
    """Export Google My Maps compatible KML file."""
    from xml.sax.saxutils import escape

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        "  <Document>",
        "    <name>aespa 日本聖地巡禮地圖 (2022–2026)</name>",
        "    <description>aespa (Karina / Giselle / Winter / Ningning) 東京與全日本打卡美食、景點、購物與 MV 取景地</description>",
    ]

    folders: dict[str, list[dict]] = {}
    for p in places:
        if not p.get("lat") or not p.get("lng"):
            continue
        reg = p.get("region", "其他")
        folders.setdefault(reg, []).append(p)

    for reg, items in folders.items():
        lines.append("    <Folder>")
        lines.append(f"      <name>{escape(reg)}</name>")
        for p in items:
            members_str = " / ".join(p.get("members") or [])
            status = p.get("business_status", "OPERATIONAL")
            status_prefix = "【已歇業】" if status == "CLOSED_PERMANENTLY" else ("【已搬遷】" if status == "RELOCATED" else "")
            title = f"{status_prefix}{p.get('name', '')} ({members_str})"
            desc_parts = [
                f"成員：{members_str}",
                f"分類：{p.get('category', '')}（{p.get('sub_category', '')}）",
                f"造訪時間：{p.get('visit_date', '')}",
                f"日文店名：{p.get('name_ja', '')}",
                f"地址：{p.get('address', '')}",
            ]
            if p.get("same_order"):
                desc_parts.append(f"同款／亮點：{p['same_order']}")
            if p.get("status_note"):
                desc_parts.append(f"營業備註：{p['status_note']}")
            if p.get("note"):
                desc_parts.append(f"說明：{p['note']}")
            if p.get("ig_url"):
                desc_parts.append(f"IG／影片：{p['ig_url']}")
            if p.get("source_url"):
                desc_parts.append(f"考據來源：{p['source_url']}")
            desc_html = "<br/>".join(escape(x) for x in desc_parts)
            lines.extend([
                "      <Placemark>",
                f"        <name>{escape(title)}</name>",
                f"        <description><![CDATA[{desc_html}]]></description>",
                "        <Point>",
                f"          <coordinates>{p['lng']},{p['lat']},0</coordinates>",
                "        </Point>",
                "      </Placemark>",
            ])
        lines.append("    </Folder>")

    lines.extend(["  </Document>", "</kml>"])
    kml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def save_places_atomic(places: list[dict]) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if DATA_FILE.exists():
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_file = BACKUP_DIR / f"places-{ts}.json"
        shutil.copy2(DATA_FILE, backup_file)
        # Keep latest 15 backups
        backups = sorted(BACKUP_DIR.glob("places-*.json"))
        for old in backups[:-15]:
            old.unlink(missing_ok=True)

    for p in places:
        p["google_maps_url"] = verify_places.build_google_maps_url(p)

    tmp_file = DATA_FILE.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(places, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp_file.replace(DATA_FILE)
    write_kml(places, ROOT_DIR / "data" / "aespa-japan.kml")


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if self.path.startswith("/api/") or self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def _send_json(self, payload: dict | list, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            has_git = (ROOT_DIR / ".git").exists()
            self._send_json({
                "ok": True,
                "mode": "local-api",
                "editable": True,
                "git_enabled": has_git,
                "places_count": len(json.loads(DATA_FILE.read_text(encoding="utf-8"))) if DATA_FILE.exists() else 0,
            })
            return
        if parsed.path == "/api/places":
            places = json.loads(DATA_FILE.read_text(encoding="utf-8")) if DATA_FILE.exists() else []
            self._send_json(places)
            return
        super().do_GET()

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/places":
            try:
                data = self._read_json()
                if not isinstance(data, list):
                    self._send_json({"ok": False, "error": "Expected JSON array of places"}, 400)
                    return
                save_places_atomic(data)
                self._send_json({"ok": True, "count": len(data)})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)
            return
        self._send_json({"ok": False, "error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/places/item":
            try:
                item = self._read_json()
                places = json.loads(DATA_FILE.read_text(encoding="utf-8")) if DATA_FILE.exists() else []
                item_id = (item.get("id") or "").strip()
                if not item_id:
                    item_id = f"jp-custom-{int(datetime.now().timestamp())}"
                    item["id"] = item_id
                replaced = False
                for i, ex in enumerate(places):
                    if ex.get("id") == item_id:
                        places[i] = item
                        replaced = True
                        break
                if not replaced:
                    places.insert(0, item)
                save_places_atomic(places)
                self._send_json({"ok": True, "item": item, "count": len(places)})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)
            return

        if parsed.path == "/api/places/delete":
            try:
                req = self._read_json()
                target_id = req.get("id", "")
                places = json.loads(DATA_FILE.read_text(encoding="utf-8")) if DATA_FILE.exists() else []
                new_places = [p for p in places if p.get("id") != target_id]
                save_places_atomic(new_places)
                self._send_json({"ok": True, "deleted": len(places) - len(new_places), "count": len(new_places)})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)
            return

        if parsed.path == "/api/geocode":
            try:
                req = self._read_json()
                name_ja = req.get("name_ja") or req.get("name") or ""
                address = req.get("address") or ""
                api_key = os.environ.get("GOOGLE_PLACES_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY") or ""
                if api_key:
                    res = verify_places.query_google_places_new(f"{name_ja} {address}".strip(), api_key)
                    if res and res.get("lat"):
                        self._send_json({"ok": True, **res})
                        return
                coords = verify_places.query_gsi_geocoder(address) if address else None
                if not coords and (name_ja or address):
                    coords = verify_places.query_nominatim(f"{name_ja} {address}".strip())
                if coords:
                    self._send_json({"ok": True, "lat": coords[0], "lng": coords[1], "place_id": ""})
                else:
                    self._send_json({"ok": False, "error": "查無對應座標，請確認日文地址或直接點擊地圖選點"}, 404)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)
            return

        if parsed.path == "/api/git-sync":
            try:
                msg = (self._read_json() or {}).get("message") or f"Update places.json ({datetime.now().strftime('%Y-%m-%d %H:%M')})"
                subprocess.run(["git", "add", "data/places.json", "data/aespa-japan.kml"], cwd=ROOT_DIR, check=True)
                diff = subprocess.run(["git", " status", "--porcelain", "data/"], cwd=ROOT_DIR, capture_output=True, text=True)
                status_proc = subprocess.run(["git", "status", "--porcelain", "data/"], cwd=ROOT_DIR, capture_output=True, text=True)
                if status_proc.stdout.strip():
                    subprocess.run(["git", "commit", "-m", msg], cwd=ROOT_DIR, check=True)
                    push = subprocess.run(["git", "push"], cwd=ROOT_DIR, capture_output=True, text=True, timeout=25)
                    if push.returncode != 0:
                        self._send_json({"ok": False, "error": push.stderr or push.stdout}, 500)
                        return
                    self._send_json({"ok": True, "pushed": True, "message": msg})
                else:
                    self._send_json({"ok": True, "pushed": False, "message": "目前沒有尚未同步的變更"})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)
            return

        self._send_json({"ok": False, "error": "Not found"}, 404)


def main():
    parser = argparse.ArgumentParser(description="Run aespa map local & remote-edit server")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--bind", default="0.0.0.0")
    args = parser.parse_args()

    if DATA_FILE.exists():
        places = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        write_kml(places, ROOT_DIR / "data" / "aespa-japan.kml")

    server = ThreadingHTTPServer((args.bind, args.port), AppHandler)
    print(f"Serving aespa Japan Map at http://127.0.0.1:{args.port}/ (bound to {args.bind}:{args.port})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
