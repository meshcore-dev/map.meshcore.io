import { nextTick, ref, watch } from '../lib/vue.esm-browser.prod.js';
import { highlightMatch } from './utils.js';
import { formatCoordinates } from './places.js';

// Autocomplete list shared by the main search and the deletion request search. The main search also
// lists a typed point (lat, lon) first and places (towns, streets, peaks, ...) after the nodes.
// mousedown is prevented so picking a result doesn't blur (and close) the search input.
// The search input moves through the results with the arrow keys (move) and picks the highlighted
// one with Enter (pick): the focus stays in the input.
export const NodeSearchResults = {
	props: {
		results: { type: Array, required: true },
		query: { type: String, default: '' },
		// optional: marks results that are already selected
		isSelected: { type: Function, default: null },
		// optional: coordinates read from the query ({ lat, lon })
		point: { type: Object, default: null },
		// optional: places found for the query
		places: { type: Array, default: () => [] },
	},
	emits: ['select', 'select-point', 'select-place'],
	setup(props, { emit }) {
		const list = ref(null);
		// highlighted result: index into items() (point, nodes, places), -1 for none
		const active = ref(-1);
		function items() {
			return [
				...(props.point ? [['select-point', props.point]] : []),
				...props.results.map(node => ['select', node]),
				...props.places.map(place => ['select-place', place]),
			];
		}
		// a new query: nothing highlighted (places come in later, after the nodes: that keeps it)
		watch(() => props.query, () => { active.value = -1; });

		// down (1) / up (-1), through "none" (the input) at both ends
		function move(step) {
			const count = items().length;
			if(!count) return;
			active.value = (active.value + 1 + step + count + 1) % (count + 1) - 1;
			nextTick(() => list.value?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' }));
		}
		// picks the highlighted result; false when none is
		function pick() {
			const item = items()[active.value];
			if(!item) return false;
			emit(...item);
			return true;
		}
		const pointOffset = () => props.point ? 1 : 0;
		return { highlightMatch, formatCoordinates, list, active, move, pick, pointOffset };
	},
	template: `
		<article class="search-results no-margin no-padding" @mousedown.prevent>
			<ul ref="list" class="list no-space border">
				<li v-if="point" :class="['search-point', { active: active === 0 }]" tabindex="0" @mousemove="active = 0" @click="$emit('select-point', point)" @keyup.enter="$emit('select-point', point)">
					<i class="search-icon">my_location</i>
					<div class="max search-text">
						<h6 class="small">{{ formatCoordinates(point) }}</h6>
						<div class="search-detail">Go to this point<span class="search-key"> (Enter)</span></div>
					</div>
				</li>
				<li v-for="(node, i) in results" :key="node.public_key" :class="{ active: active === pointOffset() + i }" tabindex="0" @mousemove="active = pointOffset() + i" @click="$emit('select', node)" @keyup.enter="$emit('select', node)">
					<img :src="'./img/node_types/' + node.type + '.svg'" width="32" alt="">
					<div class="max search-text">
						<h6 class="small" v-html="highlightMatch(node.adv_name, query)"></h6>
						<div class="search-pkey" v-html="highlightMatch(node.public_key, query)"></div>
					</div>
					<i v-if="isSelected && isSelected(node.public_key)" class="primary-text" title="Already added">check_circle</i>
				</li>
				<li v-for="(place, i) in places" :key="place.id" :class="{ active: active === pointOffset() + results.length + i }" tabindex="0" @mousemove="active = pointOffset() + results.length + i" @click="$emit('select-place', place)" @keyup.enter="$emit('select-place', place)">
					<i class="search-icon">{{ place.icon }}</i>
					<div class="max search-text">
						<h6 class="small">{{ place.name }}</h6>
						<div class="search-detail">{{ place.kind }}<template v-if="place.area"> · {{ place.area }}</template></div>
					</div>
				</li>
				<li v-if="places.length" class="search-credit">
					<span>Places: <a href="https://photon.komoot.io" target="_blank">Photon</a>, © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors</span>
				</li>
			</ul>
		</article>
	`,
};
