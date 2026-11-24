namespace ChestCounter;

/// <summary>
/// Horas del tesoro (Cazatesoros, noviembre–diciembre de 2026): durante esas dos horas aumenta la probabilidad de los
/// tesoros (Acceso a la Tienda pirata ×1,5, Traje dorado ×7,5, vehículo ×10). Horario en UTC, como lo publica
/// fortnite.bot/treasure: cada sábado de 19:00 a 21:00 y la madrugada del domingo de 02:00 a 04:00. Se pasa a la hora
/// local de Windows al mostrarlo. Sin conexión: el horario va dentro de la aplicación.
/// </summary>
public static class TreasureHours
{
    public sealed record Window(DateTime StartUtc, DateTime EndUtc)
    {
        public DateTime StartLocal => StartUtc.ToLocalTime();
        public DateTime EndLocal => EndUtc.ToLocalTime();
    }

    public static readonly IReadOnlyList<Window> Schedule = new[]
    {
        W("2026-11-07T19:00"), W("2026-11-08T02:00"),
        new Window(Utc("2026-11-14T19:00"), Utc("2026-11-14T23:00")), W("2026-11-15T02:00"),
        W("2026-11-21T19:00"), W("2026-11-22T02:00"),
        W("2026-11-28T19:00"), W("2026-11-29T02:00"),
    };

    /// <summary>Hora del tesoro en curso, o null.</summary>
    public static Window? Active(DateTime utcNow) => All.FirstOrDefault(w => utcNow >= w.StartUtc && utcNow < w.EndUtc);

    /// <summary>Próxima Hora del tesoro (aún sin empezar), o null si ya no quedan.</summary>
    public static Window? Next(DateTime utcNow) => All.Where(w => w.StartUtc > utcNow).OrderBy(w => w.StartUtc).FirstOrDefault();

    /// <summary>
    /// Desarrollo: CHESTCOUNTER_TREASURE_PREVIEW=1 simula una Hora del tesoro en curso (modo dorado) y =2 una que
    /// empieza dentro de 3 horas (cuenta atrás del día).
    /// </summary>
    private static readonly IReadOnlyList<Window> All = Environment.GetEnvironmentVariable("CHESTCOUNTER_TREASURE_PREVIEW") switch
    {
        "1" => new[] { new Window(DateTime.UtcNow.AddMinutes(-15), DateTime.UtcNow.AddMinutes(105)) },
        "2" => new[] { new Window(DateTime.UtcNow.AddHours(3), DateTime.UtcNow.AddHours(5)) },
        _ => Schedule,
    };


    /// <summary>"sáb 21/11 16:00", en hora local.</summary>
    public static string When(Window w) => w.StartLocal.ToString("ddd dd/MM HH:mm", L.Culture);

    /// <summary>Cuenta atrás: "1 d 05:23:10", o "05:23:10" si queda menos de un día.</summary>
    public static string Countdown(TimeSpan left)
    {
        if (left < TimeSpan.Zero) left = TimeSpan.Zero;
        var clock = $"{left.Hours:00}:{left.Minutes:00}:{left.Seconds:00}";
        return left.Days > 0 ? $"{left.Days} d {clock}" : clock;
    }

    private static Window W(string startUtc) => new(Utc(startUtc), Utc(startUtc).AddHours(2));

    private static DateTime Utc(string s) =>
        DateTime.SpecifyKind(DateTime.ParseExact(s, "yyyy-MM-dd'T'HH:mm", System.Globalization.CultureInfo.InvariantCulture), DateTimeKind.Utc);
}
