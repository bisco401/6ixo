#!/usr/bin/env python3
"""Import exact, publicly contactable US dealer and Ethiopian property/vehicle ads."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("marketplace_refresh", ROOT / "scripts/refresh-marketplace-listings.py")
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
availability = refresh.availability
clean = refresh.clean
STATES = {"NY": "New York", "FL": "Florida", "GA": "Georgia", "TX": "Texas"}
SOURCES = {
    "liusedcars": ("LIUsedCars", "https://www.liusedcars.com/dealers/saw-mill-auto", r"/for-sale/[^/?]+-\d+$"),
    "atlanta": ("Atlanta Best Used Cars", "https://www.atlantabestusedcars.com/used-cars-in-peachtree-corners-ga", r"/inventory/used-[^/?]+$"),
    "florida": ("Turnpike Motors", "https://www.turnpikemotorsflorida.com/cars-for-sale", r"/details/[^/?]+/\d+$"),
    "texas": ("Lexo Enterprises Inc", "https://www.lexoinc.com/cars-for-sale", r"/Inventory/Details/[a-f0-9-]+$"),
    "mekina": ("Mekina Showroom", "https://mekinashowroom.com/cars", r"/cars/[^/?]+-[a-z0-9]{6}$"),
    "betoch": ("Betoch.et", "https://betoch.et/", r"/properties/[^/?]+$"),
}


def text(node):
    return clean(node.get_text(" ", strip=True)) if node else ""


def schemas(soup):
    result = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            result.extend(availability.entities(json.loads(script.get_text())))
        except (ValueError, TypeError):
            pass
    return result


def kinds(entity):
    value = entity.get("@type", [])
    return set(value if isinstance(value, list) else [value])


def own_entity(soup, url, allowed):
    matches = [e for e in schemas(soup) if kinds(e) & allowed
               and availability.source_key(e.get("url") or e.get("@id") or "") == availability.source_key(url)]
    if len(matches) != 1:
        raise ValueError("Exact primary source entity not confirmed")
    return matches[0]


def canonical_matches(soup, url):
    tag = soup.select_one('link[rel="canonical"]')
    return bool(tag and availability.source_key(urljoin(url, tag.get("href", ""))) == availability.source_key(url))


def phone_number(value, country):
    digits = re.sub(r"\D", "", str(value or ""))
    if country == "Ethiopia":
        if re.fullmatch(r"0[79]\d{8}", digits):
            digits = "251" + digits[1:]
        return "+" + digits if re.fullmatch(r"251[79]\d{8}", digits) else ""
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return "+1" + digits if re.fullmatch(r"[2-9]\d{2}[2-9]\d{6}", digits) else ""


def facts_dict(soup, selector, label_selector, value_selector):
    result = {}
    for node in soup.select(selector):
        label, value = text(node.select_one(label_selector)).rstrip(":"), text(node.select_one(value_selector))
        if label and value:
            result[label] = value
    return result


def finish(row, price, currency, facts, region="", metro="", contact_price=False):
    if contact_price:
        if price not in (None, "") or currency:
            raise ValueError("Contact-price listings must not inherit an amount or currency")
        row.update(price_value="", currency="", price_text="Call for price")
    else:
        if currency not in {"USD", "ETB"} or price is None or not math.isfinite(float(price)) or float(price) <= 0:
            raise ValueError("No positive source price in the expected currency")
        row.update(price_value=str(price), currency=currency,
                   price_text=f"{currency} {float(price):,.0f}")
    facts = {k: clean(v) for k, v in facts.items() if clean(v).lower() not in {"", "none", "not specified", "n/a", "unknown"}}
    attrs = json.loads(row["attributes"])
    attrs.update(parser="regional_public_sources_v1", region=region, searchMetro=metro,
                 sourceKind="dealer" if row["source_site"] in {"Atlanta Best Used Cars", "Turnpike Motors", "Lexo Enterprises Inc"} else "marketplace",
                 sourceSpecifications=[{"label": k, "value": v} for k, v in facts.items()],
                 detailsSourceUrl=row["source_url"], detailsVerifiedAt=row["scraped_at"])
    row["attributes"] = json.dumps(attrs, ensure_ascii=False, separators=(",", ":"))
    # Use factual listing details; don't copy site-wide marketing or contact forms.
    row["description"] = clean(f"{row['title']} listed by {row['seller']} in {row['city']}. "
                               + "; ".join(f"{k}: {v}" for k, v in facts.items()))[:1000]
    return row


def liusedcars_row(body, url, checked):
    soup = BeautifulSoup(body, "html.parser")
    ident = url.rsplit("-", 1)[-1]
    vehicle = soup.select_one("#veh-id")
    print_link = soup.select_one('#listing-main a.print-me[href]')
    print_matches = print_link and urlsplit(print_link["href"]).path.replace("/print/", "/for-sale/", 1) == urlsplit(url).path
    if not ident.isdigit() or not vehicle or vehicle.get("value") != ident or not print_matches:
        raise ValueError("Vehicle ID/canonical mismatch")
    headline = soup.select_one("#listing-main > h5")
    location = re.fullmatch(r"For sale at (.+) in (.+), ([A-Z]{2})", text(headline))
    if not location or location[3] != "NY":
        raise ValueError("New York dealer address not confirmed")
    contact = soup.select_one('#listing-disclaimer a[href^="tel:"]')
    phone = phone_number(contact.get("href", "")[4:] if contact else "", "United States")
    images = [n["src"] for n in soup.select("#sync1 img.gal-ph[src]")
              if re.search(rf"-{re.escape(ident)}l\.", n["src"])]
    facts = {}
    for node in soup.select("#attributes > li"):
        label = text(node.select_one("span"))
        if label:
            facts[label.rstrip(":")] = text(node)[len(label):].strip()
    row = refresh.row_base(url, text(soup.select_one("#listing-main h1")), location[2], "United States", phone,
                           images, "vehicles", "vehicles", checked, "LIUsedCars")
    row.update(seller=location[1], make=facts.get("Make", ""), model=facts.get("Model", ""),
               year=facts.get("Year", ""), trim=facts.get("Trim Level", ""), condition=facts.get("Condition", "").lower())
    amount = re.sub(r"[^\d.]", "", facts.pop("Price", ""))
    mileage = text(soup.select_one("#listing-top-info .mileage"))
    facts.pop("Mileage", None)
    if mileage.endswith(" miles"):
        facts["Mileage"] = mileage
    facts["Price terms"] = "Excludes registration, title, fees and taxes"
    return finish(row, amount, "USD", facts, "New York")


def vehicle_schema_row(body, url, checked, source):
    soup = BeautifulSoup(body, "html.parser")
    entity = own_entity(soup, url, {"Car", "Vehicle"})
    offer = entity.get("offers") or {}
    contact_price = False
    visible_facts = {}
    # Atlanta's current pages omit Offer when the primary vehicle says Call for
    # price. Bind this layout to its canonical vehicle, VIN and public dealer;
    # never use prices or contact details from recommended inventory cards.
    if source == "atlanta":
        for node in reversed(soup.select('[class*="related"], [class*="recommend"], [class*="similar"]')):
            node.decompose()
        vin = str(entity.get("vehicleIdentificationNumber") or "")
        for grid in soup.select(".vdp-details-grid"):
            facts = {}
            for node in grid.select(".vdp-detail"):
                label = text(node.select_one("b")).rstrip(":")
                pair = node.select_one(".d-flex")
                cells = pair.find_all("div", recursive=False) if pair else []
                if label and len(cells) == 2:
                    facts[label] = text(cells[1])
            if vin and facts.get("VIN") == vin:
                visible_facts = facts
    if source == "atlanta" and not offer:
        costs = soup.select(".vdp-costpayment")
        dealers = [e for e in schemas(soup) if "AutoDealer" in kinds(e)
                   and e.get("name") == SOURCES[source][0]
                   and availability.source_key(e.get("url") or "")
                   == availability.source_key("https://www.atlantabestusedcars.com/")]
        if (not canonical_matches(soup, url) or text(soup.select_one("h1")) != clean(entity.get("name"))
                or not visible_facts or len(dealers) != 1
                or not costs or not all(text(node).startswith("Call for price") for node in costs)):
            raise ValueError("Exact primary contact-price vehicle not confirmed")
        dealer = dealers[0]
        telephone = phone_number(dealer.get("telephone"), "United States")
        public_phones = {phone_number(n.get("href", "")[4:], "United States")
                         for n in soup.select('a[href^="tel:"]')}
        public_phones.update(phone_number(text(n), "United States")
                             for n in soup.select('[data-cy="header-phone"], .vdp-costpayment [role="button"]'))
        state, _ = availability.classify({"source_url": url, "title": entity.get("name", "")}, 200, body, url)
        if not telephone or telephone not in public_phones or state != "active":
            raise ValueError("Active vehicle and public dealer contact required")
        offer = {"seller": dealer, "price": None, "priceCurrency": ""}
        contact_price = True
    if not contact_price and (not isinstance(offer, dict) or str(offer.get("availability", "")).rsplit("/", 1)[-1] != "InStock"):
        raise ValueError("No exact in-stock offer")
    if offer.get("url") and availability.source_key(offer["url"]) != availability.source_key(url):
        raise ValueError("Offer URL does not match the exact vehicle")
    seller = offer.get("seller") or {}
    if source == "atlanta" and seller.get("@id") and not seller.get("name"):
        dealers = [e for e in schemas(soup) if "AutoDealer" in kinds(e)
                   and e.get("@id") == seller["@id"] and e.get("name") == SOURCES[source][0]
                   and availability.source_key(e.get("url") or "")
                   == availability.source_key("https://www.atlantabestusedcars.com/")]
        if (len(dealers) != 1 or not canonical_matches(soup, url) or not visible_facts
                or text(soup.select_one("h1")) != clean(entity.get("name"))):
            raise ValueError("Exact vehicle/dealer reference not confirmed")
        seller = dealers[0]
        public_phones = {phone_number(n.get("href", "")[4:], "United States")
                         for n in soup.select('a[href^="tel:"]')}
        public_phones.update(phone_number(text(n), "United States")
                             for n in soup.select('[data-cy="header-phone"], .vdp-costpayment [role="button"]'))
        telephone = phone_number(seller.get("telephone"), "United States")
        if not telephone or telephone not in public_phones:
            raise ValueError("Public dealer contact not confirmed")
    address = seller.get("address") or {}
    country = "Ethiopia" if source == "mekina" else "United States"
    city = (offer.get("areaServed") or {}).get("name", "") if source == "mekina" else address.get("addressLocality", "")
    region = "" if source == "mekina" else STATES.get(address.get("addressRegion"), "")
    if source == "atlanta" and (region != "Georgia" or seller.get("name") != "Atlanta Best Used Cars"):
        raise ValueError("Dealer identity/address mismatch")
    if source == "texas":
        dealers = [e for e in schemas(soup) if "AutoDealer" in kinds(e) and e.get("name") == seller.get("name")]
        if region != "Texas" or seller.get("name") != SOURCES[source][0] or len(dealers) != 1 or not canonical_matches(soup, url):
            raise ValueError("Texas dealer identity/address mismatch")
        seller = {**seller, "telephone": dealers[0].get("telephone")}
    if not contact_price and offer.get("priceCurrency") != ("ETB" if source == "mekina" else "USD"):
        raise ValueError("Unexpected source currency")
    images = entity.get("image") or []
    images = images if isinstance(images, list) else [images]
    if source == "texas":
        galleries = [e for e in schemas(soup) if "ImageGallery" in kinds(e)]
        if len(galleries) == 1:
            gallery = [i.get("url", "") for i in galleries[0].get("Image", [])]
            if gallery and images and gallery[0] == images[0]:
                images = gallery
    row = refresh.row_base(url, clean(entity.get("name")), city, country, phone_number(seller.get("telephone"), country),
                           images, "vehicles", "vehicles", checked, SOURCES[source][0])
    brand = entity.get("brand") or {}
    row.update(seller=clean(seller.get("name")), make=brand.get("name", "") if isinstance(brand, dict) else brand,
               model=clean(entity.get("model")), year=str(entity.get("vehicleModelDate") or "")[:4],
               trim=clean(entity.get("vehicleConfiguration")), transmission=clean(entity.get("vehicleTransmission")),
               color=clean(entity.get("color")))
    condition = str(entity.get("itemCondition") or offer.get("itemCondition") or "").rsplit("/", 1)[-1]
    row["condition"] = {"UsedCondition": "used", "NewCondition": "new"}.get(condition, "")
    facts = {"Year": row["year"], "Make": row["make"], "Model": row["model"], "Trim": row["trim"],
             "Condition": row["condition"], "Transmission": row["transmission"], "Color": row["color"],
             "VIN": entity.get("vehicleIdentificationNumber"), "Body style": entity.get("bodyType"),
             "Fuel": entity.get("fuelType") or (entity.get("vehicleEngine") or {}).get("fuelType"),
             "Doors": entity.get("numberOfDoors"),
             "Seats": entity.get("seatingCapacity") or entity.get("vehicleSeatingCapacity") or entity.get("numberOfSeats")}
    # No engine displacement: one provider has contradictory EV/combustion data.
    mileage = entity.get("mileageFromOdometer") or {}
    if mileage.get("value") is not None and mileage.get("unitCode") in {"SMI", "KMT"}:
        unit = "miles" if mileage["unitCode"] == "SMI" else "km"
        facts["Mileage"] = f"{mileage['value']:,} {unit}"
        if unit == "km":
            row["mileage_km"] = str(mileage["value"])
    elif source == "mekina":
        # This source omits the odometer from JSON-LD, including new cars at 0 km.
        # Read only its primary details table and retain the explicit unit.
        label = next((n for n in soup.select("dl dt") if text(n) == "Mileage"), None)
        value = text(label.find_next_sibling("dd")) if label else ""
        match = re.fullmatch(r"([\d,]+(?:\.\d+)?)\s+km", value, re.I)
        if match:
            row["mileage_km"] = match[1].replace(",", "")
            facts["Mileage"] = value
    if source == "atlanta":
        facts.update(visible_facts)
        if re.search(r"\bThis vehicle has a Branded Title\b", text(soup.select_one(".dealer-notes")), re.I):
            facts["Title information"] = "Branded Title (dealer disclosure)"
        facts["Price terms"] = ("Call for price" if contact_price else
                                "Source retail price, including listed dealer fees; taxes and registration may be additional")
    row = finish(row, offer.get("price"), offer.get("priceCurrency"), facts, region,
                 "Atlanta" if source == "atlanta" else "", contact_price=contact_price)
    if source == "atlanta":
        hours = []
        for item in seller.get("openingHoursSpecification", []):
            days = item.get("dayOfWeek", [])
            days = [days] if isinstance(days, str) else days
            if item.get("opens") and item.get("closes"):
                hours.extend(str(day).rsplit("/", 1)[-1] + " " + item["opens"] + "–" + item["closes"] for day in days)
        if hours:
            attributes = json.loads(row["attributes"])
            attributes["contactHours"] = "; ".join(hours)
            row["attributes"] = json.dumps(attributes, ensure_ascii=False, separators=(",", ":"))
    return row


def carsforsale_row(body, url, checked, source):
    soup = BeautifulSoup(body, "html.parser")
    # This template omits URL on Vehicle; bind the sole entity to its canonical and h1.
    entities = [e for e in schemas(soup) if kinds(e) & {"Vehicle"}]
    dealers = [e for e in schemas(soup) if "AutoDealer" in kinds(e)]
    title = text(soup.select_one("h1.vdp-header-bar__title"))
    if len(entities) != 1 or len(dealers) != 1 or not canonical_matches(soup, url):
        raise ValueError("Exact dealer vehicle page not confirmed")
    entity, dealer = entities[0], dealers[0]
    if not title.startswith(clean(entity.get("name"))) or not entity.get("name"):
        raise ValueError("Primary vehicle title mismatch")
    offer = entity.get("offers") or {}
    seller = offer.get("seller") or {}
    address = dealer.get("address") or {}
    if seller.get("name") != dealer.get("name") or dealer.get("name") != SOURCES[source][0]:
        raise ValueError("Seller identity mismatch")
    expected_state = "FL" if source == "florida" else "TX"
    if address.get("addressRegion") != expected_state:
        raise ValueError("Dealer state mismatch")
    gallery = soup.select(".carousel-inner img.car-image[data-lazy]")
    images = list(dict.fromkeys(n["data-lazy"] for n in gallery if "cdn05.carsforsale.com/" in n["data-lazy"]))
    primary = str(entity.get("image", "")).split("/")
    if not images or len(primary) < 4 or primary[3] != images[0].split("/")[3]:
        raise ValueError("Gallery does not belong to primary vehicle")
    row = refresh.row_base(url, title, clean(address.get("addressLocality")), "United States",
                           phone_number(seller.get("telephone"), "United States"), images,
                           "vehicles", "vehicles", checked, SOURCES[source][0])
    facts = facts_dict(soup, ".vdp-info-block__info-item", ".vdp-info-block__info-item-title", ".vdp-info-block__info-item-description")
    row.update(seller=dealer["name"], make=clean(entity.get("manufacturer")), model=clean(entity.get("model")),
               year=str(entity.get("vehicleModelDate") or ""), condition=facts.get("Condition", "").lower(),
               transmission=facts.get("Transmission", ""), color=facts.get("Exterior Color", ""))
    mileage = text(soup.select_one(".vdp-header-bar__mileage"))
    if mileage:
        facts["Odometer (source units)"] = mileage
    visible_price = re.sub(r"[^\d.]", "", text(soup.select_one(".vdp-header-bar__price")))
    if not visible_price or float(visible_price) != float(offer.get("price") or 0):
        raise ValueError("Visible and structured prices disagree")
    return finish(row, offer.get("price"), offer.get("priceCurrency"), facts, STATES[expected_state])


def betoch_row(body, url, checked):
    soup = BeautifulSoup(body, "html.parser")
    entity = own_entity(soup, url, {"RealEstateListing"})
    agent = soup.select_one(".box-avatar")
    link = agent.select_one('a[href^="tel:"]') if agent else None
    agent_links = agent.select('a[href*="/agents/"]') if agent else []
    seller = next((text(a) for a in agent_links if text(a)), "")
    address = entity.get("address") or {}
    if address.get("addressCountry") != "Ethiopia" or not seller:
        raise ValueError("Property location/agent not confirmed")
    title = clean(entity.get("name")).removesuffix(" | Betoch.et")
    subcategory = "for_rent_long" if re.search(r"\bfor rent\b", title, re.I) else "for_sale" if re.search(r"\bfor sale\b", title, re.I) else ""
    if not subcategory:
        raise ValueError("Property transaction type is unclear")
    posted = datetime.fromisoformat(entity.get("datePosted", ""))
    if posted.tzinfo is None:
        posted = posted.replace(tzinfo=timezone.utc)
    age = (datetime.fromisoformat(checked.replace("Z", "+00:00")) - posted).days
    if age > 180 or age < -1:
        raise ValueError("Property posting is outside the freshness window")
    price = entity.get("price") or {}
    # A source sometimes supplies "14" where its copy means millions. Never rescale by guesswork.
    if price.get("priceCurrency") != "ETB" or float(price.get("price") or 0) < 10000:
        raise ValueError("Property price is incomplete or requires currency review")
    if subcategory == "for_rent_long":
        # Don't guess monthly vs nightly or convert a USD description to ETB.
        raise ValueError("Rental price period/currency requires separate verification")
    row = refresh.row_base(url, title, clean(address.get("addressLocality")), "Ethiopia",
                           phone_number(link.get("href", "")[4:] if link else "", "Ethiopia"),
                           entity.get("image") or [], "real_estate", subcategory, checked, "Betoch.et")
    row["seller"] = seller + " (Betoch.et agency)"
    size = entity.get("floorSize") or {}
    facts = {"Rooms": entity.get("numberOfRooms"), "Bathrooms": entity.get("numberOfBathroomsTotal"),
             "Area": f"{size['value']} {size.get('unitCode', '')}" if size.get("value") else "",
             "Source posted": posted.date().isoformat()}
    row = finish(row, price.get("price"), price.get("priceCurrency"), facts, clean(address.get("addressRegion")))
    attrs = json.loads(row["attributes"])
    attrs.update(propertyType="apartment" if "apartment" in title.lower() else "house" if re.search("house|villa", title, re.I) else "other",
                 bedrooms=entity.get("numberOfRooms"), bathrooms=entity.get("numberOfBathroomsTotal"),
                 area=size.get("value"), sourcePostedAt=entity.get("datePosted"))
    row["attributes"] = json.dumps(attrs, ensure_ascii=False, separators=(",", ":"))
    return row


def parse_listing(source, body, url, checked):
    if source == "liusedcars":
        row = liusedcars_row(body, url, checked)
    elif source in {"atlanta", "mekina", "texas"}:
        row = vehicle_schema_row(body, url, checked, source)
    elif source == "betoch":
        row = betoch_row(body, url, checked)
    else:
        row = carsforsale_row(body, url, checked, source)
    state, reason = availability.classify(row, 200, body, url)
    if state != "active":
        raise ValueError(f"Source availability is {state}: {reason}")
    return row


def discovery_links(body, catalogue, pattern):
    soup = BeautifulSoup(body, "html.parser")
    candidates = [a["href"] for a in soup.select("a[href]")]
    candidates += [e.get("url", "") for e in schemas(soup) if kinds(e) & {"Car", "Vehicle", "Product"}]
    return list(dict.fromkeys(urljoin(catalogue, u).split("#")[0] for u in candidates
        if urlsplit(urljoin(catalogue, u)).netloc == urlsplit(catalogue).netloc
        and re.fullmatch(pattern, urlsplit(urljoin(catalogue, u)).path)))


def catalogue_pages(body, catalogue):
    """Follow only published pagination links on this catalogue, with a bounded crawl."""
    base = urlsplit(catalogue)
    result = []
    for a in BeautifulSoup(body, "html.parser").select("a[href]"):
        url = urljoin(catalogue, a["href"])
        parts = urlsplit(url)
        if parts.netloc != base.netloc:
            continue
        same_path = parts.path.rstrip("/") == base.path.rstrip("/")
        query_page = any(k.lower() == "page" and v[0].isdigit() and int(v[0]) > 1 for k, v in parse_qs(parts.query).items())
        path_page = re.fullmatch(re.escape(base.path.rstrip("/")) + r"/page/\d+", parts.path)
        if (same_path and query_page) or path_page:
            result.append(url)
    return list(dict.fromkeys(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", default=",".join(SOURCES))
    parser.add_argument("--limit-per-source", type=int, default=12)
    parser.add_argument("--candidate-limit", type=int, default=36)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--report", type=Path, default=Path("output/regional-listing-refresh-report.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    checked = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    existing = list(csv.DictReader((ROOT / "data/scraped-listings.csv").open()))
    existing_by_url = {availability.source_key(r.get("source_url", "")): r for r in existing}
    failures, incoming, source_reports = [], [], {}
    headers = {"User-Agent": availability.USER_AGENT}
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)

    def fetch(url):
        response = requests.get(url, headers=headers, timeout=25)
        response.raise_for_status()
        if availability.source_key(response.url) != availability.source_key(url):
            raise ValueError("Redirect away from requested source URL")
        if args.cache_dir:
            (args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".html")).write_text(response.text)
        return response.text

    def load(task):
        source, url = task
        try:
            row = parse_listing(source, fetch(url), url, checked)
            # Validate every published photo, not only the cover image.
            images = []
            for image_url in row["image_urls"].split("|"):
                try:
                    with requests.get(image_url, headers=headers, stream=True, timeout=15) as response:
                        if refresh.image_response_is_usable(response):
                            images.append(image_url)
                except requests.RequestException:
                    pass
            if not images:
                raise ValueError("No publicly readable source photo")
            row["image_urls"] = "|".join(images)
            return row, None
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            return None, {"source": source, "url": url, "reason": str(error)[:240]}

    for source in filter(None, args.sources.split(",")):
        name, catalogue, pattern = SOURCES[source]
        try:
            body = fetch(catalogue)
            links = discovery_links(body, catalogue, pattern)
            for page in catalogue_pages(body, catalogue)[:2]:
                try:
                    links.extend(discovery_links(fetch(page), catalogue, pattern))
                except (requests.RequestException, ValueError) as error:
                    failures.append({"source": source, "url": page, "reason": str(error)[:240]})
            links = list(dict.fromkeys(links))
            if not links:
                raise ValueError("No listing links in public catalogue")
            # New URLs first; revisit existing inventory for changed prices/details.
            links.sort(key=lambda u: (availability.source_key(u) in existing_by_url,
                                      existing_by_url.get(availability.source_key(u), {}).get("scraped_at", "")))
            known = [r["source_url"] for r in sorted(existing, key=lambda r: r.get("scraped_at", "")) if r.get("source_site") == name]
            links = list(dict.fromkeys(links[:args.candidate_limit] + known))[:max(args.candidate_limit, 120)]
            found = []
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                for row, error in pool.map(load, [(source, u) for u in links]):
                    if error:
                        failures.append(error)
                    elif availability.source_key(row["source_url"]) in existing_by_url or len([r for r in found if availability.source_key(r["source_url"]) not in existing_by_url]) < args.limit_per_source:
                        found.append(row)
            incoming.extend(found)
            source_reports[source] = {"name": name, "candidates": len(links), "verified": len(found)}
        except (requests.RequestException, ValueError) as error:
            failures.append({"source": source, "url": catalogue, "reason": str(error)[:240]})
            source_reports[source] = {"name": name, "candidates": 0, "verified": 0}
        print(f"{name}: {source_reports[source]['verified']} verified", flush=True)
    merged = refresh.merge(ROOT / "data/scraped-listings.csv", incoming) if incoming and not args.dry_run else {}
    report = {"checkedAt": checked, "sources": source_reports, "eligible": len(incoming), "merged": merged,
              "countries": dict(Counter(r["country"] for r in incoming)), "failures": failures,
              "ids": [r["id"] for r in incoming], "urls": [r["source_url"] for r in incoming]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps({k: v for k, v in report.items() if k not in {"ids", "urls", "failures"}}, indent=2))
    if not incoming:
        raise SystemExit("No verified records; saved listings retained")


if __name__ == "__main__":
    main()
