// GUI half: draws a wall-clock stamp beside every timeline message row.
// Display-only by design - the model never sees these times. Built as one
// CommonJS bundle because OpenCode Desktop evaluates this file verbatim
// (see README "Notes for maintainers"): splitting into sibling requires
// depends on loader behavior we have not measured, and a build step would
// reintroduce the package.json `exports` trap. The extra length buys a
// zero-dependency plugin the owner can read top to bottom.
const { Plugin, Style } = require("@opencode/plugin/gui")
const { createEffect, createMemo, onCleanup } = require("solid-js")

const STAMP = "oc-tstamp"
const HANDLED = new Set(["UserMessage", "AssistantPart", "Thinking", "Shell"])
const MISSING = "[time unavailable]"

const CSS = `
.oc-tstamp {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0 2px 2px;
  font-size: 11px;
  line-height: 13px;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--v2-text-text-muted, #9c9c9c);
  opacity: 0.9;
  user-select: none;
  pointer-events: none;
  white-space: nowrap;
}
.oc-tstamp[data-missing] {
  color: var(--v2-state-fg-warning, #b07d00);
  opacity: 1;
}
`

// ---------------------------------------------------------------------------
// Format. Options (read once in setup; the host reloads the plugin when the
// entry's options change, so nothing here is reactive):
//   format:   "compact" (default) | "time-only" | "iso" | a token pattern.
//             Tokens: YYYY MM DD HH hh h mm ss A. Every other character -
//             brackets, dashes, colons, spaces - is literal.
//   timezone: "local" (default) | "UTC" | "+HH:MM"/"-HH:MM" fixed offset |
//             an IANA zone name ("Europe/Berlin"). Invalid names fall back
//             to local with a console error. Etc/GMT+N keeps its inverted
//             sign because it goes through Intl, not string math.
//   source:   "system" (default; message time.created is already the
//             OpenCode server's clock) | "network": calibrate an offset
//             against an HTTP time endpoint - raw NTP is UDP-only and
//             unreachable from the Electron renderer. Stamps show
//             [time unavailable] until the first successful sync; after a
//             success, a failed resync keeps the last offset.
//             Options: timeUrl, syncMinutes (default 60).
// ---------------------------------------------------------------------------
const PRESETS = {
  compact: "[MM-DD h:mm A]",
  "time-only": "[h:mm A]",
  iso: "[YYYY-MM-DD HH:mm:ss]",
}
const TOKEN = /YYYY|MM|DD|HH|hh|h|mm|ss|A/g

function renderStamp(pattern, parts) {
  return pattern.replace(TOKEN, (token) => (parts[token] === undefined ? "?" : parts[token]))
}

function pad2(value) {
  return String(value).padStart(2, "0")
}

// Pull stamp parts out of a Date already in the target zone. `utc` selects the
// getUTC* accessors (fixed-offset paths); false uses the renderer's local zone.
function partsOf(date, utc) {
  if (Number.isNaN(date.getTime())) return undefined
  // Local accessors carry the "get" prefix (getHours, getMonth, ...); the UTC
  // branch spells it out explicitly. (Packet deviation: the dictated line
  // used date[name](), which is undefined for the local getters.)
  const get = (name) => (utc ? date["getUTC" + name]() : date["get" + name]())
  const hour = get("Hours")
  const hour12 = hour % 12 || 12
  return {
    YYYY: String(get("FullYear")),
    MM: pad2(get("Month") + 1),
    DD: pad2(get("Date")),
    HH: pad2(hour),
    h: String(hour12),
    hh: pad2(hour12),
    mm: pad2(get("Minutes")),
    ss: pad2(get("Seconds")),
    A: hour < 12 ? "AM" : "PM",
  }
}

// zone spec -> (ms) -> parts | undefined; NULL for an invalid spec.
function partsReader(spec) {
  const name = typeof spec === "string" ? spec.trim() : ""
  if (name === "" || name.toLowerCase() === "local") return (ms) => partsOf(new Date(ms), false)
  if (name.toUpperCase() === "UTC") return (ms) => partsOf(new Date(ms), true)
  const fixed = /^([+-])(\d{1,2}):(\d{2})$/.exec(name)
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3])
    const offset = (fixed[1] === "-" ? -minutes : minutes) * 60000
    return (ms) => partsOf(new Date(ms + offset), true)
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h12",
    })
    return (ms) => {
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return undefined
      const fields = {}
      for (const part of fmt.formatToParts(date)) fields[part.type] = part.value
      const hour12 = Number(fields.hour)
      if (!Number.isFinite(hour12)) return undefined
      const pm = String(fields.dayPeriod || "").toUpperCase().includes("P")
      return {
        YYYY: fields.year,
        MM: fields.month,
        DD: fields.day,
        HH: pad2((hour12 % 12) + (pm ? 12 : 0)),
        h: String(hour12),
        hh: pad2(hour12),
        mm: fields.minute,
        ss: fields.second,
        A: pm ? "PM" : "AM",
      }
    }
  } catch (error) {
    return null
  }
}

// ---------------------------------------------------------------------------
// Clock. Accepts: a bare number (seconds if < 1e11, else milliseconds), an
// object field epoch_ms|epochMs|epoch|unixtime|timestamp, an object field
// dateTime|utc|iso holding an ISO string (naive ISO assumed UTC), or a
// timeapi.io-style body with year+month+day(+hour,minute,seconds,milliSeconds).
// ---------------------------------------------------------------------------
const DEFAULT_TIME_URL = "https://timeapi.io/api/time/current/zone?timeZone=UTC"

function toEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value
  if (typeof value === "string") {
    const text = value.trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text) < 1e11 ? Number(text) * 1000 : Number(text)
    const withZone = /(\d)(Z|[+-]\d{2}(:\d{2})?)$/i.test(text) ? text : text + "Z"
    const parsed = Date.parse(withZone)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function parseTimePayload(text) {
  if (typeof text !== "string" || !text) return undefined
  const direct = toEpoch(text)
  if (direct !== undefined) return direct
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  for (const key of ["epoch_ms", "epochMs", "epoch", "unixtime", "timestamp"]) {
    if (body[key] !== undefined) {
      const ms = toEpoch(body[key])
      if (ms !== undefined) return ms
    }
  }
  for (const key of ["dateTime", "utc", "iso"]) {
    if (body[key] !== undefined) {
      const ms = toEpoch(body[key])
      if (ms !== undefined) return ms
    }
  }
  if (typeof body.year === "number" && typeof body.month === "number" && typeof body.day === "number") {
    return Date.UTC(
      body.year,
      body.month - 1,
      body.day,
      body.hour || 0,
      body.minute || 0,
      body.seconds ?? body.second ?? 0,
      body.milliSeconds ?? body.milliseconds ?? 0,
    )
  }
  return undefined
}

// timers seam keeps the node test honest without real waiting.
function createClock(options, fetchImpl, now, timers) {
  const clockTimers = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }
  let source = String(options.source ?? "system").toLowerCase()
  if (source !== "network") {
    if (source !== "system") console.error("[timeline-timestamps] unknown source:", options.source, "- using system")
    source = "system"
  }
  const url = typeof options.timeUrl === "string" && options.timeUrl.trim() ? options.timeUrl.trim() : DEFAULT_TIME_URL
  const syncEvery = Math.max(1, Number(options.syncMinutes) || 60) * 60000
  let offset = source === "network" ? undefined : 0
  let timer = 0

  const schedule = (delay) => {
    clockTimers.clear(timer)
    timer = clockTimers.set(() => {
      timer = 0
      void sync()
    }, delay)
    if (timer && timer.unref) timer.unref()
  }

  async function sync() {
    try {
      const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(5000) })
      const remote = parseTimePayload(await response.text())
      if (remote === undefined) throw new Error("unrecognized time payload")
      offset = remote - now()
      console.info("[timeline-timestamps] clock synced:", url, "offset:", offset, "ms")
      schedule(syncEvery)
    } catch (error) {
      console.error("[timeline-timestamps] network clock failed:", url, error)
      schedule(offset === undefined ? 60000 : syncEvery)
    }
  }

  return {
    stampMs(created) {
      if (offset === undefined || !Number.isFinite(created)) return undefined
      return created + offset
    },
    start() {
      if (source === "network") void sync()
    },
    stop() {
      clockTimers.clear(timer)
      timer = 0
    },
    sync,
  }
}

function messageIDForRow(row, tag) {
  const part = row.querySelector("[data-timeline-part-id], [data-timeline-part-ids]")
  const raw =
    part && (part.getAttribute("data-timeline-part-id") || part.getAttribute("data-timeline-part-ids"))
  if (raw) return raw.split(",")[0].split(":")[0]
  return tag === "UserMessage" ? row.getAttribute("data-message-id") : undefined
}

function containerFor(row) {
  return row.querySelector('[data-slot="session-turn-message-container"]') || row
}

function stampOf(container) {
  return container.querySelector(":scope > ." + STAMP)
}

function showStamp(row, text, missing) {
  const container = containerFor(row)
  let stamp = stampOf(container)
  if (!stamp) {
    stamp = document.createElement("span")
    stamp.className = STAMP
    stamp.setAttribute("aria-hidden", "true")
    container.prepend(stamp)
  }
  if (stamp.textContent !== text) stamp.textContent = text
  if (missing) stamp.setAttribute("data-missing", "")
  else stamp.removeAttribute("data-missing")
}

function hideStamp(row) {
  const stamp = stampOf(containerFor(row))
  if (stamp) stamp.remove()
}

function clearStamps() {
  document.querySelectorAll("." + STAMP).forEach((stamp) => stamp.remove())
}

module.exports.default = Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS)

    const options = ctx.options || {}
    const rawFormat = typeof options.format === "string" ? options.format.trim() : ""
    const pattern = Object.prototype.hasOwnProperty.call(PRESETS, rawFormat)
      ? PRESETS[rawFormat]
      : rawFormat || PRESETS.compact
    let read = partsReader(options.timezone === undefined ? "local" : options.timezone)
    if (!read) {
      console.error("[timeline-timestamps] invalid timezone:", options.timezone, "- using local")
      read = partsReader("local")
    }
    const clock = createClock(options, (input, init) => fetch(input, init), () => Date.now())
    clock.start()

    const stampText = (ms) => {
      const stamped = clock.stampMs(ms)
      if (stamped === undefined) return undefined
      const parts = read(stamped)
      return parts === undefined ? undefined : renderStamp(pattern, parts)
    }

    let lastKey = ""
    let scheduled = 0

    const session = createMemo(() => ctx.sessions.current())
    const times = createMemo(() => {
      const current = session()
      const map = new Map()
      if (!current || !current.id) return map
      try {
        for (const message of current.server.data.session.message.list(current.id) || []) {
          if (message && typeof message.id === "string" && message.time && Number.isFinite(message.time.created))
            map.set(message.id, message.time.created)
        }
      } catch (error) {
        console.error("[timeline-timestamps] message store unavailable", error)
      }
      return map
    })

    const paint = () => {
      const current = session()
      const key = current ? current.key : ""
      if (key !== lastKey) {
        lastKey = key
        clearStamps()
      }

      const map = times()
      const stamped = new Set()
      const rows = document.querySelectorAll("[data-timeline-row][data-message-id]")

      rows.forEach((row) => {
        const tag = row.getAttribute("data-timeline-row")
        if (!HANDLED.has(tag)) return

        const id = messageIDForRow(row, tag)
        const created = id ? map.get(id) : undefined
        const fallback = map.get(row.getAttribute("data-message-id"))
        const ms = created !== undefined ? created : fallback
        const text = ms !== undefined ? stampText(ms) : undefined

        // One stamp per message: the first mounted row of an assistant message carries it.
        if (tag !== "UserMessage" && id && stamped.has(id)) {
          hideStamp(row)
          return
        }

        if (text === undefined) {
          showStamp(row, MISSING, true)
          return
        }

        if (id) stamped.add(id)
        showStamp(row, text, false)
      })
    }

    const schedule = () => {
      if (scheduled) return
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        paint()
      })
    }

    createEffect(paint)

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList && node.classList.contains(STAMP)) continue
          return schedule()
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    // The virtualizer remounts rows without a data change; a light heartbeat
    // catches rows that mount between mutations of their own.
    const heartbeat = setInterval(schedule, 1000)

    onCleanup(() => {
      observer.disconnect()
      clearInterval(heartbeat)
      if (scheduled) cancelAnimationFrame(scheduled)
      clock.stop()
      clearStamps()
    })
  },
})

module.exports.__test = {
  PRESETS,
  renderStamp,
  partsOf,
  partsReader,
  parseTimePayload,
  toEpoch,
  createClock,
  DEFAULT_TIME_URL,
}
