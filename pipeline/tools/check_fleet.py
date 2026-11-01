#!/usr/bin/env python3
"""Cross-check web/js/fleet.js model ranges against per-vehicle registers.

Downloads the Sofia lists of transphoto.org (trams, trolleybuses, electric buses)
and fotobus.msk.ru (buses), samples the live GTFS-realtime feed for the fleet
numbers in service, and prints every vehicle whose model differs from our lookup.

    python3 pipeline/tools/check_fleet.py [--samples 6]
"""
import collections, html, json, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "tram": "https://transphoto.org/list.php?t=1&cid=396&serv=0",
    "trolley": "https://transphoto.org/list.php?t=2&cid=396&serv=0",
    "ebus": "https://transphoto.org/list.php?t=9&cid=396&serv=0",
    "bus": "https://fotobus.msk.ru/list.php?loid=2235",
}
FEED = "https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions"
UA = {"User-Agent": "sofia-transport-fleet-check"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def register(url):
    """Fleet number -> list of model names (a number can be reused over the years).
    fotobus lists 500 rows per page (&st=500, 1000, ...)."""
    out = collections.defaultdict(list)
    pages = [url] if "transphoto" in url else [f"{url}&st={st}" for st in range(0, 10000, 500)]
    for page in pages:
        n = _parse(get(page).decode("utf-8", "replace"), out)
        if not n:
            break
    return out


def _parse(s, out):
    n = 0
    for tr in re.findall(r'<tr class="s\d+">(.*?)</tr>', s, re.S):
        tds = re.findall(r'<td class="([^"]*)">(.*?)</td>', tr, re.S)
        if not tds:
            continue
        num = html.unescape(re.sub("<[^>]+>", "", tds[0][1])).strip()
        models = [html.unescape(re.sub("<[^>]+>", "", v)).strip() for c, v in tds if c == "cs"]
        if models and num.isdigit():
            out[int(num)].append(models[0])
            n += 1
    return n


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7F) << s; s += 7
        if c < 0x80:
            return r, i


def fields(b):
    i, out = 0, collections.defaultdict(list)
    while i < len(b):
        k, i = varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = varint(b, i)
        elif t == 1:
            v = b[i:i + 8]; i += 8
        elif t == 5:
            v = b[i:i + 4]; i += 4
        else:
            n, i = varint(b, i); v = b[i:i + n]; i += n
        out[f].append(v)
    return out


def live_ids(samples):
    ids = set()
    for k in range(samples):
        for e in fields(get(FEED))[2]:
            vp = fields(fields(e)[4][0]) if 4 in fields(e) else {}
            if 8 in vp:
                ids.add(fields(vp[8][0])[1][0].decode())
        if k < samples - 1:
            time.sleep(5)
    return ids


def main():
    samples = int(sys.argv[sys.argv.index("--samples") + 1]) if "--samples" in sys.argv else 3
    js = (ROOT / "web" / "js" / "fleet.js").read_text(encoding="utf-8")
    models = json.loads(re.search(r"const MODELS = (\[.*?\]);", js, re.S).group(1))
    order = {"tram": ["tram", "trolley", "bus"], "trolley": ["trolley", "bus", "tram"], "bus": ["bus", "trolley", "tram"]}

    def lookup(kind, n):
        for ty in order[kind]:
            best = min(((b - a, m) for m in models if m["type"] == ty for a, b in m["ranges"] if a <= n <= b),
                       key=lambda x: x[0], default=None)
            if best:
                return best[1]["model"]

    reg = {k: register(u) for k, u in SOURCES.items()}
    # Compare spellings loosely: Latin/Cyrillic look-alikes, punctuation and suffixes differ between sources.
    lat = str.maketrans("тмкаеорсх", "tmkaeopcx")
    key = lambda s: re.sub(r"[^a-z0-9]", "", s.lower().translate(lat).replace("škoda", "skoda").replace("mercedes-benz", "mb"))
    def same(a, b):
        a, b = key(a), key(b)
        common = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        return a in b or b in a or common >= 8
    ok, unknown, bad = 0, [], []
    for vid in sorted(live_ids(samples)):
        kind = "tram" if vid.startswith("TM") else "trolley" if vid.startswith("TB") else "bus"
        n = int(re.sub(r"\D", "", vid))
        ours = lookup(kind, n)
        theirs = reg["tram"].get(n, []) if kind == "tram" else reg[kind].get(n, []) + reg["ebus"].get(n, [])
        if not theirs:
            unknown.append(vid)
        elif ours and any(same(t, ours) for t in theirs):
            ok += 1
        else:
            bad.append((vid, ours, theirs[:3]))
    print(f"{ok} match, {len(bad)} differ, {len(unknown)} not in the registers")
    for vid, ours, theirs in bad:
        print(f"  {vid}: ours {ours!r}, register {theirs}")


if __name__ == "__main__":
    main()
