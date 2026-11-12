// Usage: node web/stamp-version.mjs <published wwwroot> <version>
// Writes the version into the page and adds it to every address the page loads its own files from
// (style.css?v=…, app.js?v=…, import './stats.js?v=…'), so a browser never mixes files of two versions.
// The .NET files in _framework are left alone: their names already change with their content.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [root, version] = process.argv.slice(2);
if (!root || !/^[\w.-]+$/.test(version ?? '')) {
    console.error('usage: node stamp-version.mjs <wwwroot> <version>   (version: letters, digits, dot, dash)');
    process.exit(1);
}
const tag = `?v=${version}`;

const htmlPath = join(root, 'index.html');
let html = await readFile(htmlPath, 'utf8');
const before = html;
html = html
    .replace('<meta name="app-version" content="dev">', `<meta name="app-version" content="${version}">`)
    .replace('href="style.css"', `href="style.css${tag}"`)
    .replace('src="app.js"', `src="app.js${tag}"`);
if (html === before || !html.includes(`content="${version}"`) || !html.includes(`app.js${tag}`) || !html.includes(`style.css${tag}`)) {
    console.error('index.html does not have the expected version placeholders');
    process.exit(1);
}
await writeFile(htmlPath, html);

let stamped = 0;
for (const name of (await readdir(root)).filter(file => file.endsWith('.js'))) {
    const path = join(root, name);
    const source = await readFile(path, 'utf8');
    // Static imports and the worker address; the dynamic import of ./_framework/dotnet.js does not match.
    const result = source
        .replace(/(\bfrom\s+['"]\.\/[\w-]+\.js)(['"])/g, `$1${tag}$2`)
        .replace(/(new URL\(\s*['"]\.\/[\w-]+\.js)(['"])/g, `$1${tag}$2`);
    if (result !== source) {
        await writeFile(path, result);
        stamped++;
    }
}
console.log(`version ${version}: index.html and ${stamped} script(s) stamped`);
