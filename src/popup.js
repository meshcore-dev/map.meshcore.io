import QRCode from '../lib/qrcode.min.js';
import { NODE_TYPES, RADIO_PARAM_DESC, UPDATE_STATUS_DESC } from './config.js';
import { requestCoverage } from './coverage.js';
import { deletionRequest, isDeletionRequested, isInDeletionRequest, openDeletionRequest } from './deletion.js';
import { findPresets, presetsLoaded } from './presets.js';
import { addProfileEnd, getProfileLinkLabel } from './profile.js';
import { bytesToHex, escapeHtml, timeAgo } from './utils.js';

const REPEATER_TYPE = 2;

function renderTime(value) {
	const dt = new Date(value);
	return `<time datetime="${escapeHtml(value)}" title="${dt.toLocaleString()}">${timeAgo(dt.getTime())}</time>`;
}

function renderCoords(value) {
	const [lat, lon] = value.split(',').map(s => s.trim());
	return `<span class="coords-menu-wrap">` +
		`<a href="#" class="coords-menu-toggle">${escapeHtml(value)}</a>` +
		`<span class="coords-menu">` +
			`<a href="#" data-copy="${escapeHtml(value)}">Copy coordinates</a>` +
			`<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=15" target="_blank">OpenStreetMap</a>` +
			`<a href="https://www.google.com/maps/place/${lat},${lon}" target="_blank">Google Maps</a>` +
			`<a href="https://mapy.com/?q=${lat},${lon}" target="_blank">Mapy.com</a>` +
		`</span>` +
	`</span>`;
}

// On short screens only the start and end of the key are shown (see style.css), tapping it shows all of it
function renderPublicKey(value) {
	const key = escapeHtml(value);
	return `<span class="pkey" title="Show the full public key">` +
		`<span class="pkey-short">${key.slice(0, 8)}…${key.slice(-8)}</span>` +
		`<span class="pkey-full">${key}</span>` +
	`</span>`;
}

// Rows of the node info table, in display order. `render` returns HTML; values without it are shown as-is.
const COLUMNS = [
	{ key: 'adv_name', label: 'Name', render: escapeHtml },
	{ key: 'public_key', label: 'Public key', className: 'break-all', render: renderPublicKey },
	{ key: 'type', label: 'Type', render: val => NODE_TYPES[val] ?? 'Unknown' },
	{ key: 'status', label: 'Freshness', render: val => `<span class="status-dot update-${val}"></span>${UPDATE_STATUS_DESC[val]}` },
	{ key: 'link', label: 'Meshcore link', render: bytes => `<a href="#" data-copy="meshcore://${bytesToHex(bytes)}">Copy to clipboard</a>` },
	{ key: 'inserted_date', label: 'Inserted', render: renderTime },
	{ key: 'updated_date', label: 'Updated', render: renderTime },
	{ key: 'coords', label: 'Coordinates', render: renderCoords },
	{
		key: 'preset',
		label: 'Radio preset',
		render: params => presetsLoaded()
			? findPresets(params).map(p => escapeHtml(p.name)).join(', ') || 'Custom'
			: 'Loading…',
	},
	{
		key: 'params',
		label: 'Radio params',
		render: params => Object.entries(params)
			.filter(([key]) => RADIO_PARAM_DESC[key])
			.map(([key, val]) => {
				const { label, unit } = RADIO_PARAM_DESC[key];
				return escapeHtml(`${label}: ${val}${unit}`);
			})
			.join('<br>'),
	},
];

function renderInfoTable(node) {
	const rows = COLUMNS
		.filter(col => node[col.key])
		.map(col => {
			const value = col.render ? col.render(node[col.key]) : node[col.key];
			return `<tr><td><b>${col.label}</b></td><td class="${col.className ?? ''}">${value}</td></tr>`;
		});

	return `<table class="node-info"><tbody>${rows.join('')}</tbody></table>`;
}

function renderQRCode(node) {
	const url = new URL('meshcore://contact/add');
	url.searchParams.set('name', node.adv_name);
	url.searchParams.set('public_key', node.public_key);
	url.searchParams.set('type', node.type);

	const svgEl = QRCode.generateSVG(url.toString(), { modulesize: 4, margin: 2 });
	svgEl.setAttribute('class', 'node-qr');
	return svgEl.outerHTML;
}

// Makes it clear that the link adds to a request being collected, rather than starting a new email
function getDeletionLinkLabel(publicKey) {
	const count = deletionRequest.publicKeys.length;
	if(isDeletionRequested(publicKey)) return 'Deletion already requested';
	if(isInDeletionRequest(publicKey)) return `In deletion request (${count})`;
	if(count > 0) return `Add to deletion request (${count})`;
	return 'Request node deletion';
}

function renderProfileLink(node) {
	const label = getProfileLinkLabel(node.public_key);
	return label ? `<a href="#" data-profile="${escapeHtml(node.public_key)}">${label}</a>` : '';
}

export function getNodePopupHTML(node) {
	return `
		${renderQRCode(node)}
		${renderInfoTable(node)}
		<div class="user-actions">
			${node.type === REPEATER_TYPE ? `<a href="#" data-coverage="${escapeHtml(node.public_key)}">Show coverage</a>` : ''}
			${renderProfileLink(node)}
			<a href="#" data-deletion-request="${escapeHtml(node.public_key)}">${getDeletionLinkLabel(node.public_key)}</a>
		</div>
	`;
}

// Delegated handlers for links in HTML rendered outside Vue (popup copy links, coordinates menu, deletion requests)
export function installPopupHandlers(root = document) {
	root.addEventListener('click', ev => {
		const toggle = ev.target.closest('.coords-menu-toggle');
		const toggleWrap = toggle?.parentElement;

		for(const openWrap of root.querySelectorAll('.coords-menu-wrap.open')) {
			if(openWrap !== toggleWrap) openWrap.classList.remove('open');
		}

		if(toggle) {
			ev.preventDefault();
			toggleWrap.classList.toggle('open');
			return;
		}

		const publicKey = ev.target.closest('.pkey');
		if(publicKey) {
			publicKey.classList.add('expanded');
			return;
		}

		const copyLink = ev.target.closest('[data-copy]');
		if(copyLink) {
			ev.preventDefault();
			navigator.clipboard.writeText(copyLink.dataset.copy);
			return;
		}

		const coverageLink = ev.target.closest('[data-coverage]');
		if(coverageLink) {
			ev.preventDefault();
			requestCoverage(coverageLink.dataset.coverage);
			return;
		}

		const profileLink = ev.target.closest('[data-profile]');
		if(profileLink) {
			ev.preventDefault();
			addProfileEnd({ publicKey: profileLink.dataset.profile });
			return;
		}

		// popup links carry the node's key, the map footer link (href only) opens an empty request
		const deletionLink = ev.target.closest('[data-deletion-request], a[href="#deletion-request"]');
		if(deletionLink) {
			ev.preventDefault();
			openDeletionRequest(deletionLink.dataset.deletionRequest ?? '');
		}
	});
}
