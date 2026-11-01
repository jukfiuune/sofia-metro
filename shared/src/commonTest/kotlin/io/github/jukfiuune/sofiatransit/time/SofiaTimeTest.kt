package io.github.jukfiuune.sofiatransit.time

import kotlin.test.Test
import kotlin.test.assertEquals

class SofiaTimeTest {
    // Epoch ms of a UTC wall-clock time.
    private fun utc(y: Int, mo: Int, d: Int, h: Int, mi: Int) =
        (daysFromCivil(y, mo, d) * 86_400 + h * 3600 + mi * 60) * 1000

    @Test
    fun winterAndSummerOffsets() {
        assertEquals("12:00", SofiaTime.at(utc(2026, 1, 15, 10, 0)).hhmm)
        assertEquals("13:00", SofiaTime.at(utc(2026, 7, 15, 10, 0)).hhmm)
    }

    @Test
    fun switchesAtOneUtcOnLastSundays() {
        // 2026: summer time from 29 March, back on 25 October.
        assertEquals(2 * 3600, SofiaTime.offsetSeconds(utc(2026, 3, 29, 0, 59)))
        assertEquals(3 * 3600, SofiaTime.offsetSeconds(utc(2026, 3, 29, 1, 0)))
        assertEquals(3 * 3600, SofiaTime.offsetSeconds(utc(2026, 10, 25, 0, 59)))
        assertEquals(2 * 3600, SofiaTime.offsetSeconds(utc(2026, 10, 25, 1, 0)))
    }

    @Test
    fun nightTripsBelongToThePreviousServiceDay() {
        // 02:30 Sofia on 1 November 2026 (winter, UTC+2).
        assertEquals(ServiceTime("20261031", 26 * 3600 + 30 * 60), SofiaTime.serviceTime(utc(2026, 11, 1, 0, 30)))
        // Across a month and year end.
        assertEquals("20251231", SofiaTime.serviceTime(utc(2026, 1, 1, 0, 0)).day)
        assertEquals(ServiceTime("20261101", 3 * 3600), SofiaTime.serviceTime(utc(2026, 11, 1, 1, 0)))
    }

    @Test
    fun civilDaysRoundTrip() {
        for (days in listOf(-1L, 0L, 59L, 11_016L, 20_758L, 47_541L)) {
            val (y, m, d) = civilFromDays(days)
            assertEquals(days, daysFromCivil(y, m, d))
        }
        assertEquals(Triple(1969, 12, 31), civilFromDays(-1))
    }
}
