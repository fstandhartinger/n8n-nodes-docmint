import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeParameterResourceLocator,
	JsonObject,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { CREDENTIAL_NAME, DEFAULT_BASE_URL } from './constants';
import type { InspectResponse } from './fields';
import { toResourceMapperFields } from './fields';

export interface DocMintResponse {
	body: Buffer | IDataObject;
	headers: Record<string, string>;
	statusCode: number;
}

async function baseUrl(context: IExecuteFunctions | ILoadOptionsFunctions): Promise<string> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	const raw = (credentials?.baseUrl as string) || DEFAULT_BASE_URL;
	return raw.replace(/\/+$/, '');
}

/**
 * The API's hints are deliberately client-neutral, because curl users read them
 * too. These add the n8n-shaped half — what to click, which field to change —
 * for the failures an n8n operator actually hits.
 */
const N8N_ADVICE: Record<string, string> = {
	missing_api_key: 'In n8n, open the node and pick a DocMint credential in the Credential dropdown.',
	invalid_api_key: 'Open the credential in n8n and paste the key from your DocMint dashboard again.',
	quota_exceeded: 'Add a Wait or an IF node if you need to spread the work, or upgrade the plan.',
	plan_required: 'Choose a plan on your DocMint dashboard, then run this node again.',
	rate_limited:
		'Turn on Settings > Retry On Fail, or add a Loop Over Items node with a batch interval to slow the workflow down.',

	placeholder_unresolved:
		'Open the Data section: the placeholder named above is one of the fields listed there. If it is genuinely optional, set Options > On Missing to "Leave Empty".',
	section_unresolved:
		'The Data field for this section takes a list. Pass an expression that yields an array, for example {{ $json.items }}. An empty list renders the section zero times.',
	placeholder_not_scalar:
		'You mapped a list or an object onto a field the template writes as text. Point at one of its properties instead, or loop over it in the template.',
	placeholder_shadowed:
		'A field inside a loop is being filled from outside it, so every row would print the same value. Put the field on each row of the list.',
	placeholder_outside_loop:
		'Options > Strict Scope is on. Either put this field on each row of the list, or write {../name} in the template.',

	template_not_found:
		'Reopen the Template dropdown to reload the list from your account, or switch the Template field to By Name and check the spelling.',
	missing_template: 'Set the Template field: pick one From List, name it, or point at a binary field holding the file.',
	ambiguous_template: 'Pick one Template mode. The node sends only the mode you selected.',
	template_version_not_found: 'Use Template > List Versions to see which versions this template has.',
	template_format_changed:
		'Upload this file under a different template name; changing a template from Word to Excel would break every workflow using it.',
	template_too_large:
		'Most of the size in a large Office file is embedded images. "Compress Pictures" in Word or PowerPoint usually takes it under the limit.',
	request_too_large:
		'Sending the template inline on every render is the usual cause. Upload it once with Template > Upload and reference it by name.',
	data_too_large: 'Trim the data, or split the run with a Loop Over Items node.',

	missing_file: 'Set Input Binary Field to the property that holds the .docx, .xlsx or .pptx file.',
	bad_base64: 'The binary field does not hold a readable file. Check Input Binary Field on this node.',
	bad_template_name:
		'Template names are lower case letters, digits, dot, dash and underscore, 1 to 64 characters.',
	template_not_office: 'DocMint fills .docx, .xlsx and .pptx files. This file is not one of them.',
	template_is_pdf: 'This is a PDF. DocMint fills Office templates; PDFMint is the node for PDFs.',
	template_is_opendocument: 'Open the file in LibreOffice and save it as .docx, .xlsx or .pptx first.',
	template_is_legacy_office: 'Open the file in Office and save it as .docx, .xlsx or .pptx first.',
	template_corrupt: 'The file does not open as an Office document. Re-save it from Word, Excel or PowerPoint.',

	bad_data: 'Use an expression that yields an object, for example {{ $json }}.',
	unknown_field: 'This is a bug in the node rather than in your workflow — please report it.',
	bad_json:
		'Switch the field to Expression mode and pass an object rather than building a JSON string by hand.',

	pdf_not_available: 'Set Output to "Office File" — this DocMint instance cannot convert to PDF.',
	pdf_queue_full: 'Turn on Settings > Retry On Fail so this item retries by itself.',
	pdf_timeout: 'Turn on Settings > Retry On Fail. A very large document can take longer than the limit.',
	pdf_conversion_failed: 'The Office file itself was produced. Set Output to "Office File" to get it.',
};

/**
 * The HTTP helper hands the node a NodeApiError whose payload is whatever the
 * server sent — and for a binary request that payload is a Buffer, which the
 * error panel renders as a few hundred decimal bytes. These pull the real
 * envelope back out, whatever wrapper it arrived in.
 */
function bufferFrom(value: unknown): Buffer | undefined {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
	// A Buffer that has been through JSON, as it is once n8n saves an execution.
	const serialised = value as { type?: string; data?: unknown };
	if (serialised?.type === 'Buffer' && Array.isArray(serialised.data)) {
		return Buffer.from(serialised.data as number[]);
	}
	return undefined;
}

interface DecodedBody {
	json?: IDataObject;
	text?: string;
}

function decodeBody(value: unknown): DecodedBody | undefined {
	if (value === undefined || value === null || value === '') return undefined;

	const buffer = bufferFrom(value);
	const text = buffer ? buffer.toString('utf8') : typeof value === 'string' ? value : undefined;

	if (text !== undefined) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (parsed && typeof parsed === 'object') return { json: parsed as IDataObject, text };
		} catch {
			// Not JSON — a proxy's HTML page, say. The text is still readable.
		}
		return { text };
	}
	if (typeof value === 'object') return { json: value as IDataObject };
	return undefined;
}

/** Every place an error body can hide, from the outermost wrapper inwards. */
function errorBody(error: unknown): DecodedBody | undefined {
	const err = (error ?? {}) as JsonObject & {
		cause?: JsonObject & { response?: JsonObject };
		context?: JsonObject;
		errorResponse?: JsonObject;
	};
	const response = (err.response ?? {}) as JsonObject;
	const causeResponse = (err.cause?.response ?? {}) as JsonObject;
	const candidates = [
		response.body,
		response.data,
		err.body,
		causeResponse.body,
		causeResponse.data,
		err.context?.data,
		err.errorResponse,
	];

	let fallback: DecodedBody | undefined;
	for (const candidate of candidates) {
		const decoded = decodeBody(candidate);
		if (decoded?.json?.error) return decoded;
		if (decoded && !fallback) fallback = decoded;
	}
	return fallback;
}

/** The status code, wherever the wrapper happened to keep it. */
function statusCodeOf(error: unknown): string {
	const err = (error ?? {}) as JsonObject & {
		httpCode?: string;
		cause?: JsonObject & { response?: JsonObject };
	};
	const response = (err.response ?? {}) as JsonObject;
	const causeResponse = (err.cause?.response ?? {}) as JsonObject;
	const code =
		err.httpCode ?? response.status ?? response.statusCode ?? causeResponse.status ?? err.statusCode;
	return code === undefined || code === null ? '' : String(code);
}

/** The parsed API error the node attaches to everything it throws. */
const API_ERROR_PROPERTY = 'docMintApiError';

function compactApiError(apiError: IDataObject, httpCode: string): IDataObject {
	const info: IDataObject = { message: String(apiError.message) };
	if (apiError.code) info.code = String(apiError.code);
	if (apiError.hint) info.hint = String(apiError.hint);
	if (apiError.docs) info.docs = String(apiError.docs);
	if (apiError.request_id) info.request_id = String(apiError.request_id);
	if (httpCode) info.httpCode = httpCode;

	// The 422 contract: when DocMint cannot resolve a placeholder it names the
	// placeholder AND where in the document it is. Both are lifted to the top of
	// the error so an IF node can branch on them without digging into `details`.
	const details = apiError.details as IDataObject | undefined;
	if (details !== undefined) info.details = details;
	if (details?.field) info.field = String(details.field);
	if (details?.location) info.location = String(details.location);
	if (Array.isArray(details?.available)) info.available = details.available as string[];
	return info;
}

/**
 * Reads the API's own error fields back off a thrown error, so Continue On Fail
 * can emit something an IF node can branch on rather than a sentence.
 */
function docMintApiError(error: unknown): IDataObject | undefined {
	const attached = (error as { [API_ERROR_PROPERTY]?: IDataObject })?.[API_ERROR_PROPERTY];
	if (attached) return attached;

	const apiError = errorBody(error)?.json?.error as IDataObject | undefined;
	if (!apiError?.message) return undefined;
	return compactApiError(apiError, statusCodeOf(error));
}

/**
 * The item Continue On Fail emits. `error` is an object so a workflow can test
 * `$json.error.code`, `$json.error.field` or `$json.error.location` in an IF
 * node; `errorMessage` keeps the plain sentence for anything that only prints it.
 */
export function errorItemJson(error: unknown): IDataObject {
	const info = docMintApiError(error);
	const thrown = (error ?? {}) as { message?: string; description?: string };
	const message = String(info?.message ?? thrown.message ?? 'Unknown error');
	const details: IDataObject = { ...(info ?? {}), message };
	// A node-side error has no API hint, but its description is one.
	if (!info && thrown.description) details.hint = thrown.description;

	const json: IDataObject = { error: details, errorMessage: message };
	if (thrown.description) json.errorDescription = thrown.description;
	return json;
}

/**
 * NodeApiError hands back its second argument untouched when that argument is
 * already a NodeApiError, so an error can only be given a better message by
 * building it from a plain object. Annotating in place is the honest way to add
 * the item index to one the node already built.
 */
export function withItemIndex<T>(error: T, itemIndex: number): T {
	const context = (error as { context?: IDataObject })?.context;
	if (context && typeof context === 'object' && context.itemIndex === undefined) {
		context.itemIndex = itemIndex;
	}
	return error;
}

/**
 * The headline sentence. DocMint's own message usually names the placeholder
 * already, but when it does not — and it never carries the location — the node
 * adds them, because "which field, and where in the document" is the single
 * thing the operator needs and the one thing every competing product makes you
 * open Word to find out.
 */
export function errorTitle(info: IDataObject): string {
	const message = String(info.message ?? '');
	const field = info.field === undefined ? '' : String(info.field);
	const location = info.location === undefined ? '' : String(info.location);
	if (!field) return message;

	const parts: string[] = [];
	if (!message.includes(field)) parts.push(`Placeholder "${field}"`);
	if (location) parts.push(`in ${location}`);
	if (parts.length === 0) return message;
	return `${message.replace(/\s+$/, '')} (${parts.join(' ')})`;
}

/** Everything the operator needs to act, in the order they need it. */
export function errorDescription(info: IDataObject): string {
	const parts: string[] = [];
	const field = info.field === undefined ? '' : String(info.field);
	const location = info.location === undefined ? '' : String(info.location);

	if (field && location) parts.push(`Placeholder "${field}", at ${location}.`);
	else if (field) parts.push(`Placeholder "${field}".`);
	else if (location) parts.push(`At ${location}.`);

	if (info.hint) parts.push(String(info.hint));
	if (Array.isArray(info.available) && info.available.length) {
		const available = info.available as string[];
		const shown = available.slice(0, 20).join(', ');
		parts.push(
			`Fields the template can see here: ${shown}${available.length > 20 ? `, and ${available.length - 20} more` : ''}.`,
		);
	}
	const advice = N8N_ADVICE[String(info.code ?? '')];
	if (advice) parts.push(advice);
	if (info.docs) parts.push(`Docs: ${String(info.docs)}`);
	if (info.request_id) parts.push(`Request ID: ${String(info.request_id)}`);
	return parts.join(' ');
}

/**
 * The API answers every failure with
 *   { error: { code, message, hint?, docs?, request_id?, details? } }
 * and a 422 whose `details` names the placeholder and the place in the document
 * it was written, so the node can show the operator a sentence they can act on
 * instead of "Request failed with status code 422".
 */
function describeError(context: IExecuteFunctions | ILoadOptionsFunctions, error: JsonObject): never {
	const decoded = errorBody(error);
	const apiError = (decoded?.json?.error ?? {}) as IDataObject;
	const httpCode = statusCodeOf(error);

	if (apiError.message) {
		const info = compactApiError(apiError, httpCode);
		// The plain object is what stops NodeApiError from short-circuiting.
		const failure = new NodeApiError(context.getNode(), decoded?.json as JsonObject, {
			message: errorTitle(info),
			description: errorDescription(info),
			httpCode: httpCode || undefined,
		});
		// The decoded envelope, not the Buffer the transport happened to use.
		failure.context.data = decoded?.json as IDataObject;
		Object.assign(failure, { [API_ERROR_PROPERTY]: info });
		throw failure;
	}

	const code = String((error as JsonObject).code ?? '');
	if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)) {
		throw new NodeApiError(
			context.getNode(),
			{ code, message: String((error as JsonObject).message ?? code) },
			{
				message: 'Could not reach the DocMint API',
				description:
					'Check that this n8n instance has outbound internet access, and that the Base URL in the credential is correct.',
			},
		);
	}

	// Nothing recognisable in the body. Keep whatever n8n already worked out,
	// but never leave a Buffer behind for the panel to print as decimal bytes.
	const failure = new NodeApiError(context.getNode(), error);
	if (decoded?.text !== undefined) {
		failure.context.data = decoded.text.slice(0, 2000);
	}
	throw failure;
}

export async function docMintRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
	binary = false,
): Promise<DocMintResponse> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(this)}${endpoint}`,
		headers: {
			'User-Agent': 'n8n-nodes-docmint',
			Accept: binary ? '*/*' : 'application/json',
		},
		json: !binary,
		returnFullResponse: true,
		ignoreHttpStatusErrors: false,
	};
	if (body !== undefined) {
		options.body = body;
		// A request that asks for a binary RESPONSE still sends a JSON body, and
		// `json: false` only describes the response. Naming the request content
		// type here means the node does not depend on the HTTP client inferring
		// it from the body's type.
		options.headers = { ...options.headers, 'Content-Type': 'application/json' };
	}
	if (binary) options.encoding = 'arraybuffer';

	try {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as unknown as DocMintResponse;
		return response;
	} catch (error) {
		return describeError(this, error as JsonObject);
	}
}

/* ------------------------------------------------------------ the template */

export interface TemplateRef {
	/** `list`, `name` or `binary`. */
	mode: string;
	value: string;
}

/**
 * A resource locator arrives as `{ __rl: true, mode, value }`, but a workflow
 * saved before the field became a locator — or an expression that yields a plain
 * string — still hands over a string. Both have to keep working.
 */
export function templateRefFrom(raw: unknown): TemplateRef {
	if (raw && typeof raw === 'object') {
		const locator = raw as INodeParameterResourceLocator;
		return { mode: String(locator.mode ?? 'name'), value: String(locator.value ?? '').trim() };
	}
	return { mode: 'name', value: String(raw ?? '').trim() };
}

/**
 * The Template dropdown. `GET /v1/templates` returns every template on the
 * account in one response — there is no pagination to page through — so the
 * filter is applied here rather than round-tripping for each keystroke.
 */
export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response = await docMintRequest.call(this, 'GET', '/v1/templates');
	const templates = ((response.body as IDataObject)?.templates ?? []) as IDataObject[];
	const needle = (filter ?? '').toLowerCase();

	const results = templates
		.filter((template) => !needle || String(template.name).toLowerCase().includes(needle))
		.map((template) => {
			const format = template.format ? String(template.format).toUpperCase() : '';
			const count = Array.isArray(template.fields) ? template.fields.length : undefined;
			const suffix = [format, count === undefined ? '' : `${count} placeholder${count === 1 ? '' : 's'}`]
				.filter(Boolean)
				.join(', ');
			return {
				name: suffix ? `${String(template.name)} (${suffix})` : String(template.name),
				value: String(template.name),
			};
		});

	return { results };
}

/* --------------------------------------------------- the placeholder mapper */

/**
 * The method behind the resource mapper: it asks the API which placeholders the
 * chosen template actually contains and hands n8n a schema, so the operator gets
 * one real, typed, expression-capable input per placeholder instead of a JSON
 * textarea they have to guess the keys for.
 */
export async function getTemplateFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const template = templateRefFrom(this.getNodeParameter('template', ''));

	if (template.mode === 'binary') {
		return {
			fields: [],
			emptyFieldsNotice:
				'The template is taken from a binary field on each item, so its placeholders are only known once the workflow runs. Turn on "Send Raw JSON Instead" below, or add a DocMint node set to Document > Inspect to see the placeholder list.',
		};
	}
	if (!template.value) {
		return {
			fields: [],
			emptyFieldsNotice: 'Choose a template above and the fields it needs will appear here.',
		};
	}

	// The mapper has to describe the same version the render will use.
	const version = Number(this.getNodeParameter('options.templateVersion', 0) ?? 0);
	const query = version > 0 ? `?version=${version}` : '';
	const response = await docMintRequest.call(
		this,
		'GET',
		`/v1/templates/${encodeURIComponent(template.value)}/fields${query}`,
	);
	return toResourceMapperFields(response.body as InspectResponse);
}

/* ---------------------------------------------------------------- utilities */

export function parseJsonParameter(
	context: IExecuteFunctions,
	value: unknown,
	field: string,
	itemIndex: number,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'object') return value as IDataObject;
	try {
		return JSON.parse(String(value)) as IDataObject;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), `"${field}" is not valid JSON`, {
			itemIndex,
			description: `Use an expression that yields an object, for example {{ $json }}, or fix the JSON by hand. The parser said: ${(error as Error).message}`,
		});
	}
}

/** Copies the options the operator set, and only those, onto the request body. */
export function applyRenderOptions(body: IDataObject, options: IDataObject): IDataObject {
	// The API refuses unknown fields by design, so nothing may be sent blank.
	for (const key of ['locale', 'currency', 'timezone', 'onMissing'] as const) {
		const value = options[key];
		if (value !== undefined && value !== '') body[key] = value;
	}
	if (options.strictScope === true) body.strictScope = true;
	return body;
}
