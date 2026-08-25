'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the package has zero runtime dependencies', () => {
	// n8n: "verified community nodes aren't allowed to use any run-time
	// dependencies". This is the check the whole packaging strategy rests on.
	assert.deepEqual(pkg.dependencies ?? {}, {});
	assert.deepEqual(pkg.peerDependencies, { 'n8n-workflow': '*' });
	assert.ok(pkg.devDependencies['@n8n/node-cli'], 'the n8n node CLI must be a devDependency');
});

test('package.json carries what the community-node checks look for', () => {
	assert.ok(pkg.name.startsWith('n8n-nodes-'), `bad package name: ${pkg.name}`);
	assert.equal(pkg.license, 'MIT');
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'the version must be semver');
	assert.ok(pkg.description);
	assert.ok(pkg.author.name && pkg.author.email);
	assert.ok(new URL(pkg.homepage));
	assert.match(pkg.repository.url, /github\.com\/fstandhartinger\/n8n-nodes-docmint/);
	assert.deepEqual(pkg.files, ['dist', '!dist/*.tsbuildinfo']);

	assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
	for (const entry of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
		assert.ok(entry.startsWith('dist/'), `n8n entry must start with dist/: ${entry}`);
		assert.ok(fs.existsSync(path.join(root, entry)), `built file missing: ${entry}`);
	}

	// A lifecycle script that runs on install is banned in community packages.
	for (const banned of ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish']) {
		assert.equal(pkg.scripts[banned], undefined, `forbidden lifecycle script: ${banned}`);
	}
});

test('the node never reads the environment, the filesystem, or spawns anything', () => {
	const sources = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.ts')) sources.push(full);
		}
	};
	walk(path.join(root, 'nodes'));
	walk(path.join(root, 'credentials'));
	assert.ok(sources.length >= 6, 'expected the node sources to be found');

	for (const file of sources) {
		const code = fs.readFileSync(file, 'utf8');
		for (const banned of ['process.env', "require('fs')", "require('node:fs')", 'child_process']) {
			assert.ok(!code.includes(banned), `${path.relative(root, file)} uses ${banned}`);
		}
	}
});

test('the interface and the documentation are English only', () => {
	const files = [
		path.join(root, 'README.md'),
		...fs
			.readdirSync(path.join(root, 'nodes', 'DocMint'))
			.filter((f) => f.endsWith('.ts'))
			.map((f) => path.join(root, 'nodes', 'DocMint', f)),
	];
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		const hits = text.match(/[äöüßÄÖÜ]/g);
		assert.equal(hits, null, `${path.relative(root, file)} contains non-English characters`);
	}
});

test('the tarball npm would publish contains the node, credential, icons, README and licence', () => {
	const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	const files = JSON.parse(output)[0].files.map((f) => f.path);

	for (const expected of [
		'dist/nodes/DocMint/DocMint.node.js',
		'dist/nodes/DocMint/DocMint.node.json',
		'dist/nodes/DocMint/docmint.svg',
		'dist/nodes/DocMint/docmint.dark.svg',
		'dist/credentials/DocMintApi.credentials.js',
		'dist/credentials/docmint.svg',
		'dist/credentials/docmint.dark.svg',
		'README.md',
		'LICENSE.md',
		'package.json',
	]) {
		assert.ok(files.includes(expected), `missing from the published package: ${expected}`);
	}
	assert.equal(
		files.filter((f) => f.endsWith('.js.map')).length,
		0,
		'source maps must not be published',
	);
	// tsc writes an incremental build cache into the output directory even with
	// --noEmit, and it has no business in a published package.
	assert.equal(
		files.filter((f) => f.endsWith('.tsbuildinfo')).length,
		0,
		'the TypeScript build cache must not be published',
	);
});
