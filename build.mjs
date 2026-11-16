import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const output = new URL('dist/server/', root);
await mkdir(output, {recursive: true});

await Promise.all([
  ...Object.entries({'worker.mjs': 'index.js', 'audit.mjs': 'audit.mjs', 'profile.mjs': 'profile.mjs'})
    .map(([source, target]) => copyFile(new URL(source, root), new URL(target, output))),
  ...Object.entries({'index.html': 'page.mjs', 'profile.html': 'profile-page.mjs'})
    .map(async ([source, target]) => {
      const html = await readFile(new URL(source, root), 'utf8');
      await writeFile(new URL(target, output), 'export default ' + JSON.stringify(html) + ';\n');
    }),
]);
