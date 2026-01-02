// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      1.2.2
// @description  Detecta la tabla relacionada (Nombre del Pre-requisito) y extrae la fecha mas reciente de la columna "Fecha real fin" SOLO en la pestaña visible. Guarda en sessionStorage y borra cache si no hay fecha.
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    const ONLY_OBJECT_API = "Constructive_project__c";
    const HEADER_ANCLA = "Nombre del Pre-requisito";
    const HEADER_OBJETIVO = "Fecha real fin";

    const STORAGE_KEY = "CONTROL_PLAZOS_FECHA_REAL_FIN";
    const DEBUG_CACHE_EVERY_MS = 5000;

    const CONTEXT_POLL_MS = 800;
    const SCAN_MAX_ATTEMPTS = 14;
    const SCAN_DELAY_MS = 700;

    // Re-escaneo por cambios internos (ordenar / paginar / refrescos)
    const RESCAN_DEBOUNCE_MS = 500;

    function isAllowedUrl() {
        const p = location.pathname;
        return (
            /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/view$/.test(p) ||
            /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/related\/Prerequisites__r\/view$/.test(p)
        );
    }

    // -------------------------
    // RESTAURAR CACHE tras F5
    // -------------------------
    if (sessionStorage.getItem(STORAGE_KEY)) {
        window.CONTROL_PLAZOS_FECHA_REAL_FIN = sessionStorage.getItem(STORAGE_KEY);
        console.log("[Control Plazos] Cache restaurado desde sessionStorage:", window.CONTROL_PLAZOS_FECHA_REAL_FIN);
    } else {
        window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
    }

    const clean = (s) =>
        (s || "")
            .replace(/\u00A0/g, " ")
            .replace(/[ \t\r\n]+/g, " ")
            .trim();

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

    function getVisibleTabPanel() {
        return (
            document.querySelector('.slds-tabs_default__content[aria-hidden="false"]') ||
            document.querySelector('.slds-tabs_scoped__content[aria-hidden="false"]') ||
            document.querySelector('[role="tabpanel"][aria-hidden="false"]') ||
            null
        );
    }

    function getActiveRoot() {
        const tabPanel = getVisibleTabPanel();
        if (tabPanel) return tabPanel;
        return document;
    }

    function getConstructiveIdFromUrl() {
        const m = location.href.match(/\/lightning\/r\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\/view/i);
        return m ? m[1] : null;
    }

    function getActiveRecordIdFromDom() {
        const root = getActiveRoot();

        const layout = root.querySelector("records-record-layout");
        if (layout) {
            const rid =
                layout.getAttribute("record-id") ||
                layout.getAttribute("data-recordid") ||
                layout.getAttribute("data-record-id");
            if (rid) return rid;
        }

        const attrs = ["[record-id]", "[data-recordid]", "[data-record-id]"];
        for (const sel of attrs) {
            const el = root.querySelector(sel);
            if (el) {
                const rid =
                    el.getAttribute("record-id") ||
                    el.getAttribute("data-recordid") ||
                    el.getAttribute("data-record-id");
                if (rid) return rid;
            }
        }

        const a = root.querySelector('a[href*="/lightning/r/Constructive_project__c/"]');
        if (a) {
            const mm = (a.getAttribute("href") || "").match(/\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\/view/i);
            if (mm) return mm[1];
        }

        return null;
    }

    function getUrlKey() {
        const rid = getConstructiveIdFromUrl();
        return rid ? `${ONLY_OBJECT_API}:${rid}` : null;
    }

    function getActiveDomKey() {
        const rid = getActiveRecordIdFromDom();
        return rid ? `${ONLY_OBJECT_API}:${rid}` : null;
    }

    function findTableInRoot(root) {
        const thTitle = getElementsByXPath(`.//span[@title='${HEADER_ANCLA}']`, root);

        for (const th of thTitle) {
            if (!isVisible(th)) continue;

            const table = th.closest("table");
            if (!table) continue;

            const frf = getElementsByXPath(`.//span[@title='${HEADER_OBJETIVO}']`, table)[0];
            if (frf) return table;
        }
        return null;
    }

    function readUltimaFechaRealFin(root) {
        const table = findTableInRoot(root);
        if (!table) return { foundTable: false, dateStr: null, tableEl: null };

        const frfSpan = getElementsByXPath(`.//span[@title='${HEADER_OBJETIVO}']`, table)[0];
        if (!frfSpan) return { foundTable: true, dateStr: null, tableEl: table };

        const th = frfSpan.closest("th");
        if (!th) return { foundTable: true, dateStr: null, tableEl: table };

        const colIndex = th.cellIndex;
        if (typeof colIndex !== "number") return { foundTable: true, dateStr: null, tableEl: table };

        let maxDate = null;

        const rows = table.querySelectorAll("tbody tr");
        for (const tr of rows) {
            const td = tr.children && tr.children[colIndex];
            if (!td) continue;
            const d = parseDDMMYYYY(td.innerText);
            if (d && (!maxDate || d > maxDate)) maxDate = d;
        }

        if (!maxDate) return { foundTable: true, dateStr: null, tableEl: table };
        return { foundTable: true, dateStr: formatDDMMYYYY(maxDate), tableEl: table };
    }

    function setCache(valueOrNull) {
        if (valueOrNull) {
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = valueOrNull;
            sessionStorage.setItem(STORAGE_KEY, valueOrNull);
        } else {
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
            sessionStorage.removeItem(STORAGE_KEY);
        }
    }

    // Evitar “DOM por detras”: si URL tiene ID, exigir que coincida con el DOM activo
    function urlDomMatchOrUnknown() {
        const urlId = getConstructiveIdFromUrl();
        const domId = getActiveRecordIdFromDom();
        if (!urlId) return true;
        if (!domId) return true; // si no podemos leer domId, no bloqueamos
        return urlId === domId;
    }

    let scanToken = 0;
    let lastPrintedKey = null;
    let lastPrintedDate = null;

    function scanForCurrent(reason) {
        if (!isAllowedUrl()) return;
        if (!document.hasFocus()) return; // si la pestaña chrome no esta enfocada, no escanear
        if (!urlDomMatchOrUnknown()) return; // evita leer “panel oculto” de otro registro

        const urlKey = getUrlKey();
        const domKey = getActiveDomKey();
        const keyForLog = domKey || urlKey || "Constructive_project__c:?";

        const token = ++scanToken;
        let attempts = 0;

        function attempt() {
            if (token !== scanToken) return;
            attempts++;

            const root = getActiveRoot();
            const res = readUltimaFechaRealFin(root);

            if (res.foundTable && res.dateStr) {
                setCache(res.dateStr);

                // Decide si imprimir o no: por defecto, NO repetimos si es igual
                const sameAsLast = (keyForLog === lastPrintedKey && res.dateStr === lastPrintedDate);
                if (!sameAsLast) {
                    console.log("[Fecha real fin] Key:", keyForLog, "| Ultima:", res.dateStr, "| origen:", reason);
                    lastPrintedKey = keyForLog;
                    lastPrintedDate = res.dateStr;
                }
                return;
            }

            if (res.foundTable && !res.dateStr) {
                setCache(null);
                const sameAsLast = (keyForLog === lastPrintedKey && lastPrintedDate === null);
                if (!sameAsLast) {
                    console.log("[Fecha real fin] Key:", keyForLog, "| No hay fecha | origen:", reason);
                    lastPrintedKey = keyForLog;
                    lastPrintedDate = null;
                }
                return;
            }

            if (attempts < SCAN_MAX_ATTEMPTS) {
                setTimeout(attempt, SCAN_DELAY_MS);
            } else {
                setCache(null);
                console.log("[Fecha real fin] Key:", keyForLog, "| No se ha encontrado la tabla | origen:", reason);
                lastPrintedKey = keyForLog;
                lastPrintedDate = null;
            }
        }

        attempt();
    }

    // -------------------------
    // DETECCION DE CAMBIO CONTEXTO (Console)
    // -------------------------
    let lastUrlKey = null;
    let lastDomKey = null;

    setInterval(() => {
        if (!isAllowedUrl()) return;
        const u = getUrlKey();
        const d = getActiveDomKey();

        if ((u && u !== lastUrlKey) || (d && d !== lastDomKey)) {
            lastUrlKey = u;
            lastDomKey = d;
            scanForCurrent("cambio contexto");
        }
    }, CONTEXT_POLL_MS);

    // -------------------------
    // REESCANEO POR EVENTOS (ordenar / click / focus)
    // -------------------------
    let rescanTimer = null;
    function requestRescan(reason) {
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => scanForCurrent(reason), RESCAN_DEBOUNCE_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) requestRescan("visibilidad");
    });

    window.addEventListener("focus", () => requestRescan("focus"));

    // Clicks (captura): ordenar columna suele ser click
    document.addEventListener("click", () => requestRescan("click"), true);

    // MutationObserver: si la tabla cambia por orden/paginacion/refresco
    let mo = null;
    function attachObserver() {
        if (mo) return;
        mo = new MutationObserver(() => requestRescan("mutacion"));
        mo.observe(getActiveRoot(), { childList: true, subtree: true });
    }

    // Inicio
    setTimeout(() => {
        attachObserver();
        lastUrlKey = getUrlKey();
        lastDomKey = getActiveDomKey();
        scanForCurrent("inicio");
    }, 2000);

    // -------------------------
    // DEBUG: imprimir cache siempre (no depende de URL)
    // -------------------------
    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            console.log("[Control Plazos][CACHE] Fecha real fin:", window.CONTROL_PLAZOS_FECHA_REAL_FIN);
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Fecha real fin cargado (persistente)");
})();
