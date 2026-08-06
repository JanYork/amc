import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join, relative} from 'node:path';
import test from 'node:test';
import {type Checker, type Type, API, TypeFlags} from 'typescript/unstable/sync';
import {SyntaxKind, type CallExpression, type Node, type SourceFile} from 'typescript/unstable/ast';
import {
	isAsExpression,
	isCallExpression,
	isIdentifier,
	isImportDeclaration,
	isNonNullExpression,
	isParameterDeclaration,
	isPropertyAccessExpression,
	isStringLiteral,
	isTypeAssertion,
} from 'typescript/unstable/ast/is';

type Finding = {
	file: string;
	line: number;
	column: number;
	message: string;
};

const repositoryRoot = process.cwd();
const sourceRoot = join(repositoryRoot, 'src');
const tsconfigPath = join(repositoryRoot, 'tsconfig.json');

const collectSourceFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
	const files: Array<string> = [];
	const entries = await readdir(directory, {withFileTypes: true});

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...await collectSourceFiles(entryPath));
			continue;
		}

		if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
			files.push(entryPath);
		}
	}

	return files.sort();
};

const isAnyType = (type: Type): boolean => (type.flags & TypeFlags.Any) !== 0;

const pushFinding = (findings: Array<Finding>, node: Node, message: string): void => {
	const sourceFile = node.getSourceFile();
	const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	findings.push({
		file: relative(repositoryRoot, sourceFile.fileName),
		line: line + 1,
		column: character + 1,
		message,
	});
};

const isFsImport = (specifier: string): boolean =>
	specifier === 'node:fs' || specifier.startsWith('node:fs/');

const isUiImport = (specifier: string): boolean =>
	specifier === 'ink' ||
	specifier.startsWith('ink/') ||
	specifier === 'react' ||
	specifier.startsWith('react/');

const isForbiddenCall = (node: CallExpression): boolean => {
	if (isIdentifier(node.expression)) {
		return node.expression.text === 'rm' || node.expression.text === 'rmdir' || node.expression.text === 'unlink';
	}

	if (isPropertyAccessExpression(node.expression)) {
		return (
			node.expression.name.text === 'rm' ||
			node.expression.name.text === 'rmdir' ||
			node.expression.name.text === 'unlink'
		);
	}

	return false;
};

const scanDirectiveComments = (findings: Array<Finding>, sourceFile: SourceFile): void => {
	const directivePattern = /@ts-ignore|@ts-expect-error|@ts-nocheck/g;
	const text = sourceFile.getFullText();
	let match = directivePattern.exec(text);

	while (match !== null) {
		const {line, character} = sourceFile.getLineAndCharacterOfPosition(match.index);
		findings.push({
			file: relative(repositoryRoot, sourceFile.fileName),
			line: line + 1,
			column: character + 1,
			message: `forbidden directive ${match[0]}`,
		});
		match = directivePattern.exec(text);
	}
};

const scanSourceFile = (
	findings: Array<Finding>,
	sourceFile: SourceFile,
	checker: Checker,
): void => {
	scanDirectiveComments(findings, sourceFile);
	const relativePath = relative(sourceRoot, sourceFile.fileName);
	const inTui = relativePath.startsWith('tui/');
	const inCli = relativePath.startsWith('cli/');
	const inCore = relativePath.startsWith('core/');

	const visit = (node: Node): void => {
		if (node.kind === SyntaxKind.AnyKeyword) {
			pushFinding(findings, node, 'explicit any keyword');
		}

		if (isAsExpression(node)) {
			pushFinding(findings, node, 'as expression');
		}

		if (isTypeAssertion(node)) {
			pushFinding(findings, node, 'angle-bracket type assertion');
		}

		if (isNonNullExpression(node)) {
			pushFinding(findings, node, 'non-null assertion');
		}

		if (isParameterDeclaration(node) && node.type === undefined && node.name.getText(sourceFile) !== 'this') {
			const parameterType = checker.getTypeAtLocation(node.name);

			if (parameterType !== undefined && isAnyType(parameterType)) {
				pushFinding(findings, node.name, 'parameter inferred as any');
			}
		}

		if (
			(inTui || inCli) &&
			isImportDeclaration(node) &&
			isStringLiteral(node.moduleSpecifier) &&
			isFsImport(node.moduleSpecifier.text)
		) {
			pushFinding(findings, node.moduleSpecifier, 'tui/cli must not import node:fs');
		}

		if (
			inCore &&
			isImportDeclaration(node) &&
			isStringLiteral(node.moduleSpecifier) &&
			isUiImport(node.moduleSpecifier.text)
		) {
			pushFinding(findings, node.moduleSpecifier, 'core must not import ink or react');
		}

		if (inCore && isIdentifier(node) && node.text === 'process') {
			pushFinding(findings, node, 'core must not access process');
		}

		if (
			isCallExpression(node)
			&& isForbiddenCall(node)
			&& !(relativePath === 'core/skills/permanent-delete.ts' && isIdentifier(node.expression) && node.expression.text === 'rm')
		) {
			pushFinding(findings, node.expression, 'rm/rmdir/unlink call is forbidden');
		}

		node.forEachChild(visit);
	};

	visit(sourceFile);
};

const formatFinding = (finding: Finding): string =>
	`${finding.file}:${finding.line}:${finding.column} ${finding.message}`;

test('production source stays within the agreed type-safety and layer boundaries', async () => {
	const fileNames = await collectSourceFiles(sourceRoot);
	const api = new API({cwd: repositoryRoot});
	const snapshot = api.updateSnapshot({openProjects: [tsconfigPath]});
	const project = snapshot.getProject(tsconfigPath);
	const findings: Array<Finding> = [];

	if (project === undefined) {
		api.close();
		assert.fail('project for tsconfig.json was not loaded');
	}

	for (const fileName of fileNames) {
		const sourceFile = project.program.getSourceFile(fileName);

		if (sourceFile !== undefined) {
			scanSourceFile(findings, sourceFile, project.checker);
		}
	}

	api.close();

	assert.equal(
		findings.length,
		0,
		findings.map(formatFinding).join('\n'),
	);

	const extractedCoreFileNames = [
		join(sourceRoot, 'core', 'index.ts'),
		join(sourceRoot, 'core', 'model.ts'),
		join(sourceRoot, 'core', 'layout.ts'),
		join(sourceRoot, 'core', 'skills', 'scan.ts'),
		join(sourceRoot, 'core', 'skills', 'toggle.ts'),
		join(sourceRoot, 'core', 'skills', 'migration.ts'),
		join(sourceRoot, 'core', 'skills', 'reconcile.ts'),
		join(sourceRoot, 'core', 'skills', 'permanent-delete.ts'),
	];
	const coreSources = await Promise.all(
		extractedCoreFileNames.map(async fileName => readFile(fileName, 'utf8')),
	);
	const renameCallCount = coreSources.reduce(
		(count, source) => count + (source.match(/\brename\(/gu)?.length ?? 0),
		0,
	);
	const migrationSource = await readFile(join(sourceRoot, 'core', 'skills', 'migration.ts'), 'utf8');
	const reconcileSource = await readFile(join(sourceRoot, 'core', 'skills', 'reconcile.ts'), 'utf8');
	assert.equal(renameCallCount, 1, 'rename() must have exactly one core call site');
	assert.equal(
		migrationSource.match(/\brename\(/gu)?.length,
		1,
		'rename() must be centralized behind the operation-root safety helper',
	);
	assert.equal(reconcileSource.match(/\bcp\(/gu)?.length ?? 0, 0, 'reconciliation must move, not copy, canonical Skill content');
	const allProductionSources = await Promise.all(fileNames.map(async fileName => readFile(fileName, 'utf8')));
	const deleteCallCount = coreSources.reduce(
		(count, source) => count + (source.match(/\brm\(/gu)?.length ?? 0),
		0,
	);
	const destructiveTokenCount = allProductionSources.reduce(
		(count, source) => count + (source.match(/\b(?:rm|rmdir|unlink)\b/gu)?.length ?? 0),
		0,
	);
	const permanentDeleteSource = await readFile(join(sourceRoot, 'core', 'skills', 'permanent-delete.ts'), 'utf8');
	assert.equal(deleteCallCount, 1, 'rm() must have exactly one approved core call site');
	assert.equal(destructiveTokenCount, 2, 'only the approved rm import and call may exist in production source');
	assert.equal(
		permanentDeleteSource.match(/\brm\(/gu)?.length,
		1,
		'rm() must stay inside the permanent-delete containment primitive',
	);
});
