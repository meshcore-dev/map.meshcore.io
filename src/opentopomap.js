// OpenTopoMap's vector map (https://github.com/der-stefan/OpenTopoMap, vector/maplibregljs): their
// vector tiles and sprite, their layers, and elevation colours, hillshade and contour lines from the
// Mapterhorn terrain tiles (the same as the coverage model). Contour lines are made from the terrain in
// the browser by maplibre-contour.
import { addProtocol } from '../lib/maplibre-gl.mjs';
import mlcontour from '../lib/maplibre-contour.mjs';

// their layer list, pinned to a commit so changes upstream can't break the map. It's a script
// (`const otm_layers = [...]`, with comments): read as data below, never run.
const LAYERS_URL = 'https://cdn.jsdelivr.net/gh/der-stefan/OpenTopoMap@a2d5ea8e74341aaaf5a7a0b827e9237fcc696bdf/vector/maplibregljs/otm_layers.json';
const TERRAIN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
// Mapterhorn covers the whole world up to here (more detailed tiles only in some countries)
const TERRAIN_MAX_ZOOM = 12;

// what their vector tiles cover: Europe (west, south, east, north); the map is kept in here
export const OPENTOPOMAP_BOUNDS = [-34, 29, 48, 82];
// mainland Europe ([west, south, east, north]): with the view elsewhere when the map is picked, it's
// shown around `center` (central Europe: the box's own middle is in Scandinavia, on a web mercator map)
export const OPENTOPOMAP_HOME = { area: [-10, 36, 32, 71], center: [12, 50] };
// their colour of seas and lakes
const WATER_COLOR = '#a3dde8';

let layersPromise = null;
let demSource = null;

// The array literal of a script like `const name = [ ... ];` as JSON: comments dropped, single quoted
// strings double quoted, trailing commas and unquoted keys fixed
function parseArrayLiteral(text) {
	text = text.trim().replace(/^const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '');
	let out = '', quote = null;
	for(let i = 0; i < text.length;) {
		const c = text[i], next = text[i + 1];
		if(quote) {
			if(c === '\\') { out += c + next; i += 2; continue; }
			if(c === quote) { out += '"'; quote = null; }
			else if(c === '"') out += '\\"';
			else out += c;
			i++;
		} else if(c === '"' || c === "'") {
			quote = c;
			out += '"';
			i++;
		} else if(c === '/' && next === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else if(c === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end;
		} else {
			out += c;
			i++;
		}
	}
	out = out.replace(/,(\s*[\]}])/g, '$1').replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
	const layers = JSON.parse(out);
	if(!Array.isArray(layers)) throw new Error('OpenTopoMap layers: not a list');
	return layers;
}

function loadLayers() {
	layersPromise ??= fetch(LAYERS_URL)
		.then(res => {
			if(!res.ok) throw new Error(`OpenTopoMap layers: HTTP ${res.status}`);
			return res.text();
		})
		.then(parseArrayLiteral)
		// the raster version of the map is in there too (hidden)
		.then(layers => layers.filter(layer => layer.source !== 'opentopomap-raster').map(adjustLayer));
	layersPromise.catch(() => { layersPromise = null; });
	return layersPromise;
}

function adjustLayer(layer) {
	// the elevation colours start at 1 m with green: sea level (and below) gets the water colour
	if(layer.type === 'color-relief') {
		const [interpolate, curve, input, ...stops] = layer.paint['color-relief-color'];
		if(stops[0] > 0) {
			return { ...layer, paint: { ...layer.paint, 'color-relief-color': [interpolate, curve, input, 0, WATER_COLOR, ...stops] } };
		}
	}
	// the sea comes in one polygon per tile: its outline would draw the tile grid on the water
	if(layer.id === 'ocean' && layer.paint?.['fill-outline-color']) {
		const { 'fill-outline-color': outline, ...paint } = layer.paint;
		return { ...layer, paint };
	}
	return layer;
}

function getDemSource() {
	if(!demSource) {
		demSource = new mlcontour.DemSource({
			url: TERRAIN_URL,
			encoding: 'terrarium',
			maxzoom: TERRAIN_MAX_ZOOM,
			worker: true,
			cacheSize: 100,
			timeoutMs: 10000,
		});
		demSource.setupMaplibre({ addProtocol });
	}
	return demSource;
}

export async function getOpenTopoMapStyle() {
	const layers = await loadLayers();
	const dem = getDemSource();
	return {
		version: 8,
		glyphs: 'https://fonts.undpgeohub.org/fonts/{fontstack}/{range}.pbf',
		sprite: 'https://opentopomap.org/vector/otm_sprite',
		sources: {
			'opentopomap-vector': {
				type: 'vector',
				lineMetrics: true,
				tiles: ['https://opentopomap.org/otm/{z}/{x}/{y}.pbf'],
				bounds: OPENTOPOMAP_BOUNDS,
				maxzoom: 14,
				attribution: 'Map style: © <a href="https://opentopomap.org/about" target="_blank">OpenTopoMap</a>, Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
			},
			// elevation colours and hillshade, sharing the terrain tiles with the contour lines
			dem: {
				type: 'raster-dem',
				encoding: 'terrarium',
				tiles: [dem.sharedDemProtocolUrl],
				// no relief outside the map's data
				bounds: OPENTOPOMAP_BOUNDS,
				tileSize: 512,
				maxzoom: TERRAIN_MAX_ZOOM,
				attribution: 'Elevation: <a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
			},
			'contour-source': {
				type: 'vector',
				tiles: [
					dem.contourProtocolUrl({
						multiplier: 1,
						// zoom: [minor, major] contour interval (m)
						thresholds: {
							10: [50, 1000],
							11: [20, 500],
							12: [10, 100],
							13: [10, 100],
							14: [10, 100],
							15: [10, 50],
						},
						contourLayer: 'contours',
						elevationKey: 'ele',
						levelKey: 'level',
						extent: 4096,
						buffer: 1,
					}),
				],
				bounds: OPENTOPOMAP_BOUNDS,
				maxzoom: 15,
			},
		},
		layers,
	};
}
