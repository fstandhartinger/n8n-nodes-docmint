'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DocMint } = require('../dist/nodes/DocMint/DocMint.node.js');
const {
	toResourceMapperFields,
	expandPaths,
	dataFromMapper,
	fieldTypeOf,
	rowKeysFromFormatters,
} = require('../dist/nodes/DocMint/fields.js');
const { createLoadOptionsContext, ok, rl } = require('./harness.js');

/**
 * A recorded `GET /v1/templates/invoice/fields` response, in the shape the DOCX
 * and PPTX renderers produce: `fields` are the distinct data paths, `tags` are
 * every tag in source order including the `close` tags that make the nesting
 * knowable.
 */
const INVOICE_FIELDS = {
	id: 'tpl_2Nc8Kq9wQb',
	name: 'invoice',
	format: 'docx',
	version: 3,
	fields: [
		'invoice_no',
		'customer.name',
		'issued|date:YYYY-MM-DD',
		'items',
		'sku',
		'qty',
		'price',
		'currency',
		'total',
		'paid',
		'logo',
	],
	tags: [
		{ expr: 'invoice_no', kind: 'value', location: 'word/document.xml, paragraph 3' },
		{ expr: 'customer.name', kind: 'value', location: 'word/document.xml, paragraph 5' },
		{ expr: 'issued|date:YYYY-MM-DD', kind: 'value', location: 'word/document.xml, paragraph 6' },
		{ expr: '%logo', kind: 'image', location: 'word/document.xml, paragraph 1' },
		{ expr: 'items', kind: 'section', location: 'word/document.xml, paragraph 12' },
		{ expr: 'sku', kind: 'value', location: 'word/document.xml, paragraph 12' },
		{ expr: 'qty', kind: 'value', location: 'word/document.xml, paragraph 12' },
		{ expr: 'price|currency:EUR', kind: 'value', location: 'word/document.xml, paragraph 12' },
		{ expr: '../currency', kind: 'value', location: 'word/document.xml, paragraph 12' },
		{ expr: 'items', kind: 'close', location: 'word/document.xml, paragraph 13' },
		{ expr: 'items|sum:amount', kind: 'value', location: 'word/document.xml, paragraph 15' },
		{ expr: 'total|currency:EUR', kind: 'value', location: 'word/document.xml, paragraph 15' },
		{ expr: 'paid|yesno:Paid:Unpaid', kind: 'value', location: 'word/document.xml, paragraph 16' },
	],
};

const byId = (result) => Object.fromEntries(result.fields.map((f) => [f.id, f]));

test('an API response becomes one n8n field per placeholder, with the types the template implies', () => {
	const result = toResourceMapperFields(INVOICE_FIELDS);
	const fields = byId(result);

	assert.equal(fields.invoice_no.type, 'string');
	assert.equal(fields['customer.name'].type, 'string');
	// `{issued|date:...}` is a date, `{total|currency:EUR}` a number,
	// `{paid|yesno:...}` a boolean, `{#items}` a list.
	assert.equal(fields.issued.type, 'dateTime');
	assert.equal(fields.total.type, 'number');
	assert.equal(fields.paid.type, 'boolean');
	assert.equal(fields.items.type, 'array');
	// An image placeholder takes a URL or base64, so it stays text.
	assert.equal(fields.logo.type, 'string');

	// Every field n8n needs to draw the form is present and well-formed.
	for (const field of result.fields) {
		assert.equal(typeof field.id, 'string');
		assert.equal(typeof field.displayName, 'string');
		assert.equal(field.defaultMatch, false);
		assert.equal(field.display, true);
		assert.equal(typeof field.required, 'boolean');
		assert.equal(field.canBeUsedToMatch, false);
	}
});

test('placeholders written inside a loop are not offered as root fields', () => {
	const fields = byId(toResourceMapperFields(INVOICE_FIELDS));
	// sku, qty and price are properties of a row of `items`. Offering them at the
	// root is how a workflow ends up printing the same value on every line.
	for (const inner of ['sku', 'qty', 'price']) {
		assert.equal(fields[inner], undefined, `${inner} belongs to a row, not to the root`);
	}
	// `{../currency}` reaches out of the loop on purpose, so it IS root data.
	assert.ok(fields.currency, 'a ../ path is root data even though it is written inside a loop');
});

test('the list field says what each row has to contain — the thing nothing else tells you', () => {
	const fields = byId(toResourceMapperFields(INVOICE_FIELDS));
	assert.match(fields.items.displayName, /^items \(rows: /);
	for (const key of ['sku', 'qty', 'price']) {
		assert.ok(fields.items.displayName.includes(key), `row key ${key} missing from the label`);
	}
});

test('a response with no close tags offers everything at the root rather than guessing', () => {
	// The XLSX renderer filters close tags out before returning, so the nesting
	// cannot be reconstructed. Dropping fields on a guess would be worse than
	// showing them all.
	const xlsx = {
		format: 'xlsx',
		fields: ['company', 'rows', 'sku', 'amount'],
		tags: [
			{ expr: 'company', kind: 'value', location: 'Sheet1!B2' },
			{ expr: 'rows', kind: 'section', location: 'Sheet1!A5' },
			{ expr: 'sku', kind: 'value', location: 'Sheet1!A5' },
			{ expr: 'amount|number:2', kind: 'value', location: 'Sheet1!C5' },
		],
	};
	const fields = byId(toResourceMapperFields(xlsx));
	assert.deepEqual(Object.keys(fields).sort(), ['amount', 'company', 'rows', 'sku']);
	assert.equal(fields.rows.type, 'array');
	assert.equal(fields.amount.type, 'number');
	// With the nesting unknown, the label stays the bare placeholder name.
	assert.equal(fields.rows.displayName, 'rows');
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
		fields: ['title', '$index', '.', ''],
		tags: [{ expr: 'title', kind: 'value', location: 'slide 1' }],
	});
	assert.deepEqual(
		result.fields.map((f) => f.id),
		['title'],
	);
});

test('a malformed or empty response never throws', () => {
	for (const body of [{}, { fields: null, tags: null }, { fields: ['a'] }]) {
		const result = toResourceMapperFields(body);
		assert.ok(Array.isArray(result.fields));
	}
});

test('fieldTypeOf reads the formatter pipeline, not the field name', () => {
	const tags = [{ expr: 'x|filter:active|sort:due', kind: 'value' }];
	assert.equal(fieldTypeOf('x', tags), 'array');
	assert.equal(fieldTypeOf('unknown', tags), 'string');
});

/* ------------------------------------------------ the method n8n calls into */

test('getTemplateFields asks the API about the chosen template and shapes the answer', async () => {
	const { context, calls } = createLoadOptionsContext({
		params: { template: rl('list', 'invoice'), options: {} },
		http: () => ok(INVOICE_FIELDS),
	});
	const node = new DocMint();
	const result = await node.methods.resourceMapping.getTemplateFields.call(context);

	assert.equal(calls[0].method, 'GET');
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates/invoice/fields');
	assert.ok(result.fields.length > 0);
	assert.ok(result.fields.some((f) => f.id === 'invoice_no'));
});

test('getTemplateFields asks about the pinned version when one is set', async () => {
	const { context, calls } = createLoadOptionsContext({
		params: { template: rl('name', 'invoice'), options: { templateVersion: 2 } },
		http: () => ok(INVOICE_FIELDS),
	});
	await new DocMint().methods.resourceMapping.getTemplateFields.call(context);
	assert.equal(calls[0].url, 'https://docmint.test/v1/templates/invoice/fields?version=2');
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
	assert.deepEqual(
		all.results.map((r) => r.value),
		['invoice', 'forecast'],
	);
	assert.equal(all.results[0].name, 'invoice (DOCX, 2 placeholders)');
	assert.equal(all.results[1].name, 'forecast (XLSX, 0 placeholders)');

	const filtered = await node.methods.listSearch.searchTemplates.call(context, 'FORE');
	assert.deepEqual(
		filtered.results.map((r) => r.value),
		['forecast'],
	);
});

/* ---------------------------------------------- flat mapper -> nested data */

test('dotted placeholder paths become the nested object the API resolves against', () => {
	assert.deepEqual(expandPaths({ 'customer.name': 'Acme', 'customer.vat': 'DE123', total: 12 }), {
		customer: { name: 'Acme', vat: 'DE123' },
		total: 12,
	});
	// A numeric segment means a list, matching the API's own path splitter.
	assert.deepEqual(expandPaths({ 'items.0.sku': 'A1', 'items.1.sku': 'B2' }), {
		items: [{ sku: 'A1' }, { sku: 'B2' }],
	});
	assert.deepEqual(expandPaths({ 'a[0].b': 1 }), { a: [{ b: 1 }] });
});

test('a list typed into the JSON editor arrives at the API as a real list', () => {
	const schema = [
		{ id: 'items', displayName: 'items', type: 'array', defaultMatch: false, required: false, display: true },
		{ id: 'total', displayName: 'total', type: 'number', defaultMatch: false, required: false, display: true },
	];
	const data = dataFromMapper({ items: '[{"sku":"A1","qty":2}]', total: 41.5 }, schema);
	assert.deepEqual(data.items, [{ sku: 'A1', qty: 2 }]);
	assert.equal(data.total, 41.5);
});

test('text that is not JSON in a list field is passed through rather than silently dropped', () => {
	const schema = [
		{ id: 'items', displayName: 'items', type: 'array', defaultMatch: false, required: false, display: true },
	];
	assert.deepEqual(dataFromMapper({ items: 'not json' }, schema), { items: 'not json' });
	// An empty list field means "nothing here", not "the string ''".
	assert.deepEqual(dataFromMapper({ items: '   ' }, schema), {});
});

/* ------------------------------ recorded responses from the real renderers */

/**
 * The literal `POST /v1/inspect` response for `fixtures/invoice.docx`, copied
 * from the DocMint renderer rather than invented. It matters because the DOCX
 * and XLSX renderers do NOT emit close tags, so this is the shape the node
 * mostly meets in practice.
 */
const REAL_DOCX_INVOICE = {
	format: 'docx',
	fields: [
		'logo',
		'invoice_no',
		'issued',
		'customer.name',
		'customer.address',
		'items',
		'description',
		'qty',
		'unit_price',
		'line_total',
		'paid',
		'terms_days',
		'notes',
		'company',
	],
	tags: [
		{ expr: 'logo', kind: 'image', location: 'word/document.xml, paragraph 1' },
		{ expr: 'invoice_no', kind: 'value', location: 'word/document.xml, paragraph 2' },
		{ expr: 'issued|date:DD MMMM YYYY', kind: 'value', location: 'word/document.xml, paragraph 3' },
		{ expr: 'customer.name', kind: 'value', location: 'word/document.xml, paragraph 5' },
		{ expr: 'customer.address', kind: 'value', location: 'word/document.xml, paragraph 6' },
		{ expr: 'items', kind: 'section', location: 'word/document.xml, table 1 row 2' },
		{ expr: 'description', kind: 'value', location: 'word/document.xml, table 1 row 2, paragraph 11' },
		{ expr: 'qty', kind: 'value', location: 'word/document.xml, table 1 row 2, paragraph 12' },
		{ expr: 'unit_price|currency:EUR', kind: 'value', location: 'word/document.xml, table 1 row 2, paragraph 13' },
		{ expr: 'line_total|currency:EUR', kind: 'value', location: 'word/document.xml, table 1 row 2, paragraph 14' },
		{
			expr: 'items|sumProduct:qty:unit_price|currency:EUR',
			kind: 'value',
			location: 'word/document.xml, table 1 row 3, paragraph 18',
		},
		{ expr: 'paid', kind: 'inverted', location: 'word/document.xml, paragraph 19' },
		{ expr: 'terms_days', kind: 'value', location: 'word/document.xml, paragraph 19' },
		{ expr: 'paid', kind: 'section', location: 'word/document.xml, paragraph 19' },
		{ expr: 'notes', kind: 'section', location: 'word/document.xml, paragraph 21' },
		{ expr: '.', kind: 'value', location: 'word/document.xml, paragraph 22' },
		{ expr: 'company', kind: 'value', location: 'word/document.xml, paragraph 24' },
		{ expr: 'items|count', kind: 'value', location: 'word/document.xml, paragraph 24' },
	],
};

test('a real Word invoice becomes a usable form, not a JSON textarea', () => {
	const fields = byId(toResourceMapperFields(REAL_DOCX_INVOICE));

	// Every placeholder the document actually contains, with a real type.
	assert.equal(fields.invoice_no.type, 'string');
	assert.equal(fields.issued.type, 'dateTime');
	assert.equal(fields['customer.name'].type, 'string');
	assert.equal(fields.unit_price.type, 'number');
	assert.equal(fields.items.type, 'array');
	// `{.}` inside `{#notes}` is the loop item, not a field to fill in.
	assert.equal(fields['.'], undefined);
});

test('row keys are recovered from the formatter pipeline when close tags are absent', () => {
	const fields = byId(toResourceMapperFields(REAL_DOCX_INVOICE));
	// The DOCX renderer emits no close tags, so nesting is unknowable — but
	// `{items|sumProduct:qty:unit_price}` still states that every row has `qty`
	// and `unit_price`, and that fact is worth showing.
	assert.match(fields.items.displayName, /^items \(rows: /);
	assert.ok(fields.items.displayName.includes('qty'));
	assert.ok(fields.items.displayName.includes('unit_price'));
});

test('row keys are read from every list formatter that names one', () => {
	const cases = [
		['t|sum:amount', ['amount']],
		['t|sumProduct:qty:price', ['qty', 'price']],
		['t|filter:active', ['active']],
		['t|sort:due_date:desc', ['due_date']],
		['t|groupBy:category', ['category']],
		['t|unique:sku', ['sku']],
		// Arguments that are not field names must not be mistaken for them.
		['t|limit:10', undefined],
		['t|join:, ', undefined],
	];
	for (const [expr, expected] of cases) {
		const rows = rowKeysFromFormatters([{ expr, kind: 'value' }]);
		assert.deepEqual(rows.get('t'), expected, `wrong row keys for ${expr}`);
	}
});
