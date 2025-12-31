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
    const ONLY_OBJECT_API = "Constructive_project__c";
    const RELATED_LIST_TITLE = "Pre-requisitos";
    const COL_LABEL = "Fecha real fin";

    // Cache: por registro (JSON en sessionStorage)
    const STORAGE_KEY = "CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN_MAP";

    // Debug
    const DEBUG_CACHE_EVERY_MS = 5000;

    // Exponer ultimo valor del registro activo
    window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = null;

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

    function getMap() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === "object") ? obj : {};
        } catch {
            return {};
        }
    }

    function setMap(map) {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map || {}));
        } catch {}
    }

    function setCachedValueFor(key, value) {
        const map = getMap();
        map[key] = value;
        setMap(map);
    }

    function getCachedValueFor(key) {
        const map = getMap();
        return map[key] || null;
    }

    function parseDateEs(s) {
        const t = clean(s);
        const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const d = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const y = parseInt(m[3], 10);
        if (!d || !mo || !y) return null;
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== (mo - 1) || dt.getDate() !== d) return null;
        return dt;
    }

    function formatDateEs(dt) {
        const dd = String(dt.getDate()).padStart(2, "0");
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        const yy = String(dt.getFullYear());
        return `${dd}/${mm}/${yy}`;
    }

    // -------------
    // Contexto (URL + tabs console)
    // -------------
    function isRecordPageByUrl() {
        return new RegExp(`/lightning/r/${ONLY_OBJECT_API}/[a-zA-Z0-9]{15,18}/view`, "i").test(location.href);
    }

    function getRecordIdFromUrl() {
        const re = new RegExp(`/lightning/r/${ONLY_OBJECT_API}/([a-zA-Z0-9]{15,18})/view`, "i");
        const m = location.href.match(re);
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

        const a = root.querySelector(`a[href*="/lightning/r/${ONLY_OBJECT_API}/"]`);
        if (a) {
            const href = a.getAttribute("href") || "";
            const m = href.match(new RegExp(`/${ONLY_OBJECT_API}/([a-zA-Z0-9]{15,18})/view`, "i"));
            if (m) return m[1];
        }

        return null;
    }

    function getUrlKey() {
        const rid = getRecordIdFromUrl();
        return rid ? `${ONLY_OBJECT_API}:${rid}` : null;
    }

    function getActiveDomKey() {
        const rid = getActiveRecordIdFromDom();
        return rid ? `${ONLY_OBJECT_API}:${rid}` : null;
    }

    // -------------
    // Lectura de la tabla "Pre-requisitos" -> max Fecha real fin
    // -------------
    function getTableTitle(table) {
        // Intentar encontrar el titulo del bloque/carta que contiene la tabla
        const container =
            table.closest('article') ||
            table.closest('section') ||
            table.closest('div.slds-card') ||
            table.parentElement;

        if (!container) return "";

        const candidates = container.querySelectorAll('h2, header, .slds-card__header, .slds-card__header-title, span');
        for (const el of candidates) {
            if (!isVisible(el)) continue;
            const t = clean(el.textContent);
            if (t) return t;
        }
        return "";
    }

    function findPreReqTable(root) {
        const tables = Array.from(root.querySelectorAll("table")).filter(isVisible);
        if (!tables.length) return null;

        let best = null;
        let bestScore = -1;

        for (const table of tables) {
            // headers
            const ths = Array.from(table.querySelectorAll("thead th")).filter(isVisible);
            if (!ths.length) continue;

            const headers = ths.map(th => clean(th.innerText || th.textContent));
            const hasFecha = headers.some(h => h === COL_LABEL);
            if (!hasFecha) continue;

            const title = getTableTitle(table);
            const score =
                (title.includes(RELATED_LIST_TITLE) ? 10 : 0) +
                (headers.includes("Nombre del Pre-requisito") ? 3 : 0) +
                (headers.includes("Fecha de inicio") ? 1 : 0);

            if (score > bestScore) {
                bestScore = score;
                best = table;
            }
        }

        return best;
    }

    function readUltimaFechaRealFin(root) {
        const table = findPreReqTable(root);
        if (!table) return null;

        const ths = Array.from(table.querySelectorAll("thead th"));
        let idx = -1;
        for (let i = 0; i < ths.length; i++) {
            const h = clean(ths[i].innerText || ths[i].textContent);
            if (h === COL_LABEL) {
                idx = i;
                break;
            }
        }
        if (idx < 0) return null;

        let maxDt = null;

        const rows = Array.from(table.querySelectorAll("tbody tr"));
        for (const row of rows) {
            if (!isVisible(row)) continue;

            // En lightning, cada fila puede tener mezcla de th/td
            const cells = Array.from(row.querySelectorAll("th,td"));
            if (cells.length <= idx) continue;

            const txt = clean(cells[idx].innerText || cells[idx].textContent);
            if (!txt) continue;

            const dt = parseDateEs(txt);
            if (!dt) continue;

            if (!maxDt || dt.getTime() > maxDt.getTime()) {
                maxDt = dt;
            }
        }

        if (!maxDt) return null;
        return formatDateEs(maxDt);
    }

    // -------------
    // Escaneo con reintentos + cambio de contexto
    // -------------
    let scanToken = 0;

    function scanForCurrent(reason) {
        const urlKey = getUrlKey();
        const domKey = getActiveDomKey();
        if (!urlKey && !domKey && !isRecordPageByUrl()) return;

        const key = domKey || urlKey || `${ONLY_OBJECT_API}:?`;
        const token = ++scanToken;

        let attempts = 0;
        const maxAttempts = 18;
        const delayMs = 800;

        // Cargar cache si existe (para que haya valor inmediato)
        const cached = getCachedValueFor(key);
        if (cached) {
            window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = cached;
        }

        function attempt() {
            if (token !== scanToken) return;

            attempts++;
            const valor = readUltimaFechaRealFin(getActiveRoot());

            if (valor) {
                window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN = valor;
                setCachedValueFor(key, valor);
                console.log("[Control Plazos] Key:", key, "| Ultima Fecha real fin:", valor, "| origen:", reason, "| intentos:", attempts);
                return;
            }

            if (attempts < maxAttempts) setTimeout(attempt, delayMs);
        }

        attempt();
    }

    let lastUrlKey = null;
    let lastDomKey = null;

    setInterval(() => {
        const u = getUrlKey();
        const d = getActiveDomKey();
        if ((u && u !== lastUrlKey) || (d && d !== lastDomKey)) {
            lastUrlKey = u;
            lastDomKey = d;
            scanForCurrent("cambio contexto");
        }
    }, 800);

    setTimeout(() => {
        lastUrlKey = getUrlKey();
        lastDomKey = getActiveDomKey();
        scanForCurrent("inicio");
    }, 2000);

    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            const key = getActiveDomKey() || getUrlKey() || `${ONLY_OBJECT_API}:?`;
            console.log("[Control Plazos][CACHE]", "Key:", key, "|", window.CONTROL_PLAZOS_ULTIMA_FECHA_REAL_FIN);
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Ultima Fecha real fin (Pre-requisitos) cargado (persistente)");
})();
