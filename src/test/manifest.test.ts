import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// Tests run from out-test/, one level below the repository root.
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const contributes = pkg.contributes;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('package.json', () => {
  it('only lets user settings define quick actions (they run shell commands)', () => {
    const scope = contributes.configuration.properties['agntree.quickActions'].scope;
    // "application" and "machine" are the scopes VS Code refuses in workspace .vscode/settings.json.
    assert.ok(['application', 'machine'].includes(scope), `agntree.quickActions scope is ${scope}`);
  });

  it('scopes every keybinding with a when clause, so none override built-ins like Save As', () => {
    for (const binding of contributes.keybindings ?? []) {
      assert.ok(binding.when, `${binding.command} (${binding.key}) has no when clause`);
    }
  });

  it('declares every command its menus, keybindings and welcome views reference', () => {
    const declared = new Set(contributes.commands.map((c: { command: string }) => c.command));
    const referenced = new Set<string>();
    for (const items of Object.values(contributes.menus) as { command: string }[][]) {
      items.forEach((item) => referenced.add(item.command));
    }
    (contributes.keybindings ?? []).forEach((k: { command: string }) => referenced.add(k.command));
    for (const view of contributes.viewsWelcome) {
      for (const match of (view.contents as string).matchAll(/command:([\w.]+)/g)) {
        referenced.add(match[1]);
      }
    }
    const missing = [...referenced].filter((command) => !declared.has(command));
    assert.deepEqual(missing, []);
  });

  it('registers a handler for every declared command', () => {
    const source = sourceFiles(path.join(root, 'src')).map((file) => fs.readFileSync(file, 'utf-8')).join('\n');
    const registered = new Set([...source.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]));
    const unregistered = contributes.commands
      .map((c: { command: string }) => c.command)
      .filter((command: string) => !registered.has(command));
    assert.deepEqual(unregistered, []);
  });
});
