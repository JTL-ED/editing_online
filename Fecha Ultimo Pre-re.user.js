// ==UserScript==
// @name         Fecha Ultima Fecha real fin
// @namespace    sf-control-plazos
// @version      2.0
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

    const STORAGE_KEY_LAST = "CONTROL_PLAZOS_FECHA_REAL_FIN:__LAST__";


    function isAllowedUrl() {
        const p = location.pathname;
        return (
            /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/view$/.test(p) ||
            /^\/lightning\/r\/Constructive_project__c\/[a-zA-Z0-9]{15,18}\/related\/Prerequisites__r\/view$/.test(p) ||
            /^\/lightning\/cmp\/c__nnssCreatePrerequisito$/.test(p)
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

    function setCacheForRecord(recordId, valueOrNull) {
        const id18 = toId18(recordId) || recordId;
        const id15 = id18 ? id18.slice(0, 15) : null;

        const k18 = id18 ? getStorageKey(id18) : null;
        const k15 = id15 ? getStorageKey(id15) : null;

        if (valueOrNull) {
            if (k18) sessionStorage.setItem(k18, valueOrNull);
            if (k15) sessionStorage.setItem(k15, valueOrNull);
            sessionStorage.setItem(STORAGE_KEY_LAST, valueOrNull);
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = valueOrNull;
        } else {
            if (k18) sessionStorage.removeItem(k18);
            if (k15) sessionStorage.removeItem(k15);
            // no borrar LAST
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
        }
    }

    function restoreCacheForRecord(recordId) {
        const id18 = toId18(recordId) || recordId;
        const id15 = id18 ? id18.slice(0, 15) : null;

        const k18 = id18 ? getStorageKey(id18) : null;
        const k15 = id15 ? getStorageKey(id15) : null;

        const v =
              (k18 && sessionStorage.getItem(k18)) ||
              (k15 && sessionStorage.getItem(k15)) ||
              sessionStorage.getItem(STORAGE_KEY_LAST);

        window.CONTROL_PLAZOS_FECHA_REAL_FIN = v || null;
        if (v) console.log("[Control Plazos] Cache restaurado:", v);
    }




    function getRecordIdFromUrl() {
        // 1) Caso normal: /lightning/r/Constructive_project__c/<id>/...
        let m = location.href.match(/\/lightning\/r\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\//i);
        if (m) return toId18(m[1]) || m[1];

        // 2) Caso CMP: parentId o ws
        try {
            const qs = new URLSearchParams(location.search || "");
            const parentId = qs.get("c__parentId");
            if (parentId && /^[a-zA-Z0-9]{15,18}$/.test(parentId)) return toId18(parentId) || parentId;

            const ws = qs.get("ws");
            if (ws) {
                const decodedWs = decodeURIComponent(ws);
                const m2 = decodedWs.match(/\/lightning\/r\/Constructive_project__c\/([a-zA-Z0-9]{15,18})\//i);
                if (m2) return toId18(m2[1]) || m2[1];
            }
        } catch (e) {}

        return null;
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


    function toId18(id) {
        const s = (id || "").trim();
        if (s.length === 18) return s;
        if (s.length !== 15) return null;

        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
        let suffix = "";

        for (let i = 0; i < 3; i++) {
            let flags = 0;
            for (let j = 0; j < 5; j++) {
                const c = s.charAt(i * 5 + j);
                if (c >= "A" && c <= "Z") flags |= (1 << j);
            }
            suffix += chars.charAt(flags);
        }
        return s + suffix;
    }


    function getStorageKey(recordId) {
        return STORAGE_KEY_PREFIX + recordId;
    }

    function isCreatePrerequisitoCmpUrl() {
        return /^\/lightning\/cmp\/c__nnssCreatePrerequisito$/.test(location.pathname);
    }




    function restoreCacheForRecord(recordId) {
        const k = getStorageKey(recordId);
        const v = sessionStorage.getItem(k) || sessionStorage.getItem(STORAGE_KEY_LAST);
        window.CONTROL_PLAZOS_FECHA_REAL_FIN = v || null;
        if (v) console.log("[Control Plazos] Cache restaurado:", v);
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

    function isPrerequisitesRelatedListUrl() {
        return /\/related\/Prerequisites__r\/view$/.test(location.pathname);
    }


    function scanForCurrent(reason) {
        if (!isAllowedUrl()) return;
        if (document.visibilityState !== "visible") return;

        const recordId = getRecordIdFromUrl();
        if (!recordId) {
            const last = sessionStorage.getItem(STORAGE_KEY_LAST);
            window.CONTROL_PLAZOS_FECHA_REAL_FIN = last || null;
            return;
        }


        // En CREATE no hay tabla: no reescaneamos ni tocamos cache.
        if (isCreatePrerequisitoCmpUrl()) {
            restoreCacheForRecord(recordId);
            console.log("[Fecha real fin] Key:", `${ONLY_OBJECT_API}:${recordId}`, "| CREATE: usando cache:", window.CONTROL_PLAZOS_FECHA_REAL_FIN || null);
            return;
        }

        const keyForLog = `${ONLY_OBJECT_API}:${recordId}`;

        const token = ++scanToken;
        let attempts = 0;

        function attempt() {
            if (token !== scanToken) return;
            attempts++;

            let best = { foundTable: false, dateStr: null, table: null };

            const roots = getScanRoots();

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
                // Importante: no borrar cache si no hay fecha.
                console.log("[Fecha real fin] Key:", keyForLog, "| No hay fecha | origen:", reason, "| cache se mantiene:", sessionStorage.getItem(getStorageKey(recordId)) || null);
                attachTableObserver(best.table);
                return;
            }

            if (attempts < SCAN_MAX_ATTEMPTS) {
                setTimeout(attempt, SCAN_DELAY_MS);
            } else {
                console.log("[Fecha real fin] Key:", keyForLog, "| No se ha encontrado la tabla | origen:", reason, "| cache se mantiene:", sessionStorage.getItem(getStorageKey(recordId)) || null);
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
            const valByRid = rid ? sessionStorage.getItem(getStorageKey(rid)) : null;
            const valLast = sessionStorage.getItem(STORAGE_KEY_LAST);

            console.log("[Control Plazos][CACHE]",
                        "| rid:", rid || null,
                        "| por rid:", valByRid || null,
                        "| last:", valLast || null,
                        "| window:", window.CONTROL_PLAZOS_FECHA_REAL_FIN || null
                       );
        }, DEBUG_CACHE_EVERY_MS);
    }


    console.log("[Control Plazos] Script Fecha real fin cargado (persistente, cache por recordId, modal ok)");
})();
