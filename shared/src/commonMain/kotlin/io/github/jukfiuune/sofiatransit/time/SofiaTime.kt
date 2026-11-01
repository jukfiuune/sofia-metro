package io.github.jukfiuune.sofiatransit.time

/** A wall-clock moment in Sofia. */
data class SofiaDateTime(
    val year: Int,
    val month: Int,
    val day: Int,
    val hour: Int,
    val minute: Int,
    val second: Int,
) {
    /** "YYYYMMDD", the date format of GTFS calendars. */
    val ymd: String get() = ymd(year, month, day)
    val hhmm: String get() = "${pad2(hour)}:${pad2(minute)}"
    val hhmmss: String get() = "$hhmm:${pad2(second)}"
}

/** A moment as a service day and seconds since that day's midnight (may pass 24 h). */
data class ServiceTime(val day: String, val seconds: Int)

/**
 * Time in Sofia (Europe/Sofia: EET, UTC+2, and EEST, UTC+3, from the last Sunday of
 * March to the last Sunday of October, switching at 01:00 UTC). The rule is built in
 * so every platform gets the same answer without a time zone database.
 */
object SofiaTime {
    /** Service days change at 03:00: a night's last trips belong to the day before. */
    const val DAY_START = 3 * 3600

    private const val MS_PER_DAY = 86_400_000L

    /** Offset from UTC in seconds at an instant. */
    fun offsetSeconds(epochMs: Long): Int {
        val year = civilFromDays(floorDiv(epochMs, MS_PER_DAY)).first
        val start = lastSunday(year, 3) * MS_PER_DAY + 3_600_000L
        val end = lastSunday(year, 10) * MS_PER_DAY + 3_600_000L
        return if (epochMs in start until end) 3 * 3600 else 2 * 3600
    }

    fun at(epochMs: Long): SofiaDateTime {
        val local = epochMs + offsetSeconds(epochMs) * 1000L
        val days = floorDiv(local, MS_PER_DAY)
        val (y, m, d) = civilFromDays(days)
        val sec = ((local - days * MS_PER_DAY) / 1000).toInt()
        return SofiaDateTime(y, m, d, sec / 3600, sec / 60 % 60, sec % 60)
    }

    /** The service day running at an instant, and the seconds since its midnight. */
    fun serviceTime(epochMs: Long): ServiceTime {
        val t = at(epochMs)
        val sec = t.hour * 3600 + t.minute * 60 + t.second
        if (sec >= DAY_START) return ServiceTime(t.ymd, sec)
        val (y, m, d) = civilFromDays(daysFromCivil(t.year, t.month, t.day) - 1)
        return ServiceTime(ymd(y, m, d), sec + 86_400)
    }

    /** Days since 1970-01-01 of the last Sunday of a month. */
    private fun lastSunday(year: Int, month: Int): Long {
        val last = daysFromCivil(year, month + 1, 1) - 1
        return last - floorMod(last + 4, 7)   // 1970-01-01 was a Thursday
    }
}

internal fun pad2(n: Int) = if (n < 10) "0$n" else "$n"

internal fun ymd(y: Int, m: Int, d: Int) = "$y${pad2(m)}${pad2(d)}"

private fun floorDiv(a: Long, b: Long): Long {
    val q = a / b
    return if (a % b != 0L && (a < 0) != (b < 0)) q - 1 else q
}

private fun floorMod(a: Long, b: Int) = ((a % b) + b) % b

// Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian).
internal fun daysFromCivil(year: Int, month: Int, day: Int): Long {
    var y = year.toLong()
    var m = month.toLong()
    if (m > 12) { y += (m - 1) / 12; m = (m - 1) % 12 + 1 }
    if (m <= 2) y -= 1
    val era = (if (y >= 0) y else y - 399) / 400
    val yoe = y - era * 400
    val mp = (m + 9) % 12
    val doy = (153 * mp + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

internal fun civilFromDays(days: Long): Triple<Int, Int, Int> {
    val z = days + 719_468
    val era = (if (z >= 0) z else z - 146_096) / 146_097
    val doe = z - era * 146_097
    val yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val d = (doy - (153 * mp + 2) / 5 + 1).toInt()
    val m = (if (mp < 10) mp + 3 else mp - 9).toInt()
    val y = (yoe + era * 400 + if (m <= 2) 1 else 0).toInt()
    return Triple(y, m, d)
}
