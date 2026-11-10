import { reactive } from '../lib/vue.esm-browser.prod.js';
import { DELETION_EMAIL, DELETION_MAX_NODES, DELETION_REQUESTED_REMEMBER_DAYS, DELETION_SUBJECT } from './config.js';
import { daysAgo } from './utils.js';

// Remembered keys of nodes whose deletion was already requested: { publicKey: timestamp }
const REQUESTED_STORAGE_KEY = 'deletionRequestedKeys';

function loadRequestedKeys() {
	try {
		const stored = JSON.parse(localStorage.getItem(REQUESTED_STORAGE_KEY)) ?? {};
		const since = daysAgo(DELETION_REQUESTED_REMEMBER_DAYS);
		return Object.fromEntries(Object.entries(stored).filter(([, time]) => time > since));
	}
	catch {
		return {};
	}
}

function saveRequestedKeys() {
	try {
		localStorage.setItem(REQUESTED_STORAGE_KEY, JSON.stringify(deletionRequest.requestedKeys));
	}
	catch {}
}

export const deletionRequest = reactive({
	open: false,
	// 'collect': build the node list, 'send': pick how to send the email, 'sent': confirmation
	step: 'collect',
	// asked once before sending a request for a single node
	confirmingSingle: false,
	showManual: false,
	// "pick on map" mode: the dialog is hidden and clicked markers are added to / removed from the request
	pickingOnMap: false,
	publicKeys: [],
	// keys of the last sent request, so "I didn't send it" can bring them back
	sentKeys: [],
	requestedKeys: loadRequestedKeys(),
	body: '',
});

export function buildDeletionBody(publicKeys = []) {
	return [
		'Please delete my node(s) from MeshCore Map database',
		'MeshCore link(s) or Public key(s):',
		'',
		...publicKeys,
	].join('\n');
}

export function isInDeletionRequest(publicKey) {
	return deletionRequest.publicKeys.includes(publicKey);
}

export function isDeletionRequested(publicKey) {
	return publicKey in deletionRequest.requestedKeys;
}

// keys that actually go into the email - already requested nodes are left out
export function getPendingKeys() {
	return deletionRequest.publicKeys.filter(key => !isDeletionRequested(key));
}

// admins can lift the limit via localStorage (any non-empty value)
export const deletionMaxNodes = localStorage.getItem('userDeleteLimitOverride') ? Infinity : DELETION_MAX_NODES;

export function isDeletionRequestFull() {
	return deletionRequest.publicKeys.length >= deletionMaxNodes;
}

export function addToDeletionRequest(publicKey) {
	if(publicKey && !isInDeletionRequest(publicKey) && !isDeletionRequestFull()) {
		deletionRequest.publicKeys.push(publicKey);
	}
}

export function removeFromDeletionRequest(publicKey) {
	const index = deletionRequest.publicKeys.indexOf(publicKey);
	if(index >= 0) deletionRequest.publicKeys.splice(index, 1);
}

export function toggleInDeletionRequest(publicKey) {
	if(isInDeletionRequest(publicKey)) {
		removeFromDeletionRequest(publicKey);
	} else {
		addToDeletionRequest(publicKey);
	}
}

// Nodes already in the request are kept, so several nodes can be collected (e.g. from multiple popups)
// and sent in one email. The dialog always opens on the collect step, to encourage adding them all.
export function openDeletionRequest(publicKey = '') {
	addToDeletionRequest(publicKey.toLowerCase());
	deletionRequest.body = buildDeletionBody(getPendingKeys());
	deletionRequest.step = 'collect';
	deletionRequest.confirmingSingle = false;
	deletionRequest.showManual = false;
	deletionRequest.pickingOnMap = false;
	deletionRequest.open = true;
}

// The email was handed over to a mail app / webmail (or the user says they sent it manually):
// remember the keys and start the next request with an empty list
export function markDeletionRequestSent() {
	const keys = getPendingKeys();
	const now = Date.now();
	for(const key of keys) deletionRequest.requestedKeys[key] = now;
	saveRequestedKeys();

	deletionRequest.sentKeys = keys;
	deletionRequest.publicKeys = [];
	deletionRequest.step = 'sent';
}

// "I didn't send it" - restore the list and forget the keys again
export function undoDeletionRequestSent() {
	for(const key of deletionRequest.sentKeys) delete deletionRequest.requestedKeys[key];
	saveRequestedKeys();

	deletionRequest.publicKeys = deletionRequest.sentKeys;
	deletionRequest.sentKeys = [];
	deletionRequest.step = 'send';
}

// Optional admin link configured via localStorage (userActionUrl / userActionLabel), gets all selected keys
export function getUserAction(publicKeys) {
	const url = localStorage.getItem('userActionUrl');
	if(!url) return null;

	return {
		label: localStorage.getItem('userActionLabel') || 'User action',
		href: `https://${encodeURI(url)}?nodes=${encodeURIComponent(publicKeys.join('\n'))}`,
	};
}

// mailto: needs %20 instead of + in params (some mail clients show the pluses literally) and %2B for
// the + in the address (some clients decode a literal + as a space, which would lose the +tag)
function mailtoUrl(body) {
	const params = new URLSearchParams({ subject: DELETION_SUBJECT, body });
	return `mailto:${DELETION_EMAIL.replaceAll('+', '%2B')}?${params.toString().replaceAll('+', '%20')}`;
}

// mailto: opens a blank page when no mail app is registered, so webmail links are offered as well
export function getComposeLinks(body) {
	const to = encodeURIComponent(DELETION_EMAIL);
	const subject = encodeURIComponent(DELETION_SUBJECT);
	const encodedBody = encodeURIComponent(body);
	const mailto = mailtoUrl(body);

	return [
		// no target on mailto: - a new tab stays blank when the mail app takes over (or when there is none)
		{ label: 'Email app', icon: 'mail', href: mailto },
		{ label: 'Gmail', icon: 'open_in_new', href: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${encodedBody}`, target: '_blank' },
		{ label: 'Outlook', icon: 'open_in_new', href: `https://outlook.live.com/mail/0/deeplink/compose?to=${to}&subject=${subject}&body=${encodedBody}`, target: '_blank' },
		// Proton's web app takes a whole mailto: link in the hash (the handler it registers for mailto:)
		{ label: 'Proton Mail', icon: 'open_in_new', href: `https://mail.proton.me/inbox/#mailto=${encodeURIComponent(mailto)}`, target: '_blank' },
	];
}
