"use strict";

// Labware Warehouse (worklists/labware.py, served at /api/labware) in the
// browser: the confirmation every protocol build ends with, the review of
// labware in simulated protocols, and the warehouse screen itself.

const LABWARE_STATUS = {
  standard: { label: "Opentrons standard", tone: "ok" },
  custom: { label: "Custom definition", tone: "custom" },
  placeholder: { label: "Placeholder", tone: "blocked" },
  pending: { label: "Waiting for measurements", tone: "blocked" },
  unknown: { label: "Not in the warehouse", tone: "custom" }
};

// Python the plating protocols embed to load the measured agar OmniTray; must build
// exactly what worklists/labware.agar_definition() builds (tests/test_labware.py).
function agarDefinitionPython(plateHeight, surfaceHeight) {
  return `# Nunc OmniTray agar plate, measured on a filled plate (mm above the tray's base).
AGAR_PLATE_HEIGHT_MM = ${plateHeight}
AGAR_SURFACE_HEIGHT_MM = ${surfaceHeight}


def agar_definition():
    """Nunc OmniTray agar with 96 spot positions on the agar surface."""
    rows, columns = "ABCDEFGH", range(1, 13)
    wells = {
        f"{row}{column}": {
            "shape": "rectangular", "xDimension": 8.0, "yDimension": 8.0,
            "depth": round(AGAR_PLATE_HEIGHT_MM - AGAR_SURFACE_HEIGHT_MM, 2), "totalLiquidVolume": 50,
            "x": round(14.38 + 9 * (column - 1), 2), "y": round(74.24 - 9 * index, 2), "z": AGAR_SURFACE_HEIGHT_MM,
        }
        for index, row in enumerate(rows)
        for column in columns
    }
    return {
        "schemaVersion": 2, "version": 1, "namespace": "custom_beta",
        "metadata": {"displayName": "Nunc OmniTray agar, 96 spots", "displayCategory": "wellPlate", "displayVolumeUnits": "µL", "tags": []},
        "brand": {"brand": "Thermo Scientific Nunc", "brandId": ["OmniTray"]},
        "parameters": {"format": "96Standard", "isTiprack": False, "isMagneticModuleCompatible": False, "loadName": "built_agar_omnitray_96_spots"},
        "dimensions": {"xDimension": 127.76, "yDimension": 85.48, "zDimension": AGAR_PLATE_HEIGHT_MM},
        "cornerOffsetFromSlot": {"x": 0, "y": 0, "z": 0},
        "ordering": [[f"{row}{column}" for row in rows] for column in columns],
        "wells": wells,
        "groups": [{"wells": list(wells), "metadata": {"wellBottomShape": "flat"}}],
    }
`;
}

if (typeof module !== "undefined") module.exports = { agarDefinitionPython };

if (typeof document !== "undefined") {
  window.labwareWarehouse = null;
}

async function loadWarehouse({ refresh = false } = {}) {
  if (window.labwareWarehouse && !refresh) return window.labwareWarehouse;
  const response = await apiFetch("./api/labware", { cache: "no-store" });
  if (!response.ok) throw new Error(`The labware warehouse could not be loaded (${response.status}).`);
  const data = await response.json();
  data.byName = Object.fromEntries(data.labware.map((entry) => [entry.loadName, entry]));
  window.labwareWarehouse = data;
  return data;
}

function labwareEntry(loadName) {
  const warehouse = window.labwareWarehouse;
  return (warehouse && warehouse.byName[loadName]) || { loadName, status: "unknown", kind: "Labware", checks: [], usedBy: [] };
}

function labwareBlocked(entry) { return LABWARE_STATUS[entry.status] && LABWARE_STATUS[entry.status].tone === "blocked"; }

function labwareSlots(slots) {
  if (slots.length === 1) return `Slot ${slots[0]}`;
  return `Slots ${slots.join(", ")}`;
}

// The numbers the robot moves by, in words an operator can check with a ruler.
function labwareDimensions(entry) {
  if (entry.height === undefined) return "";
  const parts = [`${entry.height} mm tall`];
  if (entry.tipLength) parts.push(`tips ${entry.tipLength} mm long`);
  else if (entry.kind === "Agar plate") parts.push(`agar surface ${entry.wellBottom} mm above the base`);
  else if (entry.wellDepth) parts.push(`wells ${entry.wellDepth} mm deep, bottoms ${entry.wellBottom} mm above the base`);
  return parts.join(", ");
}

// Every deck item, pipette, and custom definition the protocol relies on, as one checklist.
// Resolves true once every item is ticked; placeholders and missing definitions cannot be confirmed.
async function confirmLabware({ title, items, pipettes = [] }) {
  try {
    await loadWarehouse();
  } catch (error) {
    await showPrompt({ eyebrow: "Labware confirmation", title: "The labware warehouse is unavailable", body: `<p>${escapeHtml(error.message)}</p><p>Protocols cannot be generated without confirming labware.</p>`, actions: [{ label: "Close", value: "close", kind: "primary" }], cancel: "close" });
    return false;
  }
  const checklist = [];
  const blocked = [];
  for (const item of items) {
    const entry = labwareEntry(item.loadName);
    const status = LABWARE_STATUS[entry.status] || LABWARE_STATUS.unknown;
    const name = entry.displayName || item.loadName;
    const label = `${labwareSlots(item.slots)} · ${item.role}: ${name}${item.slots.length > 1 ? ` ×${item.slots.length}` : ""}`;
    if (labwareBlocked(entry)) {
      blocked.push(entry);
      checklist.push({ label, detail: `${status.label}${entry.placeholderFor ? ` for ${entry.placeholderFor}` : ""}. ${entry.source || ""}`, blocked: true });
      continue;
    }
    const detail = [`${item.loadName} · ${status.label}`, labwareDimensions(entry), ...(entry.checks || [])].filter(Boolean).join(" · ");
    checklist.push({ label, detail, tone: status.tone });
    if (entry.status === "custom" || entry.status === "unknown") {
      checklist.push({ label: `Checked the ${name} definition against a real item`, detail: entry.verify || entry.source || "This definition is not from Opentrons; measure the physical item before running.", tone: "custom" });
    }
  }
  for (const pipette of pipettes) {
    checklist.push({ label: `${pipette.mount === "left" ? "Left" : "Right"} mount: ${pipette.label}`, detail: `${pipette.name} · attached and shown in the OT-2 App` });
  }
  const body = blocked.length
    ? `<p class="prompt-warning">This protocol cannot be generated: ${blocked.map((entry) => `${escapeHtml(entry.displayName || entry.loadName)} is a ${entry.status === "pending" ? "definition still waiting for measurements" : "placeholder"}`).join("; ")}. See the Labware Warehouse.</p>`
    : "<p>Check each item on the deck against its definition. The robot moves by these numbers; a plate that differs can crash the tips.</p>";
  const choice = await showPrompt({
    eyebrow: "Labware confirmation",
    title,
    body,
    checklist,
    actions: blocked.length
      ? [{ label: "Close", value: "cancel", kind: "primary" }]
      : [{ label: "Cancel", value: "cancel" }, { label: "Labware confirmed", value: "confirm", kind: "primary", needsChecklist: true }],
    cancel: "cancel"
  });
  return choice === "confirm";
}

// ------------------------------------------------------------ simulation review

// Flags labware in a simulated protocol that is custom, a placeholder, or unknown to the warehouse.
function reviewSimulatedLabware(model, metadata) {
  const warehouse = window.labwareWarehouse;
  const builtHere = (metadata || {}).author === "OT-2 Manufacturing Tools";
  const rows = model.labware.map((lw) => {
    const entry = warehouse && warehouse.byName[lw.loadName];
    let status = entry ? entry.status : lw.namespace === "opentrons" ? "standard" : "unknown";
    // Protocols built here before the agar definition used the Corning plate for agar.
    if (status === "placeholder" && !builtHere) status = "standard";
    return { lw, entry, status };
  });
  $("#sim-labware").innerHTML = rows.map(({ lw, status }) => {
    const info = LABWARE_STATUS[status] || LABWARE_STATUS.unknown;
    return `<li class="labware-row ${info.tone}"><span>${escapeHtml(lw.slot ? `Slot ${lw.slot}` : "")}</span><strong>${escapeHtml(lw.displayName)}</strong><small>${escapeHtml(info.label)}</small></li>`;
  }).join("") || `<li class="labware-row"><small>No labware loaded.</small></li>`;
  const flagged = rows.filter(({ status }) => status !== "standard");
  $("#sim-labware-card").dataset.status = flagged.some(({ status }) => LABWARE_STATUS[status].tone === "blocked") ? "fail" : flagged.length ? "warn" : "pass";
  if (!flagged.length) return;
  const checklist = flagged.map(({ lw, entry, status }) => {
    const info = LABWARE_STATUS[status] || LABWARE_STATUS.unknown;
    const dims = `${lw.dimensions.z} mm tall${Object.values(lw.wells)[0] ? `, first well bottom ${(Object.values(lw.wells)[0].z - lw.origin.z).toFixed(2)} mm above the base` : ""}`;
    const why = status === "placeholder" ? (entry && entry.source) || "" : entry && entry.verify ? entry.verify : "Not an Opentrons definition: the simulation trusts it exactly, so check it against the physical item.";
    return { label: `Slot ${lw.slot} · ${lw.displayName} (${info.label})`, detail: `${lw.loadName} · ${lw.namespace || "?"} · ${dims}. ${why}`, tone: info.tone, blocked: info.tone === "blocked" };
  });
  showPrompt({
    eyebrow: "Labware review",
    title: flagged.some(({ status }) => status === "placeholder") ? "This protocol uses placeholder labware" : "This protocol uses custom labware",
    body: "<p>The simulation only checks moves against these definitions. Confirm each one matches the plate that will be on the deck; a placeholder has to be replaced before the protocol runs.</p>",
    checklist,
    actions: [{ label: "Close", value: "close", kind: "primary" }],
    cancel: "close"
  });
}

// ------------------------------------------------------------ warehouse screen

async function showWarehouse() {
  $("#warehouse-list").innerHTML = `<p class="cal-empty-note">Loading…</p>`;
  let warehouse;
  try {
    warehouse = await loadWarehouse({ refresh: true });
  } catch (error) {
    $("#warehouse-list").innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
    return;
  }
  const order = ["pending", "placeholder", "custom", "standard"];
  const entries = [...warehouse.labware].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const counts = order.map((status) => [status, entries.filter((entry) => entry.status === status).length]).filter(([, n]) => n);
  $("#warehouse-summary").textContent = counts.map(([status, n]) => `${n} ${LABWARE_STATUS[status].label.toLowerCase()}`).join(" · ");
  $("#warehouse-list").innerHTML = entries.map((entry) => {
    const status = LABWARE_STATUS[entry.status] || LABWARE_STATUS.unknown;
    const facts = [
      entry.height !== undefined ? ["Height", `${entry.height} mm`] : null,
      entry.footprint ? ["Footprint", `${entry.footprint[0]} × ${entry.footprint[1]} mm`] : null,
      entry.wells ? ["Wells", entry.wells] : null,
      entry.tipLength ? ["Tip length", `${entry.tipLength} mm (overlap ${entry.tipOverlap} mm)`] : entry.wellDepth !== undefined ? ["Well", `${entry.wellDepth} mm deep, bottom ${entry.wellBottom} mm above base`] : null,
      entry.namespace ? ["Definition", `${entry.namespace} v${entry.version}`] : null
    ].filter(Boolean);
    const hasDefinition = entry.height !== undefined;
    return `<article class="warehouse-card ${status.tone}" data-blueprint="${escapeHtml(entry.loadName)}" tabindex="0" title="Show the technical drawing">
      <div class="warehouse-head"><div><p class="eyebrow">${escapeHtml(entry.kind)}</p><h3>${escapeHtml(entry.displayName || entry.loadName)}</h3><code>${escapeHtml(entry.loadName)}</code></div><span class="warehouse-badge ${status.tone}">${escapeHtml(status.label)}</span></div>
      ${entry.source ? `<p class="warehouse-source">${escapeHtml(entry.source)}</p>` : ""}
      ${facts.length ? `<dl>${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join("")}</dl>` : ""}
      ${(entry.checks || []).length ? `<ul class="warehouse-checks">${entry.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul>` : ""}
      ${entry.verify ? `<p class="warehouse-verify">${escapeHtml(entry.verify)}</p>` : ""}
      <div class="warehouse-foot"><small>Used by ${escapeHtml((entry.usedBy || []).join(", ") || "—")}</small>${hasDefinition ? `<button type="button" class="secondary-button" data-definition="${escapeHtml(entry.loadName)}">Download JSON</button>` : ""}</div>
    </article>`;
  }).join("");
}

if (typeof document !== "undefined") {
  $("#open-warehouse").addEventListener("click", () => routeTo("warehouse"));
  $("#warehouse-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-definition]");
    if (!button) return;
    try {
      const response = await apiFetch(`./api/labware/${encodeURIComponent(button.dataset.definition)}`);
      if (!response.ok) throw new Error(`Definition not available (${response.status}).`);
      const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${button.dataset.definition}.json`;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) {
      $("#warehouse-summary").textContent = error.message;
    }
  });
}

// ------------------------------------------------------------ blueprints

// Technical drawing of a definition: top view with every well, front elevation with
// height and well dimensions, and a title block. All numbers come from the definition.
function blueprintSvg(definition, entry) {
  const dims = definition.dimensions;
  const wells = Object.values(definition.wells);
  const scale = Math.min(3.4, 330 / dims.xDimension);
  const zScale = Math.min(scale, 170 / Math.max(dims.zDimension, 1));
  const W = dims.xDimension * scale, D = dims.yDimension * scale, H = dims.zDimension * zScale;
  const left = 70, top = 70;
  const frontTop = top + D + 90;
  const px = (x) => left + x * scale;
  const py = (y) => top + D - y * scale;
  const pz = (z) => frontTop + H - z * zScale;
  const fmt = (v) => Number(v.toFixed(2)).toString();
  const lines = [];
  const dim = (x1, y1, x2, y2, label, offset = 0, vertical = false) => {
    lines.push(`<line class="dim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    lines.push(vertical
      ? `<text class="dimtext" x="${mx + offset}" y="${my}" transform="rotate(-90 ${mx + offset} ${my})" text-anchor="middle">${label}</text>`
      : `<text class="dimtext" x="${mx}" y="${my + offset}" text-anchor="middle">${label}</text>`);
  };
  // Top view.
  lines.push(`<text class="label" x="${left}" y="${top - 30}">TOP VIEW</text>`);
  lines.push(`<rect class="part" x="${px(0)}" y="${py(dims.yDimension)}" width="${W}" height="${D}" rx="4"/>`);
  for (const well of wells) {
    if (well.shape === "circular") lines.push(`<circle class="well" cx="${px(well.x)}" cy="${py(well.y)}" r="${Math.max(0.8, well.diameter / 2 * scale)}"/>`);
    else lines.push(`<rect class="well" x="${px(well.x - well.xDimension / 2)}" y="${py(well.y + well.yDimension / 2)}" width="${well.xDimension * scale}" height="${well.yDimension * scale}"/>`);
  }
  const first = definition.wells[definition.ordering[0][0]];
  lines.push(`<line class="center" x1="${px(first.x)}" y1="${py(0) + 12}" x2="${px(first.x)}" y2="${py(dims.yDimension) - 12}"/>`);
  lines.push(`<line class="center" x1="${px(0) - 12}" y1="${py(first.y)}" x2="${px(dims.xDimension) + 12}" y2="${py(first.y)}"/>`);
  dim(px(0), top - 14, px(dims.xDimension), top - 14, `${fmt(dims.xDimension)}`, -5);
  dim(left - 22, py(0), left - 22, py(dims.yDimension), `${fmt(dims.yDimension)}`, -6, true);
  dim(px(0), py(0) + 16, px(first.x), py(0) + 16, `${fmt(first.x)}`, 14);
  lines.push(`<text class="note" x="${px(first.x) + 6}" y="${py(first.y) - 6}">${escapeHtml(definition.ordering[0][0])}</text>`);
  // Front elevation.
  lines.push(`<text class="label" x="${left}" y="${frontTop - 22}">FRONT ELEVATION</text>`);
  lines.push(`<rect class="part" x="${px(0)}" y="${pz(dims.zDimension)}" width="${W}" height="${H}"/>`);
  lines.push(`<line class="ground" x1="${px(0) - 20}" y1="${pz(0)}" x2="${px(dims.xDimension) + 20}" y2="${pz(0)}"/>`);
  const columnWells = definition.ordering.map((column) => definition.wells[column[0]]);
  for (const well of columnWells) {
    const half = (well.shape === "circular" ? well.diameter : well.xDimension) / 2;
    if (definition.parameters.isTiprack) {
      const tipTop = well.z + well.depth;
      lines.push(`<path class="hidden" d="M ${px(well.x - half)} ${pz(tipTop)} L ${px(well.x - 0.4)} ${pz(tipTop - definition.parameters.tipLength)} L ${px(well.x + 0.4)} ${pz(tipTop - definition.parameters.tipLength)} L ${px(well.x + half)} ${pz(tipTop)}"/>`);
    } else {
      lines.push(`<rect class="hidden" x="${px(well.x - half)}" y="${pz(well.z + well.depth)}" width="${half * 2 * scale}" height="${Math.max(0.5, well.depth * zScale)}"/>`);
    }
  }
  const right = px(dims.xDimension);
  dim(right + 24, pz(0), right + 24, pz(dims.zDimension), `${fmt(dims.zDimension)}`, 14, true);
  if (!definition.parameters.isTiprack && first.depth > 0) {
    dim(right + 58, pz(0), right + 58, pz(first.z), `${fmt(first.z)}`, 14, true);
    lines.push(`<text class="note" x="${right + 70}" y="${pz(first.z) - 4}">well bottom</text>`);
  } else if (definition.parameters.isTiprack) {
    const tipTop = first.z + first.depth;
    dim(right + 58, pz(tipTop - definition.parameters.tipLength), right + 58, pz(tipTop), `${fmt(definition.parameters.tipLength)}`, 14, true);
    lines.push(`<text class="note" x="${right + 70}" y="${pz(tipTop) + 12}">tip length</text>`);
  }
  // Title block.
  const tb = { x: 560, y: 380, w: 320, h: 150 };
  const status = (LABWARE_STATUS[entry.status] || LABWARE_STATUS.unknown).label.toUpperCase();
  const rows = [
    ["TITLE", definition.metadata.displayName],
    ["LOAD NAME", definition.parameters.loadName],
    ["DEFINITION", `${definition.namespace} v${definition.version}`],
    ["STATUS", status],
    ["UNITS", "mm · scale not exact"]
  ];
  lines.push(`<rect class="part" x="${tb.x}" y="${tb.y}" width="${tb.w}" height="${tb.h}"/>`);
  rows.forEach(([key, value], i) => {
    const y = tb.y + 22 + i * 27;
    if (i) lines.push(`<line class="thin" x1="${tb.x}" y1="${y - 17}" x2="${tb.x + tb.w}" y2="${y - 17}"/>`);
    lines.push(`<text class="tbkey" x="${tb.x + 10}" y="${y}">${key}</text><text class="tbval" x="${tb.x + 96}" y="${y}">${escapeHtml(String(value)).slice(0, 44)}</text>`);
  });
  lines.push(`<text class="note" x="${tb.x}" y="${tb.y - 12}">OT-2 MANUFACTURING TOOLS · LABWARE WAREHOUSE</text>`);
  return `<svg class="blueprint" viewBox="0 0 900 560" role="img" aria-label="Technical drawing of ${escapeHtml(definition.metadata.displayName)}">
    <defs>
      <pattern id="bp-fine" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="1"/></pattern>
      <pattern id="bp-grid" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#bp-fine)"/><path d="M50 0H0V50" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="1"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e8f1ff"/></marker>
    </defs>
    <rect width="900" height="560" fill="#0f3d7a"/><rect width="900" height="560" fill="url(#bp-grid)"/>
    <rect x="12" y="12" width="876" height="536" fill="none" stroke="#e8f1ff" stroke-width="1.5"/>
    ${lines.join("\n")}
  </svg>`;
}

async function showBlueprint(loadName) {
  const entry = labwareEntry(loadName);
  let definition = null;
  try {
    const response = await apiFetch(`./api/labware/${encodeURIComponent(loadName)}`);
    if (response.ok) definition = await response.json();
  } catch (_error) { /* shown below */ }
  showPrompt({
    eyebrow: `Labware Warehouse · ${entry.kind || "Labware"}`,
    title: entry.displayName || loadName,
    body: definition ? blueprintSvg(definition, entry) : `<p>${escapeHtml(entry.source || "No definition is available for this labware yet.")}</p>`,
    actions: [{ label: "Close", value: "close", kind: "primary" }],
    cancel: "close",
    tone: definition ? "blueprint" : ""
  });
}

if (typeof document !== "undefined") {
  $("#warehouse-list").addEventListener("click", (event) => {
    if (event.target.closest("[data-definition]")) return;
    const card = event.target.closest("[data-blueprint]");
    if (card) showBlueprint(card.dataset.blueprint);
  });
}

if (typeof document !== "undefined") {
  $("#warehouse-list").addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-blueprint]");
    if (card && (event.key === "Enter" || event.key === " ") && event.target === card) { event.preventDefault(); showBlueprint(card.dataset.blueprint); }
  });
  // Loaded early so the plating bill of materials can name the agar plate.
  loadWarehouse().catch(() => null);
}
