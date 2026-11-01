const params = new URLSearchParams(location.search);
const role = params.get("role") || "";
const slot = params.get("slot") || "";

document.title = role === "lease" && /^\d+$/.test(slot)
  ? `__BW_TAB_${slot}__`
  : "Browser Workspace";
