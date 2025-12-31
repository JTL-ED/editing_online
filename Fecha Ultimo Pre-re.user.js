// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      1.1.1
// @description  Detecta la tabla relacionada (Nombre del Pre-requisito) y extrae la fecha mas reciente de la columna "Fecha real fin" SOLO en la pestaña visible. Guarda en sessionStorage y borra cache si no hay fecha.
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {

    const OBJECT_API = "Constructive_project__c";
    const HEADER_ANCLA = "Nombre del Pre-requisito";
    const HEADER_OBJETIVO = "Fecha real fin";

    const STORAGE_KEY = "CONTROL_PLAZOS_FECHA_REAL_FIN";

    const CONTEXT_POLL_MS = 800;
    const SCAN_MAX_ATTEMPTS = 14;
    const SCAN_DELAY_MS = 700;

    const DEBUG_CACHE_EVERY_MS = 5000;

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
    if (isAllowedUrl() && sessionStorage.getItem(STORAGE_KEY)) {
        window.CONTROL_PLAZOS_FECHA_REAL_FIN = sessionStorage.getItem(STORAGE_KEY);
        console.log(
            "[Control Plazos] Cache restaurado desde sessionStorage:",
            window.CONTROL_PLAZOS_FECHA_REAL_FIN
        );
    } else {
        window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
        sessionStorage.removeItem(STORAGE_KEY);
    }

    const clean = s =>
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
        const it = document.evaluate(
            xpath,
            ctx,
            null,
            XPathResult.ORDERED_NODE_ITERATOR_TYPE,
            null
        );
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
        return dd + "/" + mm + "/" + yyyy;
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
        return getVisibleTabPanel() || document;
    }

    function getRecordIdFromUrl() {
        const m = location.pathname.match(
            /\/lightning\/r\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\//
        );
        return m ? m[1] : null;
    }

    function getKeyForLog() {
        const rid = getRecordIdFromUrl();
        return rid ? OBJECT_API + ":" + rid : OBJECT_API + ":?";
    }

    function findTableInRoot(root) {
        const thTitle = getElementsByXPath(
            ".//span[@title='" + HEADER_ANCLA + "']",
            root
        );

        for (const th of thTitle) {
            if (!isVisible(th)) continue;
            const table = th.closest("table");
            if (!table || !isVisible(table)) continue;

            const frf = getElementsByXPath(
                ".//span[@title='" + HEADER_OBJETIVO + "']",
                table
            )[0];

            if (frf) return table;
        }
        return null;
    }

    function readUltimaFechaRealFin(root) {
        const table = findTableInRoot(root);
        if (!table) return { foundTable: false, dateStr: null };

        const frfSpan = getElementsByXPath(
            ".//span[@title='" + HEADER_OBJETIVO + "']",
            table
        )[0];

        if (!frfSpan) return { foundTable: true, dateStr: null };

        const th = frfSpan.closest("th");
        if (!th) return { foundTable: true, dateStr: null };

        const colIndex = th.cellIndex;
        if (typeof colIndex !== "number") return { foundTable: true, dateStr: null };

        let maxDate = null;
        const rows = table.querySelectorAll("tbody tr");

        for (const tr of rows) {
            const td = tr.children[colIndex];
            if (!td) continue;
            const d = parseDDMMYYYY(td.innerText);
            if (d && (!maxDate || d > maxDate)) maxDate = d;
        }

        if (!maxDate) return { foundTable: true, dateStr: null };
        return { foundTable: true, dateStr: formatDDMMYYYY(maxDate) };
    }

    function setCache(val) {
        if (val) {
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = val;
            sessionStorage.setItem(STORAGE_KEY, val);
        } else {
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
            sessionStorage.removeItem(STORAGE_KEY);
        }
    }

    let scanToken = 0;

    function scanForCurrent(reason) {
        if (!isAllowedUrl()) return;

        const keyForLog = getKeyForLog();
        const token = ++scanToken;
        let attempts = 0;

        function attempt() {
            if (token !== scanToken) return;
            attempts++;

            const root = getActiveRoot();
            const res = readUltimaFechaRealFin(root);

            if (res.foundTable && res.dateStr) {
                setCache(res.dateStr);
                console.log(
                    "[Fecha real fin] Key:",
                    keyForLog,
                    "| Ultima:",
                    res.dateStr,
                    "| origen:",
                    reason
                );
                return;
            }

            if (res.foundTable && !res.dateStr) {
                setCache(null);
                console.log(
                    "[Fecha real fin] Key:",
                    keyForLog,
                    "| No hay fecha | origen:",
                    reason
                );
                return;
            }

            if (attempts < SCAN_MAX_ATTEMPTS) {
                setTimeout(attempt, SCAN_DELAY_MS);
            } else {
                setCache(null);
                console.log(
                    "[Fecha real fin] Key:",
                    keyForLog,
                    "| No se ha encontrado la tabla | origen:",
                    reason
                );
            }
        }

        attempt();
    }

    let lastKey = null;

    setInterval(() => {
        if (!isAllowedUrl()) return;
        const k = getKeyForLog();
        if (k !== lastKey) {
            lastKey = k;
            scanForCurrent("cambio contexto");
        }
    }, CONTEXT_POLL_MS);

    setTimeout(() => scanForCurrent("inicio"), 2000);

    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            console.log(
                "[Control Plazos][CACHE] Fecha real fin:",
                window.CONTROL_PLAZOS_FECHA_REAL_FIN
            );
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Fecha real fin cargado (baseline estable)");
})();
