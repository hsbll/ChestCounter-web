using FortniteReplayReader.Models;
using FortniteReplayReader.Models.NetFieldExports;
using Unreal.Core.Contracts;
using Unreal.Core.Models.Enums;

namespace ChestCounter.Web;

// Web-only analysis, kept out of the files shared with the desktop tool: where the player stood when each chest
// was opened, and whether that spot was in the storm at that moment. It reads the replay a second time, in the
// parser's "full" mode (the only one that carries player positions).

/// <summary>One closing of the storm: from <see cref="Start"/> to <see cref="Finish"/> (seconds of the match clock) the safe circle shrinks to this centre and radius.</summary>
public sealed class StormPhase
{
    public double Start { get; set; }
    public double Finish { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Radius { get; set; }
}

/// <summary>Where the player was at one moment, against the storm of that moment.</summary>
public sealed class StormPoint
{
    public double X { get; set; }
    public double Y { get; set; }
    /// <summary>True: outside the safe circle (in the storm). Null: no circle known for that moment.</summary>
    public bool? InStorm { get; set; }
    /// <summary>0 before the first circle starts closing, then 1, 2, 3…</summary>
    public int Phase { get; set; }
    /// <summary>The circle was moving at that moment: its edge is interpolated, so a spot close to it is uncertain.</summary>
    public bool Closing { get; set; }
    /// <summary>Distance to the edge of the safe circle, in metres: negative inside the circle, positive in the storm.</summary>
    public double? EdgeMeters { get; set; }
}

public sealed class StormInfo
{
    public List<StormPhase> Phases { get; set; } = new();
    /// <summary>One entry per chest of the match, in the same order (null: no position found near that moment).</summary>
    public List<StormPoint?> Chests { get; set; } = new();
    /// <summary>One entry per treasure of the match, in the same order.</summary>
    public List<StormPoint?> Treasures { get; set; } = new();
    /// <summary>Why there is no data, when there is none.</summary>
    public string? Note { get; set; }
}

public static class StormAnalyzer
{
    /// <summary>Bumped when the way of computing this changes: the page reads replays again.</summary>
    public const int Version = 1;

    /// <summary>A position further than this (seconds) from the chest moment is not trusted.</summary>
    private const double MaxPositionGap = 8;
    /// <summary>The circle before the first closing is not in the replay: it is taken as this many times the first target.</summary>
    private const double FirstCircleFactor = 2.2;

    public static StormInfo Analyze(byte[] data, MatchRecord match)
    {
        var info = new StormInfo();
        var reader = new StormReader();
        FortniteReplay replay;
        using (var stream = new MemoryStream(data, writable: false))
        {
            replay = reader.ReadReplay(stream);
        }

        info.Phases = BuildPhases(replay.MapData?.SafeZones);
        var track = BuildTrack(replay, match);
        if (track.Count == 0)
        {
            info.Note = "no positions for the player in this replay";
        }

        foreach (var chest in match.Chests)
        {
            info.Chests.Add(Locate(chest.TimeSeconds, reader, track, info.Phases));
        }
        foreach (var find in match.TreasureFinds)
        {
            info.Treasures.Add(find.ObtainedAtSeconds is float t ? Locate(t, reader, track, info.Phases) : null);
        }
        return info;
    }

    /// <summary>The parser adds one entry per update of the storm, often partial: they are merged per closing.</summary>
    private static List<StormPhase> BuildPhases(IList<SafeZone>? zones)
    {
        var phases = new List<StormPhase>();
        if (zones == null) return phases;
        foreach (var zone in zones.OrderBy(z => z.StartShrinkTime))
        {
            if (zone.FinishShrinkTime <= 0 || zone.FinishShrinkTime < zone.StartShrinkTime) continue;
            var last = phases.Count > 0 ? phases[^1] : null;
            var same = last != null && Math.Abs(last.Start - zone.StartShrinkTime) < 1;
            var phase = same ? last! : new StormPhase { Start = zone.StartShrinkTime };
            phase.Finish = zone.FinishShrinkTime;
            if (zone.NextRadius > 0) phase.Radius = zone.NextRadius;
            if (zone.NextCenter != null) { phase.X = zone.NextCenter.X; phase.Y = zone.NextCenter.Y; }
            if (!same) phases.Add(phase);
        }
        phases.RemoveAll(p => p.Radius <= 0);
        return phases;
    }

    /// <summary>Positions of the counted player (match clock, x, y), in time order.</summary>
    private static List<(double Time, double X, double Y)> BuildTrack(FortniteReplay replay, MatchRecord match)
    {
        var players = (replay.PlayerData ?? Enumerable.Empty<PlayerData>()).ToList();
        var mine = players.Where(p => !string.IsNullOrEmpty(match.EpicId) && string.Equals(p.EpicId, match.EpicId, StringComparison.OrdinalIgnoreCase)).ToList();
        if (mine.Count == 0) mine = players.Where(p => p.IsReplayOwner).ToList();

        var track = new List<(double, double, double)>();
        foreach (var move in mine.SelectMany(p => p.Locations))
        {
            var time = move.ReplicatedWorldTimeSecondsDouble ?? move.ReplicatedWorldTimeSeconds;
            var location = move.ReplicatedMovement?.Location;
            if (time is null or <= 0 || location == null) continue;
            track.Add((time.Value, location.X, location.Y));
        }
        track.Sort((a, b) => a.Item1.CompareTo(b.Item1));
        return track;
    }

    private static StormPoint? Locate(float replaySeconds, StormReader reader, List<(double Time, double X, double Y)> track, List<StormPhase> phases)
    {
        if (track.Count == 0 || reader.ToMatchClock(replaySeconds) is not double clock) return null;

        // Nearest position in time.
        int lo = 0, hi = track.Count - 1;
        while (lo < hi)
        {
            var mid = (lo + hi) / 2;
            if (track[mid].Time < clock) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && Math.Abs(track[lo - 1].Time - clock) <= Math.Abs(track[lo].Time - clock)) lo--;
        var spot = track[lo];
        if (Math.Abs(spot.Time - clock) > MaxPositionGap) return null;

        var point = new StormPoint { X = Math.Round(spot.X), Y = Math.Round(spot.Y) };
        if (phases.Count == 0) return point;

        var index = phases.FindLastIndex(p => p.Start <= clock);
        if (index < 0)
        {
            // Before the first closing: the whole island is safe.
            point.InStorm = false;
            return point;
        }

        var phase = phases[index];
        point.Phase = index + 1;
        double x = phase.X, y = phase.Y, radius = phase.Radius;
        if (clock < phase.Finish)
        {
            point.Closing = true;
            var progress = phase.Finish > phase.Start ? (clock - phase.Start) / (phase.Finish - phase.Start) : 1;
            var fromX = index > 0 ? phases[index - 1].X : phase.X;
            var fromY = index > 0 ? phases[index - 1].Y : phase.Y;
            var fromRadius = index > 0 ? phases[index - 1].Radius : phase.Radius * FirstCircleFactor;
            x = fromX + (phase.X - fromX) * progress;
            y = fromY + (phase.Y - fromY) * progress;
            radius = fromRadius + (phase.Radius - fromRadius) * progress;
        }
        var edge = Math.Sqrt((spot.X - x) * (spot.X - x) + (spot.Y - y) * (spot.Y - y)) - radius;
        point.InStorm = edge > 0;
        point.EdgeMeters = Math.Round(edge / 100, 1); // Unreal units are centimetres
        return point;
    }

    /// <summary>Reads the replay in full mode and keeps the pairs (replay time, match clock) seen along the way.</summary>
    private sealed class StormReader : FortniteReplayReader.ReplayReader
    {
        private readonly List<(float Replay, double Clock)> _clock = new();

        public StormReader() : base(null, ParseMode.Full)
        {
        }

        protected override void OnExportRead(uint channelIndex, INetFieldExportGroup? exportGroup)
        {
            base.OnExportRead(channelIndex, exportGroup);
            if (exportGroup is GameState state && (state.ReplicatedWorldTimeSecondsDouble ?? state.ReplicatedWorldTimeSeconds) is { } clock and > 0)
            {
                var now = Unreal.Core.ReplayReader<FortniteReplay>.CurrentTime;
                if (_clock.Count == 0 || now > _clock[^1].Replay) _clock.Add((now, clock));
            }
        }

        /// <summary>Chest times are in replay time; the storm and the positions use the match clock.</summary>
        public double? ToMatchClock(float replaySeconds)
        {
            if (_clock.Count == 0) return null;
            var index = _clock.FindLastIndex(c => c.Replay <= replaySeconds);
            var sample = _clock[Math.Max(index, 0)];
            return sample.Clock + (replaySeconds - sample.Replay);
        }
    }
}
