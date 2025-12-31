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
    const RELATED_API = "Prerequisites__r";
    const RELATED_LABEL_FALLBACK = "Pre-requisitos";
    const HEADER_TARGET = "Fecha real fin";

    const STORAGE_PREFIX = "CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN::";

    // Debug
    const DEBUG_CACHE_EVERY_MS = 5000;

    const clean = s => s?.replace(/\u00A0/g, " ")
                         .replace(/[ \t\r\n]+/g, " ")
                         .trim() || "";

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

    function isConstructiveProjectPageByUrl() {
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
        const tabPanel = getVisibleTabPanel();
        if (tabPanel) return tabPanel;
        return document;
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

    function getContextKey() {
        const rid = getActiveRecordIdFromDom() || getRecordIdFromUrl();
        return rid ? `${OBJECT_API}:${rid}` : null;
    }

    function getStorageKey() {
        const rid = getActiveRecordIdFromDom() || getRecordIdFromUrl();
        return rid ? (STORAGE_PREFIX + rid) : null;
    }

    // Restaura cache por registro si existe
    function restoreCacheIfAny() {
        const sk = getStorageKey();
        if (!sk) return;
        const cached = sessionStorage.getItem(sk);
        if (cached) {
            window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = cached;
            console.log("[Control Plazos] Cache restaurado:", getContextKey(), "| Fecha real fin:", cached);
        }
    }

    function parseEsDateToTime(s) {
        // Acepta dd/mm/yyyy o d/m/yyyy
        const txt = clean(s);
        const m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const dd = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const yy = parseInt(m[3], 10);
        if (!dd || !mm || !yy) return null;

        const d = new Date(yy, mm - 1, dd);
        if (isNaN(d.getTime())) return null;

        // Validacion basica (evita 32/13/2025)
        if (d.getFullYear() !== yy || (d.getMonth() + 1) !== mm || d.getDate() !== dd) return null;

        return d.getTime();
    }

    function formatTimeToEsDate(t) {
        const d = new Date(t);
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const yy = String(d.getFullYear());
        return `${dd}/${mm}/${yy}`;
    }

    function findMostRelevantPrereqTable(root) {
        // 1) Si estas en related/Prerequisites__r/view, suele haber un datatable principal.
        // 2) Si estas en /view, hay related list en la pagina.
        // Buscamos tablas visibles con cabeceras (th) y elegimos la que tenga "Fecha real fin".
        const candidates = deepQueryAll(root, 'table');
        const visibleTables = candidates.filter(t => isVisible(t) && t.querySelector("thead") && t.querySelector("tbody"));
        if (!visibleTables.length) return null;

        let best = null;
        let bestScore = -1;

        for (const t of visibleTables) {
            const ths = Array.from(t.querySelectorAll("thead th"));
            if (!ths.length) continue;

            const headers = ths.map(th => clean(th.innerText || th.textContent || ""));
            const hasTarget = headers.some(h => h.toLowerCase() === HEADER_TARGET.toLowerCase());
            if (!hasTarget) continue;

            // Score: + si parece related list por texto cercano
            let score = 10;

            const containerText = clean((t.closest("article, section, div")?.innerText || "").slice(0, 600));
            if (containerText.toLowerCase().includes(RELATED_LABEL_FALLBACK.toLowerCase())) score += 3;

            // + si la tabla tiene bastantes filas
            const rows = t.querySelectorAll("tbody tr").length;
            score += Math.min(rows, 30) / 10;

            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }

        return best;
    }

    function getHeaderIndex(table, headerText) {
        const ths = Array.from(table.querySelectorAll("thead th"));
        const target = headerText.toLowerCase();

        for (let i = 0; i < ths.length; i++) {
            const h = clean(ths[i].innerText || ths[i].textContent || "").toLowerCase();
            if (h === target) return i;
        }
        return -1;
    }

    function readUltimaFechaRealFin(root) {
        const table = findMostRelevantPrereqTable(root);
        if (!table) return null;

        const idx = getHeaderIndex(table, HEADER_TARGET);
        if (idx < 0) return null;

        const rows = Array.from(table.querySelectorAll("tbody tr"));
        if (!rows.length) return null;

        let bestTime = null;

        for (const tr of rows) {
            if (!isVisible(tr)) continue;

            // En lightning-datatable normalmente hay celdas td en orden
            const tds = Array.from(tr.querySelectorAll("td"));
            if (tds.length <= idx) continue;

            const cell = tds[idx];
            const txt = clean(cell.innerText || cell.textContent || "");
            if (!txt) continue;

            const t = parseEsDateToTime(txt);
            if (t == null) continue;

            if (bestTime == null || t > bestTime) bestTime = t;
        }

        return bestTime != null ? formatTimeToEsDate(bestTime) : null;
    }

    let scanToken = 0;

    function scanForCurrent(reason) {
        if (!isConstructiveProjectPageByUrl()) return;

        const token = ++scanToken;
        const keyForLog = getContextKey() || `${OBJECT_API}:?`;
        const storageKey = getStorageKey();

        let attempts = 0;
        const maxAttempts = 14;
        const delayMs = 700;

        function attempt() {
            if (token !== scanToken) return;

            attempts++;
            const valor = readUltimaFechaRealFin(getActiveRoot());

            if (valor) {
                window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = valor;
                if (storageKey) sessionStorage.setItem(storageKey, valor);

                console.log("[Control Plazos] Key:", keyForLog, "| Ultima Fecha real fin:", valor, "| origen:", reason, "| intentos:", attempts);
                return;
            }

            if (attempts < maxAttempts) setTimeout(attempt, delayMs);
        }

        attempt();
    }

    let lastCtx = null;

    setInterval(() => {
        const ctx = getContextKey();
        if (ctx && ctx !== lastCtx) {
            lastCtx = ctx;
            restoreCacheIfAny();
            scanForCurrent("cambio contexto");
        }
    }, 800);

    setTimeout(() => {
        lastCtx = getContextKey();
        restoreCacheIfAny();
        scanForCurrent("inicio");
    }, 2000);

    // Debug cache: si quieres que NO se agrupe en consola, metemos contador
    let debugCounter = 0;
    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            debugCounter++;
            console.log(
                "[Control Plazos][CACHE][" + debugCounter + "]",
                window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN || null
            );
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Ultima Fecha real fin cargado (persistente por registro)");
})();
