using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace ChestCounter.Web;

/// <summary>Entry points called from the page (wwwroot/engine.js).</summary>
[SupportedOSPlatform("browser")]
public static partial class Interop
{
    /// <summary>Analyzes one replay (the bytes of the file) and returns the result as JSON.</summary>
    [JSExport]
    internal static string Analyze(byte[] data, string fileName) => WebAnalyzer.AnalyzeToJson(data, fileName);

    /// <summary>Version of the analysis: a replay analyzed by an older one is worth reading again.</summary>
    [JSExport]
    internal static int AnalyzerVersion() => ReplayAnalyzer.CurrentVersion;
}
