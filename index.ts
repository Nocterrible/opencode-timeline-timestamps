import { Plugin } from "@opencode/plugin"

// Server half. This plugin is display-only: the window half draws wall-clock
// stamps beside the timeline rows and the model never sees them. The server
// half exists so the desktop app lists the plugin and loads its GUI bundle.
export default Plugin.define({
  id: "timeline-timestamps",
  async setup() {},
})