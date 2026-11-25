import { reactive } from '../lib/vue.esm-browser.prod.js';

// Point-to-point profile between two ends, each a node ({ publicKey }) or a picked point ({ lat, lon })

export const profile = reactive({
	a: null,
	b: null,
	// antenna heights above ground (m)
	heightA: 10,
	heightB: 10,
	loading: false,
	error: '',
});

// Sets the next free end (the start first); with both set, replaces the end
export function addProfileEnd(end) {
	if(!profile.a) profile.a = end;
	else profile.b = end;
	profile.error = '';
}

export function setProfileStart(end) {
	profile.a = end;
	profile.error = '';
}

export function swapProfileEnds() {
	[profile.a, profile.b] = [profile.b, profile.a];
	[profile.heightA, profile.heightB] = [profile.heightB, profile.heightA];
}

export function closeProfile() {
	profile.a = null;
	profile.b = null;
	profile.loading = false;
	profile.error = '';
}

// Popup link label for a node: start a profile, or end the one being picked
export function getProfileLinkLabel(publicKey) {
	if(profile.a?.publicKey === publicKey && !profile.b) return null;
	return profile.a ? 'Profile to here' : 'Profile from here';
}
