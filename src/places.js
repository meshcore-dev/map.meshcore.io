// Place search (towns, villages, streets, peaks, ...) with Photon (https://photon.komoot.io, OpenStreetMap
// data, free with fair use), and coordinates typed or pasted into the search box.

const PHOTON_URL = 'https://photon.komoot.io/api/';
export const PLACE_SEARCH_MIN_LENGTH = 3;
export const PLACE_SEARCH_DELAY_MS = 300;
const PLACE_SEARCH_LIMIT = 8;
// a higher zoom narrows the location bias down so much that exact spellings far away come first
// ("zilina" near Žilina: a street in Crete)
const BIAS_MAX_ZOOM = 12;

// --- Coordinates ---

// One coordinate: decimal degrees, or degrees and minutes (and seconds), with an optional N/S/E/W before
// or after. The marks (° ' ") can be left out: "48 8.9 N".
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const COORDINATE = new RegExp(String.raw`^([NSEW])?\s*([-+])?\s*(${NUMBER})\s*°?` +
	String.raw`(?:\s*(${NUMBER})\s*['′’]?(?:\s*(${NUMBER})\s*(?:"|″|”|'')?)?)?\s*([NSEW])?$`, 'i');

function parseCoordinate(text) {
	const match = COORDINATE.exec(text.trim());
	if(!match) return null;
	const [, before, sign, ...rest] = match;
	const [degrees, minutes, seconds, after] = rest;
	if(before && after) return null;
	const number = s => Number(s.replace(',', '.'));
	// only the last part can have decimals, minutes and seconds stay under 60
	if(minutes && (!Number.isInteger(number(degrees)) || number(minutes) >= 60)) return null;
	if(seconds && (!Number.isInteger(number(minutes)) || number(seconds) >= 60)) return null;
	let value = number(degrees) + (minutes ? number(minutes) / 60 : 0) + (seconds ? number(seconds) / 3600 : 0);
	const hemisphere = (before || after || '').toUpperCase();
	if(sign === '-' || hemisphere === 'S' || hemisphere === 'W') value = -value;
	return { value, axis: hemisphere ? (hemisphere === 'N' || hemisphere === 'S' ? 'lat' : 'lon') : null };
}

function toLatLon(a, b) {
	if(!a || !b || (a.axis && a.axis === b.axis)) return null;
	const [lat, lon] = a.axis === 'lon' || b.axis === 'lat' ? [b.value, a.value] : [a.value, b.value];
	return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// The two coordinates in the text: split at a ";" or ",", else at the one space where both halves read as
// a coordinate (a comma in "48,15 17,10" is a decimal comma)
function parsePair(text) {
	for(const separator of [';', ',']) {
		const parts = text.split(separator);
		if(parts.length === 2) {
			const pair = toLatLon(parseCoordinate(parts[0]), parseCoordinate(parts[1]));
			if(pair) return pair;
		}
	}
	const found = [];
	for(const space of text.matchAll(/\s+|(?<=[NSEW])(?=[\d+-])|(?<=[\d°'′’"″”])(?=[NSEW]\s*[\d+-])/gi)) {
		const pair = toLatLon(
			parseCoordinate(text.slice(0, space.index)),
			parseCoordinate(text.slice(space.index + space[0].length)),
		);
		if(pair) found.push(pair);
	}
	// more than one way to read it ("48 8 17 6"): not taken as coordinates
	return found.length === 1 ? found[0] : null;
}

// Latitude and longitude in the text ({ lat, lon }) or null: "48.14864, 17.10775", "48.14864 17.10775",
// "48°08'55"N 17°06'28"E", "N 48.1486 E 17.1077", "17.1077E 48.1486N", "48 8.9 N 17 6.4 E", map links
// with "@48.14,17.10,15z" or "?lat=48.14&lon=17.10". Without N/S/E/W latitude comes first (as in Google
// Maps and GPS apps).
export function parseCoordinates(text) {
	text = text.trim();
	const link = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text)
		?? /[?&#]lat=(-?\d+(?:\.\d+)?)&(?:lon|lng)=(-?\d+(?:\.\d+)?)/.exec(text);
	if(link) return toLatLon({ value: Number(link[1]), axis: null }, { value: Number(link[2]), axis: null });
	if(!/\d/.test(text) || /[^\d\s.,;°'′’"″”+\-NSEW]/i.test(text)) return null;
	return parsePair(text);
}

export function formatCoordinates({ lat, lon }) {
	return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// --- Places ---

// [OSM tag (`key=value` or just `key`), Material Symbols icon, description, map zoom to show it at]
const PLACE_KINDS = [
	['natural=peak', 'landscape', 'Peak', 13],
	['natural=volcano', 'landscape', 'Volcano', 13],
	['natural=saddle', 'landscape', 'Saddle', 14],
	['mountain_pass=yes', 'landscape', 'Mountain pass', 14],
	['natural=ridge', 'landscape', 'Ridge'],
	['natural=valley', 'landscape', 'Valley'],
	['natural=water', 'water', 'Water'],
	['waterway', 'water', 'Waterway'],
	['place=country', 'flag', 'Country', 5],
	['place=state', 'map', 'Region', 7],
	['place=region', 'map', 'Region', 7],
	['place=province', 'map', 'Region', 7],
	['place=county', 'map', 'County', 9],
	['place=city', 'location_city', 'City', 11],
	['place=town', 'location_city', 'Town', 12],
	['place=village', 'cottage', 'Village', 13],
	['place=hamlet', 'cottage', 'Hamlet', 14],
	['place=isolated_dwelling', 'cottage', 'Hamlet', 15],
	['place=suburb', 'holiday_village', 'Suburb', 13],
	['place=quarter', 'holiday_village', 'Quarter', 14],
	['place=neighbourhood', 'holiday_village', 'Neighbourhood', 15],
	['place=locality', 'pin_drop', 'Locality', 14],
	['place=island', 'landscape', 'Island'],
	['boundary', 'map', 'Area'],
	['highway', 'road', 'Street', 15],
	['railway=station', 'train', 'Station', 15],
	['aeroway', 'flight', 'Airport'],
	['amenity', 'storefront', null, 16],
	['tourism', 'attractions', null, 16],
	['building', 'home', 'Building', 17],
];

// map zoom by Photon's type, for places of other kinds without an extent
const TYPE_ZOOM = { country: 5, state: 7, county: 9, city: 11, district: 13, locality: 14, street: 15, house: 17, other: 14 };

function toPlace(feature) {
	const p = feature.properties;
	const [lon, lat] = feature.geometry.coordinates;
	const name = p.name ?? ([p.street, p.housenumber].filter(Boolean).join(' ') || p.postcode);
	if(!name) return null;
	const [, icon = 'location_on', kind, zoom] = PLACE_KINDS.find(([tag]) => tag === `${p.osm_key}=${p.osm_value}` || tag === p.osm_key) ?? [];
	// where it is: the town (unless that's the place itself), region and country
	const area = [p.city ?? p.town ?? p.village, p.county, p.state, p.country]
		.filter((part, i, all) => part && part !== name && all.indexOf(part) === i);
	return {
		id: `${p.osm_type}${p.osm_id}`,
		name,
		area: area.slice(0, 3).join(', '),
		icon,
		kind: kind ?? (p.osm_value ? (p.osm_value[0].toUpperCase() + p.osm_value.slice(1)).replace(/_/g, ' ') : p.type),
		lat, lon,
		// Photon's extent: [west, north, east, south]; a peak is shown around its top
		bounds: p.extent && p.osm_key !== 'natural' ? [[p.extent[0], p.extent[3]], [p.extent[2], p.extent[1]]] : null,
		zoom: zoom ?? TYPE_ZOOM[p.type] ?? TYPE_ZOOM.other,
	};
}

const cache = new Map();

// Places matching the query, the ones near `near` ({ lat, lon, zoom } of the map) first; only inside
// `bounds` ([west, south, east, north]) when given
export async function searchPlaces(query, { near = null, bounds = null, signal } = {}) {
	const params = new URLSearchParams({ q: query, limit: PLACE_SEARCH_LIMIT });
	if(near) {
		params.set('lat', near.lat.toFixed(3));
		params.set('lon', near.lon.toFixed(3));
		params.set('zoom', Math.min(BIAS_MAX_ZOOM, Math.round(near.zoom)));
	}
	if(bounds) params.set('bbox', bounds.map(v => v.toFixed(4)).join(','));
	const url = `${PHOTON_URL}?${params}`;
	if(cache.has(url)) return cache.get(url);

	const res = await fetch(url, { signal });
	if(!res.ok) throw new Error(`Place search: HTTP ${res.status}`);
	const { features = [] } = await res.json();
	const seen = new Set();
	const places = features.map(toPlace).filter(place => {
		// the same street comes in many pieces: once per name and area
		const key = `${place?.name}|${place?.area}|${place?.kind}`;
		if(!place || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if(cache.size > 100) cache.delete(cache.keys().next().value);
	cache.set(url, places);
	return places;
}
