import type { FieldType, IDataObject, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';

/**
 * Turning "what does this template need?" into n8n form fields.
 *
 * Every competing product joins the data payload to the template by invisible
 * string matching, and none of them will tell you the names before you render.
 * DocMint's `GET /v1/templates/:name/fields` and `POST /v1/inspect` both answer
 * the question, so this file is where that answer becomes real, typed,
 * expression-capable inputs instead of a JSON textarea.
 *
 * Everything here is a pure function of the API response, so it can be tested
 * against a recorded response without a network or an n8n runtime.
 */

/** The `tags` entries the API returns, straight from the renderer's `inspect`. */
export interface InspectTag {
	/** The tag body as written, formatters included: `price|currency:EUR`. */
	expr: string;
	/** `value`, `section`, `inverted`, `image`, `raw`, `close` or `comment`. */
	kind: string;
	/** Human-usable position: `Sheet1!C7`, `word/document.xml, paragraph 12`. */
	location?: string;
}

/** The body of `GET /v1/templates/:name/fields` and of `POST /v1/inspect`. */
export interface InspectResponse {
	format?: string;
	name?: string;
	version?: number;
	/** Distinct data paths the template needs. */
	fields?: string[];
	tags?: InspectTag[];
}

/**
 * Formatters that only make sense applied to a number, so a placeholder wearing
 * one is a number field. Read off `src/template/formatters.js`; a formatter that
 * is not in this list simply leaves the field a string, which is never wrong.
 */
const NUMBER_FORMATTERS = new Set([
	'number',
	'currency',
	'percent',
	'round',
	'ordinal',
	'multiply',
	'add',
	'subtract',
	'divide',
]);

/** Formatters that consume a list, so the placeholder holds an array. */
const ARRAY_FORMATTERS = new Set([
	'join',
	'sum',
	'sumProduct',
	'count',
	'filter',
	'reject',
	'sort',
	'reverse',
	'limit',
	'skip',
	'unique',
	'groupBy',
]);

const DATE_FORMATTERS = new Set(['date']);
const BOOLEAN_FORMATTERS = new Set(['yesno']);

/** `price | currency:EUR` -> `price`, and `../currency` keeps its `../`. */
function rawPathOf(expr: string): string {
	return String(expr ?? '').split('|')[0].trim();
}

/** The path as the API reports it in `fields`: relative prefixes removed. */
export function pathOf(expr: string): string {
	return rawPathOf(expr).replace(/^(\.\.\/)+/, '');
}

interface Formatter {
	name: string;
	args: string[];
}

/** `price|currency:EUR|default:-` -> [{currency, [EUR]}, {default, [-]}] */
function formattersOf(expr: string): Formatter[] {
	return String(expr ?? '')
		.split('|')
		.slice(1)
		.map((segment) => {
			const colon = segment.indexOf(':');
			const name = (colon === -1 ? segment : segment.slice(0, colon)).trim();
			const args = colon === -1 ? [] : segment.slice(colon + 1).split(':').map((a) => a.trim());
			return { name, args };
		})
		.filter((formatter) => formatter.name !== '');
}

const formatterNames = (expr: string) => formattersOf(expr).map((formatter) => formatter.name);

/**
 * Formatters whose arguments name a field of each row, and how many of their
 * arguments do so. `{items|sumProduct:qty:price}` is a statement that every item
 * has `qty` and `price` — a fact about the shape of the list, available in every
 * format regardless of whether the response carried close tags.
 */
const ROW_FIELD_FORMATTERS: Record<string, number> = {
	sum: 1,
	sumProduct: 2,
	filter: 1,
	reject: 1,
	sort: 1,
	unique: 1,
	groupBy: 1,
};

/** A plain field name, as opposed to `10`, `desc` in `sort:total:desc`, or ''. */
const looksLikeFieldName = (value: string) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);

/** Section path -> the row fields its formatters prove each row has. */
export function rowKeysFromFormatters(tags: InspectTag[]): Map<string, string[]> {
	const rows = new Map<string, string[]>();
	for (const tag of tags) {
		const path = pathOf(tag.expr);
		if (!isDataPath(path)) continue;
		for (const formatter of formattersOf(tag.expr)) {
			const take = ROW_FIELD_FORMATTERS[formatter.name];
			if (!take) continue;
			for (const arg of formatter.args.slice(0, take)) {
				if (!looksLikeFieldName(arg)) continue;
				const known = rows.get(path) ?? [];
				if (!known.includes(arg)) known.push(arg);
				rows.set(path, known);
			}
		}
	}
	return rows;
}

/** Loop metadata and `{.}` are not data the caller supplies. */
function isDataPath(path: string): boolean {
	return path !== '' && path !== '.' && !path.startsWith('$');
}

interface Scoping {
	/** Section path -> the leaf placeholders written inside it, in source order. */
	rows: Map<string, string[]>;
	/** Leaf placeholders that live inside a section, so not root data. */
	inner: Set<string>;
	/** False when the response carried no close tags, so nesting is unknowable. */
	known: boolean;
}

/**
 * Works out which placeholders sit inside a `{#section}` and therefore belong to
 * a row rather than to the root of the data.
 *
 * This is only possible when the response includes the `close` tags. The DOCX and
 * PPTX renderers emit them; the XLSX one filters them out before returning. When
 * they are absent the honest answer is "unknown", and every placeholder is
 * offered at the root — which is what the caller would have had to guess anyway.
 */
export function scopeOf(tags: InspectTag[]): Scoping {
	const rows = new Map<string, string[]>();
	const inner = new Set<string>();
	const known = tags.some((tag) => tag.kind === 'close');
	if (!known) {
		for (const tag of tags) {
			if (tag.kind === 'section' || tag.kind === 'inverted') {
				const path = pathOf(tag.expr);
				if (isDataPath(path) && !rows.has(path)) rows.set(path, []);
			}
		}
		return { rows, inner, known };
	}

	const stack: string[] = [];
	for (const tag of tags) {
		if (tag.kind === 'comment') continue;
		if (tag.kind === 'close') {
			stack.pop();
			continue;
		}
		const raw = rawPathOf(tag.expr);
		const path = pathOf(raw);
		// `{../currency}` reaches out of the loop on purpose, so it is root data
		// even though it is written inside one.
		const escapesScope = raw.startsWith('../');
		const insideSection = stack.length > 0 && !escapesScope;

		if (tag.kind === 'section' || tag.kind === 'inverted') {
			if (isDataPath(path)) {
				if (insideSection) {
					inner.add(path);
					rows.get(stack[0])?.push(path);
				} else if (!rows.has(path)) {
					rows.set(path, []);
				}
			}
			stack.push(path);
			continue;
		}

		if (!isDataPath(path) || !insideSection) continue;
		inner.add(path);
		const outermost = rows.get(stack[0]);
		if (outermost && !outermost.includes(path)) outermost.push(path);
	}

	return { rows, inner, known };
}

/**
 * The n8n input widget a placeholder deserves, derived from what the template
 * does with it: a section is a list, `{total|currency:EUR}` is a number,
 * `{due|date:YYYY-MM-DD}` is a date. Anything we cannot tell stays a string,
 * because a wrong type is worse than a plain one.
 */
export function fieldTypeOf(path: string, tags: InspectTag[]): FieldType {
	let type: FieldType = 'string';
	for (const tag of tags) {
		if (pathOf(tag.expr) !== path) continue;
		if (tag.kind === 'section' || tag.kind === 'inverted') return 'array';
		const formatters = formatterNames(tag.expr);
		if (formatters.some((name) => ARRAY_FORMATTERS.has(name))) return 'array';
		if (formatters.some((name) => DATE_FORMATTERS.has(name))) type = 'dateTime';
		else if (formatters.some((name) => BOOLEAN_FORMATTERS.has(name))) type = 'boolean';
		else if (formatters.some((name) => NUMBER_FORMATTERS.has(name))) type = 'number';
	}
	return type;
}

/**
 * The whole point of the node. Turns the API's answer into the schema n8n uses
 * to draw one input per placeholder.
 */
export function toResourceMapperFields(body: InspectResponse): ResourceMapperFields {
	const tags = Array.isArray(body?.tags) ? body.tags : [];
	const names = Array.isArray(body?.fields) ? body.fields : [];
	const scope = scopeOf(tags);
	// The DOCX and XLSX renderers leave the close tags out of `inspect`, so the
	// nesting cannot always be reconstructed. What CAN be read in every format is
	// the formatter pipeline: `{items|sumProduct:qty:price}` names two fields of
	// every row, whether or not the loop's boundaries are visible.
	const formatterRows = rowKeysFromFormatters(tags);

	const seen = new Set<string>();
	const fields: ResourceMapperField[] = [];

	for (const raw of names) {
		const path = pathOf(String(raw));
		if (!isDataPath(path) || seen.has(path)) continue;
		// A placeholder written inside a `{#section}` is a property of a row, not
		// of the data root. Offering it at the root is how a workflow ends up
		// printing the same value on every line of an invoice.
		if (scope.known && scope.inner.has(path)) continue;
		seen.add(path);

		const type = fieldTypeOf(path, tags);
		const rowKeys = [...(scope.rows.get(path) ?? [])];
		for (const key of formatterRows.get(path) ?? []) {
			if (!rowKeys.includes(key)) rowKeys.push(key);
		}
		fields.push({
			id: path,
			// The label is the placeholder exactly as it is written in the
			// document, because that is the string the user has to match. For a
			// section, the row keys go in the label as well: it is the one place
			// the user can see what each row of the list has to contain.
			displayName: rowKeys.length ? `${path} (rows: ${rowKeys.join(', ')})` : path,
			// The mapper runs in 'add' mode, so nothing is ever matched on.
			defaultMatch: false,
			canBeUsedToMatch: false,
			// Not marked required: `{x|default:-}` in the template and Options ->
			// On Missing both make an empty value legitimate, and n8n blocks a run
			// on an empty required field. DocMint refuses by name at render time
			// instead, which is the guarantee that actually holds.
			required: false,
			display: true,
			type,
		});
	}

	const result: ResourceMapperFields = { fields };
	if (fields.length === 0) {
		result.emptyFieldsNotice =
			body?.format === undefined
				? 'DocMint could not read any placeholders. Pick a template first, or use Send Raw JSON Instead.'
				: `This ${body.format.toUpperCase()} template contains no placeholders, so there is nothing to fill in. Add tags such as {customer} or {{customer}} to the document and upload it again.`;
	}
	return result;
}

/* ------------------------------------------------------- runtime conversion */

/** True for `0`, `12` — a segment that indexes a list rather than names a key. */
const isIndex = (segment: string) => /^\d+$/.test(segment);

/** `a.b[0].c` -> ['a', 'b', '0', 'c'], matching the API's own `splitPath`. */
export function splitPath(path: string): string[] {
	const segments: string[] = [];
	let current = '';
	let depth = 0;
	for (const char of path) {
		if (char === '[') {
			depth += 1;
			if (depth === 1 && current !== '') {
				segments.push(current);
				current = '';
			}
			current += char;
			continue;
		}
		if (char === ']') {
			depth -= 1;
			current += char;
			if (depth === 0) {
				segments.push(current);
				current = '';
			}
			continue;
		}
		if (char === '.' && depth === 0) {
			if (current !== '') segments.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current !== '') segments.push(current);
	return segments.map((segment) =>
		segment.startsWith('[') && segment.endsWith(']') ? segment.slice(1, -1) : segment,
	);
}

/**
 * The resource mapper hands back a flat object keyed by placeholder path, so
 * `{customer.name}` arrives as the key `"customer.name"`. The API resolves
 * dotted paths against nested data, so the node has to rebuild the nesting —
 * otherwise a template that works from curl fails from n8n, which would be the
 * node's fault and impossible for the user to diagnose.
 */
export function expandPaths(flat: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(flat ?? {})) {
		const segments = splitPath(key);
		if (segments.length === 0) continue;
		if (segments.length === 1) {
			out[segments[0]] = value as never;
			continue;
		}
		let cursor: IDataObject | unknown[] = out;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			const wantsList = isIndex(segments[i + 1]);
			const container = cursor as Record<string, unknown>;
			const existing = container[segment];
			if (existing === undefined || existing === null || typeof existing !== 'object') {
				container[segment] = wantsList ? [] : {};
			}
			cursor = container[segment] as IDataObject | unknown[];
		}
		(cursor as Record<string, unknown>)[segments[segments.length - 1]] = value;
	}
	return out;
}

/**
 * n8n keeps `array` and `object` mapper values as text, because the widget is a
 * JSON editor. Parsing them here is what lets `{#items}` be filled from an
 * expression that yields a real list.
 */
export function coerceMapperValues(
	value: IDataObject,
	schema: ResourceMapperField[] = [],
): IDataObject {
	const types = new Map(schema.map((field) => [field.id, field.type]));
	const out: IDataObject = {};
	for (const [key, raw] of Object.entries(value ?? {})) {
		const type = types.get(key);
		if ((type === 'array' || type === 'object') && typeof raw === 'string') {
			const text = raw.trim();
			if (text === '') continue;
			try {
				out[key] = JSON.parse(text) as never;
				continue;
			} catch {
				// Leave it as text; the API's error names the field either way, and
				// silently dropping what the user typed would be worse.
			}
		}
		out[key] = raw as never;
	}
	return out;
}

/** Mapper value -> the `data` object the API is sent. */
export function dataFromMapper(value: IDataObject, schema: ResourceMapperField[] = []): IDataObject {
	return expandPaths(coerceMapperValues(value, schema));
}
