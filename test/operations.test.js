'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DocMint } = require('../dist/nodes/DocMint/DocMint.node.js');
const { createContext, mapperValue, rl, ok } = require('./harness.js');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SCHEMA = [
	{ id: 'invoice_no', displayName: 'invoice_no', type: 'string', defaultMatch: false, required: false, display: true },
	{ id: 'customer.name', displayName: 'customer.name', type: 'string', defaultMatch: false, required: false, display: true },
	{ id: 'items', displayName: 'items (rows: sku, qty)', type: 'array', defaultMatch: false, required: false, display: true },
];

const fillParams = (extra = {}) => ({
	resource: 'document',
	operation: 'fill',
	template: rl('name', 'invoice'),
	sendRawJson: false,
	data: mapperValue(
		{ invoice_no: 'INV-2026-0001', 'customer.name': 'Acme Ltd', items: '[{"sku":"A1","qty":2}]' },
		SCHEMA,
	),
	output: 'document',
	fileName: '',
	options: {},
	...extra,
});

const runFill = (overrides) => {
	const { context, calls } = createContext(overrides);
	return { promise: new DocMint().execute.call(context), calls };
};

test('filling a template sends the mapped placeholders as the nested data the API expects', async () => {
	const { promise, calls } = runFill({
		params: fillParams(),
		http: () =>
			ok(Buffer.from('PKdocx'), {
				'content-type': DOCX_MIME,
				'content-disposition': 'attachment; filename="invoice.docx"',
				'x-docmint-credits-remaining': '1987',
				'x-docmint-warnings': '0',
				'x-docmint-request-id': '51e5390e4107f566',
			}),
	});
	const [items] = await promise;

	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].url, 'https://docmint.test/v1/render');
	assert.equal(calls[0].body.template, 'invoice');
	assert.equal(calls[0].body.output, 'document');
	// The flat mapper keys have become the nested object the template resolves.
	assert.deepEqual(calls[0].body.data, {
		invoice_no: 'INV-2026-0001',
		customer: { name: 'Acme Ltd' },
		items: [{ sku: 'A1', qty: 2 }],
	});
	// The API refuses unknown fields, so nothing may be sent blank.
	assert.deepEqual(Object.keys(calls[0].body).sort(), ['data', 'output', 'template']);

	const item = items[0];
	assert.equal(item.binary.data.fileName, 'invoice.docx');
	assert.equal(item.binary.data.mimeType, DOCX_MIME);
	assert.equal(item.json.format, 'docx');
	assert.equal(item.json.creditsRemaining, 1987);
	assert.equal(item.json.requestId, '51e5390e4107f566');
	assert.deepEqual(item.pairedItem, { item: 0 });
});

test('Output = Both puts the Office file and the PDF on the same item', async () => {
	const { promise, calls } = runFill({
		params: fillParams({ output: 'both' }),
		http: () =>
			ok({
				request_id: 'abc',
				format: 'docx',
				document: {
					filename: 'invoice.docx',
					content_type: DOCX_MIME,
					size: 4,
					base64: Buffer.from('DOCX').toString('base64'),
				},
				pdf: {
					filename: 'invoice.pdf',
					content_type: 'application/pdf',
					size: 3,
					pages: 2,
					base64: Buffer.from('PDF').toString('base64'),
				},
				stats: { tags: 9 },
				warnings: [],
				credits: { used: 2, remaining: 1985 },
			}),
	});
	const [items] = await promise;

	assert.equal(calls[0].body.output, 'both');
	assert.equal(calls[0].body.response, 'json');

	const item = items[0];
	assert.equal(Buffer.from(item.binary.data.data, 'base64').toString(), 'DOCX');
	assert.equal(item.binary.data.mimeType, DOCX_MIME);
	assert.equal(Buffer.from(item.binary.pdf.data, 'base64').toString(), 'PDF');
	assert.equal(item.binary.pdf.mimeType, 'application/pdf');
	// The item says where it put them, so the next node does not have to guess.
	assert.deepEqual(item.json.binaryFields, { document: 'data', pdf: 'pdf' });
	assert.equal(item.json.pdf.pages, 2);
});

test('the two binary field names are configurable and both are honoured', async () => {
	const { promise } = runFill({
		params: fillParams({
			output: 'both',
			options: { binaryPropertyName: 'office', pdfBinaryPropertyName: 'printable' },
		}),
		http: () =>
			ok({
				format: 'docx',
				document: { filename: 'a.docx', content_type: DOCX_MIME, base64: 'QQ==' },
				pdf: { filename: 'a.pdf', content_type: 'application/pdf', base64: 'Qg==' },
			}),
	});
	const [items] = await promise;
	assert.ok(items[0].binary.office);
	assert.ok(items[0].binary.printable);
});

test('Output = PDF asks for a PDF and puts it in the one binary field there is', async () => {
	const { promise, calls } = runFill({
		params: fillParams({ output: 'pdf', fileName: 'invoice-{invoice_no}' }),
		http: () =>
			ok(Buffer.from('%PDF-1.7'), {
				'content-type': 'application/pdf',
				'content-disposition': 'attachment; filename="invoice-INV-2026-0001.pdf"',
			}),
	});
	const [items] = await promise;
	assert.equal(calls[0].body.output, 'pdf');
	assert.equal(calls[0].body.filename, 'invoice-{invoice_no}');
	assert.equal(items[0].binary.data.fileName, 'invoice-INV-2026-0001.pdf');
	assert.equal(items[0].json.format, 'pdf');
	assert.equal(items[0].json.binaryField, 'data');
});

test('an inline template is read off the item and sent with the request', async () => {
	const { promise, calls } = runFill({
		params: fillParams({ template: rl('binary', 'file') }),
		items: [{ json: {}, binary: { file: { data: Buffer.from('PKZIP').toString('base64') } } }],
		http: () => ok(Buffer.from('out'), { 'content-type': DOCX_MIME }),
	});
	await promise;
	assert.equal(calls[0].body.template_base64, Buffer.from('PKZIP').toString('base64'));
	assert.equal(calls[0].body.template, undefined, 'never both — the API refuses that on purpose');
	assert.equal(calls[0].body.template_version, undefined, 'a version is meaningless for an inline file');
});

test('the raw JSON escape hatch bypasses the mapper entirely', async () => {
	const { promise, calls } = runFill({
		params: fillParams({ sendRawJson: true, dataJson: { total: 12, nested: { a: 1 } } }),
		http: () => ok(Buffer.from('out'), { 'content-type': DOCX_MIME }),
	});
	await promise;
	assert.deepEqual(calls[0].body.data, { total: 12, nested: { a: 1 } });
});

test('Map Automatically sends the incoming item as the data', async () => {
	const { promise, calls } = runFill({
		params: fillParams({ data: mapperValue(null, SCHEMA, 'autoMapInputData') }),
		items: [{ json: { invoice_no: 'INV-9', total: 4 } }],
		http: () => ok(Buffer.from('out'), { 'content-type': DOCX_MIME }),
	});
	await promise;
	assert.deepEqual(calls[0].body.data, { invoice_no: 'INV-9', total: 4 });
});

test('only the options the operator actually set are sent', async () => {
	const { promise, calls } = runFill({
		params: fillParams({
			options: {
				locale: 'de-DE',
				currency: 'EUR',
				timezone: 'Europe/Berlin',
				onMissing: 'empty',
				strictScope: true,
				templateVersion: 4,
				binaryPropertyName: 'data',
			},
		}),
		http: () => ok(Buffer.from('out'), { 'content-type': DOCX_MIME }),
	});
	await promise;
	const body = calls[0].body;
	assert.equal(body.locale, 'de-DE');
	assert.equal(body.currency, 'EUR');
	assert.equal(body.timezone, 'Europe/Berlin');
	assert.equal(body.onMissing, 'empty');
	assert.equal(body.strictScope, true);
	assert.equal(body.template_version, 4);
	// The binary field name is a node concern; the API has never heard of it.
	assert.equal(body.binaryPropertyName, undefined);
});

test('each input item is filled and paired back to the item it came from', async () => {
	const { promise, calls } = runFill({
		params: fillParams({
			data: mapperValue(null, SCHEMA, 'autoMapInputData'),
		}),
		items: [{ json: { invoice_no: 'A' } }, { json: { invoice_no: 'B' } }],
		http: () => ok(Buffer.from('out'), { 'content-type': DOCX_MIME }),
	});
	const [items] = await promise;
	assert.equal(calls.length, 2);
	assert.deepEqual(
		items.map((i) => i.pairedItem),
		[{ item: 0 }, { item: 1 }],
	);
});

/* --------------------------------------------------------- other operations */

test('Inspect asks the API what the template needs and returns it as JSON', async () => {
	const { context, calls } = createContext({
		params: { resource: 'document', operation: 'inspect', template: rl('name', 'invoice'), options: {} },
		http: () => ok({ format: 'docx', fields: ['a'], tags: [] }),
	});
	const [items] = await new DocMint().execute.call(context);
	assert.equal(calls[0].url, 'https://docmint.test/v1/inspect');
	assert.equal(calls[0].body.template, 'invoice');
	assert.deepEqual(items[0].json.fields, ['a']);
});

test('Template > Upload base64-encodes the binary field and names the template', async () => {
	const { context, calls } = createContext({
		params: {
			resource: 'template',
			operation: 'upload',
			name: 'invoice',
			inputBinaryField: 'data',
			uploadOptions: { description: 'EU layout', note: 'new VAT wording' },
		},
		items: [{ json: {}, binary: { data: { data: Buffer.from('PKZIP').toString('base64') } } }],
		http: () => ok({ id: 'tpl_1', name: 'invoice', version: 2 }),
	});
	const [items] = await new DocMint().execute.call(context);
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates');
	assert.equal(calls[0].body.name, 'invoice');
	assert.equal(calls[0].body.file_base64, Buffer.from('PKZIP').toString('base64'));
	assert.equal(calls[0].body.description, 'EU layout');
	assert.equal(calls[0].body.note, 'new VAT wording');
	assert.equal(items[0].json.version, 2);
});

test('Template > Get Many returns one item per template and respects the limit', async () => {
	const templates = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
	const base = {
		resource: 'template',
		operation: 'getAll',
		readOptions: {},
	};

	const limited = createContext({
		params: { ...base, returnAll: false, limit: 2 },
		http: () => ok({ templates }),
	});
	const [some] = await new DocMint().execute.call(limited.context);
	assert.deepEqual(
		some.map((i) => i.json.name),
		['a', 'b'],
	);

	const all = createContext({
		params: { ...base, returnAll: true, limit: 2 },
		http: () => ok({ templates }),
	});
	const [every] = await new DocMint().execute.call(all.context);
	assert.equal(every.length, 3);
});

test('the template read and write operations hit the endpoints they say they do', async () => {
	const cases = [
		[{ operation: 'get' }, 'GET', 'https://docmint.test/v1/templates/invoice'],
		[{ operation: 'getFields' }, 'GET', 'https://docmint.test/v1/templates/invoice/fields'],
		[
			{ operation: 'getFields', readOptions: { version: 2 } },
			'GET',
			'https://docmint.test/v1/templates/invoice/fields?version=2',
		],
		[{ operation: 'listVersions' }, 'GET', 'https://docmint.test/v1/templates/invoice/versions'],
		[{ operation: 'delete' }, 'DELETE', 'https://docmint.test/v1/templates/invoice'],
		[{ operation: 'rollback', version: 3 }, 'POST', 'https://docmint.test/v1/templates/invoice/rollback'],
	];

	for (const [extra, method, url] of cases) {
		const { context, calls } = createContext({
			params: {
				resource: 'template',
				templateName: rl('name', 'invoice'),
				readOptions: {},
				...extra,
			},
			http: () => ok({ ok: true }),
		});
		await new DocMint().execute.call(context);
		assert.equal(calls[0].method, method, `wrong method for ${extra.operation}`);
		assert.equal(calls[0].url, url, `wrong url for ${extra.operation}`);
	}
});

test('Template > Rollback sends the version to restore', async () => {
	const { context, calls } = createContext({
		params: {
			resource: 'template',
			operation: 'rollback',
			templateName: rl('name', 'invoice'),
			version: 3,
			readOptions: {},
		},
		http: () => ok({ version: 5, restored_from: 3 }),
	});
	await new DocMint().execute.call(context);
	assert.deepEqual(calls[0].body, { version: 3 });
});

test('Template > Download returns the file as binary', async () => {
	const { context, calls } = createContext({
		params: {
			resource: 'template',
			operation: 'download',
			templateName: rl('name', 'invoice'),
			readOptions: { binaryPropertyName: 'template', version: 2 },
		},
		http: () =>
			ok(Buffer.from('PKZIP'), {
				'content-type': DOCX_MIME,
				'content-disposition': 'attachment; filename="invoice.docx"',
			}),
	});
	const [items] = await new DocMint().execute.call(context);
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates/invoice/file?version=2');
	assert.equal(items[0].binary.template.fileName, 'invoice.docx');
	assert.equal(items[0].json.format, 'docx');
	assert.equal(items[0].json.version, 2);
});

test('Account > Get Usage runs once for the node and pairs to every input item', async () => {
	const { context, calls } = createContext({
		params: { resource: 'account', operation: 'getUsage' },
		items: [{ json: {} }, { json: {} }],
		http: () => ok({ plan: { id: 'pro' }, credits: { remaining: 19998 } }),
	});
	const [items] = await new DocMint().execute.call(context);
	assert.equal(calls.length, 1, 'usage describes the account, not each item');
	assert.equal(calls[0].url, 'https://docmint.test/v1/usage');
	assert.equal(items.length, 1);
	assert.deepEqual(items[0].pairedItem, [{ item: 0 }, { item: 1 }]);
	assert.equal(items[0].json.credits.remaining, 19998);
});
