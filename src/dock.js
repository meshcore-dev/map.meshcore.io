import { computed, reactive, watch } from '../lib/vue.esm-browser.prod.js';

// The dock for the coverage and profile panels: a side of the screen (left, right or bottom) the map
// gives up while a panel is open, like Chrome's developer tools. Its side and sizes are remembered.
// On narrow screens there's no room beside the map: the dock is at the bottom there.
// The dock collapses to its bar (a click on its title): the map takes the whole screen but the stats
// bar, which stays beside the dock's bar.

const STORAGE_KEY = 'dock';
// screens narrower than this get the dock at the bottom
const NARROW_WIDTH = 700;
// default and smallest sizes (px), the largest as a share of the screen
const DEFAULT_SIZES = { left: 420, right: 420, bottom: 320 };
const MIN_SIZES = { left: 300, right: 300, bottom: 140 };
const MAX_SHARE = { left: 0.6, right: 0.6, bottom: 0.75 };
// height of the collapsed bottom dock: its bar (as tall as the stats bar)
const BAR_HEIGHT = 30;

export const DOCK_SIDES = [
	{ value: 'left', icon: 'dock_to_left', title: 'Dock to the left' },
	{ value: 'bottom', icon: 'dock_to_bottom', title: 'Dock to the bottom' },
	{ value: 'right', icon: 'dock_to_right', title: 'Dock to the right' },
];

function readStored() {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
		if(DOCK_SIDES.some(side => side.value === stored?.side)) {
			return { side: stored.side, sizes: { ...DEFAULT_SIZES, ...stored.sizes } };
		}
	} catch {}
	return { side: 'right', sizes: { ...DEFAULT_SIZES } };
}

// isOpen: getter, whether a panel is shown. Returns the state and handlers for the template.
export function useDock(isOpen) {
	const stored = readStored();
	const dock = reactive({
		side: stored.side,
		sizes: stored.sizes,
		narrow: innerWidth < NARROW_WIDTH,
		resizing: false,
		collapsed: false,
	});
	addEventListener('resize', () => { dock.narrow = innerWidth < NARROW_WIDTH; });

	// the side in use (the chosen one, or the bottom on narrow screens)
	const dockSide = computed(() => dock.narrow ? 'bottom' : dock.side);
	const dockSides = computed(() => dock.narrow ? [] : DOCK_SIDES);

	function save() {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ side: dock.side, sizes: dock.sizes })); } catch {}
	}
	function clampSize(side, size) {
		const screen = side === 'bottom' ? innerHeight : innerWidth;
		return Math.round(Math.max(MIN_SIZES[side], Math.min(size, screen * MAX_SHARE[side])));
	}
	function setDockSide(side) {
		dock.side = side;
		save();
	}

	function toggleDockCollapsed() {
		dock.collapsed = !dock.collapsed;
	}
	// closed: open again expanded
	watch(() => isOpen(), open => { if(!open) dock.collapsed = false; });

	// the space the dock takes (CSS): --dock-left/right/bottom for the map and the controls over it,
	// --dock-bar-left/right for the stats bar (beside the dock's bar, also when it's collapsed)
	watch([() => isOpen(), dockSide, () => dock.sizes[dockSide.value], () => dock.narrow, () => dock.collapsed], ([open, side, size, , collapsed]) => {
		const style = document.body.style;
		const px = value => `${value}px`;
		for(const name of ['left', 'right', 'bottom']) {
			const here = open && name === side;
			const full = here && clampSize(side, size);
			const map = !here ? null : name === 'bottom' && collapsed ? BAR_HEIGHT : collapsed ? null : full;
			if(map === null) style.removeProperty(`--dock-${name}`);
			else style.setProperty(`--dock-${name}`, px(map));
			if(name !== 'bottom') {
				if(here) style.setProperty(`--dock-bar-${name}`, px(full));
				else style.removeProperty(`--dock-bar-${name}`);
			}
		}
		document.body.classList.toggle('docked', open);
	}, { immediate: true });

	// dragging the inner edge resizes the dock (and the map with it)
	function startDockResize(ev) {
		if(ev.button !== 0) return;
		ev.preventDefault();
		const side = dockSide.value;
		const handle = ev.currentTarget;
		handle.setPointerCapture(ev.pointerId);
		dock.resizing = true;
		const sizeAt = e => side === 'left' ? e.clientX : side === 'right' ? innerWidth - e.clientX : innerHeight - e.clientY;
		const offset = clampSize(side, dock.sizes[side]) - sizeAt(ev);
		const move = e => { dock.sizes[side] = clampSize(side, sizeAt(e) + offset); };
		const end = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
			dock.resizing = false;
			save();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	return { dock, dockSide, dockSides, setDockSide, startDockResize, toggleDockCollapsed };
}
