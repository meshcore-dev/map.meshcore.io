import { highlightMatch } from './utils.js';

// Autocomplete list shared by the main search and the deletion request search.
// mousedown is prevented so picking a result doesn't blur (and close) the search input.
export const NodeSearchResults = {
	props: {
		results: { type: Array, required: true },
		query: { type: String, default: '' },
		// optional: marks results that are already selected
		isSelected: { type: Function, default: null },
	},
	emits: ['select'],
	setup() {
		return { highlightMatch };
	},
	template: `
		<article class="search-results no-margin no-padding" @mousedown.prevent>
			<ul class="list no-space border">
				<li v-for="node in results" :key="node.public_key" tabindex="0" @click="$emit('select', node)" @keyup.enter="$emit('select', node)">
					<img :src="'./img/node_types/' + node.type + '.svg'" width="32" alt="">
					<div class="max search-text">
						<h6 class="small" v-html="highlightMatch(node.adv_name, query)"></h6>
						<div class="search-pkey" v-html="highlightMatch(node.public_key, query)"></div>
					</div>
					<i v-if="isSelected && isSelected(node.public_key)" class="primary-text" title="Already added">check_circle</i>
				</li>
			</ul>
		</article>
	`,
};
