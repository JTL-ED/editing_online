// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      1.4.0
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

    // Re-escaneo por cambios internos (ordenar / paginar / refrescos)
    const RESCAN_DEBOUNCE_MS = 350;

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

    // Modal flotante visible (prioridad)
    function getVisibleModalContainer() {
        const modals = Array.from(document.querySelectorAll(".slds-modal, .uiModal, [role='dialog']"));
        for (const m of modals) {
            if (!isVisible(m)) continue;
            const container =
                  m.querySelector(".slds-modal__container") ||
                  m.querySelector(".modal-container") ||
                  m;
            if (container && isVisible(container)) return container;
        }
        return null;
    }

    // Roots candidatos en orden: modal -> tabpanel -> document
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
        if (v) console.log("[Control Plazos] Cache restaurado desde sessionStorage:", v);
    }

    // Evita que 2 escaneos en paralelo se pisen
    let scanToken = 0;

    // Debounce de reescaneo
    let rescanTimer = null;
    function requestRescan(reason) {
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => scanForCurrent(reason), RESCAN_DEBOUNCE_MS);
    }

    // Observer de cambios de tabla (reordenar, paginar, refrescar lista, etc.)
    let tableObserver = null;
    let observedTable = null;

    function attachTableObserver(table) {
        if (!table) return;
        if (observedTable === table) return;

        if (tableObserver) {
            try { tableObserver.disconnect(); } catch {}
            tableObserver = null;
            observedTable = null;
        }

        observedTable = table;

        tableObserver = new MutationObserver(() => {
            requestRescan("tabla cambio");
        });

        // Importante: en modal, el sort a veces solo cambia header/atributos,
        // asi que observamos la tabla completa.
        try {
            tableObserver.observe(table, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: false
            });
        } catch {}
    }

    // Observer del modal visible (Salesforce re-renderiza mucho dentro del modal)
    let modalObserver = null;
    let observedModal = null;

    function attachModalObserver(modal) {
        if (!modal) return;

        if (observedModal === modal) return;

        if (modalObserver) {
            try { modalObserver.disconnect(); } catch {}
            modalObserver = null;
            observedModal = null;
        }

        observedModal = modal;
        modalObserver = new MutationObserver(() => {
            requestRescan("modal cambio");
        });

        try {
            modalObserver.observe(modal, { childList: true, subtree: true, attributes: true });
        } catch {}
    }

    function scanForCurrent(reason) {
        if (!isAllowedUrl()) return;
        if (document.visibilityState !== "visible") return;

        const recordId = getRecordIdFromUrl();
        if (!recordId) return;

        const keyForLog = `${ONLY_OBJECT_API}:${recordId}`;

        const token = ++scanToken;
        let attempts = 0;

        function attempt() {
            if (token !== scanToken) return;
            attempts++;

            let best = { foundTable: false, dateStr: null, table: null };

            const roots = getScanRoots();

            // Si hay modal, nos interesa enganchar observer al modal actual
            const modalNow = getVisibleModalContainer();
            if (modalNow) attachModalObserver(modalNow);

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
                attachTableObserver(best.table);
                return;
            }

            if (best.foundTable && !best.dateStr) {
                setCacheForRecord(recordId, null);
                console.log("[Fecha real fin] Key:", keyForLog, "| No hay fecha | origen:", reason);
                attachTableObserver(best.table);
                return;
            }

            if (attempts < SCAN_MAX_ATTEMPTS) {
                setTimeout(attempt, SCAN_DELAY_MS);
            } else {
                //setCacheForRecord(recordId, null);
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
        if (document.visibilityState === "visible") requestRescan("tab chrome visible");
    });

    // Trigger principal que te faltaba en modal: ordenar es click
    document.addEventListener("click", () => {
        if (!isAllowedUrl()) return;
        requestRescan("click");
    }, true);

    // Tambien por focus (a veces el modal no muta pero el DOM se actualiza al ganar foco)
    window.addEventListener("focus", () => {
        if (!isAllowedUrl()) return;
        requestRescan("focus");
    });

    // Debug: imprime el cache actual
    if (DEBUG_CACHE_EVERY_MS > 0) {
        setInterval(() => {
            const rid = getRecordIdFromUrl();
            const key = rid ? getStorageKey(rid) : "(sin recordId)";
            const val = rid ? sessionStorage.getItem(getStorageKey(rid)) : null;
            console.log("[Control Plazos][CACHE]", "| Fecha real fin:", val || null);
            //console.log("[Control Plazos][CACHE] Fecha de aceptacion", window.CONTROL_PLAZOS_FECHA_ACEPTACION);

        }, DEBUG_CACHE_EVERY_MS);
    }

    console.log("[Control Plazos] Script Fecha real fin cargado (persistente, cache por recordId, modal ok)");
})();
