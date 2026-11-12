// Starts the .NET WebAssembly runtime and returns the exported C# functions (ChestCounter.Web.Interop).
// onProgress(loaded, total) follows the download of the runtime files (first visit: several megabytes);
// onStage(name) says how far the start got. Each stage is also written to the console, to tell where a start stalls.
export async function loadAnalyzer(onProgress, onStage = () => {}) {
    const where = typeof document === 'undefined' ? 'worker' : 'page';
    const stage = name => {
        console.info(`[Chest Lookout] ${where}: ${name}`);
        try { onStage(name); } catch { /* display only */ }
    };

    stage('loading dotnet.js');
    const { dotnet } = await import('./_framework/dotnet.js');
    stage('starting the runtime');
    let builder = dotnet;
    if (onProgress && typeof dotnet.withModuleConfig === 'function') {
        builder = dotnet.withModuleConfig({
            onDownloadResourceProgress: (loaded, total) => { try { onProgress(loaded, total); } catch { /* display only */ } },
        });
    }
    // .NET 10 has reports of the interpreter stalling in long loops with its SSA optimisation on; turning it off
    // costs a little speed in interpreted code only (none in the ahead-of-time compiled build).
    if (typeof builder.withEnvironmentVariable === 'function') {
        builder = builder.withEnvironmentVariable('MONO_INTERPRETER_OPTIONS', '-ssa');
    }
    const { getAssemblyExports, getConfig } = await builder.create();
    stage('runtime started, loading the analyzer');
    const exports = await getAssemblyExports(getConfig().mainAssemblyName ?? 'ChestCounter.Web');
    const api = exports?.ChestCounter?.Web?.Interop;
    if (!api) throw new Error('as funções do analisador não foram encontradas');
    stage('ready');
    return api;
}
