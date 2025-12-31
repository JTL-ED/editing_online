// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      1.0.0
// @description  En Constructive_project__c: detecta cambios por URL y pestaña activa (Console) y guarda la ULTIMA "Fecha real fin" de la related list "Pre-requisitos". Cache persistente (sessionStorage) por registro.
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

//nota:  por URL (Constructive_project__c + tabs)

(function () {
    const OBJECT_API = "Constructive_project__c";
    const RELATED_API = "Prerequisites__r";
    const LABEL_COL = "Fecha real fin";

    const STORAGE_PREFIX = "CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN::"; // + recordId
    const DEBUG_CACHE_EVERY_MS = 5000;

    // Variable global (por si quieres leerlo desde consola)
    window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN || null;

    const clean = s => (s || "")
        .replace(/\u00A0/g, " ")
        .replace(/[ \t\r\n]+/g, " ")
        .trim();

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        const r = el.getClientRects();
        return r && r.length > 0;
    }

    function deepQueryAll(root, selector, cap = 25000) {
        const out = [];
        const seen = new Set();
        const stack = [root];
        let left = cap;

        while (stack.length && left-- > 0) {
            const n = stack.pop();
            if (!n || seen.has(n)) continue;
            seen.add(n);

            try {
                if (n.querySelectorAll) {
                    const found = n.querySelectorAll(selector);
                    for (const el of found) out.push(el);
                }
            } catch {}

            const ch = n.children || n.childNodes;
            if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
        }
        return out;
    }

    function isConstructiveUrl() {
        return new RegExp(`/lightning/r/${OBJECT_API}/[a-zA-Z0-9]{15,18}/`, "i").test(location.href);
    }

    function getRecordIdFromUrl() {
        const m = location.href.match(new RegExp(`/lightning/r/${OBJECT_API}/([a-zA-Z0-9]{15,18})/`, "i"));
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

    function getActiveRoot() {
        return getVisibleTabPanel() || document;
    }

    function getActiveRecordIdFromDom() {
        const root = getActiveRoot();

        const layout = root.querySelector('records-record-layout');
        if (layout) {
            const rid = layout.getAttribute('record-id') ||
                        layout.getAttribute('data-recordid') ||
                        layout.getAttribute('data-record-id');
            if (rid) return rid;
        }

        const attrs = ['[record-id]', '[data-recordid]', '[data-record-id]'];
        for (const sel of attrs) {
            const el = root.querySelector(sel);
            if (el) {
                const rid = el.getAttribute('record-id') ||
                            el.getAttribute('data-recordid') ||
                            el.getAttribute('data-record-id');
                if (rid) return rid;
            }
        }

        const a = root.querySelector(`a[href*="/lightning/r/${OBJECT_API}/"]`);
        if (a) {
            const m = a.getAttribute("href")?.match(new RegExp(`/${OBJECT_API}/([a-zA-Z0-9]{15,18})/`, "i"));
            if (m) return m[1];
        }
        return null;
    }

    function getContextRecordId() {
        return getActiveRecordIdFromDom() || getRecordIdFromUrl();
    }

    function storageKeyFor(recordId) {
        return STORAGE_PREFIX + recordId;
    }

    // -------------------------
    // Restaurar cache por registro si ya estabas en ese registro (F5)
    // -------------------------
    function restoreCacheIfAny(recordId) {
        if (!recordId) return;
        const k = storageKeyFor(recordId);
        const val = sessionStorage.getItem(k);
        if (val) {
            window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = val;
            console.log("[Control Plazos] Cache restaurado:", recordId, "| Fecha:", val);
        }
    }

    function parseEsDateToTime(s) {
        // Acepta d/m/yyyy o dd/mm/yyyy
        const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const d = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const y = parseInt(m[3], 10);
        if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const dt = new Date(y, mo - 1, d);
        return isNaN(dt.getTime()) ? null : dt.getTime();
    }

    function formatTimeToEsDate(t) {
        const dt = new Date(t);
        const dd = String(dt.getDate()).padStart(2, "0");
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        const yy = dt.getFullYear();
        return `${dd}/${mm}/${yy}`;
    }

    function getAllRelatedTables(root) {
        // Buscamos tablas o datatables que parezcan la related list (en /view o /related/view)
        // En Salesforce puede variar mucho, asi que lo hacemos robusto:
        const tables = [];

        // HTML tables
        for (const t of deepQueryAll(root, "table")) {
            if (!isVisible(t)) continue;
            tables.push({ type: "table", el: t });
        }

        // lightning-datatable / wrappers (no siempre hay <table> directo)
        for (const dt of deepQueryAll(root, "lightning-datatable")) {
            if (!isVisible(dt)) continue;
            tables.push({ type: "datatable", el: dt });
        }

        return tables;
    }

    function getHeaderIndexFromHtmlTable(tableEl, headerLabel) {
        const ths = Array.from(tableEl.querySelectorAll("thead th"));
        if (!ths.length) return null;

        for (let i = 0; i < ths.length; i++) {
            const txt = clean(ths[i].innerText || ths[i].textContent);
            if (txt.toLowerCase() === headerLabel.toLowerCase()) return i;
        }
        return null;
    }

    function extractDatesFromHtmlTable(tableEl, colIndex) {
        const outTimes = [];

        const rows = Array.from(tableEl.querySelectorAll("tbody tr"));
        for (const tr of rows) {
            if (!isVisible(tr)) continue;
            const tds = Array.from(tr.querySelectorAll("td"));
            if (tds.length <= colIndex) continue;

            const cell = tds[colIndex];
            const txt = clean(cell.innerText || cell.textContent);
            if (!txt) continue;

            const tt = parseEsDateToTime(txt);
            if (tt != null) outTimes.push(tt);
        }
        return outTimes;
    }

    function extractFromDatatableLike(dtEl, headerLabel) {
        // Intento 1: buscar dentro del shadow/light DOM algun table (muchas veces existe)
        const innerTable = dtEl.querySelector("table");
        if (innerTable) {
            const idx = getHeaderIndexFromHtmlTable(innerTable, headerLabel);
            if (idx != null) return extractDatesFromHtmlTable(innerTable, idx);
        }

        // Intento 2: buscar tablas cercanas (padres) por si el datatable es wrapper
        const wrapper = dtEl.closest("article, section, div") || dtEl.parentElement;
        if (wrapper) {
            const maybeTable = wrapper.querySelector("table");
            if (maybeTable) {
                const idx = getHeaderIndexFromHtmlTable(maybeTable, headerLabel);
                if (idx != null) return extractDatesFromHtmlTable(maybeTable, idx);
            }
        }

        return [];
    }

    function readUltimaFechaRealFin(root) {
        const candidates = getAllRelatedTables(root);

        let bestTimes = [];
        for (const c of candidates) {
            let times = [];
            if (c.type === "table") {
                const idx = getHeaderIndexFromHtmlTable(c.el, LABEL_COL);
                if (idx != null) times = extractDatesFromHtmlTable(c.el, idx);
            } else if (c.type === "datatable") {
                times = extractFromDatatableLike(c.el, LABEL_COL);
            }

            if (times.length > bestTimes.length) bestTimes = times;
        }

        if (!bestTimes.length) return null;

        const maxTime = Math.max(...bestTimes);
        return formatTimeToEsDate(maxTime);
    }

    let scanToken = 0;

    function scanForCurrent(reason) {
        const recordId = getContextRecordId();
        if (!recordId || !isConstructiveUrl()) return;

        const token = ++scanToken;
        let attempts = 0;
        const maxAttempts = 14;
        const delayMs = 700;

        // restaura cache si existe (solo 1 vez por scan inicial de ese registro)
        restoreCacheIfAny(recordId);

        function attempt() {
            if (token !== scanToken) return;

            attempts++;

            const valor = readUltimaFechaRealFin(getActiveRoot());
            if (valor) {
                window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = valor;
                sessionStorage.setItem(storageKeyFor(recordId), valor);

                console.log("[Control Plazos] Key:", `${OBJECT_API}:${recordId}`, "| Fecha:", valor, "| origen:", reason);
                return;
            }

            if (attempts < maxAttempts) setTimeout(attempt, delayMs);
        }

        attempt();
    }

    let lastRecordId = null;
    let lastHref = null;

    setInterval(() => {
        const rid = getContextRecordId();
        const href = location.href;

        // Cambio de registro o de URL (incluye pasar de /view a /related/Prerequisites__r/view)
        if ((rid && rid !== lastRecordId) || (href && href !== lastHref)) {
            lastRecordId = rid;
            lastHref = href;
            scanForCurrent("cambio contexto");
        }
    }, 800);

    setTimeout(() => {
        lastRecordId = getContextRecordId();
        lastHref = location.href;
        scanForCurrent("inicio");
    }, 2000);

    if (DEBUG_CACHE_EVERY_MS > 0) {
        let dbgCounter = 0;
        setInterval(() => {
            // OJO: Chrome puede agrupar logs identicos y mostrar un numerito (2,3,4...)
            // Para evitarlo, añadimos contador:
            dbgCounter++;
            console.log("[Control Plazos][CACHE]", dbgCounter, window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN);
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Ultima Fecha real fin cargado (persistente por registro)");
})();
