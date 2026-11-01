@file:OptIn(ExperimentalJsExport::class)

package io.github.jukfiuune.sofiatransit

import io.github.jukfiuune.sofiatransit.time.SofiaTime

// The API the website calls. Epoch times are JS numbers (ms), not Long, so callers
// don't need BigInt.

/** "HH:MM:SS" in Sofia at an epoch time. */
@JsExport
fun sofiaClock(epochMs: Double): String = SofiaTime.at(epochMs.toLong()).hhmmss

/** The GTFS service day ("YYYYMMDD") running at an epoch time. */
@JsExport
fun serviceDay(epochMs: Double): String = SofiaTime.serviceTime(epochMs.toLong()).day
