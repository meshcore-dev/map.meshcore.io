// Light/dark theme of the UI and the map: 'auto' follows the system setting.
// The early inline script in index.html applies the same stored value before the app loads.
const STORAGE_KEY = 'theme';

export const THEME_MODES = {
	auto: { icon: 'brightness_auto', label: 'Theme: automatic (system)' },
	light: { icon: 'light_mode', label: 'Theme: light' },
	dark: { icon: 'dark_mode', label: 'Theme: dark' },
};

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

function readMode() {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return THEME_MODES[stored] ? stored : 'auto';
	} catch {
		return 'auto';
	}
}

let mode = readMode();
let dark = computeDark();

function computeDark() {
	return mode === 'dark' || (mode === 'auto' && systemDark.matches);
}

function apply() {
	const next = computeDark();
	document.body.classList.toggle('dark', next);
	document.body.classList.toggle('light', !next);
	if(next === dark) return;
	dark = next;
	for(const listener of listeners) listener(dark);
}

systemDark.addEventListener('change', apply);
apply();

export function getThemeMode() {
	return mode;
}

export function setThemeMode(next) {
	mode = next;
	try { localStorage.setItem(STORAGE_KEY, next); } catch {}
	apply();
}

// auto -> light -> dark -> auto
export function cycleThemeMode() {
	const modes = Object.keys(THEME_MODES);
	setThemeMode(modes[(modes.indexOf(mode) + 1) % modes.length]);
	return mode;
}

export function isDarkTheme() {
	return dark;
}

export function onThemeChange(listener) {
	listeners.add(listener);
}
