import type { FieldType, IDataObject, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';

/**
 * Turning "what does this template need?" into n8n form fields.
 *
 * Every competing product joins the data payload to the template by invisible
 * string matching, and none of them will tell you the names before you render.
 * DocMint's `GET /v1/templates/:name/fields` and `POST /v1/inspect` both answer
 * the question with a typed, scoped tree, so this file is where that answer
 * becomes real, typed, expression-capable inputs instead of a JSON textarea.
 *
 * Nothing here guesses. Types, nesting and optionality are read straight off the
 * API, which derives them by actually running the renderer — so they cannot
 * drift from what a real render would do. The one exception is `legacyFields`
 * at the bottom, which exists only for DocMint instances older than the typed
 * tree and is clearly fenced off.
 *
 * Everything is a pure function of the API response, so it can be tested against
 * a recorded response without a network or an n8n runtime.
 */

/** The `tags` entries the API returns: what is literally written in the file. */
export interface InspectTag {
	/** The tag body as written, formatters included: `price|currency:EUR`. */
	expr: string;
	/** `value`, `section`, `inverted`, `image`, `raw`, `close` or `comment`. */
	kind: string;
	/** Human-usable position: `Sheet1!C7`, `word/document.xml, paragraph 12`. */
	location?: string;
}

/** One entry of the typed, scoped field tree. */
export interface ApiField {
	/** The placeholder name, relative to its scope. */
	name: string;
	/** '' for a root field, otherwise the name of the section it lives inside. */
	scope: string;
	/** `string`, `number`, `boolean`, `date`, `array` or `image`. */
	type: string;
	/** True when the section is a real list rather than a flag. */
	repeating: boolean;
	/** False when the tag carries `|default:`. */
	required: boolean;
	formatters?: string[];
	used?: number;
	locations?: string[];
}

/** The body of `GET /v1/templates/:name/fields` and of `POST /v1/inspect`. */
export interface InspectResponse {
	format?: string;
	name?: string;
	version?: number;
	/** The typed tree. Older DocMint instances send a flat list of names here. */
	fields?: Array<ApiField | string>;
	/** The flat list of names the renderer found, kept alongside the tree. */
	names?: string[];
	tags?: InspectTag[];
	/** A skeleton payload the API built by rendering the template. */
	sample_data?: IDataObject;
}

/**
 * The API's vocabulary mapped onto n8n's. `date` becomes n8n's `dateTime` so the
 * operator gets a date picker; `image` stays text because the value is a URL or
 * base64, and n8n's `binary` field type means something else entirely.
 */
const FIELD_TYPES: Record<string, FieldType> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	date: 'dateTime',
	array: 'array',
	object: 'object',
	image: 'string',
};

const typeOf = (field: ApiField): FieldType => FIELD_TYPES[String(field.type)] ?? 'string';

const isApiField = (value: unknown): value is ApiField =>
	typeof value === 'object' && value !== null && typeof (value as ApiField).name === 'string';

/** Loop metadata and `{.}` are not data the caller supplies. */
function isDataPath(name: string): boolean {
	return name !== '' && name !== '.' && !name.startsWith('$');
}

/**
 * What one row of a list has to contain, for the field's label.
 *
 * A child that is itself a list is marked `lines[]`, so three-level nesting is
 * visible without the label turning into a tree drawing. The exact shape, to any
 * depth, is what the Inspect operation's `sample_data` is for.
 */
function rowKeys(section: string, fields: ApiField[]): string[] {
	return fields
		.filter((field) => field.scope === section && isDataPath(field.name))
		.map((field) => (field.repeating ? `${field.name}[]` : field.name));
}

/**
 * The whole point of the node. Turns the API's answer into the schema n8n uses
 * to draw one input per placeholder.
 */
export function toResourceMapperFields(body: InspectResponse): ResourceMapperFields {
	const raw = Array.isArray(body?.fields) ? body.fields : [];

	// A DocMint older than the typed tree answers with a flat list of names.
	if (raw.length && !raw.some(isApiField)) {
		return legacyFields(raw as string[], body);
	}

	const fields = raw.filter(isApiField);
	const seen = new Set<string>();
	const mapped: ResourceMapperField[] = [];

	for (const field of fields) {
		// Only root fields go on the form. A placeholder written inside a
		// `{#section}` is a property of a row, and offering it at the root is how
		// a workflow ends up printing the same value on every line of an invoice.
		if (field.scope !== '' || !isDataPath(field.name) || seen.has(field.name)) continue;
		seen.add(field.name);

		const keys = field.repeating ? rowKeys(field.name, fields) : [];
		mapped.push({
			id: field.name,
			// The label is the placeholder exactly as it is written in the
			// document, because that is the string the user has to match. For a
			// list, the row keys go in the label as well: it is the one place the
			// user can see what each row has to contain.
			displayName: keys.length ? `${field.name} (rows: ${keys.join(', ')})` : field.name,
			// The mapper runs in 'add' mode, so nothing is ever matched on.
			defaultMatch: false,
			canBeUsedToMatch: false,
			// Not marked required even when the API says the placeholder must
			// resolve: n8n blocks a run on an empty required field, while Options
			// -> On Missing legitimately allows an empty one. DocMint refuses by
			// name at render time instead, which is the guarantee that holds.
			required: false,
			display: true,
			type: typeOf(field),
		});
	}

	const result: ResourceMapperFields = { fields: mapped };
	if (mapped.length === 0) {
		result.emptyFieldsNotice =
			body?.format === undefined
				? 'DocMint could not read any placeholders. Pick a template first, or use Send Raw JSON Instead.'
				: `This ${body.format.toUpperCase()} template contains no placeholders, so there is nothing to fill in. Add tags such as {customer} or {{customer}} to the document and upload it again.`;
	}
	return result;
}

/**
 * Compatibility with a DocMint older than the typed field tree, which answered
 * with `fields: string[]` and nothing else. There is no type, no nesting and no
 * optionality to read, so every name is offered as text at the root. Nothing is
 * inferred: a guessed type that is wrong is worse than a plain one.
 */
function legacyFields(names: string[], body: InspectResponse): ResourceMapperFields {
	const seen = new Set<string>();
	const fields: ResourceMapperField[] = [];
	for (const raw of names) {
		const name = String(raw).split('|')[0].trim().replace(/^(\.\.\/)+/, '');
		if (!isDataPath(name) || seen.has(name)) continue;
		seen.add(name);
		fields.push({
			id: name,
			displayName: name,
			defaultMatch: false,
			canBeUsedToMatch: false,
			required: false,
			display: true,
			type: 'string',
		});
	}
	const result: ResourceMapperFields = { fields };
	if (fields.length === 0) {
		result.emptyFieldsNotice = body?.format
			? `This ${body.format.toUpperCase()} template contains no placeholders, so there is nothing to fill in.`
			: 'DocMint could not read any placeholders. Pick a template first, or use Send Raw JSON Instead.';
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
