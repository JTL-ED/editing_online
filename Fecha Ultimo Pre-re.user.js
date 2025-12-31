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

(function () {
    const OBJECT_API = "Constructive_project__c";
    const RELATED_LIST_API = "Prerequisites__r";
    const COL_LABEL = "Fecha real fin";

    const STORAGE_KEY = "CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN";
    const DEBUG_CACHE_EVERY_MS = 5000;

    // -------------------------
    // RESTAURAR CACHE tras F5
    // -------------------------
    if (sessionStorage.getItem(STORAGE_KEY)) {
        window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = sessionStorage.getItem(STORAGE_KEY);
        console.log("[Control Plazos] Cache restaurado desde sessionStorage:", window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN);
    } else {
        window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = null;
    }

    const clean = s => (s ?? "")
        .replace(/\u00A0/g, " ")
        .replace(/[ \t\r\n]+/g, " ")
        .trim();

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        const r = el.getClientRects();
        return r && r.length > 0;
    }

    function deepQueryAll(root, selector, cap = 30000) {
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

    // -------------------------
    // CONTEXTO: URL / pestaana activa (Console)
    // -------------------------
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

    function isProjectPageByUrl() {
        return new RegExp(`/lightning/r/${OBJECT_API}/[a-zA-Z0-9]{15,18}/`, "i").test(location.href);
    }

    function getProjectIdFromUrl() {
        const m = location.href.match(new RegExp(`/lightning/r/${OBJECT_API}/([a-zA-Z0-9]{15,18})/`, "i"));
        return m ? m[1] : null;
    }

    function getProjectIdFromDom() {
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

    function getUrlKey() {
        const rid = getProjectIdFromUrl();
        return rid ? (OBJECT_API + ":" + rid) : null;
    }

    function getDomKey() {
        const rid = getProjectIdFromDom();
        return rid ? (OBJECT_API + ":" + rid) : null;
    }

    function isRelatedListPrereqUrl() {
        return new RegExp(`/lightning/r/${OBJECT_API}/[a-zA-Z0-9]{15,18}/related/${RELATED_LIST_API}/view`, "i")
            .test(location.href);
    }

    // -------------------------
    // PARSEO FECHAS dd/mm/yyyy
    // -------------------------
    function parseDateDMY(s) {
        const t = clean(s);
        const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const dd = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const yy = parseInt(m[3], 10);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

        const d = new Date(yy, mm - 1, dd);
        if (d.getFullYear() !== yy || d.getMonth() !== (mm - 1) || d.getDate() !== dd) return null;
        return d;
    }

    function formatDMY(d) {
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yy = d.getFullYear();
        return `${dd}/${mm}/${yy}`;
    }

    // -------------------------
    // LECTURA TABLA: columna "Fecha real fin" -> max
    // Soporta:
    // - table tradicional (thead/tbody)
    // - lightning datatable (roles grid/row/gridcell)
    // -------------------------
    function getColumnIndexByHeaderText(root, headerText) {
        // Caso 1: headers con role columnheader (datatable)
        const headers = deepQueryAll(root, '[role="columnheader"]')
            .filter(h => isVisible(h))
            .map(h => ({ el: h, text: clean(h.innerText || h.textContent || "") }));

        if (headers.length) {
            for (let i = 0; i < headers.length; i++) {
                if (headers[i].text === headerText) return i;
            }
        }

        // Caso 2: th en table
        const ths = deepQueryAll(root, 'th')
            .filter(th => isVisible(th))
            .map(th => ({ el: th, text: clean(th.innerText || th.textContent || "") }));

        if (ths.length) {
            // Solo los del thead si existe
            const thead = root.querySelector("thead");
            const thInHead = thead ? Array.from(thead.querySelectorAll("th")).filter(isVisible) : [];
            const list = thInHead.length ? thInHead : ths.map(x => x.el);

            for (let i = 0; i < list.length; i++) {
                const t = clean(list[i].innerText || list[i].textContent || "");
                if (t === headerText) return i;
            }
        }

        return -1;
    }

    function readMaxFechaRealFin(root) {
        const colIdx = getColumnIndexByHeaderText(root, COL_LABEL);
        if (colIdx < 0) return null;

        const dates = [];

        // Caso A: grid/roles (LWC datatable)
        const rows = deepQueryAll(root, '[role="row"]')
            .filter(r => isVisible(r));

        if (rows.length) {
            for (const row of rows) {
                // Saltar filas de cabecera: suelen contener columnheader dentro
                if (row.querySelector('[role="columnheader"]')) continue;

                const cells = Array.from(row.querySelectorAll('[role="gridcell"]'))
                    .filter(c => isVisible(c));

                if (cells.length > colIdx) {
                    const txt = clean(cells[colIdx].innerText || cells[colIdx].textContent || "");
                    const d = parseDateDMY(txt);
                    if (d) dates.push(d);
                }
            }
        }

        // Caso B: table normal
        const tableRows = deepQueryAll(root, "tbody tr").filter(r => isVisible(r));
        if (tableRows.length) {
            for (const tr of tableRows) {
                const tds = Array.from(tr.querySelectorAll("td")).filter(td => isVisible(td));
                if (tds.length > colIdx) {
                    const txt = clean(tds[colIdx].innerText || tds[colIdx].textContent || "");
                    const d = parseDateDMY(txt);
                    if (d) dates.push(d);
                }
            }
        }

        if (!dates.length) return null;

        let max = dates[0];
        for (let i = 1; i < dates.length; i++) {
            if (dates[i].getTime() > max.getTime()) max = dates[i];
        }
        return formatDMY(max);
    }

    // -------------------------
    // SCAN con reintentos (carga async)
    // -------------------------
    let scanToken = 0;

    function scanForCurrent(reason) {
        const urlKey = getUrlKey();
        const domKey = getDomKey();

        if (!isProjectPageByUrl() && !urlKey && !domKey) return;

        const token = ++scanToken;
        const keyForLog = domKey || urlKey || (OBJECT_API + ":?");

        let attempts = 0;
        const maxAttempts = 14;
        const delayMs = 700;

        function attempt() {
            if (token !== scanToken) return;

            attempts++;

            const root = getActiveRoot();
            const valor = readMaxFechaRealFin(root);

            if (valor) {
                window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = valor;
                sessionStorage.setItem(STORAGE_KEY, valor);

                console.log(
                    "[Control Plazos] Key:", keyForLog,
                    "| Ultima Fecha real fin:", valor,
                    "| origen:", reason,
                    "| vista:", (isRelatedListPrereqUrl() ? "related/Prerequisites__r" : "view")
                );
                return;
            }

            if (attempts < maxAttempts) setTimeout(attempt, delayMs);
        }

        attempt();
    }

    // -------------------------
    // Detectar cambio de contexto: URL + pestaana visible
    // -------------------------
    let lastUrlKey = null;
    let lastDomKey = null;
    let lastHref = location.href;

    setInterval(() => {
        const u = getUrlKey();
        const d = getDomKey();
        const href = location.href;

        if (href !== lastHref || (u && u !== lastUrlKey) || (d && d !== lastDomKey)) {
            lastHref = href;
            lastUrlKey = u;
            lastDomKey = d;
            scanForCurrent("cambio contexto");
        }
    }, 800);

    // Primer scan
    setTimeout(() => {
        lastUrlKey = getUrlKey();
        lastDomKey = getDomKey();
        lastHref = location.href;
        scanForCurrent("inicio");
    }, 2000);

    // Debug cache
    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            console.log("[Control Plazos][CACHE]", window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN);
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Ultima Fecha Real Fin cargado (persistente)");
})();
