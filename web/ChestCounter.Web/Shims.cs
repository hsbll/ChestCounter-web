using System.Globalization;

namespace ChestCounter;

// Small stand-ins for the desktop classes the shared files refer to. The page is translated in JavaScript:
// here every text stays in its internal (English) form.

/// <summary>Texts of the shared code: the web page shows its own, so the English one is kept.</summary>
public static class L
{
    public static string Code => "en";
    public static bool En => true;
    public static CultureInfo Culture => CultureInfo.InvariantCulture;
    public static string T(string es, string en) => en;
    public static string F(string es, string en, params object?[] args) => string.Format(CultureInfo.InvariantCulture, en, args);
    public static string N(int n) => n.ToString("0", CultureInfo.InvariantCulture);
    public static string Count(int n, string esOne, string esMany, string enOne, string enMany) => $"{N(n)} {(n == 1 ? enOne : enMany)}";
    public static string Upgrade(string stored) => stored;
    public static string Name(string? stored) => stored ?? "";
}

/// <summary>No OBS page in the web version (only the default port constant is referenced by the settings model).</summary>
public static class ObsServer
{
    public const int DefaultPort = 7373;
}

/// <summary>No log file in the browser: errors go to the console.</summary>
public static class ErrorLog
{
    public static void Write(string message, Exception? ex = null) => Console.Error.WriteLine(ex == null ? message : $"{message}: {ex}");
}
