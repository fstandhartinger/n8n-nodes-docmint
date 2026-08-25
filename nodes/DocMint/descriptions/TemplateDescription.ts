import type { INodeProperties } from 'n8n-workflow';

/**
 * The Template resource. Templates are addressed by a name you choose rather
 * than by an opaque id, so a workflow that says `invoice` keeps working when
 * finance uploads new letterhead, and every upload becomes a new version rather
 * than an overwrite.
 */

const showFor = (operations: string[], extra: Record<string, unknown> = {}) => ({
	show: { resource: ['template'], operation: operations, ...extra },
});

const NAME_VALIDATION = {
	type: 'regex',
	properties: {
		regex: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]$',
		errorMessage:
			'A template name is 1 to 64 characters of letters, digits, dot, dash and underscore, starting and ending with a letter or digit',
	},
} as const;

export const templateRefField: INodeProperties = {
	displayName: 'Template',
	name: 'templateName',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The template to act on',
	displayOptions: showFor(['get', 'getFields', 'download', 'delete', 'listVersions', 'rollback']),
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
		},
		{
			displayName: 'By Name',
			name: 'name',
			type: 'string',
			hint: 'The name the template was uploaded under',
			placeholder: 'e.g. invoice',
			validation: [NAME_VALIDATION],
		},
	],
};

export const uploadFields: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. invoice',
		description:
			'The name to store the template under, and the name workflows will use to reference it. Uploading again under the same name adds a version rather than replacing the file.',
		displayOptions: showFor(['upload']),
	},
	{
		displayName: 'Input Binary Field',
		name: 'inputBinaryField',
		type: 'string',
		default: 'data',
		required: true,
		placeholder: 'e.g. data',
		description: 'The binary field on this item holding the .docx, .xlsx or .pptx file to upload',
		displayOptions: showFor(['upload']),
	},
	{
		displayName: 'Options',
		name: 'uploadOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: showFor(['upload']),
		options: [
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				placeholder: 'e.g. Standard invoice, EU layout',
				description: 'A description stored with the template and shown on the dashboard',
			},
			{
				displayName: 'Version Note',
				name: 'note',
				type: 'string',
				default: '',
				placeholder: 'e.g. new VAT wording',
				description: 'A note stored against this version, so a rollback later has something to go on',
			},
		],
	},
];

export const getManyFields: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: showFor(['getAll']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: showFor(['getAll'], { returnAll: [false] }),
	},
];

export const versionField: INodeProperties = {
	displayName: 'Version',
	name: 'version',
	type: 'number',
	default: 1,
	required: true,
	typeOptions: { minValue: 1 },
	description:
		'The version to restore. It is copied forward as a new version, so nothing is lost and a rollback made in a panic is itself reversible.',
	displayOptions: showFor(['rollback']),
};

export const readOptions: INodeProperties = {
	displayName: 'Options',
	name: 'readOptions',
	type: 'collection',
	placeholder: 'Add option',
	default: {},
	displayOptions: showFor(['getFields', 'download']),
	options: [
		{
			displayName: 'Put File in Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			description: 'Name of the binary field the downloaded template is attached to',
			displayOptions: { show: { '/operation': ['download'] } },
		},
		{
			displayName: 'Version',
			name: 'version',
			type: 'number',
			default: 0,
			typeOptions: { minValue: 1 },
			description: 'An older version of the template. Left at 0, the current version is used.',
		},
	],
};

export const templateFields: INodeProperties[] = [
	templateRefField,
	...uploadFields,
	...getManyFields,
	versionField,
	readOptions,
];
