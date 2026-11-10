import { unpack } from '../lib/msgpackr.js';
import { NODES_API_URL, NODE_KEYS, STATUS_THRESHOLD_DAYS } from './config.js';
import { bytesToHex, daysAgo } from './utils.js';

export async function fetchNodes() {
	const res = await fetch(NODES_API_URL);
	if(!res.ok) {
		throw new Error(`Nodes API responded with HTTP ${res.status}`);
	}
	return unpack(new Uint8Array(await res.arrayBuffer()));
}

// Renames short API keys to full property names in place
function inflateNode(node) {
	for(const [short, full] of Object.entries(NODE_KEYS)) {
		if(!(short in node)) continue;
		node[full] = node[short];
		delete node[short];
	}
	if(node.public_key instanceof Uint8Array) {
		node.public_key = bytesToHex(node.public_key);
	}
}

const statusThresholds = {
	extinct: daysAgo(STATUS_THRESHOLD_DAYS.extinct),
	old: daysAgo(STATUS_THRESHOLD_DAYS.old),
	stale: daysAgo(STATUS_THRESHOLD_DAYS.stale),
};

export function getNodeUpdateStatus(node) {
	// only nodes uploaded by the map uploader ('u...') have meaningful update dates
	if(node.source?.[0] !== 'u') return 'none';

	const updatedMs = new Date(node.updated_date).getTime();
	if(updatedMs < statusThresholds.extinct) return 'extinct';
	if(updatedMs < statusThresholds.old) return 'old';
	if(updatedMs < statusThresholds.stale) return 'stale';
	return 'recent';
}

// Converts a raw API node into the shape used by the UI (mutates for speed on large datasets)
export function prepareNode(node) {
	inflateNode(node);
	node.status = getNodeUpdateStatus(node);
	node.preset = node.params;
	node.coords = `${node.lat.toFixed(4)}, ${node.lon.toFixed(4)}`;
	node.insertDate = new Date(node.inserted_date);
	node.updatedDate = node.updated_date ? new Date(node.updated_date) : null;
	node.freqMhz = node.params?.freq ? Math.floor(node.params.freq) : null;
	return node;
}

export function groupByType(nodes) {
	const byType = {};
	for(const node of nodes) {
		(byType[node.type] ??= []).push(node);
	}
	return byType;
}

export function collectFrequencies(nodes) {
	const freqs = new Set();
	for(const node of nodes) {
		if(node.freqMhz) freqs.add(node.freqMhz);
	}
	return [...freqs].sort((a, b) => a - b);
}

export function filterNodes(nodesByType, { nodeFilter, freqFilter, fromDate, fromInsertDate, onlyDuplicates }) {
	const from = new Date(fromDate);
	const fromInsert = new Date(fromInsertDate);
	const freqs = freqFilter.length > 0 ? new Set(freqFilter.map(Number)) : null;

	const result = [];
	for(const type of nodeFilter) {
		for(const node of nodesByType[type] ?? []) {
			if((node.updatedDate ?? node.insertDate) <= from) continue;
			if(node.insertDate <= fromInsert) continue;
			if(freqs && !freqs.has(node.freqMhz)) continue;
			result.push(node);
		}
	}

	return onlyDuplicates ? keepDuplicateNames(result) : result;
}

function keepDuplicateNames(nodes) {
	const nameCounts = new Map();
	for(const node of nodes) {
		const name = node.adv_name.toLowerCase();
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	return nodes.filter(node => nameCounts.get(node.adv_name.toLowerCase()) > 1);
}

export function computeStats(nodes, nodesByType) {
	const periods = [
		{ label: '24h', title: 'Nodes added in last 24 hours', since: daysAgo(1), count: 0 },
		{ label: '7d', title: 'Nodes added in last 7 days', since: daysAgo(7), count: 0 },
		{ label: '30d', title: 'Nodes added in last 30 days', since: daysAgo(30), count: 0 },
	];

	for(const node of nodes) {
		const insertMs = node.insertDate.getTime();
		for(const period of periods) {
			if(insertMs > period.since) period.count++;
		}
	}

	const countOf = type => nodesByType[type]?.length ?? 0;

	return {
		total: nodes.length,
		clients: countOf(1),
		repeaters: countOf(2),
		roomServers: countOf(3),
		sensors: countOf(4),
		periods,
	};
}

// The visible bounds may extend past -180/180 (the world repeats horizontally), node longitudes don't
function boundsContain(bounds, lat, lon) {
	if(lat < bounds.getSouth() || lat > bounds.getNorth()) return false;
	const west = bounds.getWest(), east = bounds.getEast();
	if(east - west >= 360) return true;
	const lng = west + ((lon - west) % 360 + 360) % 360;
	return lng <= east;
}

export function searchNodes(nodes, query, { bounds = null, limit } = {}) {
	// public keys are lowercase hex, so one lowercased needle serves both name and key matching
	const needle = query.toLowerCase();
	const matches = nodes.filter(node =>
		(!bounds || boundsContain(bounds, node.lat, node.lon)) &&
		(node.adv_name.toLowerCase().includes(needle) || node.public_key.startsWith(needle))
	);
	return matches.sort((a, b) => a.adv_name.localeCompare(b.adv_name)).slice(0, limit);
}
