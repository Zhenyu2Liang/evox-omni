import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function moduleImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const specifier = node.arguments[0];
      expect(specifier && ts.isStringLiteral(specifier), `Computed module dependency in ${file}`).toBe(true);
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function familyFiles(directory: string): string[] {
  return readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => path.join(directory, name));
}

function assertAcyclic(files: string[]): void {
  const known = new Set(files);
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (file: string) => {
    expect(active.has(file), `Circular dependency at ${path.relative(projectRoot, file)}`).toBe(false);
    if (visited.has(file)) return;
    active.add(file);
    for (const specifier of moduleImports(file)) {
      if (!specifier.startsWith('.')) continue;
      const dependency = path.resolve(path.dirname(file), `${specifier}.ts`);
      if (known.has(dependency)) visit(dependency);
    }
    active.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
}

describe('Orchestration module boundaries', () => {
  it('keeps every mock family isolated from persistence, live providers and banking execution', () => {
    const directory = path.join(projectRoot, 'agent/providers/mock');
    for (const file of familyFiles(directory)) {
      for (const specifier of moduleImports(file)) {
        const allowed = specifier === '@earendil-works/pi-ai' ||
          ['@/lib/money', '@/lib/clock', '@/lib/date', '@/lib/contracts/intent', '@/lib/contracts/spending', '@/lib/contracts/tool-catalog'].includes(specifier) ||
          (specifier === '../../guidance-messages' && ['conversation-guidance.ts', 'classifier.ts'].includes(path.basename(file))) ||
          (specifier.startsWith('../../messages/') && path.basename(file) === 'invalid-amount-response.ts') ||
          (specifier === '../../banking-guidance' && path.basename(file) === 'action-follow-up.ts') ||
          (specifier.startsWith('./') && path.resolve(path.dirname(file), specifier).startsWith(`${directory}${path.sep}`));
        expect(allowed, `${path.basename(file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('keeps the production guidance vocabulary free from natural-language request parsing', () => {
    expect(moduleImports(path.join(projectRoot, 'agent/guidance-messages.ts'))).toEqual(['./messages/conversation.zh-CN.json']);
    expect(moduleImports(path.join(projectRoot, 'agent/providers/mock/request-command-patterns.ts'))).toEqual([]);
    expect(moduleImports(path.join(projectRoot, 'agent/providers/mock/request-steps.ts'))).toEqual(['./request-command-patterns']);
  });

  it('keeps conversational request selection free from persistence or provider dependencies', () => {
    const policy = path.join(projectRoot, 'agent/providers/mock/conversation-policy.ts');
    expect(moduleImports(policy)).toEqual(['./request-amounts', './advisory-policy']);
    expect(moduleImports(path.join(projectRoot, 'agent/providers/mock/advisory-policy.ts'))).toEqual([]);
    expect(moduleImports(path.join(projectRoot, 'agent/providers/mock/request-amounts.ts'))).toEqual([]);
  });

  it('keeps mock routing, parsers and narration acyclic', () => {
    assertAcyclic(familyFiles(path.join(projectRoot, 'agent/providers/mock')));
  });

  it('keeps confirmation responsibilities independent of their public facade', () => {
    const directory = path.join(projectRoot, 'agent/confirmation');
    const files = familyFiles(directory);
    for (const file of files) {
      expect(moduleImports(file), path.basename(file)).not.toContain('../confirmation');
    }
    assertAcyclic(files);
  });

  it('keeps turn presentation independent of entry points and durable recovery drivers', () => {
    const files = familyFiles(path.join(projectRoot, 'agent/turns'));
    const forbidden = new Set([
      path.join(projectRoot, 'agent/run-turn.ts'),
      path.join(projectRoot, 'agent/turn-presentation.ts'),
      path.join(projectRoot, 'agent/durable/service.ts'),
      path.join(projectRoot, 'agent/durable/continuation.ts'),
    ]);
    for (const file of files) {
      for (const specifier of moduleImports(file)) {
        const target = specifier.startsWith('.') ? path.resolve(path.dirname(file), `${specifier}.ts`)
          : specifier.startsWith('@/') ? path.join(projectRoot, `${specifier.slice(2)}.ts`) : '';
        expect(forbidden.has(target), `${path.basename(file)} imports ${specifier}`).toBe(false);
      }
    }
    assertAcyclic(files);
  });
});
