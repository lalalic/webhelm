const params = new URLSearchParams(location.search);
const workspace = params.get("workspace") || "";
const role = params.get("role") || "";
// A lease carries the actual Chrome tabId for one-time CDP target discovery.
const tabId = params.get("tabId") || "";
const validTabId = /^\d+$/.test(tabId);

// Keep this exact lease title: WebHelm's tab identity protocol depends on it.
document.title = role === "lease" && validTabId
  ? `${location.pathname.endsWith("/workspace.html") ? "__BW_TAB_" : "__WEBHELM_TAB_"}${tabId}__`
  : role === "idle" && workspace
    ? "WebHelm · Idle"
    : "WebHelm";

const setText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

setText("workspace-name", workspace || "Not assigned");

if (role === "idle" && workspace) {
  setText("status-label", "Idle · Awaiting next task");
  setText("description", "This tab is in the WebHelm pool and will be reused automatically when a task needs it.");
  setText("help-text", "No action required. Leave this tab open. This status describes the tab, not daemon connectivity.");
} else if (role === "lease" && validTabId && workspace) {
  setText("status-label", "Reserved for a task");
  setText("description", "WebHelm has assigned this tab to a browser session.");
}
