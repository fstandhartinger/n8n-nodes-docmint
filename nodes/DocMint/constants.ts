/**
 * The DocMint instance the credential points at by default. Overridable in the
 * credential so a self-hosted deployment works without editing the node.
 */
export const DEFAULT_BASE_URL = 'https://docmint-832s.onrender.com';

/** The credential this node authenticates with. */
export const CREDENTIAL_NAME = 'docMintApi';

/**
 * The three formats DocMint fills, mirrored from the API's `FORMATS` table in
 * `src/config.js`. Used to name the file the node hands back and to set the
 * binary MIME type, both of which have to match what the API actually sent.
 */
export const FORMATS: Record<string, { ext: string; name: string; mime: string }> = {
	docx: {
		ext: 'docx',
		name: 'Word document',
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	},
	xlsx: {
		ext: 'xlsx',
		name: 'Excel workbook',
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	},
	pptx: {
		ext: 'pptx',
		name: 'PowerPoint deck',
		mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	},
};

/** Guessing a format from a file name, for uploads and for inline templates. */
export function formatFromFileName(fileName?: string): string | undefined {
	const match = /\.(docx|xlsx|pptx|docm|xlsm|pptm)$/i.exec(fileName ?? '');
	if (!match) return undefined;
	return match[1].toLowerCase().replace(/m$/, 'x');
}
