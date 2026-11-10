import { DEFAULT_VIEW } from './config.js';
import { fromMapZoom } from './map.js';

export function readUrlParams() {
	return Object.fromEntries(new URLSearchParams(location.search));
}

export function writeUrlParams(params) {
	history.replaceState({}, '', `/?${new URLSearchParams(params)}`);
}

export function getInitialView(params) {
	const lat = Number(params.lat), lon = Number(params.lon), zoom = Number(params.zoom);
	return lat && lon && zoom ? { lat, lon, zoom } : DEFAULT_VIEW;
}

export function isDeletionRequest(params) {
	return params.delete === '1' &&
		typeof params.public_key === 'string' &&
		/^[a-z0-9]{64}$/i.test(params.public_key);
}

// Filter state from URL params, only for the params that are present
export function getFiltersFromUrl(params) {
	const filters = {};
	if(params.nodes) filters.nodeFilter = params.nodes.split(',').map(Number);
	if(params.freq) filters.freqFilter = params.freq.split(',').map(Number);
	if(params.date) filters.fromDate = params.date;
	if(params.dateInsert) filters.fromInsertDate = params.dateInsert;
	if(params.dupes === '1') filters.onlyDuplicates = true;
	if(params.cluster) filters.clusteringZoom = Number(params.cluster);
	return filters;
}

export function setMapPosition(params, map) {
	// the map can be panned around the world several times, keep the longitude within -180..180
	const pos = map.getCenter().wrap();
	params.lat = pos.lat.toFixed(4);
	params.lon = pos.lng.toFixed(4);
	params.zoom = Math.round(fromMapZoom(map.getZoom()) * 100) / 100;
}

export function clearMapPosition(params) {
	delete params.lat;
	delete params.lon;
	delete params.zoom;
}

// Planning sites in the URL: a node's public key, or "lat,lon" of a picked point
export function encodeSite(site) {
	if(!site) return null;
	return site.publicKey ?? `${site.lat.toFixed(5)},${site.lon.toFixed(5)}`;
}

export function decodeSite(value) {
	if(typeof value !== 'string') return null;
	if(/^[0-9a-f]{64}$/i.test(value)) return { publicKey: value.toLowerCase() };
	const [lat, lon] = value.split(',').map(Number);
	if(!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
	return { lat, lon };
}
