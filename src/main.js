/* globals Spotfire */

"use strict";

// Bundled by webpack — d3 is declared as a dependency in package.json.
// We bind it to a `viz` alias to keep call-sites short and to preserve the
// historical naming used throughout this file.
import * as viz from "d3";

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
Spotfire.initialize(async (mod) => {
  const context = mod.getRenderContext();

  // Push Spotfire's themed styling onto the document as CSS variables so
  // stylesheet rules and runtime SVG attributes can reference one source
  // of truth. Re-applied on every render in case the user toggles theme.
  function applyStyling() {
    const s = context && context.styling;
    if (!s) return null;
    const root = document.documentElement;
    const set = (k, v) => { if (v != null) root.style.setProperty(k, String(v)); };

    // General — body text + background
    set("--sf-font-family", s.general.font.fontFamily);
    set("--sf-font-size",   s.general.font.fontSize + "px");
    set("--sf-font-weight", s.general.font.fontWeight);
    set("--sf-font-style",  s.general.font.fontStyle);
    set("--sf-color",       s.general.font.color);
    set("--sf-bg",          s.general.backgroundColor);

    // Scales — axis labels, lines, ticks
    set("--sf-scale-font-family", s.scales.font.fontFamily);
    set("--sf-scale-font-size",   s.scales.font.fontSize + "px");
    set("--sf-scale-font-weight", s.scales.font.fontWeight);
    set("--sf-scale-color",       s.scales.font.color);
    set("--sf-scale-line",        s.scales.line.stroke);
    set("--sf-scale-tick",        s.scales.tick.stroke);

    // Derive a panel surface + border that contrast slightly with the
    // visual's background, so the settings popup is legible in both Light
    // and Dark themes (Spotfire only exposes the general bg + text colors).
    const bg = parseCssColor(s.general.backgroundColor);
    if (bg) {
      const lum = relativeLuminance(bg);
      const isDark = lum < 0.5;
      // Panel sits ~6% darker (light theme) or ~10% lighter (dark theme).
      const panel  = isDark ? mixWithWhite(bg, 0.10) : mixWithBlack(bg, 0.06);
      const border = isDark ? mixWithWhite(bg, 0.22) : mixWithBlack(bg, 0.18);
      set("--sf-panel-bg",     `rgba(${panel.r},${panel.g},${panel.b},0.98)`);
      set("--sf-panel-border", `rgb(${border.r},${border.g},${border.b})`);
      set("--sf-panel-shadow", isDark
        ? "0 4px 16px rgba(0,0,0,0.6)"
        : "0 4px 16px rgba(0,0,0,0.18)");
      // Tag the document so theme-aware CSS rules (e.g. the marking-rect
      // border color, which Spotfire's native chart darkens in dark mode)
      // can target either theme without re-reading colors in CSS.
      document.documentElement.setAttribute("data-sf-theme", isDark ? "dark" : "light");
    }

    return s;
  }

  // ── Tiny color helpers (kept inline so the mod has no extra deps) ────────
  function parseCssColor(c) {
    if (!c || typeof c !== "string") return null;
    const s = c.trim();
    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split("").map((x) => x + x).join("");
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    return null;
  }
  function relativeLuminance({ r, g, b }) {
    const norm = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b);
  }
  const mixWithWhite = ({ r, g, b }, t) => ({
    r: Math.round(r + (255 - r) * t),
    g: Math.round(g + (255 - g) * t),
    b: Math.round(b + (255 - b) * t),
  });
  const mixWithBlack = ({ r, g, b }, t) => ({
    r: Math.round(r * (1 - t)),
    g: Math.round(g * (1 - t)),
    b: Math.round(b * (1 - t)),
  });

  // ── Persistent mod state ─────────────────────────────────────────────────
  const state = {
    marking: null,       // active rubber-band marking rect
    markedRows: new Set(),
  };

  // Helper kept for backward-compatibility with code that read missing
  // properties as objects with .value(). Returns the real property reader.
  const safeProperty = (name) => mod.property(name);

  // ── Subscribe to everything that can trigger a re-render ─────────────────
  const reader = mod.createReader(
    mod.visualization.axis("Value"),
    mod.visualization.axis("Category"),
    mod.visualization.axis("Color"),
    mod.visualization.axis("MarkerBy"),
    mod.visualization.axis("Trellis by"),
    mod.visualization.data(),
    mod.property("ridgeMode"),
    mod.property("overlapFactor"),
    mod.property("bandwidth"),
    mod.property("histBins"),
    mod.property("fillOpacity"),
    mod.property("strokeWidth"),
    mod.property("showDataPoints"),
    mod.property("ridge3D"),
    mod.property("showMean"),
    mod.property("showMedian"),
    mod.property("showQuartiles"),
    mod.property("sortBy"),
    mod.property("trellisMode"),
    mod.windowSize(),
  );

  // Wrap render in a guard so a thrown exception surfaces in the visual
  // (and to the host) instead of leaving a blank canvas behind.
  reader.subscribe(async (...args) => {
    try {
      await render(...args);
    } catch (err) {
      console.error("[JoyPlot] render() threw", err);
      try { showError(String(err && err.stack ? err.stack : err)); } catch {}
      try { mod.controls.errorOverlay.show(String(err && err.message ? err.message : err)); } catch {}
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Settings panel — gear button toggles a custom HTML panel
  // ─────────────────────────────────────────────────────────────────────────
  const panel = document.getElementById("settings-panel");
  const settingsBtn = document.getElementById("settings-btn");

  // Latest property readers, captured each render. Used by the settings
  // panel so we don't have to await mod.property() (which is unreliable
  // across SDK versions).
  let latestProps = null;

  async function buildSettingsPanel() {
    if (!latestProps) {
      panel.innerHTML = `<h4>Settings</h4><div style="opacity:.7">Waiting for data…</div>`;
      return;
    }
    const props = latestProps;
    const v = {};
    for (const [k, p] of Object.entries(props)) v[k] = p.value();

    const radio = (val, label) =>
      `<label><span class="lbl-text">
         <input type="radio" name="ridgeMode" value="${val}" ${v.ridgeMode === val ? "checked" : ""}/>
         ${label}
       </span></label>`;

    const range = (name, label, min, max, step, val, fmt = (x) => x) =>
      `<label class="row-stack">
         <div style="display:flex;justify-content:space-between;">
           <span class="lbl-text">${label}</span>
           <span class="lbl-val" data-val-for="${name}">${fmt(val)}</span>
         </div>
         <input type="range" data-prop="${name}" min="${min}" max="${max}" step="${step}" value="${val}" />
       </label>`;

    panel.innerHTML = `
      <h4>Ridge style</h4>
      ${radio("kde", "Density (KDE)")}
      ${radio("histogram", "Histogram")}
      ${radio("both", "Both")}

      <h4>Layout</h4>
      <label>
        <span class="lbl-text">Sort by</span>
        <select data-prop="sortBy" style="background:transparent;color:inherit;border:1px solid var(--sf-panel-border, #2a3140);border-radius:3px;padding:1px 4px;">
          <option value="value"    ${v.sortBy === "value"    ? "selected" : ""}>Value (leftmost at bottom)</option>
          <option value="category" ${v.sortBy === "category" ? "selected" : ""}>Category order</option>
        </select>
      </label>
      <label>
        <span class="lbl-text">Trellis layout</span>
        <select data-prop="trellisMode" style="background:transparent;color:inherit;border:1px solid var(--sf-panel-border, #2a3140);border-radius:3px;padding:1px 4px;">
          <option value="rows"    ${v.trellisMode === "rows"    ? "selected" : ""}>Rows</option>
          <option value="columns" ${v.trellisMode === "columns" ? "selected" : ""}>Columns</option>
          <option value="panels"  ${v.trellisMode === "panels"  ? "selected" : ""}>Panels (grid)</option>
        </select>
      </label>
      <label>
        <span class="lbl-text">Panels per page (cols × rows, 0 = fit)</span>
        <span style="display:inline-flex;gap:4px;align-items:center;">
          <input type="number" data-prop="panelsPerPageCols" min="0" max="100" step="1" value="${v.panelsPerPageCols ?? 0}"
                 title="Columns per page"
                 style="width:48px;background:transparent;color:inherit;border:1px solid var(--sf-panel-border, #2a3140);border-radius:3px;padding:1px 4px;"/>
          <span style="opacity:.7">×</span>
          <input type="number" data-prop="panelsPerPageRows" min="0" max="100" step="1" value="${v.panelsPerPageRows ?? 0}"
                 title="Rows per page"
                 style="width:48px;background:transparent;color:inherit;border:1px solid var(--sf-panel-border, #2a3140);border-radius:3px;padding:1px 4px;"/>
        </span>
      </label>
      ${range("overlapFactor", "Overlap",      0.5, 5,   0.1,  v.overlapFactor, (x) => Number(x).toFixed(1))}
      ${range("fillOpacity",   "Fill opacity", 0,   1,   0.05, v.fillOpacity,   (x) => Number(x).toFixed(2))}
      ${range("strokeWidth",   "Stroke width", 0.5, 5,   0.1,  v.strokeWidth,   (x) => Number(x).toFixed(1))}

      <h4>KDE</h4>
      ${range("bandwidth", "Bandwidth (0 = auto)", 0, 50, 0.5, v.bandwidth, (x) => Number(x).toFixed(1))}

      <h4>Histogram</h4>
      ${range("histBins", "Bins", 2, 200, 1, v.histBins, (x) => Math.round(x))}

      <h4>Statistics</h4>
      <label>
        <span class="lbl-text">Mean (μ)</span>
        <input type="checkbox" data-prop="showMean" ${v.showMean ? "checked" : ""}/>
      </label>
      <label>
        <span class="lbl-text">Median</span>
        <input type="checkbox" data-prop="showMedian" ${v.showMedian ? "checked" : ""}/>
      </label>
      <label>
        <span class="lbl-text">Quartile band (IQR)</span>
        <input type="checkbox" data-prop="showQuartiles" ${v.showQuartiles ? "checked" : ""}/>
      </label>

      <h4>Extras</h4>
      <label>
        <span class="lbl-text">3D ridges</span>
        <input type="checkbox" data-prop="ridge3D" ${v.ridge3D ? "checked" : ""}/>
      </label>
      <label>
        <span class="lbl-text">Show data ticks</span>
        <input type="checkbox" data-prop="showDataPoints" ${v.showDataPoints ? "checked" : ""}/>
      </label>
    `;

    // Wire range sliders (live value + property write on release)
    panel.querySelectorAll('input[type="range"]').forEach((el) => {
      const valEl = panel.querySelector(`[data-val-for="${el.dataset.prop}"]`);
      el.addEventListener("input", () => {
        if (valEl) {
          const num = Number(el.value);
          valEl.textContent = el.step === "1" ? Math.round(num) : num.toFixed(2);
        }
      });
      el.addEventListener("change", () => {
        props[el.dataset.prop].set(Number(el.value));
      });
    });

    // Wire checkbox
    panel.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.addEventListener("change", () => {
        props[el.dataset.prop].set(el.checked);
      });
    });

    // Wire radio
    panel.querySelectorAll('input[type="radio"][name="ridgeMode"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (el.checked) props.ridgeMode.set(el.value);
      });
    });

    // Wire <select> dropdowns
    panel.querySelectorAll('select[data-prop]').forEach((el) => {
      el.addEventListener("change", () => {
        props[el.dataset.prop].set(el.value);
      });
    });

    // Wire <input type="number">
    panel.querySelectorAll('input[type="number"][data-prop]').forEach((el) => {
      el.addEventListener("change", () => {
        const n = Number(el.value);
        props[el.dataset.prop].set(Number.isFinite(n) ? n : 0);
      });
    });
  }

  async function toggleSettings() {
    if (panel.classList.contains("hidden")) {
      try {
        await buildSettingsPanel();
        panel.classList.remove("hidden");
      } catch (e) {
        console.error("[JoyPlot] failed to open settings", e);
      }
    } else {
      panel.classList.add("hidden");
    }
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSettings();
    });
  }

  // Click-outside-to-close
  document.addEventListener("click", (event) => {
    if (panel.classList.contains("hidden")) return;
    if (panel.contains(event.target)) return;
    if (settingsBtn && settingsBtn.contains(event.target)) return;
    panel.classList.add("hidden");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Main render function
  // ─────────────────────────────────────────────────────────────────────────
  async function render(
    xAxis, yAxis, colorAxis, markerByAxis, trellisAxis,
    dataView,
    ridgeModeP, overlapFactorP, bandwidthP, histBinsP,
    fillOpacityP, strokeWidthP, showDataPointsP, ridge3DP,
    showMeanP, showMedianP, showQuartilesP, sortByP, trellisModeP,
    windowSize,
  ) {
    // Read pagination properties lazily — keeping them out of the reader
    // subscription means an older manifest (without these properties) can't
    // stall renders.
    const safeProp = async (name, fallback) => {
      try {
        const p = await mod.property(name);
        if (p && typeof p.value === "function" && typeof p.set === "function") return p;
        console.warn(`[JoyPlot] property "${name}" returned but missing value()/set() — using stub. Reload the mod so Spotfire picks up the new manifest.`);
      } catch (e) {
        console.warn(`[JoyPlot] property "${name}" not found in manifest — using stub. Reload the mod (right-click → Reload Mod) so Spotfire picks up the new manifest.`, e);
      }
      return { value: () => fallback, set: () => {} };
    };
    const panelsPerPageP     = await safeProp("panelsPerPage", 0);
    const panelsPerPageColsP = await safeProp("panelsPerPageCols", 0);
    const panelsPerPageRowsP = await safeProp("panelsPerPageRows", 0);
    // Capture properties so the settings panel can read/write them.
    latestProps = {
      ridgeMode:      ridgeModeP,
      overlapFactor:  overlapFactorP,
      bandwidth:      bandwidthP,
      histBins:       histBinsP,
      fillOpacity:    fillOpacityP,
      strokeWidth:    strokeWidthP,
      showDataPoints: showDataPointsP,
      ridge3D:        ridge3DP,
      showMean:       showMeanP,
      showMedian:     showMedianP,
      showQuartiles:  showQuartilesP,
      sortBy:         sortByP,
      trellisMode:    trellisModeP,
      panelsPerPage:     panelsPerPageP,
      panelsPerPageCols: panelsPerPageColsP,
      panelsPerPageRows: panelsPerPageRowsP,
    };

    // Push Spotfire theme → CSS variables (recomputed each render so a
    // theme change in the host immediately re-themes the visual).
    const styling = applyStyling();
    const themeText = (styling && styling.scales.font.color) || "#666666";
    const themeScaleLine = (styling && styling.scales.line.stroke) || "#d0d0d0";
    // ── Diagnostics ─────────────────────────────────────────────────────────
    console.log("[JoyPlot] render called", {
      xAxis: xAxis && { name: xAxis.name, expression: xAxis.expression, isMapped: xAxis.isMapped },
      yAxis: yAxis && { name: yAxis.name, expression: yAxis.expression, isMapped: yAxis.isMapped },
      markerByAxis: markerByAxis && { name: markerByAxis.name, expression: markerByAxis.expression, isMapped: markerByAxis.isMapped },
      window: windowSize,
    });

    // ── Auto-disable aggregation ────────────────────────────────────────────
    // Spotfire forces Sum()/aggregation on continuous axes whenever the data
    // has any categorical grouping. We sidestep this entirely by ensuring the
    // "Marker by" axis carries <baserowid()>, which makes every source row a
    // distinct mark — no aggregation is applied to X or Color.
    if (markerByAxis && !markerByAxis.expression) {
      try {
        await markerByAxis.setExpression("<baserowid()>");
        // The setExpression call will re-trigger render; bail out for now.
        return;
      } catch (e) {
        console.warn("[JoyPlot] could not auto-set MarkerBy expression", e);
      }
    }

    // ── Axis-mapping checks ─────────────────────────────────────────────────
    const xMapped = !!(xAxis && (xAxis.expression || (xAxis.parts && xAxis.parts.length)));
    const yMapped = !!(yAxis && (yAxis.expression || (yAxis.parts && yAxis.parts.length)));
    if (!xMapped) {
      showEmpty("Drop a numeric column on the Value axis.");
      context.signalRenderComplete();
      return;
    }
    if (!yMapped) {
      showEmpty("Drop a categorical column on the Category axis.");
      context.signalRenderComplete();
      return;
    }

    // ── Check for errors ────────────────────────────────────────────────────
    const errors = await dataView.getErrors();
    if (errors.length > 0) {
      showError(errors.map((e) => e.message).join("\n"));
      context.signalRenderComplete();
      return;
    }

    // ── Read properties ─────────────────────────────────────────────────────
    const ridgeMode    = ridgeModeP.value();       // "kde" | "histogram" | "both"
    const overlapFactor = Math.max(0.5, Math.min(5, overlapFactorP.value() ?? 1.5));
    const bwOverride   = bandwidthP.value() ?? 0;  // 0 = auto
    const histBins     = Math.max(2, Math.min(200, histBinsP.value() ?? 20));
    const fillOpacity  = Math.max(0, Math.min(1, fillOpacityP.value() ?? 0.75));
    const strokeWidth  = Math.max(0.5, strokeWidthP.value() ?? 1.5);
    const showPoints   = showDataPointsP.value() ?? false;
    const ridge3D      = ridge3DP.value() ?? true;
    const showMean     = showMeanP.value() ?? false;
    const showMedian   = showMedianP.value() ?? false;
    const showQuartiles = showQuartilesP.value() ?? false;
    const sortBy        = sortByP.value() ?? "value";    // "value" | "category"

    // ── Read rows ────────────────────────────────────────────────────────────
    let allRows;
    try {
      allRows = await dataView.allRows();
    } catch (e) {
      console.error("[JoyPlot] dataView.allRows() failed", e);
      showError("Failed to read rows: " + (e && e.message ? e.message : e));
      context.signalRenderComplete();
      return;
    }
    console.log("[JoyPlot] allRows count =", allRows ? allRows.length : "null");

    if (!allRows || allRows.length === 0) {
      showEmpty("No rows. Put <baserowid()> on Marker by, or check filters.");
      context.signalRenderComplete();
      return;
    }

    // ── Extract values ───────────────────────────────────────────────────────
    // X is a continuous (expression) axis. To get one mark per source row
    // instead of an aggregated value, the user must put a row-unique expression
    // on the "MarkerBy" axis (e.g. <baserowid()> or <Row Number>).
    let extractError = null;
    let firstSample = null;
    const colorMapped = !!(colorAxis && (colorAxis.expression || (colorAxis.parts && colorAxis.parts.length)));
    const colorIsContinuous = colorMapped && colorAxis.isCategorical === false;

    // Detect whether the user has dropped a column on the "Trellis by" axis.
    // Spotfire's axis-property checks (.expression / .parts) can report
    // truthy values even for an empty axis, so we use the dataView hierarchy
    // (the same approach as the Donut mod) as the source of truth. We then
    // probe one row to confirm a categorical("Trellis by") value can actually
    // be read — if not, treat the axis as unmapped and skip trellising.
    let trellisMapped = false;
    try {
      const h = await dataView.hierarchy("Trellis by");
      trellisMapped = !!(h && h.isEmpty === false);
    } catch (_) { trellisMapped = false; }
    if (trellisMapped && allRows.length > 0) {
      try {
        const probe = allRows[0].categorical("Trellis by");
        if (!probe || probe.formattedValue == null) trellisMapped = false;
      } catch (_) { trellisMapped = false; }
    }
    console.log("[JoyPlot] trellisMapped =", trellisMapped);

    const rows = allRows.map((row, i) => {
      try {
        const xRaw = row.continuous("Value").value();
        const xNum = xRaw === null || xRaw === undefined ? null : Number(xRaw);
        let colorVal = null;
        if (colorIsContinuous) {
          try { colorVal = row.continuous("Color").value(); } catch (_) { colorVal = null; }
        }
        let trellisKey = null;
        if (trellisMapped) {
          try { trellisKey = String(row.categorical("Trellis by").formattedValue()); } catch (_) { trellisKey = null; }
        }
        const sample = {
          rowId:    row.elementId(),
          xRaw,
          xNum,
          xType:    typeof xRaw,
          yVal:     String(row.categorical("Category").formattedValue()),
          color:    row.color().hexCode,
          marked:   row.isMarked(),
        };
        if (i === 0) firstSample = sample;
        return {
          rowId:    sample.rowId,
          row,                       // keep DataViewRow reference for marking
          xVal:     Number.isFinite(xNum) ? xNum : null,
          yVal:     sample.yVal,
          trellisKey,
          colorVal,
          color:    sample.color,
          marked:   sample.marked,
          filtered: row.isFiltered !== undefined ? !row.isFiltered() : false,
        };
      } catch (e) {
        if (!extractError) extractError = e;
        return null;
      }
    }).filter((r) => r && r.xVal !== null && r.xVal !== undefined);

    if (extractError) console.error("[JoyPlot] row extraction error", extractError);
    console.log("[JoyPlot] first row sample =", firstSample);
    console.log("[JoyPlot] valid rows =", rows.length, "of", allRows.length);

    if (rows.length === 0) {
      const hint = firstSample
        ? `First row X = ${JSON.stringify(firstSample.xRaw)} (type ${firstSample.xType}). ` +
          `If null, check that the X column has values for these rows. ` +
          `If aggregated, ensure Marker by has <baserowid()>.`
        : "No rows returned at all.";
      showEmpty("No valid X values. " + hint);
      context.signalRenderComplete();
      return;
    }

    // ── Aggregation sanity check (global) ───────────────────────────────────
    const yKeysGlobal = [...viz.group(rows, (r) => r.yVal).keys()];
    const groupsLookAggregated = yKeysGlobal.every((k) => {
      const grp = rows.filter((r) => r.yVal === k);
      if (!grp || grp.length <= 1) return true;
      const uniq = new Set(grp.map((r) => r.xVal));
      return uniq.size <= 1;
    });
    if (groupsLookAggregated) {
      const hasMarkerBy = !!(markerByAxis && markerByAxis.expression);
      const msg = hasMarkerBy
        ? "X looks aggregated. Set Marker by to <baserowid()> (or another row-unique expression) to plot the full distribution."
        : "X looks aggregated. Drop a row-unique field on Marker by — try <baserowid()> — so each source row contributes a value.";
      showEmpty(msg);
      context.signalRenderComplete();
      return;
    }

    // Shared X domain across all trellis panels for visual comparability.
    const xExtent = viz.extent(rows, (r) => r.xVal);

    // ── Trellis orchestration ───────────────────────────────────────────────
    let trellisMode = (trellisModeP.value() || "rows").toLowerCase();
    // If the user supplied cols and/or rows on the pagination control,
    // they want a grid — promote to "panels" mode regardless of the saved
    // trellis layout choice. This is what makes 2 × 2 actually produce a
    // 2-wide, 2-tall grid even if the dropdown still says "Rows".
    const _ppCols0 = Math.max(0, Math.floor(panelsPerPageColsP.value() ?? 0));
    const _ppRows0 = Math.max(0, Math.floor(panelsPerPageRowsP.value() ?? 0));
    console.log("[JoyPlot] pagination", { cols: _ppCols0, rows: _ppRows0, savedMode: trellisMode });
    if (_ppCols0 > 0 || _ppRows0 > 0) trellisMode = "panels";

    // Final guard: even if the API reported the trellis axis as mapped, an
    // unmapped axis often surfaces as a single trellisKey that is null,
    // empty, or literally "(Empty)" — in that case there's only one panel's
    // worth of data, so render it without trellis chrome.
    if (trellisMapped) {
      const distinctKeys = new Set(rows.map((r) => r.trellisKey));
      const onlyEmpty =
        distinctKeys.size === 0 ||
        (distinctKeys.size === 1 && (() => {
          const k = distinctKeys.values().next().value;
          return k == null || k === "" || /^\(empty\)$/i.test(String(k).trim());
        })());
      if (onlyEmpty) trellisMapped = false;
    }

    // Build leaves: one per unique trellis key, or a single anonymous leaf
    // when the Trellis-by axis isn't mapped.
    const leafGrouped = trellisMapped
      ? viz.group(rows, (r) => r.trellisKey == null ? "(empty)" : r.trellisKey)
      : new Map([[null, rows]]);

    const leaves = [];
    for (const [key, leafRows] of leafGrouped) {
      leaves.push({
        id:    key == null ? "/null" : "/" + String(key).replace(/[^a-zA-Z0-9_-]/g, "_"),
        label: key,
        rows:  leafRows,
      });
    }
    // Sort: numeric ascending if all numeric, else alphabetical.
    leaves.sort((a, b) => {
      const va = a.label, vb = b.label;
      if (va == null && vb == null) return 0;
      if (va == null) return -1;
      if (vb == null) return 1;
      const na = Number(va), nb = Number(vb);
      const aNum = !isNaN(na) && va !== "";
      const bNum = !isNaN(nb) && vb !== "";
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return String(va).localeCompare(String(vb));
    });

    // Build / refresh the trellis grid DOM. When the Trellis-by axis isn't
    // mapped, we render a single full-bleed panel with NO trellis chrome
    // (no border, no title, no mode-specific sizing) so the visual looks
    // identical to the pre-trellis behaviour.
    const collection = viz.select("#trellis-collection");
    const wrapper    = viz.select("#trellis-wrapper");
    // Preserve the current scroll position across the full DOM rebuild —
    // marking, hover, etc. all trigger re-renders, and without this the
    // scrollbar snaps back to the top each time.
    const _prevScrollTop  = collection.node().scrollTop  || 0;
    const _prevScrollLeft = collection.node().scrollLeft || 0;
    collection.selectAll("*").remove();
    if (trellisMapped) {
      wrapper.classed("trellised", true);
      collection.attr("class", "trellis-collection trellised " + trellisMode);
    } else {
      wrapper.classed("trellised", false);
      collection.attr("class", "trellis-collection single");
    }

    // Use clientWidth/clientHeight (excludes scrollbar gutter) so that panel
    // size calculations never include space occupied by the scrollbar track.
    const wrapperNode = wrapper.node();
    const collW = (wrapperNode.clientWidth  || wrapperNode.getBoundingClientRect().width)  || windowSize.width;
    const collH = (wrapperNode.clientHeight || wrapperNode.getBoundingClientRect().height) || windowSize.height;
    const leafCount = leaves.length;

    // Compute panel sizes per trellis mode (only when actually trellised).
    // Pagination: panelsPerPageCols × panelsPerPageRows fixes the grid that
    // fits in one viewport; everything beyond overflows into a vertical
    // scrollbar (horizontal in Columns mode).
    //   - Rows mode    : only the rows count is used
    //   - Columns mode : only the cols count is used
    //   - Panels mode  : both are used; cols also fixes the grid width so
    //                    pages stay visually aligned
    // 0 in either field means "fit to viewport" for that axis.
    const ppCols  = Math.max(0, Math.floor(panelsPerPageColsP.value() ?? 0));
    const ppRows  = Math.max(0, Math.floor(panelsPerPageRowsP.value() ?? 0));
    // Backwards compat: legacy single-value property still fills in if the
    // mode-relevant axis is left at 0.
    const ppLegacy = Math.max(0, Math.floor(panelsPerPageP.value() ?? 0));

    let panelW = "auto", panelH = "auto";
    let gridCols = 1, gridRows = leafCount;
    let paginated = false;
    if (trellisMapped) {
      if (trellisMode === "rows") {
        const perPage = ppRows > 0 ? ppRows : ppLegacy;
        const visible = perPage > 0 ? Math.min(perPage, leafCount) : leafCount;
        paginated = perPage > 0 && leafCount > perPage;
        panelH = `calc(100% / ${visible})`;
      } else if (trellisMode === "columns") {
        const perPage = ppCols > 0 ? ppCols : ppLegacy;
        const visible = perPage > 0 ? Math.min(perPage, leafCount) : leafCount;
        paginated = perPage > 0 && leafCount > perPage;
        panelW = `calc(100% / ${visible})`;
      } else if (trellisMode === "panels") {
        // Choose grid columns: explicit cols → use them; else default sqrt.
        if (ppCols > 0) {
          gridCols = Math.max(1, Math.min(ppCols, leafCount));
        } else {
          gridCols = Math.max(1, Math.ceil(Math.sqrt(leafCount)));
        }
        gridRows = Math.max(1, Math.ceil(leafCount / gridCols));

        // Visible rows per page: explicit rows → use them; else fit all.
        const visibleRows = ppRows > 0
          ? Math.min(ppRows, gridRows)
          : gridRows;
        paginated = ppRows > 0 && gridRows > ppRows;

        // When a vertical scrollbar will appear, show the custom scrollbar
        // div first so the browser allocates its 12px immediately.
        const sbEl = document.getElementById('sf-vscrollbar');
        if (sbEl) sbEl.style.display = paginated ? 'flex' : 'none';
        // Use CSS calc() so the browser distributes width exactly —
        // no pixel rounding errors, no dependency on measured clientWidth.
        panelW = `calc(100% / ${gridCols})`;
        panelH = `calc(100% / ${visibleRows})`;
      }
    }
    collection.classed("paginated", paginated);
    collection.classed("paginated-h", paginated && trellisMode === "columns");
    // Mirror onto wrapper so CSS can remove the conflicting border side
    // without needing :has() (unsupported in older Chromium builds).
    wrapper.classed("paginated",   paginated);
    wrapper.classed("paginated-h", paginated && trellisMode === "columns");

    // Show/hide the custom vertical scrollbar div. It's only used for
    // vertical scrolling (rows + panels modes). Columns mode uses the
    // native horizontal webkit scrollbar.
    const _vsbEl = document.getElementById('sf-vscrollbar');
    if (_vsbEl) {
      const showVsb = paginated && trellisMode !== "columns";
      _vsbEl.style.display = showVsb ? 'flex' : 'none';
    }

    // Create panel DOM
    leaves.forEach((leaf, idx) => {
      const panelEl = collection.append("div").attr("class", "trellis-panel");
      if (trellisMapped) {
        panelEl.style("--panel-width",  panelW);
        panelEl.style("--panel-height", panelH);
        if (trellisMode === "panels") {
          if ((idx + 1) % gridCols === 0)            panelEl.classed("last-of-row", true);
          if (idx >= (gridRows - 1) * gridCols)      panelEl.classed("last-of-column", true);
        }
      }
      const allLeafMarked = leaf.rows.length > 0 && leaf.rows.every((r) => r.marked);
      panelEl.append("div")
        .attr("class", "title" + (allLeafMarked ? " panel-header-selected" : ""))
        .text(leaf.label == null ? "" : String(leaf.label))
        .on("click", async (event) => {
          event.stopPropagation();
          const additive = event.ctrlKey || event.metaKey;
          const rowRefs = leaf.rows.map((r) => r.row).filter(Boolean);
          await markRows(rowRefs, additive, dataView);
        });
      panelEl.append("div")
        .attr("class", "trellis-panel-content")
        .attr("data-trellis-id", leaf.id)
        .append("svg").attr("class", "joy-plot-svg");
    });

    // Render each panel against its measured size
    const anyMarked = rows.some((r) => r.marked);

    // ── Global density normalization (Option C) ─────────────────────────────
    // Compute one shared peak density across every (panel, category) group
    // so the per-panel kdeYScale / histYScale below all map [0, globalMax]
    // → [0, ridgeH]. Without this, each ridge is rescaled to its own peak,
    // making heights non-comparable both within and across trellis panels.
    //
    // The thresholds used for the global pre-pass mirror what renderPanel()
    // uses: a 120-tick grid over the shared X domain (padded by 5%, same as
    // the panel xScale below). Recomputing KDE in the panel itself is cheap
    // and keeps the rendering path unchanged.
    const padFactor = 0.05;
    const sharedXMin = xExtent[0] - (xExtent[1] - xExtent[0]) * padFactor;
    const sharedXMax = xExtent[1] + (xExtent[1] - xExtent[0]) * padFactor;
    const sharedThresholds = viz.scaleLinear()
      .domain([sharedXMin, sharedXMax])
      .ticks(120);
    // Bin thresholds are coarser (driven by the histBins property).
    const sharedHistThresholds = viz.scaleLinear()
      .domain([sharedXMin, sharedXMax])
      .ticks(histBins);

    let globalMaxKDE  = 0;
    let globalMaxHist = 0;
    leaves.forEach((leaf) => {
      const groupedLeaf = viz.group(leaf.rows, (r) => r.yVal);
      for (const [, gRows] of groupedLeaf) {
        const xs = gRows.map((r) => r.xVal).filter(Number.isFinite);
        if (xs.length === 0) continue;
        const bw = bwOverride > 0 ? bwOverride : silvermanBandwidth(xs);
        const kde = computeKDE(xs, sharedThresholds, bw);
        const m = viz.max(kde, (p) => p[1]) || 0;
        if (m > globalMaxKDE) globalMaxKDE = m;
        if (ridgeMode === "histogram" || ridgeMode === "both") {
          const hist = viz.bin().value((r) => r.xVal)
            .domain([sharedXMin, sharedXMax])
            .thresholds(sharedHistThresholds)(gRows);
          const h = viz.max(hist, (b) => b.length) || 0;
          if (h > globalMaxHist) globalMaxHist = h;
        }
      }
    });
    if (globalMaxKDE  === 0) globalMaxKDE  = 1;
    if (globalMaxHist === 0) globalMaxHist = 1;

    const panelCtx = {
      ridgeMode, overlapFactor, bwOverride, histBins, fillOpacity, strokeWidth,
      showPoints, ridge3D, showMean, showMedian, showQuartiles, sortBy,
      xExtent, anyMarked, themeText, themeScaleLine, dataView, markerByAxis,
      globalMaxKDE, globalMaxHist,
    };
    leaves.forEach((leaf) => {
      const contentEl = collection.select(`[data-trellis-id="${leaf.id}"]`);
      if (contentEl.empty()) return;
      const svgSel = contentEl.select("svg.joy-plot-svg");
      const rect = contentEl.node().getBoundingClientRect();
      const W = Math.max(50, Math.floor(rect.width));
      const H = Math.max(50, Math.floor(rect.height));
      svgSel.attr("width", W).attr("height", H);
      renderPanel(svgSel, leaf.rows, W, H, panelCtx);
    });

    // Restore the scrollbar position captured before the rebuild so a
    // re-render triggered by marking/hover doesn't snap the user back to
    // the top of the page.
    if (_prevScrollTop || _prevScrollLeft) {
      const node = collection.node();
      node.scrollTop  = _prevScrollTop;
      node.scrollLeft = _prevScrollLeft;
    }

    // Set up the custom vertical scrollbar interaction (thumb sync + buttons).
    setupCustomScrollbar(collection.node(), paginated && trellisMode !== "columns");

    context.signalRenderComplete();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Custom vertical scrollbar — mirrors Spotfire's native scrollbar structure:
  //   12px container | 12px arrow buttons | 6px thumb centred in track
  // Called after every render so the thumb reflects the current scroll state.
  // ───────────────────────────────────────────────────────────────────────────
  function setupCustomScrollbar(collNode, isActive) {
    const sbEl   = document.getElementById('sf-vscrollbar');
    if (!sbEl) return;

    // Tear down previous listeners stored on the element.
    if (sbEl._sbCleanup) { sbEl._sbCleanup(); sbEl._sbCleanup = null; }

    if (!isActive) return;

    const thumb   = sbEl.querySelector('.sf-scrollbar-thumb');
    const track   = sbEl.querySelector('.sf-scrollbar-track');
    const btnUp   = sbEl.querySelector('.sf-scrollbar-btn-up');
    const btnDown = sbEl.querySelector('.sf-scrollbar-btn-down');

    // ── Sync thumb position / size to current scroll state ──────────────────
    function updateThumb() {
      const scrollH  = collNode.scrollHeight;
      const clientH  = collNode.clientHeight;
      if (scrollH <= clientH) { thumb.style.display = 'none'; return; }
      thumb.style.display = '';
      const trackH   = track.clientHeight;
      const ratio    = clientH / scrollH;
      const thumbH   = Math.max(20, Math.round(trackH * ratio));
      const maxTop   = trackH - thumbH;
      const top      = Math.round((collNode.scrollTop / (scrollH - clientH)) * maxTop);
      thumb.style.height = thumbH + 'px';
      thumb.style.top    = Math.min(maxTop, top) + 'px';
    }

    collNode.addEventListener('scroll', updateThumb);
    updateThumb();

    // ── Arrow buttons: scroll by ~10% of visible height per click ───────────
    function onUp()   { collNode.scrollTop -= Math.round(collNode.clientHeight * 0.1); }
    function onDown() { collNode.scrollTop += Math.round(collNode.clientHeight * 0.1); }
    btnUp.addEventListener('click', onUp);
    btnDown.addEventListener('click', onDown);

    // ── Thumb drag ───────────────────────────────────────────────────────────
    function onThumbMousedown(e) {
      e.preventDefault();
      const startY          = e.clientY;
      const startScrollTop  = collNode.scrollTop;
      const trackH          = track.clientHeight;
      const thumbH          = thumb.clientHeight;
      const scrollRange     = collNode.scrollHeight - collNode.clientHeight;
      const pxPerUnit       = scrollRange / Math.max(1, trackH - thumbH);

      function onMove(e) {
        collNode.scrollTop = startScrollTop + (e.clientY - startY) * pxPerUnit;
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    thumb.addEventListener('mousedown', onThumbMousedown);

    // Store cleanup so the next render call removes stale listeners.
    sbEl._sbCleanup = () => {
      collNode.removeEventListener('scroll', updateThumb);
      btnUp.removeEventListener('click', onUp);
      btnDown.removeEventListener('click', onDown);
      thumb.removeEventListener('mousedown', onThumbMousedown);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-panel chart renderer (called once per trellis leaf by render()).
  function renderPanel(svg, rows, W, H, ctx) {
    const {
      ridgeMode, overlapFactor, bwOverride, histBins, fillOpacity, strokeWidth,
      showPoints, ridge3D, showMean, showMedian, showQuartiles, sortBy,
      xExtent, anyMarked, themeText, dataView,
      globalMaxKDE, globalMaxHist,
    } = ctx;

    // ── Per-panel grouping by Category ──────────────────────────────────────
    const grouped = viz.group(rows, (r) => r.yVal);
    const yKeys = [...grouped.keys()];

    // Order ridges per the user's chosen mode.
    //   "value":    sort by each group's median X so the group with the
    //               smallest ("leftmost") distribution ends up at the BOTTOM
    //               of the panel. yScale.range() maps yKeys[0] → top and
    //               yKeys[last] → bottom, so we sort descending by median.
    //   "category": preserve incoming category order (Spotfire's order),
    //               but if all keys parse as numbers, sort numerically.
    if (sortBy === "value") {
      const medianByKey = new Map();
      for (const k of yKeys) {
        const xs = (grouped.get(k) || []).map((r) => r.xVal).filter(Number.isFinite);
        medianByKey.set(k, xs.length ? viz.median(xs) : Infinity);
      }
      // Descending by median → smallest median ends up last → rendered at bottom.
      yKeys.sort((a, b) => medianByKey.get(b) - medianByKey.get(a));
    } else {
      const allNumericY = yKeys.every((k) => !isNaN(Number(k)));
      if (allNumericY) yKeys.sort((a, b) => Number(a) - Number(b));
    }
    if (yKeys.length === 0) return;

    // ── Layout ───────────────────────────────────────────────────────────────
    // Use a smaller left margin when the panel is narrow (trellised columns).
    const leftMargin = Math.min(90, Math.max(40, W * 0.18));
    const margin = { top: 24, right: 16, bottom: 22, left: leftMargin };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;

    // Ridge slot height
    const nGroups  = yKeys.length;
    const slotH    = innerH / nGroups;
    const ridgeH   = slotH * overlapFactor;  // actual peak height (can exceed slot)

    // ── Scales ───────────────────────────────────────────────────────────────
    const xScale = viz.scaleLinear()
      .domain([xExtent[0] - (xExtent[1] - xExtent[0]) * 0.05,
               xExtent[1] + (xExtent[1] - xExtent[0]) * 0.05])
      .range([0, innerW]);

    // yScale: scalePoint distributes baselines evenly between range[0] and
    // range[1]. Every non-top ridge gets `step` px of vertical room above
    // it (the gap between consecutive baselines). The TOP ridge only gets
    // `range[0]` px above it. To make the top ridge's headroom match the
    // gap between every other pair, solve:
    //     range[0] == step == (range[1] - range[0]) / (n - 1)
    //   ⇒ range[0] = (innerH - bottomPad) / n
    // That gives the topmost ridge the same vertical breathing room as
    // every other ridge — no more "extra empty band on top".
    const bottomPad = 4;
    const topPad = (innerH - bottomPad) / nGroups;
    const yScale = viz.scalePoint()
      .domain(yKeys)
      .range([topPad, innerH - bottomPad])
      .padding(0);

    // ── SVG setup ─────────────────────────────────────────────────────────────
    svg.selectAll("*").remove();
    svg.attr("width", W).attr("height", H);

    // Background
    svg.append("rect")
      .attr("width", W).attr("height", H)
      .attr("fill", "transparent");

    // ── Defs: drop-shadow filter + per-color ridge gradient ─────────────────
    // We register a single shadow filter and one linearGradient per unique
    // color used by the visible groups. Gradients fade from a lighter top
    // (highlight) through the base color to a darker bottom (shaded base),
    // which together with the shadow gives ridges a "3D" feel.
    const defs = svg.append("defs");
    // Each panel has its own SVG so we use a stable, panel-local shadow id.
    // (D3 randomness avoided to keep output deterministic for tests.)
    const shadowId = "ridge-shadow-" + Math.abs(
      (svg.attr("data-panel-id") || ("p" + Math.random().toString(36).slice(2, 9)))
        .split("").reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
    );
    svg.attr("data-shadow-id", shadowId);
    if (ridge3D) {
      // Stronger drop shadow — gives ridges real lift off the background.
      const shadow = defs.append("filter")
        .attr("id", shadowId)
        .attr("x", "-30%").attr("y", "-30%")
        .attr("width", "160%").attr("height", "200%");
      shadow.append("feGaussianBlur").attr("in", "SourceAlpha").attr("stdDeviation", 4);
      shadow.append("feOffset").attr("dx", 1).attr("dy", 4).attr("result", "off");
      shadow.append("feComponentTransfer").append("feFuncA").attr("type", "linear").attr("slope", 0.75);
      const merge = shadow.append("feMerge");
      merge.append("feMergeNode");
      merge.append("feMergeNode").attr("in", "SourceGraphic");
    }

    // Build a gradient lookup keyed by hex color so we don't duplicate defs.
    // Diagonal gradient simulates side-lighting from the upper-left.
    const gradIds = new Map();
    const lighten = (hex, amt) => shiftColor(hex, amt);
    const darken  = (hex, amt) => shiftColor(hex, -amt);
    function ridgeFill(hex) {
      if (!ridge3D) return hex;
      if (gradIds.has(hex)) return `url(#${gradIds.get(hex)})`;
      const id = "rg-" + hex.replace(/[^a-zA-Z0-9]/g, "");
      gradIds.set(hex, id);
      const grad = defs.append("linearGradient")
        .attr("id", id)
        .attr("x1", "0%").attr("y1", "0%")
        .attr("x2", "30%").attr("y2", "100%");   // diagonal: top-left bright → bottom-right dark
      grad.append("stop").attr("offset", "0%").attr("stop-color", lighten(hex, 55));
      grad.append("stop").attr("offset", "20%").attr("stop-color", lighten(hex, 25));
      grad.append("stop").attr("offset", "55%").attr("stop-color", hex);
      grad.append("stop").attr("offset", "85%").attr("stop-color", darken(hex, 25));
      grad.append("stop").attr("offset", "100%").attr("stop-color", darken(hex, 55));
      return `url(#${id})`;
    }

    // Number of "extrusion" layers to draw behind the main ridge to fake depth.
    // Each layer is offset slightly down-right and progressively darker, like
    // 3D text shadows. Bigger value = chunkier ridges, but more SVG nodes.
    const EXTRUDE_LAYERS = ridge3D ? 6 : 0;
    const EXTRUDE_DX = 0.8;
    const EXTRUDE_DY = 1.2;

    const g = svg.append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // (anyMarked is supplied by the orchestrator so all panels stay in
    // visual lock-step — marking in one panel fades unmarked ridges in all.)

    // ── Draw ridges (back-to-front by visible baseline Y) ───────────────────
    // SVG paints later siblings on top of earlier ones. Sort the draw order
    // by baseline Y ascending so the visually-lowest ridge is painted LAST
    // and therefore overlaps every ridge above it. This is independent of
    // how `yKeys` happens to be ordered (alphabetical, numeric, Spotfire
    // hierarchy, etc.) — it always tracks the on-screen position.
    const drawOrder = [...yKeys].sort((a, b) => yScale(a) - yScale(b));

    drawOrder.forEach((yKey) => {
      const groupRows = grouped.get(yKey);
      const baselineY = yScale(yKey);
      const groupColor = groupRows[0].color; // representative color from Spotfire
      const markedRows = groupRows.filter((r) => r.marked);
      const groupHasMarks = markedRows.length > 0;

      // Fade level applied to the full-group ridge when marking is active
      // somewhere in the view.
      const baseOpacity = anyMarked ? fillOpacity * 0.5 : fillOpacity;
      const baseStrokeOpacity = anyMarked ? 0.55 : 0.9;

      // ── Compute KDE ────────────────────────────────────────────────────────
      const xVals = groupRows.map((r) => r.xVal);
      const bw = bwOverride > 0 ? bwOverride : silvermanBandwidth(xVals);
      const kdePoints = computeKDE(xVals, xScale.ticks(120), bw);
      const maxKDE    = viz.max(kdePoints, (p) => p[1]) || 1;

      // ── Compute Histogram ──────────────────────────────────────────────────
      // Bin the row objects (keyed by xVal) so each bin retains its source
      // rows — needed for marking when a bar is clicked.
      const histogram = viz.bin()
        .value((r) => r.xVal)
        .domain(xScale.domain())
        .thresholds(xScale.ticks(histBins));
      const bins = histogram(groupRows);
      const maxHist = viz.max(bins, (b) => b.length) || 1;

      // ── Density scale ──────────────────────────────────────────────────────
      // Use the GLOBAL maxes (computed in render() across every panel and
      // every category) so a ridge with twice the density is visually twice
      // as tall — both within this panel AND across trellis panels.
      // Falls back to the per-group max if the orchestrator didn't supply
      // a global value (defensive only).
      const kdeDomain  = globalMaxKDE  > 0 ? globalMaxKDE  : maxKDE;
      const histDomain = globalMaxHist > 0 ? globalMaxHist : maxHist;
      const kdeYScale  = viz.scaleLinear().domain([0, kdeDomain]).range([0, ridgeH]).clamp(true);
      const histYScale = viz.scaleLinear().domain([0, histDomain]).range([0, ridgeH]).clamp(true);

      const ridgeGroup = g.append("g")
        .attr("class", "ridge-group")
        .attr("data-key", yKey);
      if (ridge3D) {
        const sid = svg.attr("data-shadow-id");
        if (sid) ridgeGroup.attr("filter", `url(#${sid})`);
      }

      // ── KDE area + line ────────────────────────────────────────────────────
      if (ridgeMode === "kde" || ridgeMode === "both") {
        const areaGen = viz.area()
          .x((p) => xScale(p[0]))
          .y0(0)
          .y1((p) => -kdeYScale(p[1]))
          .curve(viz.curveBasis);

        const lineGen = viz.line()
          .x((p) => xScale(p[0]))
          .y((p) => -kdeYScale(p[1]))
          .curve(viz.curveBasis);

        // Extruded depth layers — stack of progressively darker, offset
        // copies of the area to fake real volume. Drawn back-to-front so
        // the main ridge ends up on top.
        for (let i = EXTRUDE_LAYERS; i >= 1; i--) {
          const t = i / EXTRUDE_LAYERS;            // 1 at deepest, ~0 at front
          ridgeGroup.append("path")
            .datum(kdePoints)
            .attr("class", "ridge-extrude")
            .attr("transform", `translate(${i * EXTRUDE_DX},${baselineY + i * EXTRUDE_DY})`)
            .attr("d", areaGen)
            .attr("fill", darken(groupColor, 35 + t * 25))
            .attr("fill-opacity", baseOpacity * (1 - t * 0.25))
            .attr("stroke", "none")
            .attr("pointer-events", "none");
        }

        // Filled area
        ridgeGroup.append("path")
          .datum(kdePoints)
          .attr("class", "ridge-area kde-area")
          .attr("transform", `translate(0,${baselineY})`)
          .attr("d", areaGen)
          .attr("fill", ridgeFill(groupColor))
          .attr("fill-opacity", baseOpacity)
          .attr("stroke", "none")
          .on("mousemove", (event) => onRidgeHover(event, yKey, xVals, groupRows))
          .on("mouseleave", hideTooltip);
          // Click marking is handled by the brush mouseup so a single
          // click on a ridge and a Ctrl-click on another behave consistently.

        // Specular crest highlight — thin bright stroke just above the top
        if (ridge3D) {
          ridgeGroup.append("path")
            .datum(kdePoints)
            .attr("class", "ridge-specular")
            .attr("transform", `translate(0,${baselineY - 0.5})`)
            .attr("d", lineGen)
            .attr("fill", "none")
            .attr("stroke", lighten(groupColor, 75))
            .attr("stroke-width", Math.max(0.5, strokeWidth * 0.5))
            .attr("stroke-opacity", baseStrokeOpacity * 0.85)
            .attr("pointer-events", "none");
        }

        // Stroke line (acts as the top highlight in 3D mode)
        ridgeGroup.append("path")
          .datum(kdePoints)
          .attr("class", "ridge-line kde-line")
          .attr("transform", `translate(0,${baselineY})`)
          .attr("d", lineGen)
          .attr("stroke", ridge3D ? lighten(groupColor, 50) : groupColor)
          .attr("stroke-width", strokeWidth)
          .attr("stroke-opacity", baseStrokeOpacity)
          .attr("pointer-events", "none");

        // ── Marked-range area highlight ────────────────────────────────────
        // If ALL rows in this group are marked (ridge-click or full capture),
        // highlight the entire ridge at full opacity.
        // If only a subset is marked, highlight the sub-range
        // [min(marked xVal), max(marked xVal)] under the curve.
        if (groupHasMarks) {
          const allMarked = markedRows.length === groupRows.length;

          if (allMarked) {
            // Full ridge highlight — re-draw the area + line at full opacity.
            ridgeGroup.append("path")
              .datum(kdePoints)
              .attr("class", "ridge-area kde-area marked-hl")
              .attr("transform", `translate(0,${baselineY})`)
              .attr("d", areaGen)
              .attr("fill", ridgeFill(groupColor))
              .attr("fill-opacity", fillOpacity)
              .attr("stroke", "none")
              .attr("pointer-events", "none");

            ridgeGroup.append("path")
              .datum(kdePoints)
              .attr("class", "ridge-line kde-line marked-hl")
              .attr("transform", `translate(0,${baselineY})`)
              .attr("d", lineGen)
              .attr("fill", "none")
              .attr("stroke", ridge3D ? lighten(groupColor, 60) : groupColor)
              .attr("stroke-width", strokeWidth)
              .attr("stroke-opacity", 1)
              .attr("pointer-events", "none");
          } else {
          const markedXMin = viz.min(markedRows, (r) => r.xVal);
          const markedXMax = viz.max(markedRows, (r) => r.xVal);

          if (Number.isFinite(markedXMin) && Number.isFinite(markedXMax) && markedXMax > markedXMin) {
            // Evaluate the kernel at the exact boundary X values so the area
            // starts and ends precisely there, not snapped to the nearest tick.
            const kdeKernel = gaussianKernel(bw);
            const kdeAtX = (x) => viz.mean(xVals, (v) => kdeKernel(x - v));

            const interior = kdePoints.filter((p) => p[0] > markedXMin && p[0] < markedXMax);
            const bLeft  = [markedXMin, kdeAtX(markedXMin)];
            const bRight = [markedXMax, kdeAtX(markedXMax)];

            // Duplicate endpoints so curveBasis passes through them exactly.
            const hlData = [bLeft, bLeft, ...interior, bRight, bRight];

            const hlAreaGen = viz.area()
              .x((p) => xScale(p[0]))
              .y0(0)
              .y1((p) => -kdeYScale(p[1]))
              .curve(viz.curveBasis);

            const hlLineGen = viz.line()
              .x((p) => xScale(p[0]))
              .y((p) => -kdeYScale(p[1]))
              .curve(viz.curveBasis);

            // Filled area — full opacity so it stands out over the faded ridge.
            ridgeGroup.append("path")
              .datum(hlData)
              .attr("class", "ridge-area kde-area marked-hl")
              .attr("transform", `translate(0,${baselineY})`)
              .attr("d", hlAreaGen)
              .attr("fill", ridgeFill(groupColor))
              .attr("fill-opacity", fillOpacity)
              .attr("stroke", "none")
              .attr("pointer-events", "none");

            // Bright outline on top of the highlighted area.
            ridgeGroup.append("path")
              .datum(hlData)
              .attr("class", "ridge-line kde-line marked-hl")
              .attr("transform", `translate(0,${baselineY})`)
              .attr("d", hlLineGen)
              .attr("fill", "none")
              .attr("stroke", ridge3D ? lighten(groupColor, 60) : groupColor)
              .attr("stroke-width", strokeWidth)
              .attr("stroke-opacity", 1)
              .attr("pointer-events", "none");
          }
          } // end else (partial selection)
        }
      }

      // ── Histogram bars ────────────────────────────────────────────────────
      if (ridgeMode === "histogram" || ridgeMode === "both") {
        const barOpacity = ridgeMode === "both" ? fillOpacity * 0.5 : fillOpacity;
        const fadedBarOpacity = anyMarked ? barOpacity * 0.5 : barOpacity;

        // Pre-bin the marked subset so we can overlay full-opacity bars on top.
        const markedBinsByKey = groupHasMarks
          ? viz.bin().value((r) => r.xVal).domain(xScale.domain()).thresholds(xScale.ticks(histBins))(markedRows)
          : null;

        ridgeGroup.selectAll(".hist-bar")
          .data(bins)
          .join("rect")
          .attr("class", "hist-bar")
          .attr("transform", `translate(0,${baselineY})`)
          .attr("x", (b) => xScale(b.x0) + 0.5)
          .attr("width", (b) => Math.max(0, xScale(b.x1) - xScale(b.x0) - 1))
          .attr("y", (b) => -histYScale(b.length))
          .attr("height", (b) => histYScale(b.length))
          .attr("fill", ridgeFill(groupColor))
          .attr("fill-opacity", fadedBarOpacity)
          .attr("stroke", groupColor)
          .attr("stroke-width", 0.5)
          .attr("stroke-opacity", anyMarked ? 0.5 : 0.7)
          .on("mousemove", (event, b) => onBinHover(event, yKey, b, groupRows))
          .on("mouseleave", hideTooltip);
          // Click marking on bars is also handled centrally by the brush
          // mouseup handler — it detects which ridge baseline the mouse is on.

        if (markedBinsByKey) {
          ridgeGroup.selectAll(".hist-bar-marked")
            .data(markedBinsByKey)
            .join("rect")
            .attr("class", "hist-bar hist-bar-marked")
            .attr("transform", `translate(0,${baselineY})`)
            .attr("x", (b) => xScale(b.x0) + 0.5)
            .attr("width", (b) => Math.max(0, xScale(b.x1) - xScale(b.x0) - 1))
            .attr("y", (b) => -histYScale(b.length))
            .attr("height", (b) => histYScale(b.length))
            .attr("fill", ridgeFill(groupColor))
            .attr("fill-opacity", barOpacity)
            .attr("stroke", groupColor)
            .attr("stroke-width", 0.5)
            .attr("stroke-opacity", 0.9)
            .attr("pointer-events", "none");
        }
      }

      // ── Baseline ──────────────────────────────────────────────────────────
      ridgeGroup.append("line")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", baselineY).attr("y2", baselineY)
        .attr("stroke", groupColor)
        .attr("stroke-width", 0.8)
        .attr("stroke-opacity", 0.4);

      // ── Stat overlays (mean / median / quartiles) ─────────────────────────
      if (showMean || showMedian || showQuartiles) {
        const sorted = xVals.slice().sort(viz.ascending);
        const stats = {
          mean:   viz.mean(sorted),
          median: viz.median(sorted),
          q1:     viz.quantile(sorted, 0.25),
          q3:     viz.quantile(sorted, 0.75),
        };
        const statTop    = baselineY - ridgeH;
        const statBottom = baselineY;
        const STAT_COLOR = themeText;     // follow Spotfire theme so stats
                                          // are readable in light + dark.

        // IQR shaded band from Q1 to Q3
        if (showQuartiles && Number.isFinite(stats.q1) && Number.isFinite(stats.q3)) {
          ridgeGroup.append("rect")
            .attr("class", "stat-iqr")
            .attr("x", xScale(stats.q1))
            .attr("y", statTop)
            .attr("width", Math.max(1, xScale(stats.q3) - xScale(stats.q1)))
            .attr("height", ridgeH)
            .attr("fill", STAT_COLOR)
            .attr("fill-opacity", 0.08)
            .attr("stroke", STAT_COLOR)
            .attr("stroke-opacity", 0.55)
            .attr("stroke-dasharray", "2 2")
            .attr("stroke-width", 0.8)
            .attr("pointer-events", "none");
        }

        const drawStatLine = (xVal, klass, dash) => {
          if (!Number.isFinite(xVal)) return;
          const x = xScale(xVal);
          ridgeGroup.append("line")
            .attr("class", klass)
            .attr("x1", x).attr("x2", x)
            .attr("y1", statTop - 4).attr("y2", statBottom + 4)
            .attr("stroke", STAT_COLOR)
            .attr("stroke-width", 1.6)
            .attr("stroke-dasharray", dash)
            .attr("stroke-opacity", 1)
            .attr("pointer-events", "none");
        };

        if (showMedian) drawStatLine(stats.median, "stat-median", "0");
        if (showMean)   drawStatLine(stats.mean,   "stat-mean",   "4 2");
      }

      // ── Individual data point ticks ────────────────────────────────────────
      if (showPoints) {
        ridgeGroup.selectAll(".data-tick")
          .data(groupRows)
          .join("line")
          .attr("class", "data-tick")
          .attr("x1", (r) => xScale(r.xVal))
          .attr("x2", (r) => xScale(r.xVal))
          .attr("y1", baselineY - 8)
          .attr("y2", baselineY + 8)
          .attr("stroke", (r) => r.color)
          .attr("stroke-width", 1.75)
          .attr("stroke-linecap", "round")
          .attr("opacity", (r) => r.marked ? 1 : (anyMarked ? 0.55 : 0.85));
      }

      // ── Marked-row tick overlay ───────────────────────────────────────────
      // Replaces the old dashed bracket; matches Spotfire's convention of
      // visually emphasising marked rows at the baseline.
      if (groupHasMarks) {
        ridgeGroup.selectAll(".mark-tick")
          .data(markedRows)
          .join("line")
          .attr("class", "mark-tick")
          .attr("x1", (r) => xScale(r.xVal))
          .attr("x2", (r) => xScale(r.xVal))
          .attr("y1", baselineY - 6)
          .attr("y2", baselineY + 6)
          .attr("stroke", groupColor)
          .attr("stroke-width", 1.5)
          .attr("stroke-opacity", 0.95)
          .attr("pointer-events", "none");
      }
    });

    // ── Stats legend (top of chart, only when any stat is enabled) ──────────
    if (showMean || showMedian || showQuartiles) {
      const legend = svg.append("g")
        .attr("class", "stats-legend")
        .attr("transform", `translate(${margin.left}, ${Math.max(12, margin.top - 16)})`);

      let cx = 0;
      const items = [];
      if (showMean)      items.push({ label: "Mean (μ)",   dash: "4 2", isLine: true });
      if (showMedian)    items.push({ label: "Median",     dash: "0",   isLine: true });
      if (showQuartiles) items.push({ label: "IQR (Q1–Q3)", isLine: false });

      items.forEach((item) => {
        if (item.isLine) {
          legend.append("line")
            .attr("x1", cx).attr("x2", cx + 18)
            .attr("y1", 0).attr("y2", 0)
            .attr("stroke", themeText)
            .attr("stroke-width", 1.6)
            .attr("stroke-dasharray", item.dash);
        } else {
          legend.append("rect")
            .attr("x", cx).attr("y", -5)
            .attr("width", 18).attr("height", 10)
            .attr("fill", themeText).attr("fill-opacity", 0.08)
            .attr("stroke", themeText).attr("stroke-opacity", 0.55)
            .attr("stroke-dasharray", "2 2")
            .attr("stroke-width", 0.8);
        }
        legend.append("text")
          .attr("x", cx + 24)
          .attr("y", 0)
          .attr("dominant-baseline", "middle")
          .attr("fill", themeText)
          .attr("font-size", 10)
          .attr("font-weight", 600)
          .text(item.label);
        cx += 24 + item.label.length * 6.2 + 14;
      });
    }

    // Right-align labels in the left margin and truncate any text that would
    // overflow that gutter. We measure with the actual rendered SVG text node
    // and chop characters from the end until it fits, appending an ellipsis.
    // The full label is preserved in a <title> so users can hover to read it.
    const labelMaxW = Math.max(20, margin.left - 14); // 4px gutter + 10px gap
    const labelSel = g.selectAll(".y-label")
      .data(yKeys)
      .join("text")
      .attr("class", "y-label")
      .attr("x", -10)
      .attr("y", (k) => yScale(k))
      .attr("text-anchor", "end")
      .text((k) => (k == null ? "" : String(k)));
    labelSel.each(function (k) {
      const node = this;
      const full = k == null ? "" : String(k);
      if (!node.getComputedTextLength) return;
      let txt = full;
      // Fast path: already fits.
      if (node.getComputedTextLength() <= labelMaxW) return;
      // Trim until "txt…" fits.
      while (txt.length > 1 && node.getComputedTextLength() > labelMaxW) {
        txt = txt.slice(0, -1);
        node.textContent = txt + "…";
      }
    });
    labelSel.append("title").text((k) => (k == null ? "" : String(k)));

    // ── X axis ────────────────────────────────────────────────────────────────
    g.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${innerH})`)
      .call(viz.axisBottom(xScale).ticks(8).tickSizeOuter(0));

    // (X axis title intentionally omitted — column name is shown in tooltip.)

    // ── Rubber-band marking ───────────────────────────────────────────────────
    setupRubberBand(svg, g, xScale, yScale, yKeys, grouped, margin, dataView, ridgeH);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KDE helpers
  // ─────────────────────────────────────────────────────────────────────────

  function silvermanBandwidth(values) {
    const n   = values.length;
    if (n < 2) return 1;
    const mean = viz.mean(values);
    const std  = Math.sqrt(viz.mean(values.map((v) => (v - mean) ** 2)));
    const iqr  = viz.quantile(values.slice().sort(viz.ascending), 0.75)
               - viz.quantile(values.slice().sort(viz.ascending), 0.25);
    const s = Math.min(std, iqr / 1.34) || std || 1;
    return 1.06 * s * Math.pow(n, -0.2);
  }

  function gaussianKernel(bw) {
    return (u) => Math.exp(-0.5 * (u / bw) ** 2) / (bw * Math.sqrt(2 * Math.PI));
  }

  function computeKDE(values, thresholds, bw) {
    const kernel = gaussianKernel(bw);
    return thresholds.map((t) => [
      t,
      viz.mean(values, (v) => kernel(t - v)),
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Color helpers
  // ─────────────────────────────────────────────────────────────────────────

  // Shift a hex color toward white (positive amount) or black (negative).
  // amount is roughly 0..100 (percent of the distance to the target).
  function shiftColor(hex, amount) {
    if (!hex || typeof hex !== "string") return hex;
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const t = amount >= 0 ? 255 : 0;
    const p = Math.min(100, Math.abs(amount)) / 100;
    const mix = (c) => Math.round(c + (t - c) * p);
    const toHex = (n) => n.toString(16).padStart(2, "0");
    return "#" + toHex(mix(r)) + toHex(mix(g)) + toHex(mix(b));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tooltip helpers — uses the native Spotfire tooltip via mod.controls.tooltip
  // ─────────────────────────────────────────────────────────────────────────

  // mod.controls.tooltip exposes show(content)/hide(). It styles + positions
  // the tooltip exactly like a built-in Spotfire visualization and follows
  // the mouse until hide() is called. Subsequent show() calls just update
  // the text in place.
  const nativeTooltip = mod.controls && mod.controls.tooltip;

  function showTooltip(_event, text) {
    if (nativeTooltip) nativeTooltip.show(text);
  }

  function hideTooltip() {
    if (nativeTooltip) nativeTooltip.hide();
  }

  function onRidgeHover(event, yKey, xVals, groupRows) {
    const mean   = viz.mean(xVals).toFixed(2);
    const median = viz.median(xVals).toFixed(2);
    const sd     = Math.sqrt(viz.variance(xVals)).toFixed(2);
    const min    = viz.min(xVals).toFixed(2);
    const max    = viz.max(xVals).toFixed(2);
    // Native tooltip takes plain text. Use tab-aligned key/value pairs.
    showTooltip(event,
      `${yKey}\n` +
      `Count:   ${xVals.length}\n` +
      `Mean:    ${mean}\n` +
      `Median:  ${median}\n` +
      `Std Dev: ${sd}\n` +
      `Min:     ${min}\n` +
      `Max:     ${max}`
    );
  }

  function onBinHover(event, yKey, bin, groupRows) {
    showTooltip(event,
      `${yKey}\n` +
      `Range: ${bin.x0.toFixed(2)} – ${bin.x1.toFixed(2)}\n` +
      `Count: ${bin.length}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Marking helpers
  // ─────────────────────────────────────────────────────────────────────────

  async function onRidgeClick(event, groupRows, dataView) {
    event.stopPropagation();
    const ctrl = event.ctrlKey || event.metaKey;
    const rows = groupRows.map((r) => r.row).filter(Boolean);
    await markRows(rows, ctrl, dataView);
  }

  async function onBinClick(event, bin, dataView) {
    event.stopPropagation();
    const ctrl = event.ctrlKey || event.metaKey;
    // viz.bin() preserves the source-row references on each bin entry; in our
    // pipeline each entry is a `rows[]` element which carries `.row`.
    const rows = bin.map((v) => v && v.row).filter(Boolean);
    if (rows.length > 0) await markRows(rows, ctrl, dataView);
  }

  async function markRows(rows, additive, dataView) {
    if (!rows || rows.length === 0) return;
    const mode = additive ? "ToggleOrAdd" : "Replace";
    try {
      await dataView.mark(rows, mode);
    } catch (e) {
      console.error("[JoyPlot] mark() failed", e);
    }
  }

  function setupRubberBand(svg, g, xScale, yScale, yKeys, grouped, margin, dataView, ridgeH) {
    const DRAG_THRESHOLD = 6; // px — generous so a Ctrl-click jitter still counts as a click
    let startX = null, startY = null;
    let rubberRect = null;
    let isDragging = false;

    // Each ridge has its baseline at yScale(key) and its body extends UPWARD
    // from that baseline by ridgeH pixels (so visible body spans
    // [yScale(key) - ridgeH, yScale(key)]). With overlapFactor > 1, adjacent
    // ridges overlap, so pure-geometry hit-testing is ambiguous. We therefore
    // first try real SVG element-hit-testing (which respects draw order /
    // z-order and matches what the user actually sees), and only fall back
    // to geometric snapping for clicks that land on empty background.

    // For click handling we want a strict hit-test: only treat the click as
    // landing on a ridge when the actual DOM target IS part of that ridge's
    // group. Anything else (gridline, baseline, axis text, plain background)
    // counts as "empty" and should clear marking. The previous geometric
    // fallback caused empty-space clicks to mark nearby ridges.
    const ridgeAtEvent = (event) => {
      const target = event && event.target;
      if (target && target.closest) {
        const grp = target.closest(".ridge-group[data-key]");
        if (grp) return grp.getAttribute("data-key");
      }
      return null;
    };

    svg.on("mousedown", (event) => {
      if (event.button !== 0) return;
      // Don't start a band when interacting with the settings UI.
      if (event.target.closest("#settings-btn, #settings-panel")) return;
      // Suppress the browser's native text-selection drag so axis tick
      // labels (and any other text) don't get highlighted while the user
      // is rubber-band marking. CSS `user-select:none` on #mod-container
      // is the primary defense; this is a safety net for browsers that
      // still initiate a selection on mousedown.
      event.preventDefault();
      const [mx, my] = viz.pointer(event, g.node());
      startX = mx; startY = my;
      isDragging = false;
      rubberRect = g.append("rect")
        .attr("class", "marking-rect")
        .attr("x", mx).attr("y", my)
        .attr("width", 0).attr("height", 0);

      // Bind move/up on the WINDOW (not the SVG) so the drag continues to
      // track and a release that happens outside the SVG (over the settings
      // panel, another panel, the page chrome, etc.) still completes the
      // selection. This mirrors how Spotfire's native marking works
      // (see Donut's RectMarking — it also attaches to `document`).
      window.addEventListener("mousemove", onDocMove,  true);
      window.addEventListener("mouseup",   onDocUp,    true);
    });

    // Convert a window-space mouse event into a point in the inner-plot
    // coordinate system used by xScale/yScale, clamped so a release outside
    // the panel still produces a sensible selection rectangle.
    const ptFromEvent = (event) => {
      const [mx, my] = viz.pointer(event, g.node());
      // Inner plot extents (g is already translated by margin.left/top).
      const innerW = (xScale.range()[1] - xScale.range()[0]);
      // yScale is a scalePoint; safe bounds for the band rectangle:
      const innerH = (svg.node().clientHeight || 0) - margin.top - margin.bottom;
      return [
        Math.max(0, Math.min(innerW, mx)),
        Math.max(0, Math.min(innerH, my)),
      ];
    };

    const onDocMove = (event) => {
      if (startX === null || !rubberRect) return;
      const [mx, my] = ptFromEvent(event);
      const w = Math.abs(mx - startX);
      const h = Math.abs(my - startY);
      if (!isDragging && (w > DRAG_THRESHOLD || h > DRAG_THRESHOLD)) isDragging = true;
      rubberRect
        .attr("x", Math.min(startX, mx))
        .attr("y", Math.min(startY, my))
        .attr("width", w)
        .attr("height", h);
    };

    const onDocUp = async (event) => {
      window.removeEventListener("mousemove", onDocMove, true);
      window.removeEventListener("mouseup",   onDocUp,   true);
      if (startX === null) return;
      const [mx, my] = ptFromEvent(event);

      const wasDragging = isDragging;
      const pressX = startX, pressY = startY;
      const x0px = Math.min(startX, mx), x1px = Math.max(startX, mx);
      const y0px = Math.min(startY, my), y1px = Math.max(startY, my);

      if (rubberRect) { rubberRect.remove(); rubberRect = null; }
      startX = null; startY = null;
      isDragging = false;

      const additive = event.ctrlKey || event.metaKey || event.shiftKey;

      if (!wasDragging) {
        // Treat as a click.
        const key = ridgeAtEvent(event);
        if (key) {
          const rows = (grouped.get(key) || []).map((r) => r.row).filter(Boolean);
          await markRows(rows, additive, dataView);
        } else if (!additive) {
          // Empty click → clear all marking.
          try { await dataView.clearMarking(); } catch {}
        }
        return;
      }

      // Drag → mark every row whose ridge baseline is in the band's Y range
      // AND whose X value is in the band's X range.
      const x0 = xScale.invert(x0px);
      const x1 = xScale.invert(x1px);

      // Hit-test: which ridges does the rubber-band actually cover?
      //
      // Each ridge's baseline is at yScale(key); the slot between consecutive
      // baselines is slotH. With overlapFactor > 1 the visual body (ridgeH)
      // extends above the slot, into the neighbour's space — so testing against
      // ridgeH or even slotH makes the selection too sensitive: crossing ridge
      // A's baseline by 1 px immediately captures ridge B below.
      //
      // Fix: only capture ridge B when the rectangle's bottom edge crosses the
      // MIDPOINT of B's slot (slotH/2 below A's baseline). This requires a
      // deliberate movement into B's territory, not just a slight overshoot.
      const slotH = yScale.step ? yScale.step() : ridgeH;
      const inBandKeys = yKeys.filter((k) => {
        const yb = yScale(k);
        // The capture zone for this ridge is its lower half: [yb - slotH/2, yb).
        // rect top (y0px) must be above the baseline; rect bottom (y1px) must
        // reach the midpoint of the slot.
        return y0px < yb && y1px >= (yb - slotH * 0.5);
      });

      const selectedRows = [];
      inBandKeys.forEach((k) => {
        (grouped.get(k) || []).forEach((r) => {
          if (r.xVal >= x0 && r.xVal <= x1 && r.row) selectedRows.push(r.row);
        });
      });

      if (selectedRows.length > 0) {
        await markRows(selectedRows, additive, dataView);
      } else {
        // Tiny drag that didn't actually intersect any ridge body —
        // treat it as a click on the press point so Ctrl-clicks that
        // jitter a few pixels still add to the marking.
        const key = ridgeAtEvent(event);
        if (key) {
          const rows = (grouped.get(key) || []).map((r) => r.row).filter(Boolean);
          await markRows(rows, additive, dataView);
        } else if (!additive) {
          try { await dataView.clearMarking(); } catch {}
        }
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Error / empty states
  // ─────────────────────────────────────────────────────────────────────────

  function showEmpty(msg) {
    const collection = viz.select("#trellis-collection");
    collection.selectAll("*").remove();
    collection.classed("trellised", false);
    const W = collection.node().clientWidth || 600;
    const H = collection.node().clientHeight || 300;
    const svg = collection.append("svg")
      .attr("class", "joy-plot-svg empty-svg")
      .attr("width", W).attr("height", H)
      .style("width", "100%").style("height", "100%");
    svg.append("text")
      .attr("class", "empty-state")
      .attr("x", W / 2).attr("y", H / 2)
      .attr("text-anchor", "middle")
      .attr("font-size", 14)
      .text(msg);
    console.log("[JoyPlot]", msg);
  }

  function showError(msg) {
    showEmpty(`⚠ ${msg}`);
  }
});
