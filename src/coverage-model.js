// Coverage model, run in a worker (coverage-worker.js): a LoRa link budget over terrain with forests
// (no buildings). Path loss = free space + diffraction over up to three obstacles (Deygout; this also
// covers a partly obstructed Fresnel zone): knife edges, optionally with the extra loss of rounded
// hills (ITU-R P.526).
// Elevation comes from Mapterhorn terrain tiles (terrarium encoded, 512px, web mercator) - bare ground
// in many countries, so forests (OpenStreetMap, from OpenFreeMap's vector tiles) are added on top.
// Tiles Mapterhorn can't serve come from AWS Terrain Tiles (same encoding, 256px, mostly SRTM).
import { readPolygonFeatures, readPolygons } from './mvt.js';

const TERRAIN_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const TERRAIN_TILE_SIZE = 512;
// fallback: a 512px tile at zoom z is 2 × 2 of these at zoom z + 1
const FALLBACK_TERRAIN_TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const FALLBACK_TERRAIN_TILE_SIZE = 256;
const TERRAIN_MAX_ZOOM = 12;
// enough for the largest estimate (~50 tiles), with room for switching between nodes and settings
const TERRAIN_CACHE_TILES = 128;
// the terrain zoom is picked per draw distance so the estimate's radius is about this many terrain
// pixels: the same work (and roughly the same number of tiles) for 40 km and for 250 km
const TARGET_RADIUS_PIXELS = 1200;

const VECTOR_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
// forests come with OpenMapTiles' landcover layer from zoom 7 on
const VECTOR_MIN_ZOOM = 7;
const VECTOR_MAX_ZOOM = 14;
const VECTOR_CACHE_TILES = 32;
// Buildings (profile only) come from the most detailed vector tiles, with heights from OpenStreetMap
// (height, or building:levels × 3.66 m); buildings without either get BUILDING_DEFAULT_HEIGHT
const BUILDINGS_ZOOM = 14;
const BUILDINGS_CACHE_TILES = 64;
const BUILDING_DEFAULT_HEIGHT = 5;
// longer paths would need too many tiles (a tile is about 2.4 km × cos(latitude) across)
export const BUILDINGS_MAX_DISTANCE = 30000;
// buildings this close to an end are the antenna's own (it's on the roof or next to it), not obstacles
const BUILDING_CLEARANCE = 10;
// Canopy height added to forests (HamnetDB uses 30 m on top of SRTM, which partly has the canopy already).
// Trees get lower up high and stop at the tree line: full height up to 1000 m, none at 2000 m.
const FOREST_HEIGHT = 25;
const FOREST_FULL_BELOW = 1000, FOREST_NONE_ABOVE = 2000;
// forest counts as clutter around an antenna up to here (trees get low towards the tree line)
const FOREST_CLUTTER_BELOW = 1500;
// nodes are usually in a clearing or on a roof: no trees this close to the antenna or the receiver
const FOREST_CLEARANCE = 150;

// Clutter right around an antenna below the rooftops / treetops: buildings and trees in OpenStreetMap,
// with the representative heights of ITU-R P.2108 (table 3): suburban 10 m, urban / trees / forest 15 m
const CLUTTER_NONE = 0, CLUTTER_SUBURBAN = 1, CLUTTER_URBAN = 2;
const CLUTTER_HEIGHTS = [0, 10, 15];
// street width of the model
const CLUTTER_STREET_WIDTH = 27;
// rounded obstacles: their radius comes from the terrain this far on each side of the top
const OBSTACLE_SPAN = 250;
const MAX_OBSTACLE_RADIUS = 20000;

// The other end of the link: a handheld client
export const RECEIVER = { height: 2, gain: 2 };
const NOISE_FIGURE_DB = 6;
// reserve for fading, clutter and everything else this model doesn't know about (usual link planning value)
export const FADE_MARGIN_DB = 10;
// demodulation limit (SNR, dB) per spreading factor (Semtech SX126x)
export const LORA_SNR_LIMIT = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

export const EARTH_RADIUS = 6371008.8;
const EARTH_CIRCUMFERENCE = 40075016.686;
// radio waves bend a little along the earth: the usual effective earth radius factor
const REFRACTION_K = 4 / 3;

const SIGNAL_RGB = [220, 38, 38];
// radio shadow for the 3D view: cells about this big (m), at most this many across the estimate's square
const SHADOW_CELL_METERS = 150;
const SHADOW_MAX_CELLS = 512;
// link margin (dB) shown at full strength; the colour fades from there down to 0 dB
const FULL_MARGIN_DB = 45;
const MAX_ALPHA = 0.85, MIN_ALPHA = 0.1;

// Simplified horizontal antenna patterns: gain (dB, relative to the peak) by the angle off the pointing
// direction. Main lobe as in 3GPP TR 36.814: -12 (angle / beam width)² dB, so -3 dB at half the beam
// width, down to the side lobe level. A yagi also has a back lobe ("tail") around 180°, front-to-back
// ratio about 15 dB; a panel (patch / micro-strip, with a ground plane) has a deep, flat back.
// The vertical pattern is left out: antennas are taken to be aimed at the horizon.
export const ANTENNA_TYPES = {
	omni: null,
	yagi: { sideLobe: 20, frontToBack: 15 },
	panel: { sideLobe: 25, frontToBack: 25 },
};

export function antennaPatternGain({ antennaType, beamWidth, direction }, bearing) {
	const type = ANTENNA_TYPES[antennaType];
	if(!type) return 0;
	// 0-180°
	const off = Math.abs(((((bearing - direction) % 360) + 540) % 360) - 180);
	const main = -12 * (off / beamWidth) ** 2;
	// the back lobe is a bit wider than the main one
	const back = -type.frontToBack - 12 * ((180 - off) / (beamWidth * 1.5)) ** 2;
	return Math.max(main, back, -type.sideLobe);
}

// Receiver sensitivity (dBm) for LoRa with the given bandwidth (kHz) and spreading factor
export function getSensitivity({ bw, sf }) {
	return -174 + 10 * Math.log10(bw * 1000) + NOISE_FIGURE_DB + LORA_SNR_LIMIT[sf];
}

const tileCache = new Map();

// Elevations (meters) of one terrain tile
function loadTerrainTile(z, x, y) {
	const key = `${z}/${x}/${y}`;
	let promise = tileCache.get(key);
	if(!promise) {
		promise = fetchTerrainTile(z, x, y);
		tileCache.set(key, promise);
		if(tileCache.size > TERRAIN_CACHE_TILES) tileCache.delete(tileCache.keys().next().value);
		// don't keep failures, the next request can try again
		promise.catch(() => tileCache.delete(key));
	}
	return promise;
}

async function fetchImage(url) {
	const res = await fetch(url);
	if(!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return createImageBitmap(await res.blob());
}

function tileUrl(template, z, x, y) {
	return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// Elevations (m) of a terrain tile, row by row
async function fetchTerrainTile(z, x, y) {
	const canvas = new OffscreenCanvas(TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	try {
		ctx.drawImage(await fetchImage(tileUrl(TERRAIN_TILE_URL, z, x, y)), 0, 0);
	} catch(error) {
		console.warn(`Terrain tile ${z}/${x}/${y} from Mapterhorn failed (${error.message}), using AWS Terrain Tiles`);
		const quarters = await Promise.all([0, 1, 2, 3].map(i =>
			fetchImage(tileUrl(FALLBACK_TERRAIN_TILE_URL, z + 1, x * 2 + (i & 1), y * 2 + (i >> 1)))));
		quarters.forEach((bitmap, i) => ctx.drawImage(bitmap, (i & 1) * FALLBACK_TERRAIN_TILE_SIZE, (i >> 1) * FALLBACK_TERRAIN_TILE_SIZE));
	}
	const { data } = ctx.getImageData(0, 0, TERRAIN_TILE_SIZE, TERRAIN_TILE_SIZE);

	// terrarium: elevation = R * 256 + G + B / 256 - 32768
	const elevations = new Float32Array(TERRAIN_TILE_SIZE * TERRAIN_TILE_SIZE);
	for(let i = 0; i < elevations.length; i++) {
		elevations[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
	}
	return elevations;
}

let vectorTileUrl = null;
const vectorCache = new Map();

// OpenMapTiles landuse classes counted as buildings (ITU-R P.2108 clutter types). Cities are often
// covered only by their districts (suburb, quarter, neighbourhood) instead of residential areas: they
// count as suburban too, without the open land in them (fields, meadows, wetlands).
const URBAN_LANDUSE = new Set(['commercial', 'industrial', 'retail']);
const SUBURBAN_LANDUSE = new Set(['residential', 'suburb', 'quarter', 'neighbourhood']);
const OPEN_LANDCOVER = new Set(['farmland', 'grass', 'wetland', 'sand', 'rock', 'ice']);

async function fetchVectorTile(z, x, y) {
	if(!vectorTileUrl) {
		vectorTileUrl = fetch(VECTOR_TILEJSON_URL).then(res => {
			if(!res.ok) throw new Error(`Vector tiles: HTTP ${res.status}`);
			return res.json();
		}).then(tilejson => tilejson.tiles[0]);
		vectorTileUrl.catch(() => { vectorTileUrl = null; });
	}
	const url = (await vectorTileUrl).replace('{z}', z).replace('{x}', x).replace('{y}', y);
	const res = await fetch(url);
	if(!res.ok) throw new Error(`Vector tile ${z}/${x}/${y}: HTTP ${res.status}`);
	return res.arrayBuffer();
}

// Land cover polygons of one vector tile: { extent, forest, open, suburban, urban } (rings)
function loadLandCoverTile(z, x, y) {
	const key = `${z}/${x}/${y}`;
	let promise = vectorCache.get(key);
	if(!promise) {
		promise = (async () => {
			const buffer = await fetchVectorTile(z, x, y);
			const { extent, rings: forest } = readPolygons(buffer, 'landcover', properties => properties.class === 'wood');
			return {
				extent,
				forest,
				open: readPolygons(buffer, 'landcover', properties => OPEN_LANDCOVER.has(properties.class)).rings,
				suburban: readPolygons(buffer, 'landuse', properties => SUBURBAN_LANDUSE.has(properties.class)).rings,
				urban: readPolygons(buffer, 'landuse', properties => URBAN_LANDUSE.has(properties.class)).rings,
			};
		})();
		vectorCache.set(key, promise);
		if(vectorCache.size > VECTOR_CACHE_TILES) vectorCache.delete(vectorCache.keys().next().value);
		promise.catch(() => vectorCache.delete(key));
	}
	return promise;
}

const buildingsCache = new Map();

// Buildings of one BUILDINGS_ZOOM tile: { extent, buildings: [{ height, rings }] }. Tiles merge the
// buildings with the same properties into one feature; outlines drawn in 3D by their parts are left out
// (the parts are there too).
function loadBuildingsTile(x, y) {
	const key = `${x}/${y}`;
	let promise = buildingsCache.get(key);
	if(!promise) {
		promise = fetchVectorTile(BUILDINGS_ZOOM, x, y).then(buffer => {
			const { extent, features } = readPolygonFeatures(buffer, 'building', properties => !properties.hide_3d);
			return {
				extent,
				buildings: features.map(({ properties, rings }) => ({ height: properties.render_height ?? BUILDING_DEFAULT_HEIGHT, rings })),
			};
		});
		buildingsCache.set(key, promise);
		if(buildingsCache.size > BUILDINGS_CACHE_TILES) buildingsCache.delete(buildingsCache.keys().next().value);
		promise.catch(() => buildingsCache.delete(key));
	}
	return promise;
}

// Where the line from a to b (BUILDINGS_ZOOM tile units) runs through buildings: [{ from, to, height }]
// with from / to as shares of the line (0-1). Exact intersections with the outlines, so buildings
// narrower than the profile's samples count too.
async function loadBuildingSpans(ax, ay, bx, by) {
	const length = Math.hypot(bx - ax, by - ay);
	// tiles under the line, checked every 1/8 of a tile
	const keys = new Set();
	const checks = Math.ceil(length * 8) + 1;
	for(let i = 0; i <= checks; i++) {
		keys.add(`${Math.floor(ax + (bx - ax) * i / checks)},${Math.floor(ay + (by - ay) * i / checks)}`);
	}
	const across = 2 ** BUILDINGS_ZOOM;
	let failed = 0;
	const spans = [];
	await Promise.all([...keys].map(async key => {
		const [tx, ty] = key.split(',').map(Number);
		if(ty < 0 || ty >= across) return;
		let tile;
		try {
			tile = await loadBuildingsTile(((tx % across) + across) % across, ty);
		} catch(error) {
			console.error(error);
			failed++;
			return;
		}
		// the line in the tile's coordinates; only its part inside the tile counts (tiles overlap a bit)
		const { extent } = tile;
		const x0 = (ax - tx) * extent, y0 = (ay - ty) * extent;
		const dx = (bx - ax) * extent, dy = (by - ay) * extent;
		const [inFrom, inTo] = clipToSquare(x0, y0, dx, dy, extent);
		if(inFrom >= inTo) return;
		for(const { height, rings } of tile.buildings) {
			// crossings of the (endless) line with the outlines, even-odd: entering and leaving alternate
			const crossings = [];
			for(const ring of rings) {
				const n = ring.length;
				for(let i = 0, j = n - 2; i < n; j = i, i += 2) {
					const px = ring[j] - x0, py = ring[j + 1] - y0, qx = ring[i] - x0, qy = ring[i + 1] - y0;
					const sideP = dx * py - dy * px, sideQ = dx * qy - dy * qx;
					if((sideP > 0) === (sideQ > 0)) continue;
					const ex = qx - px, ey = qy - py;
					crossings.push((px * ey - py * ex) / (dx * ey - dy * ex));
				}
			}
			crossings.sort((p, q) => p - q);
			for(let i = 0; i + 1 < crossings.length; i += 2) {
				const from = Math.max(crossings[i], inFrom), to = Math.min(crossings[i + 1], inTo);
				if(from < to) spans.push({ from, to, height });
			}
		}
	}));
	return { spans, tiles: keys.size - failed, failed };
}

// The part of the line (x0, y0) + t (dx, dy), t in [0, 1], inside the square [0, size]²: [from, to]
function clipToSquare(x0, y0, dx, dy, size) {
	let from = 0, to = 1;
	for(const [p, d] of [[x0, dx], [y0, dy]]) {
		if(d === 0) {
			if(p < 0 || p >= size) return [1, 0];
			continue;
		}
		const t0 = (0 - p) / d, t1 = (size - p) / d;
		from = Math.max(from, Math.min(t0, t1));
		to = Math.min(to, Math.max(t0, t1));
	}
	return [from, to];
}

// Land cover of the square [left, left + size) x [top, top + size) in world pixels at the terrain
// zoom, per terrain pixel: forest cover (0-255) and clutter (CLUTTER_NONE / _SUBURBAN / _URBAN).
// Counts the vector tiles that couldn't be loaded.
async function loadLandCover(zoom, left, top, size) {
	const vectorZoom = Math.max(VECTOR_MIN_ZOOM, Math.min(VECTOR_MAX_ZOOM, zoom - 1));
	// size of a vector tile in terrain pixels
	const tileSpan = TERRAIN_TILE_SIZE * 2 ** (zoom - vectorZoom);
	const tilesAcross = 2 ** vectorZoom;
	const x0 = Math.floor(left / tileSpan), x1 = Math.floor((left + size - 1) / tileSpan);
	const y0 = Math.max(0, Math.floor(top / tileSpan)), y1 = Math.min(tilesAcross - 1, Math.floor((top + size - 1) / tileSpan));

	let failed = 0;
	const jobs = [];
	for(let ty = y0; ty <= y1; ty++) {
		for(let tx = x0; tx <= x1; tx++) {
			jobs.push(loadLandCoverTile(vectorZoom, ((tx % tilesAcross) + tilesAcross) % tilesAcross, ty).then(
				tile => ({ tile, offsetX: tx * tileSpan - left, offsetY: ty * tileSpan - top }),
				error => { console.error(error); failed++; return null; },
			));
		}
	}
	const tiles = (await Promise.all(jobs)).filter(Boolean);
	return { ...rasterizeLandCover(tiles, tileSpan, size), tiles: tiles.length, failed };
}

// Land cover of vector tiles ([{ tile, offsetX, offsetY }], each tileSpan pixels across) on a square
// raster of `size` pixels: { forest (0-255), clutter (CLUTTER_*) }
function rasterizeLandCover(tiles, tileSpan, size) {
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	// one path per tile and kind: holes (wound the other way) stay empty with the nonzero rule
	function fill(kind, colour) {
		ctx.fillStyle = colour;
		for(const { tile, offsetX, offsetY } of tiles) {
			const scale = tileSpan / tile.extent;
			ctx.beginPath();
			for(const ring of tile[kind]) {
				ctx.moveTo(offsetX + ring[0] * scale, offsetY + ring[1] * scale);
				for(let i = 2; i < ring.length; i += 2) ctx.lineTo(offsetX + ring[i] * scale, offsetY + ring[i + 1] * scale);
				ctx.closePath();
			}
			ctx.fill('nonzero');
		}
	}

	fill('forest', '#000');
	let { data } = ctx.getImageData(0, 0, size, size);
	const forest = new Uint8Array(size * size);
	for(let i = 0; i < forest.length; i++) forest[i] = data[i * 4 + 3];

	// urban over suburban (without open land), told apart by the red channel
	ctx.clearRect(0, 0, size, size);
	fill('suburban', 'rgb(100, 0, 0)');
	ctx.globalCompositeOperation = 'destination-out';
	fill('open', '#000');
	ctx.globalCompositeOperation = 'source-over';
	fill('urban', 'rgb(200, 0, 0)');
	({ data } = ctx.getImageData(0, 0, size, size));
	const clutter = new Uint8Array(size * size);
	for(let i = 0; i < clutter.length; i++) {
		if(data[i * 4 + 3] >= 128) clutter[i] = data[i * 4] > 150 ? CLUTTER_URBAN : CLUTTER_SUBURBAN;
	}
	return { forest, clutter };
}

// Web mercator: world pixels at a zoom and back
export function toWorldPixels(lon, lat, worldSize) {
	const sinLat = Math.sin(lat * Math.PI / 180);
	return [
		(lon + 180) / 360 * worldSize,
		(0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
	];
}

function toLngLat(x, y, worldSize) {
	const lon = x / worldSize * 360 - 180;
	const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / worldSize))) * 180 / Math.PI;
	return [lon, lat];
}

// Knife-edge diffraction loss (dB) for the Fresnel-Kirchhoff parameter v (ITU-R P.526 approximation):
// 0 dB with the first Fresnel zone mostly clear, 6 dB with the obstacle touching the line of sight
function knifeEdgeLoss(v) {
	if(v <= -0.78) return 0;
	return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

// Terminal clutter loss (dB) of an antenna at `height` among clutter of `clutterHeight` (ITU-R P.2108
// section 3.1, diffraction model): diffraction over the clutter down to the antenna
function clutterLoss(height, clutterHeight, freqMHz) {
	if(height >= clutterHeight) return 0;
	const below = clutterHeight - height;
	const angle = Math.atan(below / CLUTTER_STREET_WIDTH) * 180 / Math.PI;
	const v = 0.342 * Math.sqrt(freqMHz / 1000) * Math.sqrt(below * angle);
	return Math.max(0, knifeEdgeLoss(v) - 6.03);
}

// Fresnel-Kirchhoff parameter of hull corner k for the path from (dA, hA) to (dB, hB)
function edgeParameter(hullD, hullH, k, dA, hA, dB, hB, wavelength) {
	const d1 = hullD[k] - dA, d2 = dB - hullD[k];
	const h = hullH[k] - hA - (hB - hA) * d1 / (dB - dA);
	return h * Math.sqrt(2 * (dB - dA) / (wavelength * d1 * d2));
}

// The terrain profile along the current ray (heights relative to the antenna, one per step) for the
// shape of the obstacles, and how much of the rounded obstacle loss to apply (0: knife edges only)
const ray = { profile: null, metersPerStep: 1, spanSteps: 1, lastStep: 0, rounding: 0 };

// Extra loss (dB) of a rounded obstacle over a knife edge (ITU-R P.526 section 4.2, T(m, n)) for hull
// corner k on the path from (dA, hA) to (dB, hB). The radius comes from how sharply the terrain
// falls off on both sides of the top: a broad hill takes more than a sharp ridge, and the loss grows
// quickly with how deep the receiver is in its shadow.
function roundingLoss(hullD, hullH, k, dA, hA, dB, hB, wavelength) {
	const d1 = hullD[k] - dA, d2 = dB - hullD[k];
	const h = hullH[k] - hA - (hB - hA) * d1 / (dB - dA);
	if(h <= 0) return 0;

	const { profile, metersPerStep, spanSteps, lastStep } = ray;
	const step = Math.round(hullD[k] / metersPerStep);
	const left = Math.min(spanSteps, step), right = Math.min(spanSteps, lastStep - step);
	// turning angle over the top (the corner is on the upper hull: never negative)
	let angle = 0, span = 0;
	if(left > 0) { angle += (hullH[k] - profile[step - left]) / (left * metersPerStep); span += left * metersPerStep; }
	if(right > 0) { angle += (hullH[k] - profile[step + right]) / (right * metersPerStep); span += right * metersPerStep; }
	if(left === 0 || right === 0) { angle *= 2; span *= 2; }
	if(span === 0) return 0;
	const radius = angle > span / MAX_OBSTACLE_RADIUS ? span / angle : MAX_OBSTACLE_RADIUS;

	const scale = Math.cbrt(Math.PI * radius / wavelength);
	const m = radius * (d1 + d2) / (d1 * d2) / scale;
	const n = h * scale * scale / radius;
	const mn = m * n;
	const sqrtM = Math.sqrt(m);
	const common = 7.2 * sqrtM + 3.6 * m * sqrtM - 0.8 * m * m;
	const loss = mn <= 4
		? common - (2 - 12.5 * n) * m
		: common - 6 - 20 * Math.log10(mn) - (2 - 17 * n) * m;
	return loss > 0 ? loss : 0;
}

// Diffraction loss (dB) of hull corner k on the path from (dA, hA) to (dB, hB)
function obstacleLoss(hullD, hullH, k, dA, hA, dB, hB, wavelength) {
	const loss = knifeEdgeLoss(edgeParameter(hullD, hullH, k, dA, hA, dB, hB, wavelength));
	return ray.rounding > 0 ? loss + ray.rounding * roundingLoss(hullD, hullH, k, dA, hA, dB, hB, wavelength) : loss;
}

// The hull corner in [a, b] highest above a line with the given slope (the hull is concave: its
// segment slopes only go down)
function highestCorner(hullD, hullH, a, b, slope) {
	while(a < b) {
		const mid = (a + b) >> 1;
		if(hullH[mid + 1] - hullH[mid] <= slope * (hullD[mid + 1] - hullD[mid])) b = mid;
		else a = mid + 1;
	}
	return a;
}

const edges = new Int32Array(3);

// Diffraction loss (dB) from the antenna (hull corner 0) over the terrain hull (n corners) to a
// receiver at distance d and height h
function diffractionLoss(hullD, hullH, n, d, h, wavelength) {
	if(n < 2) return 0;
	// the receiver's horizon: the first corner the receiver sees over the following one
	let a = 0, b = n - 1;
	while(a < b) {
		const mid = (a + b) >> 1;
		if((hullD[mid + 1] - hullD[mid]) * (h - hullH[mid]) - (hullH[mid + 1] - hullH[mid]) * (d - hullD[mid]) >= 0) b = mid;
		else a = mid + 1;
	}
	const horizon = a;
	// clear line of sight: only the corner closest to it can reach into the Fresnel zone
	if(horizon === 0) {
		return obstacleLoss(hullD, hullH, highestCorner(hullD, hullH, 1, n - 1, h / d), 0, 0, d, h, wavelength);
	}

	// obstacles: the antenna's horizon (corner 1), the receiver's and the top of the hull between them
	let count = 0;
	edges[count++] = 1;
	if(horizon >= 3) {
		edges[count++] = highestCorner(hullD, hullH, 2, horizon - 1,
			(hullH[horizon] - hullH[1]) / (hullD[horizon] - hullD[1]));
	}
	if(horizon >= 2) edges[count++] = horizon;

	// Deygout: the main obstacle for the whole path, then the worst one on each side of it
	let main = 0, mainV = -Infinity;
	for(let i = 0; i < count; i++) {
		const v = edgeParameter(hullD, hullH, edges[i], 0, 0, d, h, wavelength);
		if(v > mainV) { main = i; mainV = v; }
	}
	const m = edges[main];
	let loss = obstacleLoss(hullD, hullH, m, 0, 0, d, h, wavelength);
	let left = -1, leftV = -Infinity, right = -1, rightV = -Infinity;
	for(let i = 0; i < main; i++) {
		const v = edgeParameter(hullD, hullH, edges[i], 0, 0, hullD[m], hullH[m], wavelength);
		if(v > leftV) { left = edges[i]; leftV = v; }
	}
	for(let i = main + 1; i < count; i++) {
		const v = edgeParameter(hullD, hullH, edges[i], hullD[m], hullH[m], d, h, wavelength);
		if(v > rightV) { right = edges[i]; rightV = v; }
	}
	if(left >= 0) loss += obstacleLoss(hullD, hullH, left, 0, 0, hullD[m], hullH[m], wavelength);
	if(right >= 0) loss += obstacleLoss(hullD, hullH, right, hullD[m], hullH[m], d, h, wavelength);
	return loss;
}

// Loads the terrain around a node and estimates the link margin (dB) from its antenna to a receiver
// everywhere within the draw distance. Returns the margins (a square grid of terrain pixels around
// the node), the map image for them (PNG blob, coordinates: top left, top right, bottom right,
// bottom left) and some stats.
// `rounding`: share of the rounded obstacle loss to add to the knife edges (0..1)
export async function computeCoverageGrid({ lat, lon, settings, radio, rounding = 0 }) {
	const distance = settings.distanceKm * 1000;
	const cosLat = Math.cos(lat * Math.PI / 180);

	const zoom = Math.min(TERRAIN_MAX_ZOOM, Math.round(Math.log2(
		EARTH_CIRCUMFERENCE * cosLat * TARGET_RADIUS_PIXELS / (TERRAIN_TILE_SIZE * distance),
	)));
	const worldSize = TERRAIN_TILE_SIZE * 2 ** zoom;
	const tilesAcross = 2 ** zoom;
	const metersPerPixel = EARTH_CIRCUMFERENCE * cosLat / worldSize;
	const radius = Math.ceil(distance / metersPerPixel);
	const [ox, oy] = toWorldPixels(lon, lat, worldSize);

	// the square around the node, in world pixels, and the terrain tiles it touches
	const left = Math.floor(ox) - radius, top = Math.floor(oy) - radius;
	const size = radius * 2 + 1;
	const tx0 = Math.floor(left / TERRAIN_TILE_SIZE), ty0 = Math.floor(top / TERRAIN_TILE_SIZE);
	const tx1 = Math.floor((left + size - 1) / TERRAIN_TILE_SIZE), ty1 = Math.floor((top + size - 1) / TERRAIN_TILE_SIZE);

	const started = performance.now();
	const tiles = new Map();
	let failed = 0;
	const jobs = [];
	for(let ty = Math.max(0, ty0); ty <= Math.min(tilesAcross - 1, ty1); ty++) {
		for(let tx = tx0; tx <= tx1; tx++) {
			jobs.push(loadTerrainTile(zoom, ((tx % tilesAcross) + tilesAcross) % tilesAcross, ty).then(
				tile => tiles.set(`${tx},${ty}`, tile),
				error => { console.error(error); failed++; },
			));
		}
	}
	const landCoverJob = loadLandCover(zoom, left, top, size);
	await Promise.all(jobs);
	if(tiles.size === 0) throw new Error('Terrain data could not be loaded');
	const landCover = await landCoverJob;
	const loaded = performance.now();

	// terrain of the whole square in one array (missing tiles: sea level)
	const terrain = new Float32Array(size * size);
	for(const [key, tile] of tiles) {
		const [tx, ty] = key.split(',').map(Number);
		const x0 = Math.max(left, tx * TERRAIN_TILE_SIZE), x1 = Math.min(left + size, (tx + 1) * TERRAIN_TILE_SIZE);
		const y0 = Math.max(top, ty * TERRAIN_TILE_SIZE), y1 = Math.min(top + size, (ty + 1) * TERRAIN_TILE_SIZE);
		for(let y = y0; y < y1; y++) {
			const from = (y - ty * TERRAIN_TILE_SIZE) * TERRAIN_TILE_SIZE + (x0 - tx * TERRAIN_TILE_SIZE);
			terrain.set(tile.subarray(from, from + x1 - x0), (y - top) * size + (x0 - left));
		}
	}

	// link budget: the highest path loss the link can take, keeping the fade margin in reserve
	const sensitivity = getSensitivity(radio);
	let maxPathLoss = settings.txPower + settings.antennaGain + RECEIVER.gain - sensitivity - FADE_MARGIN_DB;
	const wavelength = 299.792458 / radio.freq;
	const fsplConstant = 20 * Math.log10(radio.freq) + 32.44;
	const curvature = 1 / (2 * REFRACTION_K * EARTH_RADIUS);

	const cx = Math.floor(ox) - left, cy = Math.floor(oy) - top;
	const antenna = terrain[cy * size + cx] + settings.antennaHeight;
	const margins = new Float32Array(size * size).fill(-Infinity);

	// clutter loss per clutter type for the receiver, and for the antenna (once)
	const clutterLosses = { receiver: CLUTTER_HEIGHTS.map(() => 0), antenna: 0 };
	if(settings.clutter) {
		clutterLosses.receiver = CLUTTER_HEIGHTS.map(height => clutterLoss(RECEIVER.height, height, radio.freq));
		clutterLosses.antenna = clutterLoss(settings.antennaHeight, CLUTTER_HEIGHTS[clutterAt(cy * size + cx)], radio.freq);
		maxPathLoss -= clutterLosses.antenna;
	}
	// clutter type of a terrain pixel: buildings, or forest (as urban)
	function clutterAt(index) {
		return landCover.forest[index] >= 128 && terrain[index] < FOREST_CLUTTER_BELOW ? CLUTTER_URBAN : landCover.clutter[index];
	}

	// Rays from the antenna, one terrain pixel apart at the edge. The terrain is sampled between its
	// pixels (bilinear), with the forest canopy on top; the earth's curvature (with refraction) lowers
	// far away terrain. Along each ray the upper convex hull of the terrain profile so far is kept (a
	// stack, amortized O(1) per step): the path from the antenna to a receiver goes over it like a
	// stretched string, and its corners are the obstacles. Up to three of them - the antenna's horizon,
	// the receiver's horizon and the highest point of the hull between the two - give the diffraction
	// loss (Deygout method). A single edge would leave out every ridge but one. The hull lags
	// FOREST_CLEARANCE behind the receiver, so trees right around it don't count as an obstacle.
	const rays = Math.ceil(2 * Math.PI * radius);
	const hullD = new Float64Array(radius + 1), hullH = new Float64Array(radius + 1);
	const profile = new Float64Array(radius + 1);
	const lag = Math.max(1, Math.ceil(FOREST_CLEARANCE / metersPerPixel));
	const { forest: cover } = landCover;
	// radio shadow (3D view): how high above the ground the line of sight from the antenna passes (m),
	// on a coarse grid; averaged over the samples in a cell, with their ground elevation
	// (no smaller than the terrain's pixels)
	const shadowCells = Math.min(SHADOW_MAX_CELLS, size, Math.ceil(size * metersPerPixel / SHADOW_CELL_METERS));
	const shadowCell = size / shadowCells;
	const shadowDepth = new Float32Array(shadowCells * shadowCells);
	const shadowGround = new Float32Array(shadowCells * shadowCells);
	const shadowCount = new Uint32Array(shadowCells * shadowCells);
	Object.assign(ray, {
		profile,
		metersPerStep: metersPerPixel,
		spanSteps: Math.max(1, Math.round(OBSTACLE_SPAN / metersPerPixel)),
		rounding,
	});
	for(let r = 0; r < rays; r++) {
		const angle = 2 * Math.PI * r / rays;
		const dx = Math.cos(angle), dy = Math.sin(angle);
		// directional antennas: the ray's bearing (web mercator keeps angles; y grows southwards)
		const rayMaxPathLoss = maxPathLoss + antennaPatternGain(settings, (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
		// the antenna is the hull's first point; heights are relative to it
		hullD[0] = 0;
		hullH[0] = 0;
		profile[0] = 0;
		let n = 1;
		for(let step = 1; step <= radius; step++) {
			const fx = cx + dx * step, fy = cy + dy * step;
			const x0 = Math.min(size - 2, Math.floor(fx)), y0 = Math.min(size - 2, Math.floor(fy));
			const wx = fx - x0, wy = fy - y0;
			const i00 = y0 * size + x0, i10 = i00 + 1, i01 = i00 + size, i11 = i01 + 1;
			const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
			const elevation = terrain[i00] * w00 + terrain[i10] * w10 + terrain[i01] * w01 + terrain[i11] * w11;
			const d = step * metersPerPixel;
			// terrain height relative to the antenna
			const ground = elevation - d * d * curvature - antenna;

			let trees = 0;
			const forestCover = cover[i00] * w00 + cover[i10] * w10 + cover[i01] * w01 + cover[i11] * w11;
			if(forestCover > 0 && d >= FOREST_CLEARANCE && elevation < FOREST_NONE_ABOVE) {
				trees = FOREST_HEIGHT * forestCover / 255 *
					(elevation <= FOREST_FULL_BELOW ? 1 : (FOREST_NONE_ABOVE - elevation) / (FOREST_NONE_ABOVE - FOREST_FULL_BELOW));
			}
			profile[step] = ground + trees;

			// add the terrain point `lag` steps back to the hull, dropping the corners it covers
			const p = step - lag;
			if(p >= 1) {
				const pd = p * metersPerPixel, ph = profile[p];
				while(n >= 2 && (hullD[n - 1] - hullD[n - 2]) * (ph - hullH[n - 2]) -
					(hullH[n - 1] - hullH[n - 2]) * (pd - hullD[n - 2]) >= 0) n--;
				hullD[n] = pd;
				hullH[n] = ph;
				n++;
			}
			ray.lastStep = Math.max(0, p);

			// the line of sight over the steepest obstacle so far (the hull's first corner)
			const lineOfSight = n >= 2 ? d * hullH[1] / hullD[1] : -Infinity;
			const cell = Math.min(shadowCells - 1, Math.floor(fy / shadowCell)) * shadowCells + Math.min(shadowCells - 1, Math.floor(fx / shadowCell));
			shadowDepth[cell] += Math.max(0, lineOfSight - ground);
			shadowGround[cell] += elevation;
			shadowCount[cell]++;

			const loss = 20 * Math.log10(d / 1000) + fsplConstant +
				diffractionLoss(hullD, hullH, n, d, ground + RECEIVER.height, wavelength);
			const margin = rayMaxPathLoss - loss;
			const index = Math.round(fy) * size + Math.round(fx);
			if(margin > margins[index]) margins[index] = margin;
		}
	}
	margins[cy * size + cx] = maxPathLoss;
	for(let i = 0; i < shadowCount.length; i++) {
		const count = shadowCount[i];
		shadowDepth[i] = count ? shadowDepth[i] / count : NaN;
		shadowGround[i] = count ? shadowGround[i] / count : NaN;
	}
	// clutter type per pixel: the receiver's loss is applied where it's needed (the map image for
	// handhelds; nodes on roofs and masts are above it)
	const clutter = new Uint8Array(size * size);
	for(let i = 0; i < clutter.length; i++) clutter[i] = clutterAt(i);
	const computed = performance.now();

	// image (for a handheld, with the clutter around it): the signal colour, its opacity following
	// the link margin
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext('2d');
	const image = ctx.createImageData(size, size);
	const pixels = image.data;
	for(let i = 0; i < margins.length; i++) {
		const margin = margins[i] - clutterLosses.receiver[clutter[i]];
		if(margin < 0) continue;
		const strength = Math.min(1, margin / FULL_MARGIN_DB);
		pixels[i * 4] = SIGNAL_RGB[0];
		pixels[i * 4 + 1] = SIGNAL_RGB[1];
		pixels[i * 4 + 2] = SIGNAL_RGB[2];
		pixels[i * 4 + 3] = Math.round(255 * (MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * strength));
	}
	// (the estimate's edge and a directional antenna's direction are map lines: see map.js)
	ctx.putImageData(image, 0, 0);

	const blob = await canvas.convertToBlob({ type: 'image/png' });

	return {
		grid: { margins, clutter, clutterLosses: clutterLosses.receiver, left, top, size, worldSize, cx, cy, radius },
		shadow: { depth: shadowDepth, ground: shadowGround, cells: shadowCells, left, top, size, worldSize },
		blob,
		coordinates: [
			toLngLat(left, top, worldSize),
			toLngLat(left + size, top, worldSize),
			toLngLat(left + size, top + size, worldSize),
			toLngLat(left, top + size, worldSize),
		],
		incomplete: failed > 0 || landCover.failed > 0,
		stats: {
			zoom,
			metersPerPixel: Math.round(metersPerPixel),
			tiles: tiles.size,
			landCoverTiles: landCover.tiles,
			antennaClutterLoss: Math.round(clutterLosses.antenna * 10) / 10,
			samples: rays * radius,
			loadMs: Math.round(loaded - started),
			computeMs: Math.round(computed - loaded),
			drawMs: Math.round(performance.now() - computed),
		},
	};
}

// --- Point-to-point profile ---

// samples along a profile at most (the terrain zoom is picked for about this resolution)
const PROFILE_MAX_SAMPLES = 4000;
const PROFILE_TILE_RASTER = 512;
const landCoverRasters = new WeakMap();

// Land cover raster of one vector tile (cached with the tile)
function getLandCoverRaster(tile) {
	let raster = landCoverRasters.get(tile);
	if(!raster) {
		raster = rasterizeLandCover([{ tile, offsetX: 0, offsetY: 0 }], PROFILE_TILE_RASTER, PROFILE_TILE_RASTER);
		landCoverRasters.set(tile, raster);
	}
	return raster;
}

function toRadians(deg) {
	return deg * Math.PI / 180;
}

// Great circle distance (m) and initial bearing (degrees) from a to b
function distanceAndBearing(a, b) {
	const φ1 = toRadians(a.lat), φ2 = toRadians(b.lat), Δλ = toRadians(b.lon - a.lon);
	const h = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	const distance = 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return { distance, bearing: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}

// Terrain profile and link budget between two antennas (a, b: { lat, lon, height, gain }), with
// the same model as the coverage estimate (both ends may be among clutter). Returns the samples
// (distance, ground elevation, tree and building heights), the antennas' elevations, distance, bearings and losses.
export async function computeProfile({ a, b, settings, radio, rounding = 0 }) {
	const { distance, bearing } = distanceAndBearing(a, b);
	const backBearing = distanceAndBearing(b, a).bearing;
	if(distance < 1) throw new Error('The points are at the same place');
	const cosLat = Math.cos(toRadians((a.lat + b.lat) / 2));

	// terrain resolution: as fine as the data allows, up to PROFILE_MAX_SAMPLES along the path
	const zoom = Math.max(1, Math.min(TERRAIN_MAX_ZOOM, Math.floor(Math.log2(
		EARTH_CIRCUMFERENCE * cosLat * PROFILE_MAX_SAMPLES / (TERRAIN_TILE_SIZE * distance),
	))));
	const worldSize = TERRAIN_TILE_SIZE * 2 ** zoom;
	const metersPerPixel = EARTH_CIRCUMFERENCE * cosLat / worldSize;
	const steps = Math.max(2, Math.ceil(distance / metersPerPixel));
	const stepLength = distance / steps;

	// sample positions: a straight line on the (mercator) map, like the line drawn between the points
	const [ax, ay] = toWorldPixels(a.lon, a.lat, worldSize);
	const [bx, by] = toWorldPixels(b.lon, b.lat, worldSize);
	const positions = new Float64Array((steps + 1) * 2);
	for(let i = 0; i <= steps; i++) {
		positions[i * 2] = ax + (bx - ax) * i / steps;
		positions[i * 2 + 1] = ay + (by - ay) * i / steps;
	}

	// terrain tiles the line (and its bilinear neighbours) touches
	const tilesAcross = 2 ** zoom;
	const wrapX = tx => ((tx % tilesAcross) + tilesAcross) % tilesAcross;
	const terrainKeys = new Set();
	for(let i = 0; i <= steps; i++) {
		const x = positions[i * 2], y = positions[i * 2 + 1];
		for(const dx of [0, 1]) for(const dy of [0, 1]) {
			const ty = Math.floor((y + dy) / TERRAIN_TILE_SIZE);
			if(ty >= 0 && ty < tilesAcross) terrainKeys.add(`${wrapX(Math.floor((x + dx) / TERRAIN_TILE_SIZE))},${ty}`);
		}
	}
	const vectorZoom = Math.max(VECTOR_MIN_ZOOM, Math.min(VECTOR_MAX_ZOOM, zoom - 1));
	const vectorSpan = TERRAIN_TILE_SIZE * 2 ** (zoom - vectorZoom);
	const vectorAcross = 2 ** vectorZoom;
	const vectorKeys = new Set();
	for(let i = 0; i <= steps; i++) {
		const ty = Math.floor(positions[i * 2 + 1] / vectorSpan);
		if(ty >= 0 && ty < vectorAcross) vectorKeys.add(`${((Math.floor(positions[i * 2] / vectorSpan) % vectorAcross) + vectorAcross) % vectorAcross},${ty}`);
	}

	const started = performance.now();
	let failed = 0;
	const terrainTiles = new Map(), vectorTiles = new Map();
	const withBuildings = distance <= BUILDINGS_MAX_DISTANCE;
	const buildingsScale = 2 ** BUILDINGS_ZOOM / worldSize;
	let buildingSpans = { spans: [], tiles: 0, failed: 0 };
	await Promise.all([
		withBuildings && loadBuildingSpans(ax * buildingsScale, ay * buildingsScale, bx * buildingsScale, by * buildingsScale)
			.then(result => { buildingSpans = result; failed += result.failed; }),
		...[...terrainKeys].map(key => {
			const [tx, ty] = key.split(',').map(Number);
			return loadTerrainTile(zoom, tx, ty).then(tile => terrainTiles.set(key, tile), error => { console.error(error); failed++; });
		}),
		...[...vectorKeys].map(key => {
			const [tx, ty] = key.split(',').map(Number);
			return loadLandCoverTile(vectorZoom, tx, ty).then(tile => vectorTiles.set(key, tile), error => { console.error(error); failed++; });
		}),
	]);
	if(terrainTiles.size === 0) throw new Error('Terrain data could not be loaded');

	function terrainPixel(px, py) {
		const tile = terrainTiles.get(`${wrapX(Math.floor(px / TERRAIN_TILE_SIZE))},${Math.floor(py / TERRAIN_TILE_SIZE)}`);
		if(!tile) return 0;
		const x = ((px % TERRAIN_TILE_SIZE) + TERRAIN_TILE_SIZE) % TERRAIN_TILE_SIZE, y = py % TERRAIN_TILE_SIZE;
		return tile[y * TERRAIN_TILE_SIZE + x];
	}
	// bilinear, like the coverage estimate
	function elevationAt(x, y) {
		const x0 = Math.floor(x), y0 = Math.floor(y), wx = x - x0, wy = y - y0;
		return terrainPixel(x0, y0) * (1 - wx) * (1 - wy) + terrainPixel(x0 + 1, y0) * wx * (1 - wy) +
			terrainPixel(x0, y0 + 1) * (1 - wx) * wy + terrainPixel(x0 + 1, y0 + 1) * wx * wy;
	}
	// { forest (0-255), clutter } at a world pixel
	function landCoverAt(x, y) {
		const tx = Math.floor(x / vectorSpan), ty = Math.floor(y / vectorSpan);
		const tile = vectorTiles.get(`${((tx % vectorAcross) + vectorAcross) % vectorAcross},${ty}`);
		if(!tile) return { forest: 0, clutter: CLUTTER_NONE };
		const raster = getLandCoverRaster(tile);
		const scale = PROFILE_TILE_RASTER / vectorSpan;
		const rx = Math.min(PROFILE_TILE_RASTER - 1, Math.floor((x - tx * vectorSpan) * scale));
		const ry = Math.min(PROFILE_TILE_RASTER - 1, Math.floor((y - ty * vectorSpan) * scale));
		const index = ry * PROFILE_TILE_RASTER + rx;
		return { forest: raster.forest[index], clutter: raster.clutter[index] };
	}
	const loaded = performance.now();

	const elevations = new Float32Array(steps + 1);
	const trees = new Float32Array(steps + 1);
	// highest building at each sample (its share of the path, half a step either way). Shown and used for
	// the line of sight only: as diffracting edges, rooftops would add some 50 dB over a few km of city,
	// far more than measured (signals get around and between buildings), the clutter loss covers them.
	const buildings = new Float32Array(steps + 1);
	const buildingsEstimated = new Uint8Array(steps + 1);
	const clearance = BUILDING_CLEARANCE / distance;
	for(const { from, to, height } of buildingSpans.spans) {
		if(from <= clearance || to >= 1 - clearance) continue;
		const first = Math.max(0, Math.ceil(from * steps - 0.5)), last = Math.min(steps, Math.floor(to * steps + 0.5));
		for(let i = first; i <= last; i++) {
			if(height > buildings[i]) {
				buildings[i] = height;
				buildingsEstimated[i] = height === BUILDING_DEFAULT_HEIGHT ? 1 : 0;
			}
		}
	}
	const endClutter = [CLUTTER_NONE, CLUTTER_NONE];
	for(let i = 0; i <= steps; i++) {
		const x = positions[i * 2], y = positions[i * 2 + 1];
		const elevation = elevationAt(x, y);
		elevations[i] = elevation;
		const { forest, clutter } = landCoverAt(x, y);
		const d = i * stepLength;
		if(forest > 0 && d >= FOREST_CLEARANCE && distance - d >= FOREST_CLEARANCE && elevation < FOREST_NONE_ABOVE) {
			trees[i] = FOREST_HEIGHT * forest / 255 *
				(elevation <= FOREST_FULL_BELOW ? 1 : (FOREST_NONE_ABOVE - elevation) / (FOREST_NONE_ABOVE - FOREST_FULL_BELOW));
		}
		const clutterType = forest >= 128 && elevation < FOREST_CLUTTER_BELOW ? CLUTTER_URBAN : clutter;
		if(i === 0) endClutter[0] = clutterType;
		if(i === steps) endClutter[1] = clutterType;
	}

	// the coverage model's path loss from antenna a to antenna b: terrain relative to antenna a,
	// lowered by the earth's curvature, its upper hull lagging FOREST_CLEARANCE behind b
	const wavelength = 299.792458 / radio.freq;
	const curvature = 1 / (2 * REFRACTION_K * EARTH_RADIUS);
	const antennaA = elevations[0] + a.height;
	const profile = new Float64Array(steps + 1);
	for(let i = 0; i <= steps; i++) {
		const d = i * stepLength;
		profile[i] = elevations[i] + trees[i] - d * d * curvature - antennaA;
	}
	const lag = Math.max(1, Math.ceil(FOREST_CLEARANCE / stepLength));
	const hullD = new Float64Array(steps + 1), hullH = new Float64Array(steps + 1);
	let n = 1;
	for(let p = 1; p <= steps - lag; p++) {
		const pd = p * stepLength, ph = profile[p];
		while(n >= 2 && (hullD[n - 1] - hullD[n - 2]) * (ph - hullH[n - 2]) -
			(hullH[n - 1] - hullH[n - 2]) * (pd - hullD[n - 2]) >= 0) n--;
		hullD[n] = pd;
		hullH[n] = ph;
		n++;
	}
	Object.assign(ray, {
		profile,
		metersPerStep: stepLength,
		spanSteps: Math.max(1, Math.round(OBSTACLE_SPAN / stepLength)),
		lastStep: Math.max(0, steps - lag),
		rounding,
	});
	const heightB = elevations[steps] + b.height - distance * distance * curvature - antennaA;
	const freeSpaceLoss = 20 * Math.log10(distance / 1000) + 20 * Math.log10(radio.freq) + 32.44;
	const diffraction = diffractionLoss(hullD, hullH, n, distance, heightB, wavelength);
	const clutter = settings.clutter
		? [clutterLoss(a.height, CLUTTER_HEIGHTS[endClutter[0]], radio.freq), clutterLoss(b.height, CLUTTER_HEIGHTS[endClutter[1]], radio.freq)]
		: [0, 0];
	const pathLoss = freeSpaceLoss + diffraction + clutter[0] + clutter[1];
	const margin = settings.txPower + a.gain + b.gain - getSensitivity(radio) - FADE_MARGIN_DB - pathLoss;

	return {
		distance,
		bearing,
		backBearing,
		stepLength,
		elevations,
		trees,
		buildings,
		buildingsEstimated,
		withBuildings,
		wavelength,
		refractionK: REFRACTION_K,
		losses: { freeSpace: freeSpaceLoss, diffraction, clutterA: clutter[0], clutterB: clutter[1], total: pathLoss },
		margin,
		incomplete: failed > 0,
		stats: {
			zoom,
			samples: steps + 1,
			metersPerSample: Math.round(stepLength),
			terrainTiles: terrainTiles.size,
			landCoverTiles: vectorTiles.size,
			buildingTiles: buildingSpans.tiles,
			buildingSpans: buildingSpans.spans.length,
			loadMs: Math.round(loaded - started),
			computeMs: Math.round(performance.now() - loaded),
		},
	};
}
