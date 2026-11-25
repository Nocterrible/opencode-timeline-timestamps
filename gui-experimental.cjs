// GUI half: draws a wall-clock stamp beside every timeline message row.
// Display-only by design - the model never sees these times. Built as one
// CommonJS bundle because OpenCode Desktop evaluates this file verbatim.
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

function formatStamp(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hour = d.getHours()
  const hour12 = hour % 12 || 12
  const minute = String(d.getMinutes()).padStart(2, "0")
  return `[${month}-${day} ${hour12}:${minute} ${hour < 12 ? "AM" : "PM"}]`
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
        const text = ms !== undefined ? formatStamp(ms) : undefined

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
      clearStamps()
    })
  },
})