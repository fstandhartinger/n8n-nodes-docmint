import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPairedItemData,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { FORMATS, formatFromFileName } from './constants';
import { dataFromMapper } from './fields';
import {
	applyRenderOptions,
	docMintRequest,
	errorItemJson,
	getTemplateFields,
	parseJsonParameter,
	searchTemplates,
	templateRefFrom,
	withItemIndex,
} from './GenericFunctions';
import { documentFields } from './descriptions/DocumentDescription';
import { templateFields } from './descriptions/TemplateDescription';

export class DocMint implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DocMint',
		name: 'docMint',
		icon: { light: 'file:docmint.svg', dark: 'file:docmint.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Fill Word, Excel and PowerPoint templates with workflow data and get the file or a PDF back',
		defaults: { name: 'DocMint' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'docMintApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'document',
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Document', value: 'document' },
					{ name: 'Template', value: 'template' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'fill',
				displayOptions: { show: { resource: ['document'] } },
				options: [
					{
						name: 'Fill',
						value: 'fill',
						description: 'Fill a template with data and return the document',
						action: 'Fill document template',
					},
					{
						name: 'Inspect',
						value: 'inspect',
						description:
							'List the placeholders a document template contains and where each one is written',
						action: 'Inspect document template',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'upload',
				displayOptions: { show: { resource: ['template'] } },
				options: [
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a template and every version of it',
						action: 'Delete template',
					},
					{
						name: 'Download',
						value: 'download',
						description: 'Download the template file itself',
						action: 'Download template',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get one template, with its format, size and version history',
						action: 'Get template',
					},
					{
						name: 'Get Fields',
						value: 'getFields',
						description: 'List the placeholders a stored template needs',
						action: 'Get template fields',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the templates on the account',
						action: 'Get many templates',
					},
					{
						name: 'List Versions',
						value: 'listVersions',
						description: 'List every stored version of a template',
						action: 'List template versions',
					},
					{
						name: 'Rollback',
						value: 'rollback',
						description: 'Restore an earlier version of a template as the current one',
						action: 'Roll back template',
					},
					{
						name: 'Upload',
						value: 'upload',
						description: 'Upload a template file, or add a version to an existing template',
						action: 'Upload template',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getUsage',
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: 'Read the plan, quota and documents remaining on the account',
						action: 'Get account usage',
					},
				],
			},
			...documentFields,
			...templateFields,
		],
	};

	methods = {
		listSearch: { searchTemplates },
		resourceMapping: { getTemplateFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const returnData: INodeExecutionData[] = [];

		// Usage describes the account rather than an item, so it runs once for the
		// whole node — inside the same error handling as everything else.
		if (resource === 'account') {
			const pairedItem: IPairedItemData[] = items.map((_, index) => ({ item: index }));
			try {
				const response = await docMintRequest.call(this, 'GET', '/v1/usage');
				return [[{ json: response.body as IDataObject, pairedItem }]];
			} catch (error) {
				if (this.continueOnFail()) return [[{ json: errorItemJson(error), pairedItem }]];
				throw rethrow.call(this, error, 0);
			}
		}

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'document') {
					if (operation === 'fill') {
						returnData.push(await fillDocument.call(this, i));
						continue;
					}
					if (operation === 'inspect') {
						returnData.push(await inspectTemplate.call(this, i));
						continue;
					}
				}
				if (resource === 'template') {
					returnData.push(...(await runTemplateOperation.call(this, operation, i)));
					continue;
				}
				throw new NodeOperationError(
					this.getNode(),
					`Unknown operation "${operation}" on "${resource}"`,
					{ itemIndex: i },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: errorItemJson(error), pairedItem: { item: i } });
					continue;
				}
				throw rethrow.call(this, error, i);
			}
		}

		return [returnData];
	}
}

/**
 * n8n's NodeApiError returns its argument unchanged when handed another
 * NodeApiError, so re-wrapping one would be a no-op. The API's message, hint,
 * placeholder name, location and request id are already on the error the
 * request helper built; all that is missing is which item failed.
 */
function rethrow(this: IExecuteFunctions, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		return withItemIndex(error, itemIndex);
	}
	return new NodeOperationError(this.getNode(), error as Error, { itemIndex });
}

/* ------------------------------------------------------------------ helpers */

/** Reads a binary field off an item, saying what is actually there when it is not. */
async function binaryBuffer(
	context: IExecuteFunctions,
	itemIndex: number,
	property: string,
	parameterName: string,
): Promise<Buffer> {
	const item = context.getInputData()[itemIndex];
	if (!item?.binary?.[property]) {
		const present = Object.keys(item?.binary ?? {});
		throw new NodeOperationError(
			context.getNode(),
			`Item ${itemIndex + 1} has no binary field called "${property}"`,
			{
				itemIndex,
				description: `Binary fields on this item: ${present.join(', ') || 'none'}. Set "${parameterName}" to the one holding the Office file.`,
			},
		);
	}
	return await context.helpers.getBinaryDataBuffer(itemIndex, property);
}

/** Puts the template on the request body, whichever way the operator chose it. */
async function applyTemplate(
	context: IExecuteFunctions,
	itemIndex: number,
	body: IDataObject,
	options: IDataObject = {},
): Promise<void> {
	const template = templateRefFrom(context.getNodeParameter('template', itemIndex, ''));

	if (template.mode === 'binary') {
		const property = template.value || 'data';
		const buffer = await binaryBuffer(context, itemIndex, property, 'Template > Upload / Inline');
		body.template_base64 = buffer.toString('base64');
		return;
	}

	if (!template.value) {
		throw new NodeOperationError(context.getNode(), 'No template chosen', {
			itemIndex,
			description:
				'Pick one in the Template field: From List, By Name, or Upload / Inline to send a file from a binary field on this item.',
		});
	}
	body.template = template.value;

	// A version only means something for a stored template; sending it alongside
	// an inline file is refused by the API, and rightly so.
	const version = Number(options.templateVersion ?? 0);
	if (version > 0) body.template_version = version;
}

/** The mapper's value, or the whole incoming item when it is set to auto-map. */
function dataFromParameters(context: IExecuteFunctions, itemIndex: number): IDataObject {
	const sendRawJson = context.getNodeParameter('sendRawJson', itemIndex, false) as boolean;
	if (sendRawJson) {
		const raw = context.getNodeParameter('dataJson', itemIndex, {});
		return parseJsonParameter(context, raw, 'Data (JSON)', itemIndex) ?? {};
	}

	const mapper = context.getNodeParameter('data', itemIndex, {}) as unknown as ResourceMapperValue;
	if (mapper?.mappingMode === 'autoMapInputData') {
		return (context.getInputData()[itemIndex]?.json ?? {}) as IDataObject;
	}
	return dataFromMapper((mapper?.value ?? {}) as IDataObject, mapper?.schema ?? []);
}

/** `attachment; filename="invoice.docx"` -> `invoice.docx` */
function fileNameFromHeaders(headers: Record<string, string>): string | undefined {
	const disposition = headers?.['content-disposition'];
	if (!disposition) return undefined;
	const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
	return match ? decodeURIComponent(match[1]) : undefined;
}

function formatFromMime(mimeType?: string): string | undefined {
	if (!mimeType) return undefined;
	const bare = mimeType.split(';')[0].trim();
	for (const [id, format] of Object.entries(FORMATS)) {
		if (format.mime === bare) return id;
	}
	return undefined;
}

/** The response headers worth surfacing on the item's JSON. */
function metaFromHeaders(headers: Record<string, string>): IDataObject {
	const json: IDataObject = {};
	const requestId = headers?.['x-docmint-request-id'];
	const remaining = headers?.['x-docmint-credits-remaining'];
	const warnings = headers?.['x-docmint-warnings'];
	if (requestId) json.requestId = requestId;
	if (remaining !== undefined) json.creditsRemaining = Number(remaining);
	if (warnings !== undefined) json.warnings = Number(warnings);
	return json;
}

async function attach(
	context: IExecuteFunctions,
	buffer: Buffer,
	fileName: string,
	mimeType: string,
): Promise<IBinaryData> {
	return await context.helpers.prepareBinaryData(Buffer.from(buffer), fileName, mimeType);
}

/* -------------------------------------------------------------- operations */

async function fillDocument(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const output = this.getNodeParameter('output', itemIndex, 'document') as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const fileName = String(this.getNodeParameter('fileName', itemIndex, '') ?? '').trim();

	const body: IDataObject = {};
	await applyTemplate(this, itemIndex, body, options);
	body.data = dataFromParameters(this, itemIndex);
	body.output = output;
	if (fileName) body.filename = fileName;
	applyRenderOptions(body, options);

	const documentProperty = (options.binaryPropertyName as string) || 'data';
	const pdfProperty = (options.pdfBinaryPropertyName as string) || 'pdf';

	// Asking for both files means the API answers with JSON carrying both, which
	// is the only shape that can hold two files at once.
	if (output === 'both') {
		body.response = 'json';
		const response = await docMintRequest.call(this, 'POST', '/v1/render', body);
		const payload = response.body as IDataObject;
		const document = payload.document as IDataObject | undefined;
		const pdf = payload.pdf as IDataObject | undefined;

		const binary: Record<string, IBinaryData> = {};
		if (document?.base64) {
			binary[documentProperty] = await attach(
				this,
				Buffer.from(String(document.base64), 'base64'),
				String(document.filename ?? `document.${FORMATS[String(payload.format)]?.ext ?? 'docx'}`),
				String(document.content_type ?? 'application/octet-stream'),
			);
		}
		if (pdf?.base64) {
			binary[pdfProperty] = await attach(
				this,
				Buffer.from(String(pdf.base64), 'base64'),
				String(pdf.filename ?? 'document.pdf'),
				'application/pdf',
			);
		}

		const json: IDataObject = {
			format: payload.format,
			document: document ? { fileName: document.filename, size: document.size } : undefined,
			pdf: pdf ? { fileName: pdf.filename, size: pdf.size, pages: pdf.pages } : undefined,
			binaryFields: { document: documentProperty, pdf: pdfProperty },
			stats: payload.stats,
			warnings: payload.warnings,
			credits: payload.credits,
			requestId: payload.request_id,
		};
		return { json, binary, pairedItem: { item: itemIndex } };
	}

	const response = await docMintRequest.call(this, 'POST', '/v1/render', body, true);
	const headers = response.headers ?? {};
	const mimeType =
		output === 'pdf'
			? 'application/pdf'
			: (headers['content-type'] ?? '').split(';')[0].trim() || 'application/octet-stream';
	const name =
		fileNameFromHeaders(headers) ??
		`document.${output === 'pdf' ? 'pdf' : (formatFromMime(mimeType) ?? 'docx')}`;
	const buffer = Buffer.from(response.body as Buffer);

	const json: IDataObject = {
		fileName: name,
		mimeType,
		size: buffer.length,
		binaryField: documentProperty,
		...metaFromHeaders(headers),
	};
	const format = output === 'pdf' ? 'pdf' : formatFromMime(mimeType);
	if (format) json.format = format;

	return {
		json,
		binary: { [documentProperty]: await attach(this, buffer, name, mimeType) },
		pairedItem: { item: itemIndex },
	};
}

async function inspectTemplate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const body: IDataObject = {};
	await applyTemplate(this, itemIndex, body, options);
	const response = await docMintRequest.call(this, 'POST', '/v1/inspect', body);
	return { json: response.body as IDataObject, pairedItem: { item: itemIndex } };
}

async function runTemplateOperation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const paired = { item: itemIndex };

	if (operation === 'upload') {
		const name = String(this.getNodeParameter('name', itemIndex) ?? '').trim();
		const property = String(this.getNodeParameter('inputBinaryField', itemIndex, 'data') || 'data');
		const uploadOptions = this.getNodeParameter('uploadOptions', itemIndex, {}) as IDataObject;
		const buffer = await binaryBuffer(this, itemIndex, property, 'Input Binary Field');

		const body: IDataObject = { name, file_base64: buffer.toString('base64') };
		if (uploadOptions.description) body.description = uploadOptions.description;
		if (uploadOptions.note) body.note = uploadOptions.note;

		const response = await docMintRequest.call(this, 'POST', '/v1/templates', body);
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'getAll') {
		const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
		const response = await docMintRequest.call(this, 'GET', '/v1/templates');
		const templates = ((response.body as IDataObject)?.templates ?? []) as IDataObject[];
		// The API answers with every template in one response — there is nothing to
		// page through — so a limit is applied here rather than pretended at.
		const limit = returnAll ? templates.length : (this.getNodeParameter('limit', itemIndex, 50) as number);
		return templates.slice(0, limit).map((template) => ({ json: template, pairedItem: paired }));
	}

	const templateName = templateRefFrom(this.getNodeParameter('templateName', itemIndex, ''));
	if (!templateName.value) {
		throw new NodeOperationError(this.getNode(), 'No template chosen', {
			itemIndex,
			description: 'Pick one in the Template field, From List or By Name.',
		});
	}
	const path = `/v1/templates/${encodeURIComponent(templateName.value)}`;
	const readOptions = this.getNodeParameter('readOptions', itemIndex, {}) as IDataObject;
	const version = Number(readOptions.version ?? 0);
	const query = version > 0 ? `?version=${version}` : '';

	if (operation === 'get') {
		const response = await docMintRequest.call(this, 'GET', path);
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'getFields') {
		const response = await docMintRequest.call(this, 'GET', `${path}/fields${query}`);
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'listVersions') {
		const response = await docMintRequest.call(this, 'GET', `${path}/versions`);
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'delete') {
		const response = await docMintRequest.call(this, 'DELETE', path);
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'rollback') {
		const target = this.getNodeParameter('version', itemIndex) as number;
		const response = await docMintRequest.call(this, 'POST', `${path}/rollback`, {
			version: Number(target),
		});
		return [{ json: response.body as IDataObject, pairedItem: paired }];
	}

	if (operation === 'download') {
		const property = (readOptions.binaryPropertyName as string) || 'data';
		const response = await docMintRequest.call(this, 'GET', `${path}/file${query}`, undefined, true);
		const headers = response.headers ?? {};
		const mimeType =
			(headers['content-type'] ?? '').split(';')[0].trim() || 'application/octet-stream';
		const name = fileNameFromHeaders(headers) ?? `${templateName.value}.docx`;
		const buffer = Buffer.from(response.body as Buffer);
		const format = formatFromMime(mimeType) ?? formatFromFileName(name);

		return [
			{
				json: {
					name: templateName.value,
					fileName: name,
					mimeType,
					size: buffer.length,
					binaryField: property,
					...(format ? { format } : {}),
					...(version > 0 ? { version } : {}),
				},
				binary: { [property]: await attach(this, buffer, name, mimeType) },
				pairedItem: paired,
			},
		];
	}

	throw new NodeOperationError(this.getNode(), `Unknown template operation "${operation}"`, {
		itemIndex,
	});
}
