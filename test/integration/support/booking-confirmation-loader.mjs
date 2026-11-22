import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../../../', import.meta.url);
const aliases = ['common', 'contracts', 'messaging'];

// A subprocess cannot use Vitest's transform pipeline. Preserve the same legacy
// decorators as the production compiler, including Nest/TypeORM type metadata.
export async function resolve(specifier, context, nextResolve) {
  for (const name of aliases) {
    if (specifier === `@app/${name}` || specifier.startsWith(`@app/${name}/`)) {
      const tail =
        specifier === `@app/${name}`
          ? 'index'
          : specifier.slice(`@app/${name}/`.length).replace(/\.js$/, '');
      return {
        url: new URL(`libs/${name}/src/${tail}.ts`, root).href,
        shortCircuit: true,
      };
    }
  }
  if (
    specifier.endsWith('.js') &&
    specifier.startsWith('.') &&
    context.parentURL?.startsWith(root.href) &&
    !context.parentURL.includes('/node_modules/')
  ) {
    const candidate = new URL(
      specifier.replace(/\.js$/, '.ts'),
      context.parentURL,
    );
    try {
      await access(candidate);
      return { url: candidate.href, shortCircuit: true };
    } catch {
      /* Actual JavaScript is delegated to Node. */
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (
    !url.startsWith(root.href) ||
    url.includes('/node_modules/') ||
    !url.endsWith('.ts')
  )
    return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const result = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      useDefineForClassFields: true,
    },
  });
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
