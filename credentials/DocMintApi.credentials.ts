import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DocMintApi implements ICredentialType {
	name = 'docMintApi';

	icon = { light: 'file:docmint.svg', dark: 'file:docmint.dark.svg' } as const;

	displayName = 'DocMint API';

	documentationUrl = 'https://docmint-832s.onrender.com/docs#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e.g. dm_live_...',
			description:
				'Create an account at https://docmint-832s.onrender.com/signup and copy the key shown on your dashboard. Keys start with dm_live_ and are only shown once.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://docmint-832s.onrender.com',
			description: 'Only change this if you run your own DocMint instance',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * GET /v1/usage is authenticated, costs no credits and produces no document,
	 * so testing the credential can never charge the account or leave a file
	 * behind.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/usage',
		},
	};
}
