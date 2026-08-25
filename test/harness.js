'use strict';

/**
 * Stand-ins for n8n's IExecuteFunctions and ILoadOptionsFunctions that behave
 * like the real ones in the ways this node depends on: parameters come back per
 * item, dotted parameter paths resolve into collections, the HTTP helper throws
 * exactly what n8n-core throws (a NodeApiError wrapping an axios error), and
 * binary data round-trips through a buffer.
 *
 * The error shape is copied from n8n-core:
 *   packages/core/.../request-helpers/authentication.js
 *     catch (error) { throw new NodeApiError(this.getNode(), error); }
 * where `error` is the axios error whose response.data is a Buffer whenever the
 * request asked for `encoding: 'arraybuffer'`.
 *
 * The two contexts differ in one way that matters and is easy to get wrong:
 * IExecuteFunctions is getNodeParameter(name, itemIndex, fallback), and
 * ILoadOptionsFunctions is getNodeParameter(name, fallback).
 */
const { NodeApiError } = require('n8n-workflow');

const testNode = {
	id: 'af1b2c3d',
	name: 'DocMint',
	type: 'n8n-nodes-docmint.docMint',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** n8n reads `constructor.name === 'AxiosError'` to find the status code. */
class AxiosError extends Error {}

/** The axios error n8n's HTTP client rejects with for a non-2xx response. */
function axiosError(statusCode, body, { arraybuffer = false } = {}) {
	const error = new AxiosError(`Request failed with status code ${statusCode}`);
	error.name = 'AxiosError';
	error.isAxiosError = true;
	error.code = statusCode >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
	error.config = { url: 'https://docmint.test/v1/render', method: 'post' };
	error.response = {
		status: statusCode,
		statusText: '',
		headers: { 'content-type': 'application/json; charset=utf-8' },
		data: arraybuffer ? Buffer.from(JSON.stringify(body), 'utf8') : body,
		config: error.config,
	};
	return error;
}

/** What `helpers.httpRequestWithAuthentication` throws when the API says no. */
function httpFailure(statusCode, body, options) {
	return new NodeApiError(testNode, axiosError(statusCode, body, options));
}

/** The API's own error envelope, as `src/errors.js` builds it. */
function apiErrorBody(code, message, extra = {}) {
	const error = { code, message };
	if (extra.hint !== null) error.hint = extra.hint ?? 'A hint the operator can act on.';
	if (extra.docs !== null) error.docs = extra.docs ?? 'https://docmint.test/docs#errors';
	if (extra.request_id !== null) error.request_id = extra.request_id ?? 'c99211da08a1b46d';
	if (extra.details) error.details = extra.details;
	return { error };
}

/** A resource locator value, as the editor stores one. */
const rl = (mode, value) => ({ __rl: true, mode, value });

/** A resource mapper value, as the editor stores one. */
function mapperValue(value, schema = [], mappingMode = 'defineBelow') {
	return {
		mappingMode,
		value,
		matchingColumns: [],
		schema,
		attemptToConvertTypes: false,
		convertFieldsToString: false,
	};
}

/** `options.templateVersion` has to resolve into the `options` collection. */
function lookupParameter(params, name) {
	if (name in params) return { found: true, value: params[name] };
	const dot = name.indexOf('.');
	if (dot === -1) return { found: false };
	const head = name.slice(0, dot);
	const tail = name.slice(dot + 1);
	const parent = params[head];
	if (parent && typeof parent === 'object' && tail in parent) {
		return { found: true, value: parent[tail] };
	}
	return { found: false };
}

function makeHelpers(items, calls, http) {
	return {
		async httpRequestWithAuthentication(_credentialsType, options) {
			calls.push(options);
			const result = await http(options, calls.length - 1);
			if (result instanceof Error) throw result;
			return result;
		},
		async prepareBinaryData(buffer, fileName, mimeType) {
			return { data: Buffer.from(buffer).toString('base64'), fileName, mimeType };
		},
		async getBinaryDataBuffer(itemIndex, property) {
			return Buffer.from(items[itemIndex].binary[property].data, 'base64');
		},
	};
}

function createContext({ params = {}, items = [{ json: {} }], continueOnFail = false, http }) {
	const calls = [];
	const context = {
		getNode: () => testNode,
		getInputData: () => items,
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ apiKey: 'dm_live_test', baseUrl: 'https://docmint.test' }),
		getNodeParameter(name, itemIndex, fallback) {
			const hit = lookupParameter(params, name);
			if (!hit.found) {
				if (fallback !== undefined) return fallback;
				throw new Error(`test asked for an unset parameter: ${name}`);
			}
			return typeof hit.value === 'function' ? hit.value(itemIndex) : hit.value;
		},
		helpers: makeHelpers(items, calls, http),
	};
	return { context, calls };
}

/** The context n8n hands to listSearch and resourceMapping methods. */
function createLoadOptionsContext({ params = {}, http }) {
	const calls = [];
	const context = {
		getNode: () => testNode,
		getCredentials: async () => ({ apiKey: 'dm_live_test', baseUrl: 'https://docmint.test' }),
		getCurrentNodeParameters: () => params,
		getNodeParameter(name, fallback) {
			const hit = lookupParameter(params, name);
			return hit.found ? hit.value : fallback;
		},
		getCurrentNodeParameter(name) {
			return lookupParameter(params, name).value;
		},
		helpers: makeHelpers([], calls, http),
	};
	return { context, calls };
}

/** A success response from the API, matching `returnFullResponse: true`. */
function ok(body, headers = {}) {
	return { body, headers, statusCode: 200 };
}

module.exports = {
	createContext,
	createLoadOptionsContext,
	httpFailure,
	axiosError,
	apiErrorBody,
	mapperValue,
	rl,
	ok,
	testNode,
};
