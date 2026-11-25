// Node harness for the options core of gui-experimental.cjs. Plain node, zero deps.
// The host (OpenCode Desktop) evaluates the bundle with inert placeholders for
// the wrong-process modules (@opencode/plugin/gui, solid-js) per the docs
// "one file, two processes" rule - we mirror that here via a Module._load patch
// so the file under test runs unmodified.
// Run: node test/options.test.cjs  ->  "PASS <n> assertions, 0 failed", exit 0.
const Module = require("module")

const realLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === "@opencode/plugin/gui") return { Plugin: { define: (d) => d }, Style: {} }
  if (request === "solid-js") return { createEffect: () => {}, createMemo: (fn) => fn, onCleanup: () => {} }
  return realLoad.apply(this, arguments)
}

const t = require("../gui-experimental.cjs").__test

// Legacy formatStamp, verbatim from commit 9d5f848:gui-experimental.cjs
// (pre-options state). The LEGACY PARITY below is the load-bearing claim:
// the default output must remain byte-identical to this function's.
function formatStampLegacy(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hour = d.getHours()
  const hour12 = hour % 12 || 12
  const minute = String(d.getMinutes()).padStart(2, "0")
  return `[${month}-${day} ${hour12}:${minute} ${hour < 12 ? "AM" : "PM"}]`
}

const fails = []
let n = 0
function assert(cond, name) {
  n++
  if (!cond) fails.push(name)
}
const compact = (reader, ms) => t.renderStamp(t.PRESETS.compact, reader(ms))

// 1. Legacy parity: compact preset vs the legacy function. 2000 LCG-seeded
// epochs in 2001..2031, local-zone readers on both sides (machine-independent).
let lcg = 123456789
const start = Date.UTC(2001, 0, 1)
const span = Date.UTC(2031, 11, 31) - start
for (let i = 0; i < 2000; i++) {
  lcg = (lcg * 1103515245 + 12379) & 0x7fffffff
  const ms = start + (lcg % span)
  const parts = t.partsOf(new Date(ms), false)
  assert(t.renderStamp(t.PRESETS.compact, parts) === formatStampLegacy(ms), `legacy parity @${ms}`)
}

// 1b. Midnight/noon edges: local hours 0/11/12/13 -> 12 AM / 11 AM / 12 PM / 1 PM
// expected behavior, checked on BOTH sides, at two days.
for (const [h, m, expected] of [[0, 37, "12:37 AM]"], [11, 4, "11:04 AM]"], [12, 15, "12:15 PM]"], [13, 26, "1:26 PM]"]]) {
  for (const day of [15, 16]) {
    const ms = new Date(2026, 9, day, h, m, 0, 0).getTime()
    const parts = t.partsOf(new Date(ms), false)
    assert(t.renderStamp(t.PRESETS.compact, parts).endsWith(expected), `edge h=${h} day=${day} new`)
    assert(formatStampLegacy(ms).endsWith(expected), `edge h=${h} day=${day} legacy`)
  }
}

// 2. Preset shapes at a machine-independent zone (+00:00).
const epoch = Date.UTC(2026, 10, 25, 9, 8, 0)
const utc = t.partsReader("+00:00")
assert(compact(utc, epoch) === "[11-25 9:08 AM]", "preset compact @ +00:00")
assert(t.renderStamp(t.PRESETS["time-only"], utc(epoch)) === "[9:08 AM]", "preset time-only @ +00:00")
assert(t.renderStamp(t.PRESETS.iso, utc(epoch)) === "[2026-11-25 09:08:00]", "preset iso @ +00:00")

// 3. Fixed offsets: epoch shift + UTC-field read, including the date roll.
const noon = Date.UTC(2026, 0, 15, 12, 0, 0)
assert(compact(t.partsReader("+05:30"), noon) === "[01-15 5:30 PM]", "offset +05:30")
assert(compact(t.partsReader("-08:00"), noon) === "[01-15 4:00 AM]", "offset -08:00")
assert(compact(t.partsReader("+14:00"), noon) === "[01-16 2:00 AM]", "offset +14:00 date roll")

// 4. "UTC" / "utc" readers equal the "+00:00" reader on the same epochs.
const utcA = t.partsReader("UTC")
const utcB = t.partsReader("utc")
for (const ms of [noon, epoch, Date.UTC(1999, 5, 6, 7, 8, 9)]) {
  assert(JSON.stringify(utcA(ms)) === JSON.stringify(utcB(ms)), `UTC/utc readers equal @${ms}`)
  assert(JSON.stringify(utcA(ms)) === JSON.stringify(utc(ms)), `UTC reader == +00:00 @${ms}`)
}

// 5. IANA zones go through Intl: the zone database owns DST and Etc/GMT.
const den = t.partsReader("America/Denver")
assert(compact(den, Date.UTC(2026, 0, 15, 12, 0, 0)) === "[01-15 5:00 AM]", "Denver winter (MST)")
assert(compact(den, Date.UTC(2026, 6, 15, 12, 0, 0)) === "[07-15 6:00 AM]", "Denver summer (MDT, DST)")
assert(compact(t.partsReader("Etc/GMT+5"), noon) === "[01-15 7:00 AM]", "Etc/GMT+5 inverted sign (UTC-5)")
const kolkata = t.partsReader("Asia/Kolkata")
const kolkataNow = Date.parse("2026-11-25T17:55:06.898Z")
assert(compact(kolkata, kolkataNow) === "[11-25 11:25 PM]", "Kolkata compact")
assert(t.renderStamp(t.PRESETS.iso, kolkata(kolkataNow)) === "[2026-11-25 23:25:06]", "Kolkata iso")

// 6. Custom token patterns: literals pass through, unknown glyphs stay.
const utcParts = t.partsOf(new Date(Date.UTC(2026, 10, 25, 17, 55, 6)), true)
assert(t.renderStamp("at HH:mm", utcParts) === "at 17:55", "token pattern literal + HH:mm")
assert(t.renderStamp("x[YYYY]y", utcParts) === "x[2026]y", "unknown glyphs pass through")
assert(t.renderStamp("H?", utcParts) === "H?", "unknown glyph unchanged")

// 7. Invalid timezone -> null (setup falls back to local); empty/undefined -> local.
assert(t.partsReader("Not/AZone") === null, "invalid zone -> null")
assert(typeof t.partsReader("") === "function", "empty spec -> local reader")
assert(typeof t.partsReader(undefined) === "function", "undefined spec -> local reader")
assert(JSON.stringify(t.partsReader("")(noon)) === JSON.stringify(t.partsOf(new Date(noon), false)), "local reader parts")

// 8. parseTimePayload: every accepted payload shape.
const apiBody = JSON.stringify({
  year: 2026, month: 11, day: 25, hour: 17, minute: 55, seconds: 6, milliSeconds: 898,
  dateTime: "2026-11-25T17:55:06.898818", date: "11/25/2026", time: "17:55",
  timeZone: "UTC", dayOfWeek: "Wednesday", dstActive: false,
})
assert(t.parseTimePayload(apiBody) === Date.UTC(2026, 10, 25, 17, 55, 6, 898), "timeapi.io body")
assert(t.parseTimePayload(JSON.stringify({ unixtime: 1000000000 })) === 1e12, "unixtime seconds")
assert(t.parseTimePayload(JSON.stringify({ epoch: 1700000000000 })) === 1700000000000, "epoch ms")
assert(t.parseTimePayload(JSON.stringify({ dateTime: "2026-11-25T17:55:06" })) === Date.UTC(2026, 10, 25, 17, 55, 6), "naive ISO assumed UTC")
assert(t.parseTimePayload(JSON.stringify({ dateTime: "2026-11-25T17:55:06+02:00" })) === Date.UTC(2026, 10, 25, 15, 55, 6), "colon-offset ISO honored")
assert(t.parseTimePayload(JSON.stringify({ dateTime: "2026-11-25T17:55:06+0200" })) === Date.UTC(2026, 10, 25, 15, 55, 6), "compact-offset ISO honored (gate #2)")
assert(t.parseTimePayload("1000000000") === 1e12, "bare numeric string (seconds)")
assert(t.parseTimePayload("not a time") === undefined, "garbage text")
assert(t.parseTimePayload("") === undefined, "empty text")
assert(t.parseTimePayload(JSON.stringify([1, 2, 3])) === undefined, "JSON array")
assert(t.partsReader("+99:00") === null, "impossible fixed offset rejected (gate #6)")
assert(t.partsReader("+02:75") === null, "impossible offset minutes rejected (gate #6)")
assert(t.partsReader("+15:00") === null, "offset beyond ±14 rejected (gate #6)")
assert(t.partsReader(5) === null, "non-string timezone rejected (gate #5)")

// 9. system source: no sync, offset 0.
const sys = t.createClock({ source: "system" }, () => { throw new Error("no fetch in system mode") }, () => 5e12, { set: () => 1, clear: () => {} })
assert(sys.stampMs(1234) === 1234, "system: stampMs passthrough")
assert(sys.stampMs(5e12) === 5e12, "system: large value")
assert(sys.stampMs(NaN) === undefined, "system: NaN -> undefined")

// 10-12. The clock state machine is async; CJS has no top-level await, so this
// section runs inside an async IIFE. The fake timers never fire - the test
// drives sync() directly and inspects the scheduled delays.
async function clockSection() {
  const fakeNow = Date.UTC(2026, 0, 1, 12, 0, 0)
  const calls = []
  const body = JSON.stringify({ year: 2026, month: 1, day: 1, hour: 18, minute: 0, seconds: 0, milliSeconds: 0 })
  const timers = { set: () => 1, clear: () => {} }

  // 10. network source: before the first sync stamps are unavailable; a fake
  // fetch pins the offset; the timeUrl override is recorded by the fake.
  const net = t.createClock(
    { source: "network", timeUrl: "https://example.test/time", syncMinutes: 2 },
    (url) => { calls.push(url); return Promise.resolve({ ok: true, text: () => Promise.resolve(body) }) },
    () => fakeNow,
    timers,
  )
  assert(net.stampMs(1234) === undefined, "network: before first sync")
  await net.sync()
  const expected = Date.parse("2026-01-01T18:00:00Z")
  assert(net.stampMs(1234) === 1234 + (expected - fakeNow), "network: offset applied")
  assert(net.stampMs(1234) === 1234 + 6 * 3600000, "network: offset is 6h")
  assert(calls.length === 1 && calls[0] === "https://example.test/time", "timeUrl override recorded")

  // 11. Retry state machine through the timers seam: failure before first sync
  // retries in 60s and keeps stamps unavailable; success applies the offset and
  // reschedules at syncMinutes; a later failure keeps the last offset.
  const calls2 = []
  const scripted = []
  const seen = []
  const net2 = t.createClock({ source: "network", syncMinutes: 2 }, (url) => {
    calls2.push(url)
    const next = scripted.shift()
    if (next === "fail") return Promise.reject(new Error("network down"))
    if (next === "http404") return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(JSON.stringify({ timestamp: 1000000000 })) })
    return Promise.resolve({ ok: true, text: () => Promise.resolve(body) })
  }, () => fakeNow, { set: (fn, ms) => seen.push(ms), clear: () => {} })
  assert(net2.stampMs(1234) === undefined, "retry: unavailable before first sync")
  scripted.push("fail")
  await net2.sync()
  assert(net2.stampMs(1234) === undefined, "retry: still unavailable after failed first sync")
  assert(seen.length === 1 && seen[0] === 60000, "retry: 60s retry scheduled")
  scripted.push("http404")
  await net2.sync()
  assert(net2.stampMs(1234) === undefined, "404 body with timestamp must NOT seed the offset (gate #4)")
  scripted.push("ok")
  await net2.sync()
  assert(net2.stampMs(1234) === 1234 + 6 * 3600000, "retry: offset applied after success")
  assert(seen.length === 3 && seen[2] === 120000, "retry: next sync at syncMinutes*60000")
  scripted.push("fail")
  await net2.sync()
  assert(net2.stampMs(1234) === 1234 + 6 * 3600000, "retry: failed resync keeps last offset")
  assert(seen.length === 4 && seen[3] === 120000, "retry: resync failure back to syncMinutes cadence")
  assert(calls2.length === 4 && calls2.every((u) => u === t.DEFAULT_TIME_URL), "default URL used when timeUrl omitted")

  // 12. Unknown source: behaves as system, with one console.error warning.
  const errors = []
  const realError = console.error
  console.error = (...args) => { errors.push(args.join(" ")) }
  const ntp = t.createClock({ source: "ntp" }, () => { throw new Error("no fetch") }, () => 5e12, { set: () => 1, clear: () => {} })
  console.error = realError
  assert(ntp.stampMs(1234) === 1234, "ntp: behaves as system")
  assert(errors.length === 1 && errors[0].includes("ntp"), "ntp: one console.error warning")

  // 13. stop() while a sync is in flight must not resurrect the chain (gate #3):
  // the continuation lands after teardown and must schedule nothing.
  const seen13 = []
  const realError13 = console.error
  console.error = (...args) => { errors.push(args.join(" ")) }
  let release
  const net13 = t.createClock({ source: "network" }, () => new Promise((resolve) => {
    release = () => resolve({ ok: true, text: () => Promise.resolve(body) })
  }), () => fakeNow, { set: (fn, ms) => { seen13.push(ms); return 1 }, clear: () => {} })
  net13.start()
  net13.stop()
  release()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  console.error = realError13
  assert(seen13.length === 0, "stop: in-flight sync schedules no resync")
  assert(net13.stampMs(1234) === undefined, "stop: discarded late success leaves stamps unavailable")
}

clockSection()
  .then(() => {
    console.log(fails.length === 0 ? `PASS ${n} assertions, 0 failed` : `FAIL ${n} assertions, ${fails.length} failed`)
    for (const name of fails) console.log(`FAIL: ${name}`)
    process.exit(fails.length === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error("test harness crashed:", err)
    for (const name of fails) console.log(`FAIL: ${name}`)
    process.exit(1)
  })
