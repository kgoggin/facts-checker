import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function imports(file: URL): string[] {
  const source = readFileSync(file, 'utf8');
  // Includes static imports, re-exports and literal dynamic imports, without a bundler.
  const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map(match => match[1]!);
}

test('the api import graph has no login modules, cookies or Node built-ins', () => {
  const visited = new Set<string>();
  function visit(file: URL) {
    if (visited.has(file.href)) return;
    visited.add(file.href);
    for (const specifier of imports(file)) {
      expect(specifier, `import from ${file.pathname}`).not.toMatch(/^(?:node:|tough-cookie(?:\/|$))/);
      if (specifier.startsWith('.')) {
        expect(specifier, `import from ${file.pathname}`).not.toMatch(/(?:^|\/)(?:auth|nelnet|protocol|totp)\.[cm]?[jt]s$/);
        visit(new URL(specifier.replace(/\.js$/, '.ts'), file));
      }
    }
  }
  visit(new URL('../src/api.ts', import.meta.url));
});

test('shared API and OAuth configuration has no imports', () => {
  expect(imports(new URL('../src/config.ts', import.meta.url))).toEqual([]);
});
