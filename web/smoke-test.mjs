// Usage: node web/smoke-test.mjs <published wwwroot> <file.replay>
// Starts the published .NET runtime and analyzes one replay, the way the page does.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, replay] = process.argv.slice(2);
const { dotnet } = await import(pathToFileURL(resolve(root, '_framework/dotnet.js')).href);
const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName ?? 'ChestCounter.Web');
const api = exports.ChestCounter.Web.Interop;

console.log('analyzer version', api.AnalyzerVersion());
const junk = JSON.parse(api.Analyze(new Uint8Array([1, 2, 3]), 'junk.replay'));
if (junk.status !== 'invalid') throw new Error(`junk input: expected "invalid", got ${JSON.stringify(junk)}`);

const started = Date.now();
const result = JSON.parse(api.Analyze(new Uint8Array(await readFile(replay)), 'sample.replay'));
console.log(`sample read in ${Date.now() - started} ms:`, result.status, result.message ?? '', result.match?.playerName, result.match?.gameVersion);
if (result.status !== 'ok' || !result.match?.playerName) throw new Error('the sample replay was not decoded');
console.log('smoke test passed');
process.exit(0);
