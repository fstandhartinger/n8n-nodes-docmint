'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DocMint } = require('../dist/nodes/DocMint/DocMint.node.js');
const {
	toResourceMapperFields,
	expandPaths,
	dataFromMapper,
} = require('../dist/nodes/DocMint/fields.js');
const { createLoadOptionsContext, ok, rl } = require('./harness.js');

/**
 * Recorded `POST /v1/inspect` responses, taken from the DocMint renderer running
 * over its own fixtures rather than invented. The API derives this tree by
 * actually rendering the template, so these are the shapes the node really meets.
 */

/** `fixtures/report.pptx` — two independent lists on one deck. */
const REPORT_PPTX = {
	format: 'pptx',
	names: ['title', 'subtitle', 'client.name', 'logo', 'notes', 'rows', 'sku', 'qty', 'amount', 'findings', 'label', 'detail', 'owner'],
	fields: [
		{ name: 'title', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 4, locations: ['slide 1, shape "Title 1"'] },
		{ name: 'subtitle', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 2, locations: ['slide 1, shape "Subtitle 2"'] },
		{ name: 'client.name', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 4, locations: ['slide 1, shape "Subtitle 2"'] },
		{ name: 'logo', scope: '', type: 'image', repeating: false, required: true, formatters: [], used: 2, locations: ['slide 1, shape "Logo 3"'] },
		{ name: 'notes', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 2, locations: ['slide 1 notes, shape "Notes 1"'] },
		{ name: 'rows', scope: '', type: 'array', repeating: true, required: true, formatters: ['count', 'sum', 'currency'], used: 6, locations: ['slide 2, table "Items 5", row 1, cell 3'] },
		{ name: 'findings', scope: '', type: 'array', repeating: true, required: true, formatters: [], used: 6, locations: ['slide 3, shape "Body 6"'] },
		{ name: 'sku', scope: 'rows', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['slide 2, table "Items 5", row 2, cell 1'] },
		{ name: 'qty', scope: 'rows', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['slide 2, table "Items 5", row 2, cell 2'] },
		{ name: 'amount', scope: 'rows', type: 'number', repeating: false, required: true, formatters: ['currency'], used: 1, locations: ['slide 2, table "Items 5", row 2, cell 3'] },
		{ name: 'label', scope: 'findings', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['slide 3, shape "Body 6"'] },
		{ name: 'detail', scope: 'findings', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['slide 3, shape "Body 6"'] },
		{ name: 'owner', scope: 'findings', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['slide 3, shape "Body 6"'] },
	],
	sample_data: {
		rows: [{ sku: 'sku', qty: 'qty', amount: 0 }],
		findings: [{ label: 'label', detail: 'detail', owner: 'owner' }],
		title: 'title',
		client: { name: 'name' },
		logo: null,
	},
};

/** `fixtures/nested.docx` — a list inside a list inside the root. */
const NESTED_DOCX = {
	format: 'docx',
	names: ['customer', 'orders', 'ref', 'lines', 'sku', 'qty', 'tags'],
	fields: [
		{ name: 'customer', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 8, locations: ['word/document.xml, paragraph 1'] },
		{ name: 'orders', scope: '', type: 'array', repeating: true, required: true, formatters: [], used: 4, locations: ['word/document.xml, paragraph 2'] },
		{ name: 'sku', scope: 'lines', type: 'string', repeating: false, required: true, formatters: [], used: 2, locations: ['word/document.xml, table 1 row 2, paragraph 7'] },
		{ name: 'qty', scope: 'lines', type: 'number', repeating: false, required: true, formatters: [], used: 2, locations: ['word/document.xml, table 1 row 2, paragraph 8'] },
		{ name: 'tags', scope: 'lines', type: 'array', repeating: true, required: true, formatters: [], used: 4, locations: ['word/document.xml, table 1 row 2, paragraph 9'] },
		{ name: 'ref', scope: 'orders', type: 'string', repeating: false, required: true, formatters: [], used: 3, locations: ['word/document.xml, paragraph 3'] },
		{ name: 'customer', scope: 'orders', type: 'string', repeating: false, required: true, formatters: [], used: 3, locations: ['word/document.xml, paragraph 3'] },
		{ name: 'lines', scope: 'orders', type: 'array', repeating: true, required: true, formatters: ['sum'], used: 6, locations: ['word/document.xml, table 1 row 2'] },
	],
	sample_data: { orders: [{ lines: [{ tags: ['tags'], sku: 'sku', qty: 0 }], ref: 'ref', customer: 'customer' }], customer: 'customer' },
};

/** `fixtures/invoice.xlsx` — an optional field, because the tag carries `|default:`. */
const INVOICE_XLSX = {
	format: 'xlsx',
	fields: [
		{ name: 'invoice.number', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 2, locations: ['Invoice!A1'] },
		{ name: 'customer.name', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 8, locations: ['Invoice!B2', 'Summary!B1'] },
		{ name: 'items', scope: '', type: 'array', repeating: true, required: true, formatters: ['count'], used: 8, locations: ['Invoice!A5'] },
		{ name: 'description', scope: 'items', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['Invoice!A5'] },
		{ name: 'note', scope: 'items', type: 'string', repeating: false, required: false, formatters: ['default'], used: 1, locations: ['Invoice!A6'] },
	],
};

const byId = (result) => Object.fromEntries(result.fields.map((f) => [f.id, f]));

test('the API types every placeholder and the node uses those types verbatim', () => {
	const fields = byId(toResourceMapperFields(REPORT_PPTX));

	assert.equal(fields.title.type, 'string');
	assert.equal(fields['client.name'].type, 'string');
	// The API's `date` becomes n8n's `dateTime` so the operator gets a picker.
	assert.equal(byId(toResourceMapperFields(EXAMPLE_INVOICE)).issued.type, 'dateTime');
	// An image placeholder takes a URL or base64, so it is text in n8n.
	assert.equal(fields.logo.type, 'string');
	// A repeating section is a list.
	assert.equal(fields.rows.type, 'array');
	assert.equal(fields.findings.type, 'array');

	for (const field of Object.values(fields)) {
		assert.equal(typeof field.id, 'string');
		assert.equal(typeof field.displayName, 'string');
		assert.equal(field.defaultMatch, false);
		assert.equal(field.canBeUsedToMatch, false);
		assert.equal(field.display, true);
		assert.equal(typeof field.required, 'boolean');
	}
});

test('a placeholder written inside a section is never offered as a root field', () => {
	const fields = byId(toResourceMapperFields(REPORT_PPTX));
	// sku, qty and amount are properties of a row of `rows`. Offering them at the
	// root is how a deck ends up printing the same value on every line.
	for (const inner of ['sku', 'qty', 'amount', 'label', 'detail', 'owner']) {
		assert.equal(fields[inner], undefined, `${inner} belongs to a row, not to the root`);
	}
	assert.deepEqual(Object.keys(fields), ['title', 'subtitle', 'client.name', 'logo', 'notes', 'rows', 'findings']);
});

test('the list field says what each row has to contain', () => {
	const fields = byId(toResourceMapperFields(REPORT_PPTX));
	assert.equal(fields.rows.displayName, 'rows (rows: sku, qty, amount)');
	assert.equal(fields.findings.displayName, 'findings (rows: label, detail, owner)');
});

test('scoping works the same for Word, Excel and PowerPoint', () => {
	// The typed tree comes from running the renderer, so there is no per-format
	// caveat any more: a section is a section in all three.
	for (const [body, section, expected] of [
		[REPORT_PPTX, 'rows', 'rows (rows: sku, qty, amount)'],
		[NESTED_DOCX, 'orders', 'orders (rows: ref, customer, lines[])'],
		[INVOICE_XLSX, 'items', 'items (rows: description, note)'],
	]) {
		assert.equal(byId(toResourceMapperFields(body))[section].displayName, expected);
	}
});

test('a list inside a list is marked as one, so three-level nesting is visible', () => {
	const fields = byId(toResourceMapperFields(NESTED_DOCX));
	// orders -> lines -> sku. Only `orders` and the root `customer` are root
	// fields; `lines` is shown as a nested list in the label.
	assert.deepEqual(Object.keys(fields), ['customer', 'orders']);
	assert.match(fields.orders.displayName, /lines\[\]/);
	// The root `customer` and the `customer` inside `orders` are different
	// placeholders with the same name; only the root one is a form field.
	assert.equal(fields.customer.type, 'string');
});

test('a template with no placeholders says so instead of showing an empty form', () => {
	const result = toResourceMapperFields({ format: 'docx', fields: [], tags: [] });
	assert.deepEqual(result.fields, []);
	assert.match(result.emptyFieldsNotice, /no placeholders/i);
	assert.match(result.emptyFieldsNotice, /DOCX/);
});

test('loop metadata and {.} are never offered as fields to fill in', () => {
	const result = toResourceMapperFields({
		format: 'pptx',
		fields: [
			{ name: 'title', scope: '', type: 'string', repeating: false, required: true },
			{ name: '$index', scope: '', type: 'number', repeating: false, required: true },
			{ name: '.', scope: '', type: 'string', repeating: false, required: true },
		],
	});
	assert.deepEqual(result.fields.map((f) => f.id), ['title']);
});

test('a malformed or empty response never throws', () => {
	for (const body of [{}, { fields: null, tags: null }, { fields: [{ name: 'a', scope: '', type: 'nonsense' }] }]) {
		const result = toResourceMapperFields(body);
		assert.ok(Array.isArray(result.fields));
	}
	// An unknown type falls back to text rather than breaking the form.
	assert.equal(
		toResourceMapperFields({ fields: [{ name: 'a', scope: '', type: 'nonsense' }] }).fields[0].type,
		'string',
	);
});

test('a DocMint older than the typed tree still produces a usable form', () => {
	// Older instances answered with `fields: string[]` and nothing else. There is
	// no type, nesting or optionality to read, so everything is offered as text
	// at the root — and nothing is guessed.
	const result = toResourceMapperFields({
		format: 'docx',
		fields: ['invoice_no', 'customer.name', 'items', 'issued', '$index', '.', 'invoice_no'],
	});
	assert.deepEqual(result.fields.map((f) => f.id), ['invoice_no', 'customer.name', 'items', 'issued']);
	for (const field of result.fields) assert.equal(field.type, 'string');
});

/* ------------------------------------------------ the method n8n calls into */

test('getTemplateFields asks the API about the chosen template and shapes the answer', async () => {
	const { context, calls } = createLoadOptionsContext({
		params: { template: rl('list', 'report'), options: {} },
		http: () => ok(REPORT_PPTX),
	});
	const node = new DocMint();
	const result = await node.methods.resourceMapping.getTemplateFields.call(context);

	assert.equal(calls[0].method, 'GET');
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates/report/fields');
	assert.ok(result.fields.some((f) => f.id === 'rows' && f.type === 'array'));
});

test('getTemplateFields asks about the pinned version when one is set', async () => {
	const { context, calls } = createLoadOptionsContext({
		params: { template: rl('name', 'report'), options: { templateVersion: 2 } },
		http: () => ok(REPORT_PPTX),
	});
	await new DocMint().methods.resourceMapping.getTemplateFields.call(context);
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates/report/fields?version=2');
});

test('getTemplateFields explains itself rather than calling the API it cannot use', async () => {
	for (const [params, pattern] of [
		[{ template: rl('binary', 'data') }, /once the workflow runs/],
		[{ template: rl('list', '') }, /Choose a template/],
	]) {
		const { context, calls } = createLoadOptionsContext({
			params,
			http: () => {
				throw new Error('the API must not be called here');
			},
		});
		const result = await new DocMint().methods.resourceMapping.getTemplateFields.call(context);
		assert.deepEqual(result.fields, []);
		assert.match(result.emptyFieldsNotice, pattern);
		assert.equal(calls.length, 0);
	}
});

test('the Template dropdown lists what the account has, with the format and placeholder count', async () => {
	const { context } = createLoadOptionsContext({
		params: {},
		http: () =>
			ok({
				templates: [
					{ name: 'invoice', format: 'docx', fields: ['a', 'b'] },
					{ name: 'forecast', format: 'xlsx', fields: [] },
				],
			}),
	});
	const node = new DocMint();
	const all = await node.methods.listSearch.searchTemplates.call(context);
	assert.deepEqual(all.results.map((r) => r.value), ['invoice', 'forecast']);
	assert.equal(all.results[0].name, 'invoice (DOCX, 2 placeholders)');

	const filtered = await node.methods.listSearch.searchTemplates.call(context, 'FORE');
	assert.deepEqual(filtered.results.map((r) => r.value), ['forecast']);
});

/* ---------------------------------------------- flat mapper -> nested data */

test('dotted placeholder paths become the nested object the API resolves against', () => {
	assert.deepEqual(expandPaths({ 'customer.name': 'Acme', 'customer.vat': 'DE123', total: 12 }), {
		customer: { name: 'Acme', vat: 'DE123' },
		total: 12,
	});
	assert.deepEqual(expandPaths({ 'items.0.sku': 'A1', 'items.1.sku': 'B2' }), {
		items: [{ sku: 'A1' }, { sku: 'B2' }],
	});
	assert.deepEqual(expandPaths({ 'a[0].b': 1 }), { a: [{ b: 1 }] });
});

test('a list typed into the JSON editor arrives at the API as a real list', () => {
	const schema = toResourceMapperFields(REPORT_PPTX).fields;
	const data = dataFromMapper({ title: 'Q3', rows: '[{"sku":"A1","qty":2,"amount":9}]' }, schema);
	assert.deepEqual(data.rows, [{ sku: 'A1', qty: 2, amount: 9 }]);
	assert.equal(data.title, 'Q3');
});

test('text that is not JSON in a list field is passed through rather than silently dropped', () => {
	const schema = toResourceMapperFields(REPORT_PPTX).fields;
	assert.deepEqual(dataFromMapper({ rows: 'not json' }, schema), { rows: 'not json' });
	// An empty list field means "nothing here", not "the string ''".
	assert.deepEqual(dataFromMapper({ rows: '   ' }, schema), {});
});

/** `examples/invoice.docx`, the template the README walks through. */
const EXAMPLE_INVOICE = {
	format: 'docx',
	fields: [
		{ name: 'logo', scope: '', type: 'image', repeating: false, required: true, formatters: [], used: 2, locations: ['word/document.xml, table 1 row 1, paragraph 1'] },
		{ name: 'invoice_no', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 9, locations: ['word/document.xml, table 2 row 1, paragraph 18'] },
		{ name: 'issued', scope: '', type: 'date', repeating: false, required: true, formatters: ['date'], used: 4, locations: ['word/document.xml, paragraph 9'] },
		{ name: 'customer.name', scope: '', type: 'string', repeating: false, required: true, formatters: [], used: 2, locations: ['word/document.xml, table 2 row 1, paragraph 12'] },
		{ name: 'vat_rate', scope: '', type: 'number', repeating: false, required: true, formatters: ['percent'], used: 2, locations: ['word/document.xml, table 4 row 2, paragraph 53'] },
		{ name: 'items', scope: '', type: 'array', repeating: true, required: true, formatters: ['count', 'sumProduct', 'currency'], used: 11, locations: ['word/document.xml, table 3 row 2'] },
		{ name: 'description', scope: 'items', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['word/document.xml, table 3 row 2, paragraph 43'] },
		{ name: 'qty', scope: 'items', type: 'string', repeating: false, required: true, formatters: [], used: 1, locations: ['word/document.xml, table 3 row 2, paragraph 45'] },
		{ name: 'unit_price', scope: 'items', type: 'number', repeating: false, required: true, formatters: ['currency'], used: 1, locations: ['word/document.xml, table 3 row 2, paragraph 47'] },
	],
};

test('the Word invoice the README walks through becomes the form the README describes', () => {
	const fields = byId(toResourceMapperFields(EXAMPLE_INVOICE));
	assert.deepEqual(Object.keys(fields), ['logo', 'invoice_no', 'issued', 'customer.name', 'vat_rate', 'items']);
	assert.equal(fields.issued.type, 'dateTime');
	assert.equal(fields.vat_rate.type, 'number');
	assert.equal(fields.items.displayName, 'items (rows: description, qty, unit_price)');
});
