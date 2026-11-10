function fnv1aHash(str) {
	let hash = 0x811c9dc5n;
	for (let i = 0; i < str.length; i++) {
		hash = BigInt.asIntN(32, hash ^ BigInt(str.charCodeAt(i)));
		hash = BigInt.asIntN(32, hash * 0x01000193n);
	}

	return Number(hash & 0xFFFFFFFFn);
}

export function getColourForName(name, saturation = 60, lightness = 50) {
	const hash = fnv1aHash(name);

	return `hsl(${hash % 360}deg, ${saturation}%, ${lightness}%)`;
}

const graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;

// User-perceived characters - an emoji can be several code points (variation selector, ZWJ sequence, flag)
function splitGraphemes(str) {
	return graphemeSegmenter
		? Array.from(graphemeSegmenter.segment(str), s => s.segment)
		: Array.from(str);
}

// A grapheme counts as emoji when it is:
// - shown as emoji by default (Emoji_Presentation), or
// - requested as emoji with the VS16 selector (e.g. U+2764 U+FE0F), or
// - a pictograph from the emoji planes (U+1F000+) - browsers draw those as emoji even without VS16
//   (e.g. a bare U+1F5FA world map); common BMP symbols like U+2665 or U+00A9 stay text unless VS16 follows
const EMOJI_GRAPHEME = /\p{Emoji_Presentation}|\uFE0F|(?=\p{Extended_Pictographic})[\u{1F000}-\u{1FFFF}]/u;

export function getNameIconLabel(name) {
	if (typeof name !== 'string') {
		return '';
	}

	const emoji = splitGraphemes(name).find(char => EMOJI_GRAPHEME.test(char));
	if (emoji) {
		return emoji;
	}

	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return '';
	}

	const first = splitGraphemes(words[0])[0];
	if (words.length === 1) {
		return first;
	}
	return first + splitGraphemes(words.at(-1))[0];
}
