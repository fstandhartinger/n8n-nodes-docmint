'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DocMint } = require('../dist/nodes/DocMint/DocMint.node.js');
const { createContext, httpFailure, apiErrorBody, mapperValue, rl, ok } = require('./harness.js');

/**
 * The 422 the whole product is built around: DocMint refuses to render a
 * document with a hole in it, and says which placeholder and where in the
 * document it is. None of that is any use if the node flattens it into
 * "Request failed with status code 422".
 */
const UNRESOLVED = apiErrorBody(
	'placeholder_unresolved',
	'The template uses {customer_vat} but the data has no "customer_vat".',
	{
		hint: 'Did you mean "customer_vat_id"? Otherwise add "customer_vat" to the data, or write {customer_vat|default:} to allow it to be absent.',
		docs: 'https://docmint.test/docs#errors',
		request_id: 'c99211da08a1b46d',
		details: {
			field: 'customer_vat',
			location: 'word/document.xml, paragraph 12',
			available: ['invoice_no', 'customer_vat_id', 'total'],
			format: 'docx',
		},
	},
);

const SHEET_ERROR = apiErrorBody('placeholder_unresolved', 'A placeholder could not be resolved.', {
	hint: 'Add it to the data.',
	details: { field: 'grand_total', location: 'Sheet1!C7', available: ['subtotal'] },
});

const INVALID_KEY = apiErrorBody('invalid_api_key', 'This API key is not valid, or it has been revoked.', {
	hint: 'Keys are only shown once and cannot be read back, so if you have lost it, create a new one on your dashboard at /dashboard.',
	docs: 'https://docmint.test/docs#authentication',
	request_id: 'c99211da08a1b46d',
});

const fillParams = {
	resource: 'document',
	operation: 'fill',
	template: rl('name', 'invoice'),
	sendRawJson: false,
	data: mapperValue({ invoice_no: 'INV-1' }),
	output: 'document',
	fileName: '',
	options: {},
};

function run(overrides) {
	const { context, calls } = createContext(overrides);
	return { promise: new DocMint().execute.call(context), calls };
}

const rejection = (promise) =>
	promise.then(
		() => assert.fail('the node should have thrown'),
		(error) => error,
	);

test('a 422 names the placeholder in the message the operator reads first', async () => {
	const { promise } = run({
		params: fillParams,
		http: () => httpFailure(422, UNRESOLVED, { arraybuffer: true }),
	});
	const error = await rejection(promise);

	// The single guarantee this node exists to make.
	assert.match(error.message, /customer_vat/, `no field name in: ${error.message}`);
});

test('a 422 puts the placeholder, the location, the hint and the available fields in the description', async () => {
	const { promise } = run({
		params: fillParams,
		http: () => httpFailure(422, UNRESOLVED, { arraybuffer: true }),
	});
	const error = await rejection(promise);
	const description = String(error.description);

	assert.match(description, /Placeholder "customer_vat"/);
	assert.match(description, /word\/document\.xml, paragraph 12/);
	assert.match(description, /Did you mean "customer_vat_id"\?/);
	assert.match(description, /Fields the template can see here: invoice_no, customer_vat_id, total\./);
	// The n8n-specific advice the node keeps for this code.
	assert.match(description, /Open the Data section/);
	assert.match(description, /docs#errors/);
	assert.match(description, /c99211da08a1b46d/);

	// And never the raw buffer the binary request happened to use.
	const panel = JSON.stringify({ message: error.message, description, context: error.context });
	assert.doesNotMatch(panel, /"type":"Buffer"/);
	assert.doesNotMatch(panel, /\[123,34/);
});

test('a spreadsheet location survives too, and the field is added when the message omits it', async () => {
	const { promise } = run({
		params: fillParams,
		http: () => httpFailure(422, SHEET_ERROR, { arraybuffer: true }),
	});
	const error = await rejection(promise);

	// The API's sentence did not name the field, so the node put it in.
	assert.match(error.message, /grand_total/);
	assert.match(error.message, /Sheet1!C7/);
	assert.match(String(error.description), /Placeholder "grand_total", at Sheet1!C7\./);
});

test('a 401 on the binary path reaches the operator as the API message, not a byte array', async () => {
	const { promise } = run({
		params: fillParams,
		http: () => httpFailure(401, INVALID_KEY, { arraybuffer: true }),
	});
	const error = await rejection(promise);

	assert.match(error.message, /This API key is not valid, or it has been revoked\./);
	const description = String(error.description);
	assert.match(description, /create a new one on your dashboard/);
	assert.match(description, /Open the credential in n8n/);
	assert.match(description, /docs#authentication/);
});

test('Continue On Fail emits the placeholder and location as data an IF node can branch on', async () => {
	const { promise } = run({
		params: fillParams,
		continueOnFail: true,
		http: () => httpFailure(422, UNRESOLVED, { arraybuffer: true }),
	});
	const [items] = await promise;
	assert.equal(items.length, 1);
	const json = items[0].json;

	assert.equal(json.error.code, 'placeholder_unresolved');
	assert.equal(json.error.field, 'customer_vat');
	assert.equal(json.error.location, 'word/document.xml, paragraph 12');
	assert.deepEqual(json.error.available, ['invoice_no', 'customer_vat_id', 'total']);
	assert.equal(json.error.httpCode, '422');
	assert.equal(typeof json.errorMessage, 'string');
	assert.doesNotMatch(JSON.stringify(json), /"type":"Buffer"/);
	assert.deepEqual(items[0].pairedItem, { item: 0 });
});

test('a node-side failure names the binary field and lists what the item actually has', async () => {
	const { promise } = run({
		params: { ...fillParams, template: rl('binary', 'template') },
		items: [{ json: {}, binary: { data: { data: 'AAAA' } } }],
		http: () => ok(Buffer.from('PK')),
	});
	const error = await rejection(promise);
	assert.match(error.message, /no binary field called "template"/);
	assert.match(String(error.description), /Binary fields on this item: data/);
});

test('an unreachable API says what to check rather than leaving a DNS error behind', async () => {
	const { promise } = run({
		params: fillParams,
		http: () => Object.assign(new Error('getaddrinfo ENOTFOUND docmint.test'), { code: 'ENOTFOUND' }),
	});
	const error = await rejection(promise);
	// n8n owns the headline for a known network code, and its wording is good.
	// What the node adds is the description that says where to look.
	assert.match(error.message, /connection cannot be established/i);
	assert.match(String(error.description), /outbound internet access/);
	assert.match(String(error.description), /Base URL in the credential/);
});
