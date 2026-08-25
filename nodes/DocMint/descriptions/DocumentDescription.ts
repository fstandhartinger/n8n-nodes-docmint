import type { INodeProperties } from 'n8n-workflow';

/**
 * The Document resource: fill a template, or ask a template what it needs.
 *
 * The Template field is a resource locator rather than a text box, and the data
 * goes into a resource mapper rather than a JSON textarea, because the failure
 * this product exists to remove is "I guessed the field name wrong and found out
 * by opening the file in Word".
 */

const showFor = (operations: string[], extra: Record<string, unknown> = {}) => ({
	show: { resource: ['document'], operation: operations, ...extra },
});

/** The template modes, shared by Fill and Inspect. */
export const templateLocator: INodeProperties = {
	displayName: 'Template',
	name: 'template',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Word, Excel or PowerPoint template to fill',
	displayOptions: showFor(['fill', 'inspect']),
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'searchTemplates',
				searchable: true,
			},
		},
		{
			displayName: 'By Name',
			name: 'name',
			type: 'string',
			hint: 'The name the template was uploaded under',
			placeholder: 'e.g. invoice',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]$',
						errorMessage:
							'A template name is 1 to 64 characters of letters, digits, dot, dash and underscore, starting and ending with a letter or digit',
					},
				},
			],
		},
		{
			displayName: 'Upload / Inline',
			name: 'binary',
			type: 'string',
			hint: 'The binary field on this item that holds the .docx, .xlsx or .pptx file. It is sent with the request and nothing is stored on your account.',
			placeholder: 'e.g. data',
		},
	],
};

/**
 * The escape hatch, and the reason it is an escape hatch rather than the
 * default: a JSON textarea is what every competing node ships, and it is where
 * the guessing starts.
 */
export const sendRawJsonField: INodeProperties = {
	displayName: 'Send Raw JSON Instead',
	name: 'sendRawJson',
	type: 'boolean',
	default: false,
	description:
		'Whether to pass one JSON object straight through instead of filling in a field per placeholder. Useful when an earlier node already built the data.',
	displayOptions: showFor(['fill']),
};

export const dataMapperField: INodeProperties = {
	displayName: 'Data',
	name: 'data',
	type: 'resourceMapper',
	// n8n requires the default value to be null.
	default: { mappingMode: 'defineBelow', value: null },
	required: true,
	noDataExpression: true,
	description:
		'One input per placeholder the template actually contains, read from the template itself',
	typeOptions: {
		// Re-read the placeholder list whenever the chosen template changes.
		loadOptionsDependsOn: ['template.value'],
		resourceMapper: {
			resourceMapperMethod: 'getTemplateFields',
			mode: 'add',
			fieldWords: { singular: 'placeholder', plural: 'placeholders' },
			addAllFields: true,
			multiKeyMatch: false,
			supportAutoMap: true,
			valuesLabel: 'Placeholders in This Template',
			noFieldsError:
				'DocMint read this template and found no placeholders in it. Add tags such as {customer} or {{customer}} to the document, upload it again, then reopen this field.',
		},
	},
	displayOptions: showFor(['fill'], { sendRawJson: [false] }),
};

export const dataJsonField: INodeProperties = {
	displayName: 'Data (JSON)',
	name: 'dataJson',
	type: 'json',
	default: '={{ $json }}',
	description:
		'The values for the template placeholders, as one object. DocMint refuses to render and names the placeholder when one has no value.',
	displayOptions: showFor(['fill'], { sendRawJson: [true] }),
};

export const outputField: INodeProperties = {
	displayName: 'Output',
	name: 'output',
	type: 'options',
	noDataExpression: true,
	default: 'document',
	description: 'Which file or files you want back, chosen per request rather than fixed on the template',
	displayOptions: showFor(['fill']),
	options: [
		{
			name: 'Office File',
			value: 'document',
			description: 'The filled .docx, .xlsx or .pptx, in the same format as the template',
		},
		{
			name: 'PDF',
			value: 'pdf',
			description: 'The filled document converted to PDF. Costs one credit more than the Office file.',
		},
		{
			name: 'Both',
			value: 'both',
			description: 'The Office file and the PDF, as two binary fields on the same item',
		},
	],
};

export const bothOutputNotice: INodeProperties = {
	displayName:
		'Both files land on this item: the Office file in the binary field named under Options, and the PDF in the PDF field beside it. Defaults are <code>data</code> and <code>pdf</code>.',
	name: 'bothOutputNotice',
	type: 'notice',
	default: '',
	displayOptions: showFor(['fill'], { output: ['both'] }),
};

export const fileNameField: INodeProperties = {
	displayName: 'File Name',
	name: 'fileName',
	type: 'string',
	default: '',
	placeholder: 'e.g. invoice-{invoice_no}',
	description:
		'Name for the generated file. Placeholders work here too, so <code>invoice-{invoice_no}</code> becomes <code>invoice-INV-2026-0001.docx</code>. The right extension is added for you, and characters a file name cannot contain are removed. Left empty, the file is called <code>document</code>.',
	displayOptions: showFor(['fill']),
};

export const fillOptions: INodeProperties = {
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add option',
	default: {},
	displayOptions: showFor(['fill']),
	options: [
		{
			displayName: 'Currency',
			name: 'currency',
			type: 'string',
			default: '',
			placeholder: 'e.g. EUR',
			description:
				'Three-letter ISO code used by the <code>currency</code> formatter when the template does not name one. Defaults to USD.',
		},
		{
			displayName: 'Locale',
			name: 'locale',
			type: 'string',
			default: '',
			placeholder: 'e.g. de-DE',
			description:
				'BCP 47 language tag that decides how numbers, dates and currencies are written. Defaults to en-US.',
		},
		{
			displayName: 'On Missing Placeholder',
			name: 'onMissing',
			type: 'options',
			default: 'error',
			description: 'What to do when the template asks for a value the data does not have',
			options: [
				{
					name: 'Fail and Name the Placeholder',
					value: 'error',
					description:
						'The default. Nothing is rendered, and the error names the placeholder and where in the document it is.',
				},
				{
					name: 'Leave Empty',
					value: 'empty',
					description: 'Render nothing in its place and carry on',
				},
				{
					name: 'Keep the Tag Visible',
					value: 'keep',
					description: 'Leave the {tag} in the document. For debugging a template, not for production.',
				},
			],
		},
		{
			displayName: 'Put Office File in Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			description: 'Name of the binary field the Office file is attached to',
		},
		{
			displayName: 'Put PDF in Field',
			name: 'pdfBinaryPropertyName',
			type: 'string',
			default: 'pdf',
			description:
				'Name of the binary field the PDF is attached to when Output is Both. With Output set to PDF the file goes in the Office file field instead, so there is only ever one to look for.',
		},
		{
			displayName: 'Strict Scope',
			name: 'strictScope',
			type: 'boolean',
			default: false,
			description:
				'Whether a placeholder inside a loop must be a field of the row. Off, a name the row does not have is taken from outside the loop and reported as a warning — which prints the same value on every row. On, it fails instead.',
		},
		{
			displayName: 'Template Version',
			name: 'templateVersion',
			type: 'number',
			default: 0,
			typeOptions: { minValue: 1 },
			description:
				'Render an older version of the saved template. Left at 0, the current version is used. Use Template > List Versions to see what exists.',
		},
		{
			displayName: 'Time Zone',
			name: 'timezone',
			type: 'string',
			default: '',
			placeholder: 'e.g. Europe/Berlin',
			description: 'IANA time zone the <code>date</code> formatter renders in. Defaults to UTC.',
		},
	],
};

export const documentFields: INodeProperties[] = [
	templateLocator,
	sendRawJsonField,
	dataMapperField,
	dataJsonField,
	outputField,
	bothOutputNotice,
	fileNameField,
	fillOptions,
];
