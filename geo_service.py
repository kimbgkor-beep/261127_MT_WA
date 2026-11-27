"""Geospatial calculation service for railway routes, 5km buffers, and AWS stations."""

from itertools import combinations
import math
import random
from typing import Any

from pyproj import Transformer
from shapely.geometry import LineString, mapping
from shapely.ops import transform, unary_union

BUFFER_KM = 5
TRAIN_COUNT = 3
STATION_COUNT = 50
ZONE_COUNT = 3
RAIN_MS = 5000
ZONE_MS = 30000

RAILWAYS: dict[str, list[list[float]]] = {
    "경부선": [
        [37.5547, 126.9707],
        [37.2658, 127.0001],
        [36.81, 127.146],
        [36.3325, 127.4348],
        [36.1195, 128.3445],
        [35.879, 128.6285],
        [35.1151, 129.0414],
    ],
    "호남선": [
        [37.5547, 126.9707],
        [37.2658, 127.0001],
        [36.81, 127.146],
        [36.3325, 127.4348],
        [35.94, 126.945],
        [35.137, 126.79],
        [34.791, 126.386],
    ],
    "강릉선": [
        [37.5547, 126.9707],
        [37.58, 127.207],
        [37.49, 127.5],
        [37.36, 127.92],
        [37.62, 128.39],
        [37.764, 128.899],
    ],
    "중앙선": [
        [37.58, 127.048],
        [37.49, 127.5],
        [37.36, 127.92],
        [37.14, 128.21],
        [36.81, 128.62],
        [36.56, 128.73],
        [35.879, 128.6285],
    ],
    "전라선": [
        [35.94, 126.945],
        [35.849, 127.161],
        [35.41, 127.39],
        [34.95, 127.5],
        [34.753, 127.748],
    ],
}

HAZARD_TYPES = [
    {"name": "대설", "color": "#8653d9"},
    {"name": "호우", "color": "#06a8c4"},
    {"name": "강풍", "color": "#ef931d"},
]

_project = Transformer.from_crs(4326, 5179, always_xy=True).transform
_unproject = Transformer.from_crs(5179, 4326, always_xy=True).transform


def _build_network_data() -> dict[str, Any]:
    """Compute railway paths, single/overlap buffers, and random AWS stations."""
    lines = []
    buffers = []
    paths: dict[str, dict[str, Any]] = {}

    for name, coords in RAILWAYS.items():
        line = transform(_project, LineString([(lon, lat) for lat, lon in coords]))
        lines.append(line)
        buffers.append(line.buffer(BUFFER_KM * 1000))

        # 약 500m 간격으로 이동 경로 포인트 생성 (연속 보간의 기준 경로)
        n = max(2, int(line.length / 500) + 1)
        pts = [
            transform(_unproject, line.interpolate(i * line.length / (n - 1)))
            for i in range(n)
        ]
        paths[name] = {
            "coords": [[round(p.y, 6), round(p.x, 6)] for p in pts],
            "length_m": round(line.length, 1),
        }

    common = unary_union([a.intersection(b) for a, b in combinations(buffers, 2)])
    single_geom = unary_union(buffers).difference(common)

    single_geojson = (
        mapping(transform(_unproject, single_geom)) if not single_geom.is_empty else None
    )
    overlap_geojson = (
        mapping(transform(_unproject, common)) if not common.is_empty else None
    )

    stations = []
    for i in range(STATION_COUNT):
        line = random.choice(lines)
        pt = line.interpolate(random.uniform(0, line.length))
        angle = random.uniform(0, 2 * math.pi)
        distance = random.uniform(0, BUFFER_KM * 1000)
        lon, lat = _unproject(
            pt.x + distance * math.cos(angle),
            pt.y + distance * math.sin(angle),
        )
        stations.append(
            {
                "id": f"AWS-{i + 1:03d}",
                "lat": round(lat, 6),
                "lng": round(lon, 6),
            }
        )

    return {
        "config": {
            "bufferKm": BUFFER_KM,
            "trainCountPerLine": TRAIN_COUNT,
            "stationCount": STATION_COUNT,
            "zoneCountPerType": ZONE_COUNT,
            "rainMs": RAIN_MS,
            "zoneMs": ZONE_MS,
            "hazardTypes": HAZARD_TYPES,
        },
        "paths": paths,
        "buffers": {
            "single": single_geojson,
            "overlap": overlap_geojson,
        },
        "stations": stations,
    }


_CACHED_NETWORK: dict[str, Any] | None = None


def get_network_data() -> dict[str, Any]:
    """Return cached railway geospatial network data."""
    global _CACHED_NETWORK
    if _CACHED_NETWORK is None:
        _CACHED_NETWORK = _build_network_data()
    return _CACHED_NETWORK


def generate_hazard_zones(paths: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Generate random hazard zones along railway routes."""
    all_coords = [pt for route in paths.values() for pt in route["coords"]]
    zones = []
    for hazard in HAZARD_TYPES:
        for idx in range(ZONE_COUNT):
            lat, lng = random.choice(all_coords)
            radius = round(15000 + random.random() * 25000, 1)
            zones.append(
                {
                    "id": f"{hazard['name']}-{idx + 1}",
                    "name": hazard["name"],
                    "color": hazard["color"],
                    "lat": lat,
                    "lng": lng,
                    "radius": radius,
                }
            )
    return zones


def generate_rainfall(stations: list[dict[str, Any]]) -> dict[str, float]:
    """Generate simulated hourly rainfall (mm/h) for all stations."""
    readings: dict[str, float] = {}
    for st in stations:
        rain = 0.0 if random.random() < 0.25 else round(random.random() * 100, 1)
        readings[st["id"]] = rain
    return readings
