// ==UserScript==
// @name         Fecha de Aceptacion
// @namespace    sf-control-plazos
// @version      1.3.1
// @description  Lee "Fecha de Aceptación" SOLO en Record__c. Detecta cambios por URL y por pestaña activa (Console). Cache unico persistente (sessionStorage).
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    const LABEL = "Fecha de Aceptación";
    const ONLY_OBJECT_API = "Record__c";
    const STORAGE_KEY = "CONTROL_PLAZOS_FECHA_ACEPTACION";

    // Debug
    const DEBUG_CACHE_EVERY_MS = 5000;

    // -------------------------
    // RESTAURAR CACHE tras F5
    // -------------------------
    if (sessionStorage.getItem(STORAGE_KEY)) {
        window.CONTROL_PLAZOS_FECHA_ACEPTACION = sessionStorage.getItem(STORAGE_KEY);
        console.log("[Control Plazos] Cache restaurado desde sessionStorage:", window.CONTROL_PLAZOS_FECHA_ACEPTACION);
    } else {
        window.CONTROL_PLAZOS_FECHA_ACEPTACION = null;
    }

    const clean = s => s?.replace(/\u00A0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim() || "";

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        const r = el.getClientRects();
        return r && r.length > 0;
    }

    function deepQueryAll(root, selector, cap = 20000) {
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

    function isRecordPageByUrl() {
        return /\/lightning\/r\/Record__c\/[a-zA-Z0-9]{15,18}\/view/i.test(location.href);
    }

    function getRecordIdFromUrl() {
        const m = location.href.match(/\/lightning\/r\/Record__c\/([a-zA-Z0-9]{15,18})\/view/i);
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

        const a = root.querySelector('a[href*="/lightning/r/Record__c/"]');
        if (a) {
            const m = a.getAttribute("href")?.match(/\/Record__c\/([a-zA-Z0-9]{15,18})\/view/i);
            if (m) return m[1];
        }
        return null;
    }

    function getUrlKey() {
        const rid = getRecordIdFromUrl();
        if (rid) return ONLY_OBJECT_API + ":" + rid;
        return null;
    }

    function getActiveDomKey() {
        const rid = getActiveRecordIdFromDom();
        if (rid) return ONLY_OBJECT_API + ":" + rid;
        return null;
    }

    function readFechaAceptacion(root) {
        const blocks = deepQueryAll(root, ".slds-form-element");
        for (const el of blocks) {
            if (!isVisible(el)) continue;

            const lab = el.querySelector(".test-id__field-label, label");
            if (!lab || !isVisible(lab)) continue;

            if (clean(lab.textContent) !== LABEL) continue;

            const valRoot = el.querySelector(".test-id__field-value, .slds-form-element__control");
            if (!valRoot || !isVisible(valRoot)) continue;

            return clean(valRoot.innerText || valRoot.textContent || "") || null;
        }
        return null;
    }

    let scanToken = 0;

    function scanForCurrent(reason) {
        const urlKey = getUrlKey();
        const domKey = getActiveDomKey();
        if (!urlKey && !domKey && !isRecordPageByUrl()) return;

        const token = ++scanToken;
        const keyForLog = domKey || urlKey || "Record__c:?";

        let attempts = 0;
        const maxAttempts = 12;
        const delayMs = 700;

        function attempt() {
            if (token !== scanToken) return;

            attempts++;
            const valor = readFechaAceptacion(getActiveRoot());

            if (valor) {
                const prev = window.CONTROL_PLAZOS_FECHA_ACEPTACION;

                // Actualiza cache (aunque sea el mismo valor)
                window.CONTROL_PLAZOS_FECHA_ACEPTACION = valor;
                sessionStorage.setItem(STORAGE_KEY, valor);

                // Solo log si ha cambiado el valor respecto al que ya habia
                if (valor !== prev) {
                    console.log("[Control Plazos] Key:", keyForLog, "| Fecha:", valor, "| origen:", reason);
                }

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
            console.log(
                "[Control Plazos][CACHE] Fecha de aceptacion",
                window.CONTROL_PLAZOS_FECHA_ACEPTACION
            );
        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Fecha de Aceptacion cargado (persistente)");
})();
