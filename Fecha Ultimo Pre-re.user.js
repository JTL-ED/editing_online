// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      1.2.3
// @description  Lee la lista relacionada "Pre-requisitos" y extrae la fecha mas reciente de la columna "Fecha real fin" SOLO en contenido visible (incluye modal flotante). Cache por pestaña (sessionStorage) y por recordId. Borra cache si no hay tabla o fecha.
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  const ONLY_OBJECT_API = "Constructive_project__c";
  const HEADER_ANCLA = "Nombre del Pre-requisito";
  const HEADER_OBJETIVO = "Fecha real fin";

  // Cache por pestaña + por recordId
  const STORAGE_KEY_PREFIX = "CONTROL_PLAZOS_FECHA_REAL_FIN:";

  // Debug
  const DEBUG_CACHE_EVERY_MS = 5000;

  // Poll de contexto (tabs internas de Salesforce / cambios de vista)
  const CONTEXT_POLL_MS = 800;

  // Reintentos de carga (tabla tarda en pintar)
  const SCAN_MAX_ATTEMPTS = 14;
  const SCAN_DELAY_MS = 700;

  // Solo en estas 2 rutas
  function isAllowedUrl() {
    const p = location.pathname;
    return (
      /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/view$/.test(p) ||
      /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/related\/Prerequisites__r\/view$/.test(p)
    );
  }

  function clean(s) {
    return (s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getClientRects();
    return r && r.length > 0;
  }

  function getElementsByXPath(xpath, parent) {
    const ctx = parent || document;
    const out = [];
    const it = document.evaluate(xpath, ctx, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    let node;
    while ((node = it.iterateNext())) out.push(node);
    return out;
  }

  function parseDDMMYYYY(s) {
    const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDDMMYYYY(date) {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function getRecordIdFromUrl() {
    const m = location.href.match(/\/lightning\/r\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\//i);
    return m ? m[1] : null;
  }

  function getVisibleTabPanel() {
    return (
      document.querySelector('.slds-tabs_default__content[aria-hidden="false"]') ||
      document.querySelector('.slds-tabs_scoped__content[aria-hidden="false"]') ||
      document.querySelector('[role="tabpanel"][aria-hidden="false"]') ||
      null
    );
  }

  // Si hay modal flotante visible, se prioriza (tu captura muestra este caso)
  function getVisibleModalContainer() {
    const modals = Array.from(document.querySelectorAll(".slds-modal, .uiModal, [role='dialog']"));
    for (const m of modals) {
      if (!isVisible(m)) continue;
      // Contenedor tipico dentro del modal
      const container =
        m.querySelector(".slds-modal__container") ||
        m.querySelector(".modal-container") ||
        m;
      if (container && isVisible(container)) return container;
    }
    return null;
  }

  // Devuelve roots candidatos en orden de prioridad: modal visible -> tabpanel visible -> document
  function getScanRoots() {
    const roots = [];
    const modal = getVisibleModalContainer();
    if (modal) roots.push(modal);
    const tab = getVisibleTabPanel();
    if (tab) roots.push(tab);
    roots.push(document);
    return roots;
  }

  function findTableInRoot(root) {
    const thTitle = getElementsByXPath(`.//span[@title='${HEADER_ANCLA}']`, root);

    for (const th of thTitle) {
      if (!isVisible(th)) continue;

      const table = th.closest("table");
      if (!table || !isVisible(table)) continue;

      const frf = getElementsByXPath(`.//span[@title='${HEADER_OBJETIVO}']`, table)[0];
      if (frf) return table;
    }
    return null;
  }

  function readUltimaFechaRealFinFromRoot(root) {
    const table = findTableInRoot(root);
    if (!table) return { foundTable: false, dateStr: null, table: null };

    const frfSpan = getElementsByXPath(`.//span[@title='${HEADER_OBJETIVO}']`, table)[0];
    if (!frfSpan) return { foundTable: true, dateStr: null, table };

    const th = frfSpan.closest("th");
    if (!th) return { foundTable: true, dateStr: null, table };

    const colIndex = th.cellIndex;
    if (typeof colIndex !== "number") return { foundTable: true, dateStr: null, table };

    let maxDate = null;

    const rows = table.querySelectorAll("tbody tr");
    for (const tr of rows) {
      const td = tr.children && tr.children[colIndex];
      if (!td) continue;
      const d = parseDDMMYYYY(td.innerText);
      if (d && (!maxDate || d > maxDate)) maxDate = d;
    }

    if (!maxDate) return { foundTable: true, dateStr: null, table };
    return { foundTable: true, dateStr: formatDDMMYYYY(maxDate), table };
  }

  function getStorageKey(recordId) {
    return STORAGE_KEY_PREFIX + recordId;
  }

  function setCacheForRecord(recordId, valueOrNull) {
    const k = getStorageKey(recordId);

    if (valueOrNull) {
      sessionStorage.setItem(k, valueOrNull);
      window.CONTROL_PLAZOS_FECHA_REAL_FIN = valueOrNull;
    } else {
      sessionStorage.removeItem(k);
      window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
    }
  }

  function restoreCacheForRecord(recordId) {
    const k = getStorageKey(recordId);
    const v = sessionStorage.getItem(k);
    window.CONTROL_PLAZOS_FECHA_REAL_FIN = v || null;
    if (v) {
      console.log("[Control Plazos] Cache restaurado desde sessionStorage:", v);
    }
  }

  // Evita que 2 escaneos en paralelo se pisen
  let scanToken = 0;

  // Observer de cambios de tabla (reordenar, paginar, refrescar lista, etc.)
  let tableObserver = null;
  let observedTable = null;

  function attachTableObserver(table, recordId, keyForLog) {
    if (!table) return;

    if (observedTable === table) return;

    // Desconectar observer anterior
    if (tableObserver) {
      try { tableObserver.disconnect(); } catch {}
      tableObserver = null;
      observedTable = null;
    }

    observedTable = table;

    tableObserver = new MutationObserver(() => {
      // Si cambia la tabla (sort, refresh), reescanea
      scanForCurrent("tabla cambio");
    });

    // Observa tbody (cambios de filas)
    const tbody = table.querySelector("tbody") || table;
    try {
      tableObserver.observe(tbody, { childList: true, subtree: true });
      // Log opcional, si no lo quieres lo quitas
      // console.log("[Fecha real fin] Key:", keyForLog, "| Observer activo");
    } catch {}
  }

  function scanForCurrent(reason) {
    if (!isAllowedUrl()) return;

    // Si la pestaña de Chrome no esta visible, Salesforce a veces deja el DOM raro; lo evitamos
    if (document.visibilityState !== "visible") return;

    const recordId = getRecordIdFromUrl();
    const keyForLog = recordId ? `${ONLY_OBJECT_API}:${recordId}` : `${ONLY_OBJECT_API}:?`;

    if (!recordId) return;

    const token = ++scanToken;
    let attempts = 0;

    function attempt() {
      if (token !== scanToken) return;
      attempts++;

      // Buscar en roots visibles (modal, tabpanel, document) y quedarnos con el primero util
      let best = { foundTable: false, dateStr: null, table: null };

      const roots = getScanRoots();
      for (const r of roots) {
        const res = readUltimaFechaRealFinFromRoot(r);
        if (res.foundTable) {
          best = res;
          break;
        }
      }

      if (best.foundTable && best.dateStr) {
        setCacheForRecord(recordId, best.dateStr);
        console.log("[Fecha real fin] Key:", keyForLog, "| Ultima:", best.dateStr, "| origen:", reason);
        attachTableObserver(best.table, recordId, keyForLog);
        return;
      }

      if (best.foundTable && !best.dateStr) {
        setCacheForRecord(recordId, null);
        console.log("[Fecha real fin] Key:", keyForLog, "| No hay fecha | origen:", reason);
        attachTableObserver(best.table, recordId, keyForLog);
        return;
      }

      if (attempts < SCAN_MAX_ATTEMPTS) {
        setTimeout(attempt, SCAN_DELAY_MS);
      } else {
        setCacheForRecord(recordId, null);
        console.log("[Fecha real fin] Key:", keyForLog, "| No se ha encontrado la tabla | origen:", reason);
      }
    }

    attempt();
  }

  // Estado de contexto (para detectar cambios internos de Salesforce sin recargar)
  let lastPath = null;
  let lastRecordId = null;

  function contextTick() {
    if (!isAllowedUrl()) return;
    if (document.visibilityState !== "visible") return;

    const p = location.pathname;
    const rid = getRecordIdFromUrl();

    const changed = (p !== lastPath) || (rid !== lastRecordId);

    if (changed) {
      lastPath = p;
      lastRecordId = rid;

      if (rid) restoreCacheForRecord(rid);
      scanForCurrent("cambio contexto");
    }
  }

  // Tick de contexto
  setInterval(contextTick, CONTEXT_POLL_MS);

  // Arranque
  setTimeout(() => {
    if (!isAllowedUrl()) return;
    const rid = getRecordIdFromUrl();
    if (rid) restoreCacheForRecord(rid);
    lastPath = location.pathname;
    lastRecordId = rid;
    scanForCurrent("inicio");
  }, 1200);

  // Cuando vuelves a esta pestaña de Chrome, reescanea
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scanForCurrent("tab chrome visible");
    }
  });

  // Debug: imprime el cache actual
  if (DEBUG_CACHE_EVERY_MS > 0) {
    setInterval(() => {
      const rid = getRecordIdFromUrl();
      const key = rid ? getStorageKey(rid) : "(sin recordId)";
      const val = rid ? sessionStorage.getItem(getStorageKey(rid)) : null;

      console.log("[Control Plazos][CACHE] Key:", key, "| Fecha real fin:", val || null);
    }, DEBUG_CACHE_EVERY_MS);
  }

  console.log("[Control Plazos] Script Fecha real fin cargado (persistente, cache por recordId)");
})();
