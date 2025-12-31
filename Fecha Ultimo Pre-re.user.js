// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      0.1.0
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  const LABEL = "Fecha real fin";
  const CACHE_KEY = "plazos:lastFechaRealFin"; // puedes añadir el id del expediente si quieres
  const LOG_EVERY_MS = 3000;

  function log(...args) {
    console.log("[Plazos][FechaRealFin]", ...args);
  }

  function norm(s) {
    return (s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function findColumnIndexByHeader(table, headerText) {
    const ths = table.querySelectorAll("thead th");
    if (!ths.length) return -1;

    const target = norm(headerText);
    for (let i = 0; i < ths.length; i++) {
      const th = ths[i];
      const text = norm(th.innerText || th.textContent);
      if (text.includes(target)) return i;
    }
    return -1;
  }

  function getLastNonEmptyCellInColumn(table, colIndex) {
    const rows = table.querySelectorAll("tbody tr");
    if (!rows.length) return null;

    // recorremos desde abajo hacia arriba para encontrar el ultimo no vacio
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = rows[r].querySelectorAll("td");
      if (!cells.length) continue;
      const cell = cells[colIndex];
      if (!cell) continue;

      const val = (cell.innerText || cell.textContent || "").trim();
      if (val) return val;
    }
    return null;
  }

  function scanAndCache() {
    // Nota: lightning puede tener varias tablas. Tomamos la primera que tenga thead+tbody.
    const tables = Array.from(document.querySelectorAll("table"))
      .filter(t => t.querySelector("thead") && t.querySelector("tbody"));

    if (!tables.length) {
      log("No hay tablas aún (table thead/tbody).");
      return;
    }

    let updated = false;

    for (const table of tables) {
      const col = findColumnIndexByHeader(table, LABEL);
      if (col === -1) continue;

      const lastValue = getLastNonEmptyCellInColumn(table, col);
      if (!lastValue) {
        log("Encontrada columna pero sin valores no vacios.");
        continue;
      }

      const prev = localStorage.getItem(CACHE_KEY);
      if (prev !== lastValue) {
        localStorage.setItem(CACHE_KEY, lastValue);
        log("CACHE actualizado:", lastValue, "(antes:", prev, ")");
      } else {
        log("CACHE sin cambios:", lastValue);
      }

      updated = true;
      break; // ya lo hemos encontrado en una tabla valida
    }

    if (!updated) {
      log(`No se encontro ninguna tabla con header que contenga "${LABEL}".`);
    }
  }

  // 1) Log de arranque para confirmar que el script SI carga
  log("Script cargado. URL:", location.href);

  // 2) Observa cambios del DOM
  const mo = new MutationObserver(() => scanAndCache());
  mo.observe(document.body, { childList: true, subtree: true });

  // 3) Y ademas, por seguridad, escanea cada X segundos (Lightning a veces “esconde” cambios)
  setInterval(scanAndCache, LOG_EVERY_MS);

  // 4) primer escaneo
  scanAndCache();
})();
