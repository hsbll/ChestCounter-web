using System.Text.Json;
using System.Text.Json.Serialization;

namespace ChestCounter.Web;

/// <summary>What the page receives for one replay file.</summary>
public sealed class AnalysisResult
{
    /// <summary>"ok", "recording" (match still being recorded: no key yet), "invalid" (not a replay) or "error".</summary>
    public string Status { get; set; } = "ok";
    public string? Message { get; set; }
    /// <summary>False for a Fortnite version the desktop tool does not count either (before v43).</summary>
    public bool SupportedVersion { get; set; }
    public MatchRecord? Match { get; set; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(AnalysisResult))]
internal sealed partial class WebJson : JsonSerializerContext;

public static class WebAnalyzer
{
    private const uint FileMagic = 0x1CA2E27F;

    /// <summary>Analyzes one .replay file held in memory and returns an <see cref="AnalysisResult"/> as JSON.</summary>
    public static string AnalyzeToJson(byte[] data, string fileName) =>
        JsonSerializer.Serialize(Analyze(data, fileName), WebJson.Default.AnalysisResult);

    public static AnalysisResult Analyze(byte[] data, string fileName)
    {
        switch (ProbeHeader(data))
        {
            case HeaderState.NotAReplay:
                return new AnalysisResult { Status = "invalid", Message = "not a Fortnite replay file" };
            case HeaderState.KeyMissing:
                return new AnalysisResult { Status = "recording", Message = "match still being recorded (no encryption key yet)" };
        }

        try
        {
            using var stream = new MemoryStream(data, writable: false);
            // Same call as the desktop tool: the player who recorded the replay is the one counted.
            var match = new ReplayAnalyzer().Analyze(stream, fileName, "");
            match.ReplayFile = fileName;
            return new AnalysisResult { Status = "ok", Match = match, SupportedVersion = Profiles.IsSupportedVersion(match) };
        }
        catch (Exception ex)
        {
            var inner = (ex as AggregateException)?.InnerException ?? ex;
            return new AnalysisResult { Status = "error", Message = $"{inner.GetType().Name}: {inner.Message}" };
        }
    }

    private enum HeaderState { Readable, NotAReplay, KeyMissing }

    /// <summary>
    /// Same reading of the file header as the desktop tool (ReplayHeaderProbe). Fortnite writes the real encryption
    /// key only when the match ends: a replay still flagged "live" whose key is all zeros cannot be read yet.
    /// </summary>
    private static HeaderState ProbeHeader(byte[] data)
    {
        try
        {
            using var br = new BinaryReader(new MemoryStream(data, writable: false));
            var fs = br.BaseStream;
            if (br.ReadUInt32() != FileMagic) return HeaderState.NotAReplay;
            var fileVersion = br.ReadUInt32();
            if (fileVersion >= 7)
            {
                var count = br.ReadInt32();
                if (count < 0 || count > 64) return HeaderState.Readable; // unknown layout: let the parser decide
                fs.Seek(count * 20L, SeekOrigin.Current);
            }
            fs.Seek(12, SeekOrigin.Current); // length, network version, changelist
            var len = br.ReadInt32(); // friendly name
            fs.Seek(len < 0 ? -2L * len : len, SeekOrigin.Current);
            var live = br.ReadUInt32() != 0;
            br.ReadInt64(); // timestamp
            br.ReadUInt32(); // compressed
            if (!live || br.ReadUInt32() == 0) return HeaderState.Readable; // finished, or not encrypted
            var keyLen = br.ReadInt32();
            if (keyLen <= 0 || keyLen > 256) return HeaderState.Readable;
            return br.ReadBytes(keyLen).All(b => b == 0) ? HeaderState.KeyMissing : HeaderState.Readable;
        }
        catch (Exception e) when (e is EndOfStreamException or IOException or ArgumentException)
        {
            return data.Length < 8 ? HeaderState.NotAReplay : HeaderState.Readable;
        }
    }
}
