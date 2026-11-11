// Starts the .NET WebAssembly runtime and returns the exported C# functions (ChestCounter.Web.Interop).
// onProgress(loaded, total) follows the download of the runtime files (first visit: several megabytes).
export async function loadAnalyzer(onProgress) {
    const { dotnet } = await import('./_framework/dotnet.js');
    let builder = dotnet;
    if (onProgress && typeof dotnet.withModuleConfig === 'function') {
        builder = dotnet.withModuleConfig({
            onDownloadResourceProgress: (loaded, total) => { try { onProgress(loaded, total); } catch { /* display only */ } },
        });
    }
    const { getAssemblyExports, getConfig } = await builder.create();
    const exports = await getAssemblyExports(getConfig().mainAssemblyName ?? 'ChestCounter.Web');
    return exports.ChestCounter.Web.Interop;
}
