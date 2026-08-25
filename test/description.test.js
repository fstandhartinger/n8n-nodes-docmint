'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DocMint } = require('../dist/nodes/DocMint/DocMint.node.js');
const codex = require('../dist/nodes/DocMint/DocMint.node.json');

const description = new DocMint().description;

const operationsFor = (resource) =>
	description.properties
		.filter((p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(resource))
		.flatMap((p) => p.options.map((o) => o.value));

const propertyNamed = (name) => description.properties.find((p) => p.name === name);

test('the node declares itself the way n8n and the verification checks expect', () => {
	assert.equal(description.name, 'docMint');
	assert.equal(description.displayName, 'DocMint');
	assert.equal(description.usableAsTool, true, 'the node must be usable as an AI Agent tool');
	assert.ok(description.subtitle, 'a subtitle is required for verified community nodes');
	assert.match(description.subtitle, /operation/);
	assert.match(description.subtitle, /resource/);
	assert.ok(description.icon.light.startsWith('file:'), 'the icon must be a bundled file');
	assert.notEqual(description.icon.light, description.icon.dark, 'light and dark must differ');
	assert.deepEqual(description.credentials, [{ name: 'docMintApi', required: true }]);
});

test('every operation the node promises is declared', () => {
	assert.deepEqual(
		propertyNamed('resource').options.map((o) => o.value),
		['account', 'document', 'template'],
	);
	assert.deepEqual(operationsFor('document'), ['fill', 'inspect']);
	assert.deepEqual(operationsFor('template'), [
		'delete',
		'download',
		'get',
		'getFields',
		'getAll',
		'listVersions',
		'rollback',
		'upload',
	]);
	assert.deepEqual(operationsFor('account'), ['getUsage']);
});

test('every operation option carries the action and description n8n shows in the panel', () => {
	for (const property of description.properties.filter((p) => p.name === 'operation')) {
		for (const option of property.options) {
			assert.ok(option.action, `operation ${option.value} has no action`);
			assert.ok(option.description, `operation ${option.value} has no description`);
			// Sentence case, and no article-padded actions: "Fill document template".
			assert.doesNotMatch(option.action, /^(A|An|The) /, `action reads oddly: ${option.action}`);
		}
	}
});

test('the placeholder mapper is the default and the JSON textarea is the escape hatch', () => {
	const mapper = propertyNamed('data');
	assert.equal(mapper.type, 'resourceMapper', 'the data field must be a resource mapper');
	assert.equal(
		mapper.typeOptions.resourceMapper.resourceMapperMethod,
		'getTemplateFields',
		'the mapper must be wired to the method that reads the template',
	);
	assert.equal(mapper.typeOptions.resourceMapper.mode, 'add');
	assert.deepEqual(mapper.typeOptions.loadOptionsDependsOn, ['template.value']);
	assert.deepEqual(mapper.default, { mappingMode: 'defineBelow', value: null });

	// The mapper shows when the raw-JSON toggle is off; the textarea when it is on.
	assert.deepEqual(mapper.displayOptions.show.sendRawJson, [false]);
	assert.deepEqual(propertyNamed('dataJson').displayOptions.show.sendRawJson, [true]);
	assert.equal(propertyNamed('sendRawJson').default, false, 'raw JSON must not be the default');
});

test('the template field is a resource locator with a searchable list, a name and an inline file', () => {
	const template = propertyNamed('template');
	assert.equal(template.type, 'resourceLocator');
	assert.deepEqual(template.default, { mode: 'list', value: '' });

	const modes = Object.fromEntries(template.modes.map((m) => [m.name, m]));
	assert.deepEqual(Object.keys(modes), ['list', 'name', 'binary']);
	assert.equal(modes.list.type, 'list');
	assert.equal(modes.list.typeOptions.searchListMethod, 'searchTemplates');
	assert.equal(modes.list.typeOptions.searchable, true);
	assert.equal(modes.name.type, 'string');
	assert.ok(modes.name.validation.length, 'By Name should validate the name shape');
	assert.equal(modes.binary.type, 'string');
});

test('the methods the properties reference actually exist on the node', () => {
	const node = new DocMint();
	assert.equal(typeof node.methods.resourceMapping.getTemplateFields, 'function');
	assert.equal(typeof node.methods.listSearch.searchTemplates, 'function');
});

test('Output offers per-request choice of Office file, PDF or both', () => {
	const output = propertyNamed('output');
	assert.deepEqual(
		output.options.map((o) => o.value),
		['document', 'pdf', 'both'],
	);
	assert.equal(output.default, 'document');
	// Choosing Both has to say where the two files land.
	const notice = propertyNamed('bothOutputNotice');
	assert.equal(notice.type, 'notice');
	assert.deepEqual(notice.displayOptions.show.output, ['both']);
});

test('boolean parameters describe themselves the way the UX guidelines require', () => {
	const collect = (properties) => {
		const out = [];
		for (const property of properties) {
			if (property.type === 'boolean') out.push(property);
			if (Array.isArray(property.options) && property.type === 'collection') {
				out.push(...collect(property.options));
			}
		}
		return out;
	};
	for (const property of collect(description.properties)) {
		assert.match(
			property.description ?? '',
			/^Whether /,
			`boolean "${property.name}" must describe itself starting with "Whether"`,
		);
	}
});

test('the codex file makes the node findable and claims nothing the node cannot do', () => {
	assert.equal(codex.node, 'n8n-nodes-docmint.docMint');
	assert.equal(codex.codexVersion, '1.0');
	const allowed = new Set([
		'Data & Storage',
		'Finance & Accounting',
		'Marketing & Content',
		'Productivity',
		'Miscellaneous',
		'Sales',
		'Development',
		'Analytics',
		'Communication',
		'Utility',
	]);
	for (const category of codex.categories) {
		assert.ok(allowed.has(category), `not an n8n category: ${category}`);
	}
	assert.ok(codex.resources.primaryDocumentation[0].url.startsWith('https://'));
	assert.ok(codex.resources.credentialDocumentation[0].url.startsWith('https://'));

	assert.ok(codex.alias.length >= 8, `only ${codex.alias.length} aliases`);
	for (const expected of ['Word', 'Excel', 'PowerPoint', 'DOCX', 'XLSX', 'PPTX', 'Invoice']) {
		assert.ok(codex.alias.includes(expected), `missing alias: ${expected}`);
	}
	// Nothing the node cannot actually do. DocMint fills Office templates; it
	// does not sign, OCR, redact, split or watermark anything, and it has no
	// HTML path — that is PDFMint's job, not this one's.
	const cannotDo = /\bOCR\b|\bSign\b|\bRedact\b|\bSplit\b|\bMerge PDF|\bWatermark\b|\bHTML\b/i;
	for (const alias of codex.alias) {
		assert.doesNotMatch(alias, cannotDo, `dishonest alias: ${alias}`);
	}
});
