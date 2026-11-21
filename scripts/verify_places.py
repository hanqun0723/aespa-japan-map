#!/usr/bin/env python3
"""
verify_places.py — aespa 日本聖地巡禮資料驗證與座標補齊腳本

功能：
1. 若環境變數設有 GOOGLE_PLACES_API_KEY (或 GOOGLE_MAPS_API_KEY)，自動呼叫
   Google Places API (New) `v1/places:searchText` 補齊精準 lat, lng, place_id 與 businessStatus。
2. 若未設定 Google API Key，自動啟用日本國土地理院 (GSI AddressSearch) + OpenStreetMap Nominatim
   雙重免費地理編碼備援，精準定位至日本街區番號級座標。
3. 依據 place_id（或正規化日文店名＋地址近鄰座標）自動去重，並合併造訪成員清單與備註。
"""

import argparse
import json
import math
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

CTX = ssl.create_default_context()
HEADERS = {
    "User-Agent": "aespa-japan-pilgrimage-verifier/1.0 (https://github.com/hanqun0723)"
}


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def query_google_places_new(query: str, api_key: str) -> dict | None:
    """Call Google Places API (New) Text Search."""
    url = "https://places.googleapis.com/v1/places:searchText"
    payload = json.dumps({
        "textQuery": query,
        "languageCode": "ja",
        "regionCode": "JP",
        "maxResultCount": 1,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": (
                "places.id,places.displayName,places.formattedAddress,"
                "places.location,places.businessStatus,places.googleMapsUri"
            ),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10, context=CTX) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        places = data.get("places") or []
        if not places:
            return None
        p = places[0]
        loc = p.get("location") or {}
        return {
            "place_id": p.get("id", ""),
            "lat": round(float(loc["latitude"]), 6) if "latitude" in loc else None,
            "lng": round(float(loc["longitude"]), 6) if "longitude" in loc else None,
            "business_status": p.get("businessStatus", "OPERATIONAL"),
            "google_maps_uri": p.get("googleMapsUri", ""),
            "formatted_address": p.get("formattedAddress", ""),
        }
    except Exception as exc:
        print(f"  [Google Places warn] {query}: {exc}", file=sys.stderr)
        return None


def clean_jp_address_for_gsi(address: str) -> str:
    """Strip building floor suffixes so GSI street-block geocoder matches cleanly."""
    addr = re.sub(r"（.*?）|\(.*?\)", "", address).strip()
    # Keep up to chome-ban-go pattern (e.g. 東京都港区六本木7-8-6)
    m = re.match(r"^([^\s　]+?[0-9０-９]+(?:[-ー丁目番地号][0-9０-９]+)*)", addr)
    if m:
        return m.group(1)
    return addr.split()[0] if addr else ""


def query_gsi_geocoder(address: str) -> tuple[float, float] | None:
    """Query Japan Geospatial Information Authority (国土地理院) AddressSearch API."""
    cleaned = clean_jp_address_for_gsi(address)
    if not cleaned:
        return None
    url = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + urllib.parse.quote(cleaned)
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=8, context=CTX) as resp:
            items = json.loads(resp.read().decode("utf-8"))
        if items:
            # GSI returns [lng, lat]
            lng, lat = items[0]["geometry"]["coordinates"]
            return round(float(lat), 6), round(float(lng), 6)
    except Exception:
        pass
    return None


def query_nominatim(query: str) -> tuple[float, float] | None:
    """Fallback to OpenStreetMap Nominatim (rate-limited >= 1 req/sec)."""
    url = (
        "https://nominatim.openstreetmap.org/search?format=json&countrycodes=jp&limit=1&q="
        + urllib.parse.quote(query)
    )
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        time.sleep(1.05)
        with urllib.request.urlopen(req, timeout=10, context=CTX) as resp:
            items = json.loads(resp.read().decode("utf-8"))
        if items:
            return round(float(items[0]["lat"]), 6), round(float(items[0]["lon"]), 6)
    except Exception:
        pass
    return None


def build_google_maps_url(item: dict) -> str:
    q_parts = [item.get("name_ja") or item.get("name", ""), item.get("address", "")]
    query = urllib.parse.quote(" ".join(p for p in q_parts if p).strip())
    pid = (item.get("place_id") or "").strip()
    if pid.startswith("ChIJ"):
        return f"https://www.google.com/maps/search/?api=1&query={query}&query_place_id={urllib.parse.quote(pid)}"
    return f"https://www.google.com/maps/search/?api=1&query={query}"


def normalize_key(text: str) -> str:
    return re.sub(r"[\s　・/／()（）\-ー]+", "", (text or "").lower())


def deduplicate_places(places: list[dict]) -> list[dict]:
    """Deduplicate by place_id (if ChIJ...) or normalized name_ja + close coordinates."""
    merged: list[dict] = []
    for item in places:
        pid = (item.get("place_id") or "").strip()
        name_norm = normalize_key(item.get("name_ja") or item.get("name", ""))
        matched = None
        for existing in merged:
            ex_pid = (existing.get("place_id") or "").strip()
            if pid.startswith("ChIJ") and pid == ex_pid:
                matched = existing
                break
            ex_name = normalize_key(existing.get("name_ja") or existing.get("name", ""))
            if name_norm and name_norm == ex_name:
                if (
                    item.get("lat")
                    and existing.get("lat")
                    and haversine_m(item["lat"], item["lng"], existing["lat"], existing["lng"]) < 80
                ):
                    matched = existing
                    break
        if matched is None:
            merged.append(item)
        else:
            # Merge members preserving order
            for m in item.get("members", []):
                if m not in matched["members"]:
                    matched["members"].append(m)
            if not matched.get("ig_url") and item.get("ig_url"):
                matched["ig_url"] = item["ig_url"]
            if not matched.get("source_url") and item.get("source_url"):
                matched["source_url"] = item["source_url"]
            if item.get("note") and item["note"] not in (matched.get("note") or ""):
                matched["note"] = f"{matched.get('note', '')}；{item['note']}".strip("；")
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify and geocode places.json")
    parser.add_argument(
        "--file",
        default=str(Path(__file__).resolve().parent.parent / "data" / "places.json"),
        help="Path to places.json",
    )
    parser.add_argument(
        "--force-geocode",
        action="store_true",
        help="Re-geocode entries even if lat/lng already exist",
    )
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        return 1

    places = json.loads(path.read_text(encoding="utf-8"))
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY") or ""

    print(f"Loaded {len(places)} places from {path}")
    print(
        f"Mode: {'Google Places API (New)' if api_key else 'Japan GSI + Nominatim Open Geocoder (set GOOGLE_PLACES_API_KEY for Places API)'}"
    )

    updated = 0
    for idx, item in enumerate(places, 1):
        name_ja = item.get("name_ja") or item.get("name", "")
        addr = item.get("address", "")

        if api_key and (args.force_geocode or not item.get("place_id") or not item.get("lat")):
            res = query_google_places_new(f"{name_ja} {addr}", api_key)
            if res:
                if res.get("place_id"):
                    item["place_id"] = res["place_id"]
                if res.get("lat") and res.get("lng"):
                    item["lat"] = res["lat"]
                    item["lng"] = res["lng"]
                # Preserve explicit CLOSED_PERMANENTLY / RELOCATED notes if already verified closed
                if item.get("business_status") not in ("CLOSED_PERMANENTLY", "RELOCATED"):
                    item["business_status"] = res.get("business_status", "OPERATIONAL")
                updated += 1
                time.sleep(0.1)
        elif args.force_geocode or not item.get("lat") or not item.get("lng"):
            coords = query_gsi_geocoder(addr)
            if not coords:
                coords = query_nominatim(f"{name_ja} {addr}")
            if not coords and addr:
                coords = query_nominatim(clean_jp_address_for_gsi(addr))
            if coords:
                item["lat"], item["lng"] = coords
                updated += 1
                print(f"  [{idx}/{len(places)}] Geocoded {item['name']} -> {coords}")
            else:
                print(f"  [{idx}/{len(places)}] WARN could not geocode {item['name']} ({addr})")

        if not item.get("business_status"):
            item["business_status"] = "OPERATIONAL"
        item["google_maps_url"] = build_google_maps_url(item)

    before_dedup = len(places)
    places = deduplicate_places(places)
    after_dedup = len(places)

    path.write_text(json.dumps(places, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    closed_cnt = sum(1 for p in places if p.get("business_status") == "CLOSED_PERMANENTLY")
    reloc_cnt = sum(1 for p in places if p.get("business_status") == "RELOCATED")
    missing_coords = sum(1 for p in places if not p.get("lat") or not p.get("lng"))
    print(
        f"Done! Updated={updated}, Deduplicated {before_dedup} -> {after_dedup}, "
        f"Closed={closed_cnt}, Relocated={reloc_cnt}, MissingCoords={missing_coords}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
