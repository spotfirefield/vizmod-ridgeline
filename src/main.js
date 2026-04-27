/* globals Spotfire */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
Spotfire.initialize(async (mod) => {
  const context = mod.getRenderContext();

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
    mod.visualization.axis("X"),
    mod.visualization.axis("Y"),
    mod.visualization.axis("Color"),
    mod.visualization.axis("MarkerBy"),
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
    mod.windowSize(),
  );

  reader.subscribe(render);

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
    xAxis, yAxis, colorAxis, markerByAxis,
    dataView,
    ridgeModeP, overlapFactorP, bandwidthP, histBinsP,
    fillOpacityP, strokeWidthP, showDataPointsP, ridge3DP,
    showMeanP, showMedianP, showQuartilesP,
    windowSize,
  ) {
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
    };
    // ── Diagnostics ─────────────────────────────────────────────────────────
    console.log("[JoyPlot] render called", {
      xAxis: xAxis && { name: xAxis.name, expression: xAxis.expression, isMapped: xAxis.isMapped },
      yAxis: yAxis && { name: yAxis.name, expression: yAxis.expression, isMapped: yAxis.isMapped },
      markerByAxis: markerByAxis && { name: markerByAxis.name, expression: markerByAxis.expression, isMapped: markerByAxis.isMapped },
      window: windowSize,
    });

    // Always size the SVG so the diagnostic text below is visible.
    viz.select("#joy-plot-svg")
      .attr("width", windowSize.width)
      .attr("height", windowSize.height);

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
      showEmpty("Drop a numeric column on the X axis.");
      context.signalRenderComplete();
      return;
    }
    if (!yMapped) {
      showEmpty("Drop a categorical column on the Y axis.");
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
    const rows = allRows.map((row, i) => {
      try {
        const xRaw = row.continuous("X").value();
        const xNum = xRaw === null || xRaw === undefined ? null : Number(xRaw);
        let colorVal = null;
        if (colorIsContinuous) {
          try { colorVal = row.continuous("Color").value(); } catch (_) { colorVal = null; }
        }
        const sample = {
          rowId:    row.elementId(),
          xRaw,
          xNum,
          xType:    typeof xRaw,
          yVal:     String(row.categorical("Y").formattedValue()),
          color:    row.color().hexCode,
          marked:   row.isMarked(),
        };
        if (i === 0) firstSample = sample;
        return {
          rowId:    sample.rowId,
          row,                       // keep DataViewRow reference for marking
          xVal:     Number.isFinite(xNum) ? xNum : null,
          yVal:     sample.yVal,
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

    // ── Group by Y ───────────────────────────────────────────────────────────
    const grouped = viz.group(rows, (r) => r.yVal);
    // Preserve order of first appearance (or sort if all numeric)
    const yKeys = [...grouped.keys()];
    const allNumericY = yKeys.every((k) => !isNaN(Number(k)));
    if (allNumericY) yKeys.sort((a, b) => Number(a) - Number(b));

    // ── Aggregation sanity check ─────────────────────────────────────────────
    // If every group has at most one unique X value, the data is almost
    // certainly being aggregated by Spotfire. Show a friendly hint instead
    // of drawing a single useless dot per ridge.
    const groupsLookAggregated = yKeys.every((k) => {
      const groupRows = grouped.get(k);
      if (!groupRows || groupRows.length <= 1) return true;
      const uniq = new Set(groupRows.map((r) => r.xVal));
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

    const xExtent = viz.extent(rows, (r) => r.xVal);

    // ── Layout ───────────────────────────────────────────────────────────────
    const W = windowSize.width;
    const H = windowSize.height;
    const margin = { top: 30, right: 30, bottom: 24, left: 90 };
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

    // yScale: maps each group key to its baseline y position (bottom of ridge).
    // Bottom baseline sits on the x-axis; top baseline leaves enough headroom
    // for the tallest ridge peak (ridgeH).
    const yScale = viz.scalePoint()
      .domain(yKeys)
      .range([Math.min(ridgeH, innerH * 0.5), innerH - 4])
      .padding(0);

    // ── SVG setup ─────────────────────────────────────────────────────────────
    const svg = viz.select("#joy-plot-svg");
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
    if (ridge3D) {
      // Stronger drop shadow — gives ridges real lift off the background.
      const shadow = defs.append("filter")
        .attr("id", "ridge-shadow")
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

    // ── Gridlines ────────────────────────────────────────────────────────────
    g.append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        viz.axisBottom(xScale)
          .tickSize(-innerH)
          .tickFormat("")
      )
      .call((gEl) => {
        gEl.select(".domain").remove();
        gEl.selectAll("line")
          .attr("stroke", "rgba(200,134,42,0.08)")
          .attr("stroke-dasharray", "4,4");
      });

    // Detect whether any rows are marked anywhere in the view. When true,
    // Spotfire convention is to fade everything that is *not* marked and
    // overlay the marked subset at full intensity.
    const anyMarked = rows.some((r) => r.marked);

    // ── Draw ridges (back-to-front: last group = bottom) ─────────────────────
    // We draw in reverse so earlier groups (top) appear on top of later ones
    const drawOrder = [...yKeys].reverse();

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

      // ── Local density scale ────────────────────────────────────────────────
      const kdeYScale  = viz.scaleLinear().domain([0, maxKDE]).range([0, ridgeH]);
      const histYScale = viz.scaleLinear().domain([0, maxHist]).range([0, ridgeH]);

      const ridgeGroup = g.append("g")
        .attr("class", "ridge-group")
        .attr("data-key", yKey);
      if (ridge3D) ridgeGroup.attr("filter", "url(#ridge-shadow)");

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

        // Overlay: KDE of just the marked subset, drawn at full intensity.
        if (groupHasMarks) {
          const markedXVals = markedRows.map((r) => r.xVal);
          // Reuse the same bandwidth so the marked overlay aligns with the
          // shape of the full ridge rather than being noisy at small N.
          const markedKdePoints = computeKDE(markedXVals, xScale.ticks(120), bw);
          // Scale the marked density by its share of the group so the overlay
          // height reflects how much of the distribution is marked.
          const share = markedXVals.length / xVals.length;
          const markedAreaGen = viz.area()
            .x((p) => xScale(p[0]))
            .y0(0)
            .y1((p) => -kdeYScale(p[1] * share))
            .curve(viz.curveBasis);
          const markedLineGen = viz.line()
            .x((p) => xScale(p[0]))
            .y((p) => -kdeYScale(p[1] * share))
            .curve(viz.curveBasis);

          ridgeGroup.append("path")
            .datum(markedKdePoints)
            .attr("class", "ridge-area kde-area marked")
            .attr("transform", `translate(0,${baselineY})`)
            .attr("d", markedAreaGen)
            .attr("fill", ridgeFill(groupColor))
            .attr("fill-opacity", fillOpacity)
            .attr("stroke", "none")
            .attr("pointer-events", "none");

          ridgeGroup.append("path")
            .datum(markedKdePoints)
            .attr("class", "ridge-line kde-line marked")
            .attr("transform", `translate(0,${baselineY})`)
            .attr("d", markedLineGen)
            .attr("stroke", ridge3D ? lighten(groupColor, 60) : groupColor)
            .attr("stroke-width", strokeWidth)
            .attr("stroke-opacity", 1)
            .attr("pointer-events", "none");
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
        const STAT_COLOR = "#000";        // user requested black for visibility

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
            .attr("stroke", "#000")
            .attr("stroke-width", 1.6)
            .attr("stroke-dasharray", item.dash);
        } else {
          legend.append("rect")
            .attr("x", cx).attr("y", -5)
            .attr("width", 18).attr("height", 10)
            .attr("fill", "#000").attr("fill-opacity", 0.08)
            .attr("stroke", "#000").attr("stroke-opacity", 0.55)
            .attr("stroke-dasharray", "2 2")
            .attr("stroke-width", 0.8);
        }
        legend.append("text")
          .attr("x", cx + 24)
          .attr("y", 0)
          .attr("dominant-baseline", "middle")
          .attr("fill", "var(--og-text, #c0a878)")
          .attr("font-size", 10)
          .attr("font-weight", 600)
          .text(item.label);
        cx += 24 + item.label.length * 6.2 + 14;
      });
    }

    g.selectAll(".y-label")
      .data(yKeys)
      .join("text")
      .attr("class", "y-label")
      .attr("x", -10)
      .attr("y", (k) => yScale(k))
      .text((k) => k);

    // ── X axis ────────────────────────────────────────────────────────────────
    g.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${innerH})`)
      .call(viz.axisBottom(xScale).ticks(8).tickSizeOuter(0));

    // (X axis title intentionally omitted — column name is shown in tooltip.)

    // ── Rubber-band marking ───────────────────────────────────────────────────
    setupRubberBand(svg, g, xScale, yScale, yKeys, grouped, margin, dataView, ridgeH);

    context.signalRenderComplete();
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
  // Tooltip helpers
  // ─────────────────────────────────────────────────────────────────────────

  const tooltip = document.getElementById("tooltip");

  function showTooltip(event, html) {
    tooltip.innerHTML = html;
    tooltip.classList.remove("hidden");
    positionTooltip(event);
  }

  function positionTooltip(event) {
    const ttW = tooltip.offsetWidth;
    const ttH = tooltip.offsetHeight;
    const cx  = window.innerWidth;
    const cy  = window.innerHeight;
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + ttW > cx - 10) x = event.clientX - ttW - 14;
    if (y + ttH > cy - 10) y = event.clientY - ttH - 14;
    tooltip.style.left = `${Math.max(0, x)}px`;
    tooltip.style.top  = `${Math.max(0, y)}px`;
  }

  function hideTooltip() {
    tooltip.classList.add("hidden");
  }

  function onRidgeHover(event, yKey, xVals, groupRows) {
    const mean   = viz.mean(xVals).toFixed(2);
    const median = viz.median(xVals).toFixed(2);
    const sd     = Math.sqrt(viz.variance(xVals)).toFixed(2);
    const min    = viz.min(xVals).toFixed(2);
    const max    = viz.max(xVals).toFixed(2);
    showTooltip(event, `
      <div class="tooltip-group">${yKey}</div>
      <div class="tooltip-row"><span class="tooltip-label">Count</span><span class="tooltip-value">${xVals.length}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Mean</span><span class="tooltip-value">${mean}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Median</span><span class="tooltip-value">${median}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Std Dev</span><span class="tooltip-value">${sd}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Min</span><span class="tooltip-value">${min}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Max</span><span class="tooltip-value">${max}</span></div>
    `);
  }

  function onBinHover(event, yKey, bin, groupRows) {
    showTooltip(event, `
      <div class="tooltip-group">${yKey}</div>
      <div class="tooltip-row"><span class="tooltip-label">Range</span><span class="tooltip-value">${bin.x0.toFixed(2)} – ${bin.x1.toFixed(2)}</span></div>
      <div class="tooltip-row"><span class="tooltip-label">Count</span><span class="tooltip-value">${bin.length}</span></div>
    `);
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
    const slotH = (yScale.step ? yScale.step() : 30);
    const halfBand = slotH * 0.5;

    const ridgeAtEvent = (event, yPx) => {
      // 1) Element under the cursor — walks up the DOM to find the ridge group.
      const target = event && event.target;
      if (target && target.closest) {
        const grp = target.closest(".ridge-group[data-key]");
        if (grp) {
          const k = grp.getAttribute("data-key");
          if (k != null) return k;
        }
      }
      // 2) Fallback: nearest baseline within one slot height. Bias slightly
      //    toward baselines that sit BELOW the click (since ridge bodies
      //    extrude upward from their baseline).
      let best = null, bestD = Infinity;
      for (const k of yKeys) {
        const baseline = yScale(k);
        const d = baseline >= yPx
          ? (baseline - yPx)              // click is above baseline (in body)
          : (yPx - baseline) * 1.5;       // click is below baseline (penalised)
        if (d < bestD && d <= slotH) { bestD = d; best = k; }
      }
      return best;
    };

    svg.on("mousedown", (event) => {
      if (event.button !== 0) return;
      // Don't start a band when interacting with the settings UI.
      if (event.target.closest("#settings-btn, #settings-panel")) return;
      const [mx, my] = viz.pointer(event, g.node());
      startX = mx; startY = my;
      isDragging = false;
      rubberRect = g.append("rect")
        .attr("class", "marking-rect")
        .attr("x", mx).attr("y", my)
        .attr("width", 0).attr("height", 0);
    });

    svg.on("mousemove", (event) => {
      if (startX === null || !rubberRect) return;
      const [mx, my] = viz.pointer(event, g.node());
      const w = Math.abs(mx - startX);
      const h = Math.abs(my - startY);
      if (!isDragging && (w > DRAG_THRESHOLD || h > DRAG_THRESHOLD)) isDragging = true;
      rubberRect
        .attr("x", Math.min(startX, mx))
        .attr("y", Math.min(startY, my))
        .attr("width", w)
        .attr("height", h);
    });

    svg.on("mouseup", async (event) => {
      if (startX === null) return;
      const [mx, my] = viz.pointer(event, g.node());

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
        const key = ridgeAtEvent(event, my);
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

      const inBandKeys = yKeys.filter((k) => {
        const yb = yScale(k);
        return yb + halfBand >= y0px && yb - halfBand <= y1px;
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
        const key = ridgeAtEvent(event, pressY);
        if (key) {
          const rows = (grouped.get(key) || []).map((r) => r.row).filter(Boolean);
          await markRows(rows, additive, dataView);
        } else if (!additive) {
          try { await dataView.clearMarking(); } catch {}
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Error / empty states
  // ─────────────────────────────────────────────────────────────────────────

  function showEmpty(msg) {
    const svg = viz.select("#joy-plot-svg");
    svg.selectAll("*").remove();
    const W = +svg.attr("width") || svg.node().clientWidth || 600;
    const H = +svg.attr("height") || svg.node().clientHeight || 300;
    svg.attr("width", W).attr("height", H);
    svg.append("text")
      .attr("class", "empty-state")
      .attr("x", W / 2).attr("y", H / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c0a878")
      .attr("font-size", 14)
      .text(msg);
    console.log("[JoyPlot]", msg);
  }

  function showError(msg) {
    showEmpty(`⚠ ${msg}`);
  }
});
