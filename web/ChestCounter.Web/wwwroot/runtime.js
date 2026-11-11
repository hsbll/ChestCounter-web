// Starts the .NET WebAssembly runtime and returns the exported C# functions (ChestCounter.Web.Interop).
export async function loadAnalyzer() {
    const { dotnet } = await import('./_framework/dotnet.js');
    const { getAssemblyExports, getConfig } = await dotnet.create();
    const exports = await getAssemblyExports(getConfig().mainAssemblyName ?? 'ChestCounter.Web');
    return exports.ChestCounter.Web.Interop;
}
