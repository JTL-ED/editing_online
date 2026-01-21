// ==UserScript==
// @name         Control Plazos - Fecha real fin + Fecha aceptacion + UI fecha + pre (auto fecha)
// @namespace    sf-control-plazos
// @version      1.2.6
// @description  Integra dos funciones: (1) Ultima "Fecha real fin" desde related list Pre-requisitos (Constructive_project__c) con cache por recordId y soporte CMP create. (2) "Fecha de Aceptacion" (Record__c) con la misma logica original 1.3.1 (cache unico persistente).
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    // ------------------------------------------------------------
    // MODULO 1: Fecha Ultima Fecha real fin (Constructive_project__c)
    // ------------------------------------------------------------

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

        const NULL_MARK = "__NULL__";

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
                // NUEVO: marcar explicitamente NULL para este recordId
                if (k18) sessionStorage.setItem(k18, NULL_MARK);
                if (k15) sessionStorage.setItem(k15, NULL_MARK);
                // no borrar LAST
                window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
            }

        }


        function restoreCacheForRecord(recordId) {
            const id18 = toId18(recordId) || recordId;
            const id15 = id18 ? id18.slice(0, 15) : null;

            const k18 = id18 ? (STORAGE_KEY_PREFIX + id18) : null;
            const k15 = id15 ? (STORAGE_KEY_PREFIX + id15) : null;

            const v18 = k18 ? sessionStorage.getItem(k18) : null;
            const v15 = k15 ? sessionStorage.getItem(k15) : null;

            // Si este record esta marcado como NULL, no usar LAST
            if (v18 === NULL_MARK || v15 === NULL_MARK) {
                window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
                return;
            }

            const v =
                  v18 ||
                  v15 ||
                  sessionStorage.getItem(STORAGE_KEY_LAST);

            window.CONTROL_PLAZOS_FECHA_REAL_FIN = v || null;
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
                //const last = sessionStorage.getItem(STORAGE_KEY_LAST);
                //window.CONTROL_PLAZOS_FECHA_REAL_FIN = last || null;
                window.CONTROL_PLAZOS_FECHA_REAL_FIN = null;
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
                    setCacheForRecord(recordId, null);
                    //console.log("[Fecha real fin] Key:", keyForLog, "| No hay fecha | origen:", reason, "| cache se mantiene:", sessionStorage.getItem(getStorageKey(recordId)) || null);
                    const raw = sessionStorage.getItem(getStorageKey(recordId));
                    const shown = (raw === NULL_MARK) ? null : (raw || null);

                    console.log("[Fecha real fin] Key:", keyForLog,
                                "| No hay fecha -> cache a null",
                                "| origen:", reason,
                                "| cache por rid:", shown);
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
                //const rid = getRecordIdFromUrl();
                //const valByRid = rid ? sessionStorage.getItem(getStorageKey(rid)) : null;
                //const valLast = sessionStorage.getItem(STORAGE_KEY_LAST);

                const rid = getRecordIdFromUrl();
                const valByRid = rid ? sessionStorage.getItem(getStorageKey(rid)) : null;
                const vRidShown = (valByRid === NULL_MARK) ? null : (valByRid || null);
                const valLast = sessionStorage.getItem(STORAGE_KEY_LAST);

                //console.log("[Control Plazos][CACHE] Ultima fecha real fin: ",valLast || null,
                //            "| rid:", rid || null,
                //            "| por rid:", valByRid || null,
                //            "| last:", valLast || null,
                //            "| window:", window.CONTROL_PLAZOS_FECHA_REAL_FIN || null

                console.log("[Control Plazos][CACHE] FINAL:", window.CONTROL_PLAZOS_FECHA_REAL_FIN
                           );
            }, DEBUG_CACHE_EVERY_MS);
        }

        console.log("[Control Plazos] Script Fecha real fin cargado (persistente, cache por recordId, modal ok)");
    })();



    // ------------------------------------------------------------
    // MODULO 2: Fecha de Aceptacion (Record__c) - ORIGINAL 1.3.1
    // Integrado sin cambiar la logica, solo renombrado internamente
    // para evitar colisiones con el Modulo 1.
    // ------------------------------------------------------------

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
                    "[Control Plazos][CACHE] ACEPT:",
                    window.CONTROL_PLAZOS_FECHA_ACEPTACION
                );
            }, DEBUG_CACHE_EVERY_MS);
        }

        console.log("[Control Plazos] Script Fecha de Aceptacion cargado (persistente)");
    })();


    // ----------------------------------------
    // MODULO 3: UI popover fechas
    // (popover debajo del input + rellenar fechas)
    // ----------------------------------------
    (function () {
        //"use strict"; //"use strict" activa el modo estricto de JavaScript solo en el ámbito donde aparece.

        const MODAL_ID = "cp_fecha_picker_modal";
        let suppressNextOpen = false;

        // URL Create (cmp)
        const RX_NEW = /\/lightning\/cmp\/c__nnssCreatePrerequisito(?:\?|$)/i;

        function isCreateUrl() {
            return RX_NEW.test(location.pathname);
        }

        // Campos
        const START_DATE_NAME = "Start_date__c";
        const EXPECTED_DATE_NAME = "Expected_date__c";
        const ENABLE_START_DATE_POPOVER = false;
        const ENABLE_EXPECTED_DATE_POPOVER = true;


        // =========================================================
        // Festivos (editar a mano). Formato: "YYYY-MM-DD"
        // =========================================================
        const CP_HOLIDAYS = [
            // "2026-01-01",
            // "2026-01-06",
        ];

        // Opciones del popover para Expected_date__c
        // kind: "bdays" = dias laborables (salta findes + festivos)
        // kind: "months" = meses calendario y ajusta a siguiente laborable
        const EXPECTED_OPTIONS = [
            { label: "10 dias (laboral)", kind: "bdays", value: 10 },
            { label: "15 dias (laboral)", kind: "bdays", value: 15 },
            { label: "30 dias (laboral)", kind: "bdays", value: 30 },
            { label: "60 dias (laboral)", kind: "bdays", value: 60 },
            { label: "1 mes", kind: "months", value: 1 },
            { label: "2 meses", kind: "months", value: 2 },
            { label: "3 meses", kind: "months", value: 3 },
        ];


        function pad2(n) { return String(n).padStart(2, "0"); }

        function ymdKey(d) {
            return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        }

        function buildHolidaySet() {
            const set = new Set();
            for (const s of CP_HOLIDAYS) {
                if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) set.add(s.trim());
            }
            return set;
        }

        let CP_HOLIDAY_SET = buildHolidaySet();

        function isWorkingDay(d) {
            const day = d.getDay();
            if (day === 0 || day === 6) return false;
            return !CP_HOLIDAY_SET.has(ymdKey(d));
        }

        function addBusinessDays(dateObj, days) {
            const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
            const step = days >= 0 ? 1 : -1;
            let remaining = Math.abs(days);
            while (remaining > 0) {
                d.setDate(d.getDate() + step);
                if (isWorkingDay(d)) remaining--;
            }
            return d;
        }

        function addMonthsCalendarAndAdjust(dateObj, months) {
            const y = dateObj.getFullYear();
            const m = dateObj.getMonth();
            const day = dateObj.getDate();

            let d = new Date(y, m + months, day);

            while (!isWorkingDay(d)) {
                d.setDate(d.getDate() + 1);
            }
            return d;
        }


        function parseDateFromInput(text) {
            if (text == null) return null;

            // Normaliza espacios raros (NBSP)
            const s0 = String(text).replace(/\u00A0/g, " ").trim();
            if (!s0) return null;

            // Mapa meses ES (abreviatura 3 letras)
            const MONTHS_ES = {
                ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
                jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
            };

            // 0) Buscar dd-mmm-yyyy (ej: 08-dic-2025) incluso si hay texto alrededor
            // admite separador '-' o '/' y admite "dic." con punto
            let m = s0.toLowerCase().match(/(\d{1,2})\s*[-\/]\s*([a-zñ]{3,4})\.?\s*[-\/]\s*(\d{4})/);
            if (m) {
                const dd = parseInt(m[1], 10);
                let mon = m[2];

                // Normalizaciones frecuentes
                // "sept" -> "sep" (a veces Lightning/usuarios lo ponen asi)
                // "set"  -> "sep" (catalan)
                if (mon === "sept") mon = "sep";
                if (mon === "set") mon = "sep";

                // Si viene con 4 letras tipo "sept", por seguridad corta a 3
                if (mon.length > 3) mon = mon.slice(0, 3);

                const yy = parseInt(m[3], 10);
                if (MONTHS_ES.hasOwnProperty(mon)) {
                    const d = new Date(yy, MONTHS_ES[mon], dd);
                    if (!isNaN(d.getTime())) return d;
                }
            }


            // 1) yyyy-mm-dd exacto
            m = s0.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (m) {
                const yy = parseInt(m[1], 10);
                const mm = parseInt(m[2], 10) - 1;
                const dd = parseInt(m[3], 10);
                const d = new Date(yy, mm, dd);
                if (!isNaN(d.getTime())) return d;
            }

            // 2) dd/mm/yyyy dentro del texto
            m = s0.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (m) {
                const dd = parseInt(m[1], 10);
                const mm = parseInt(m[2], 10) - 1;
                const yy = parseInt(m[3], 10);
                const d = new Date(yy, mm, dd);
                if (!isNaN(d.getTime())) return d;
            }

            // 3) dd-mm-yyyy dentro del texto
            m = s0.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
            if (m) {
                const dd = parseInt(m[1], 10);
                const mm = parseInt(m[2], 10) - 1;
                const yy = parseInt(m[3], 10);
                const d = new Date(yy, mm, dd);
                if (!isNaN(d.getTime())) return d;
            }

            return null;
        }

        function formatDateDDMMMYYYY_ES(d) {
            const MONS = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
            return `${pad2(d.getDate())}-${MONS[d.getMonth()]}-${d.getFullYear()}`;
        }


        function readInputText(el) {
            if (!el) return "";

            // 1) valor directo del input
            try {
                const v1 = (el.value != null) ? String(el.value) : "";
                if (v1.trim()) return v1.trim();
            } catch (_) {}

            try {
                const v2 = el.getAttribute ? (el.getAttribute("value") || "") : "";
                if (String(v2).trim()) return String(v2).trim();
            } catch (_) {}

            // 2) Subir por el shadow DOM (getRootNode().host) hasta encontrar un host Lightning
            //    Esto SI atraviesa boundaries de shadowRoot, a diferencia de closest()
            function findLightningHostAcrossShadow(node) {
                try {
                    let cur = node;
                    for (let i = 0; i < 10 && cur; i++) {
                        // Si el nodo actual ya es un host Lightning conocido
                        const tag = (cur.tagName || "").toLowerCase();
                        if (tag === "lightning-input" ||
                            tag === "lightning-input-field" ||
                            tag === "lightning-datepicker" ||
                            tag === "lightning-combobox") {
                            return cur;
                        }

                        // Subir al host del shadowRoot si existe
                        const root = cur.getRootNode ? cur.getRootNode() : null;
                        if (root && root.host) {
                            cur = root.host;
                            continue;
                        }

                        // Si no hay host, subir DOM normal
                        cur = cur.parentNode || null;
                    }
                } catch (_) {}
                return null;
            }

            const host = findLightningHostAcrossShadow(el);

            // 3) Leer value del host (a veces Lightning guarda ahi la fecha)
            try {
                if (host && typeof host.value === "string" && host.value.trim()) {
                    return host.value.trim();
                }
            } catch (_) {}

            // 4) Buscar un input interno dentro del host (si existe)
            try {
                if (host && host.querySelector) {
                    const inner = host.querySelector("input");
                    if (inner) {
                        const iv = (inner.value != null) ? String(inner.value) : "";
                        if (iv.trim()) return iv.trim();

                        const ia = inner.getAttribute ? (inner.getAttribute("value") || "") : "";
                        if (String(ia).trim()) return String(ia).trim();
                    }

                    // 5) Ultimo recurso: title/aria-label
                    const withTitle = host.querySelector("[title], [aria-label]");
                    if (withTitle) {
                        const t = (withTitle.getAttribute("title") || withTitle.getAttribute("aria-label") || "").trim();
                        if (t) return t;
                    }
                }
            } catch (_) {}

            // 6) Ultimo ultimo recurso: en el propio input
            try {
                const t2 = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
                if (t2) return t2;
            } catch (_) {}

            return "";
        }




        function formatDateDDMMYYYY(d) {
            return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
        }

        function* walkDeep(root, opts = {}) {
            const MAX_NODES = opts.maxNodes ?? 2000;
            const MAX_DEPTH = opts.maxDepth ?? 4;
            let seen = 0;
            const stack = [{ node: root, depth: 0 }];
            while (stack.length) {
                const { node, depth } = stack.pop();
                if (!node) continue;
                yield node;
                if (++seen >= MAX_NODES) break;
                if (depth >= MAX_DEPTH) continue;

                if (node.shadowRoot) stack.push({ node: node.shadowRoot, depth: depth + 1 });

                if (node.children && node.children.length) {
                    for (let i = node.children.length - 1; i >= 0; i--) {
                        stack.push({ node: node.children[i], depth: depth + 1 });
                    }
                }

                const tag = node.tagName;
                if (tag === "IFRAME" || tag === "FRAME") {
                    try {
                        if (node.contentDocument) stack.push({ node: node.contentDocument, depth: depth + 1 });
                    } catch (_) {}
                }
            }
        }

        function findInputByName(name) {
            // 1) intento directo sin exigir class (mas robusto)
            let el = document.querySelector(`input[name="${name}"]`);
            if (el) return el;

            // 2) fallback con la clase por si acaso
            el = document.querySelector(`input.slds-input[name="${name}"]`);
            if (el) return el;

            // 3) deep scan (shadow roots)
            for (const n of walkDeep(document, { maxNodes: 4000, maxDepth: 7 })) {
                try {
                    if (!n.querySelector) continue;

                    el = n.querySelector(`input[name="${name}"]`);
                    if (el) return el;

                    el = n.querySelector(`input.slds-input[name="${name}"]`);
                    if (el) return el;
                } catch (_) {}
            }
            return null;
        }


        function getBaseDateForExpected(expectedInputEl) {
            // SIEMPRE usar Start_date__c como base (Expected no se usa como referencia)
            const startInput = findInputByName(START_DATE_NAME);
            const rawStart = readInputText(startInput);
            const base = parseDateFromInput(rawStart);

            if (base) return { base, source: "start", raw: rawStart };

            console.log("[expected_date][debug] rawStart:", rawStart);
            return { base: null, source: "none", raw: "" };
        }




        function writeDateTextValue(el, text) {
            try {
                if (!el) return false;
                if ((el.value || "") === text) return true;
                el.value = text;
                el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
                el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
                try {
                    if (typeof el.setCustomValidity === "function") el.setCustomValidity("");
                    if (typeof el.reportValidity === "function") el.reportValidity();
                } catch (_) {}
                return true;
            } catch (e) {
                console.warn("[cp_popover] write error:", e);
                return false;
            }
        }

        // =========================================================
        // Popover unico (estado)
        // =========================================================
        let pickerOpen = false;
        let panelEl = null;
        let activeInputEl = null;
        let activeMode = null; // "start" | "expected"

        function closePickerModal() {
            const el = document.getElementById(MODAL_ID);
            if (el) el.remove();
            panelEl = null;
            activeInputEl = null;
            activeMode = null;
        }

        function mkTileFactory() {
            return function mkTile(text) {
                const b = document.createElement("button");
                b.type = "button";
                b.textContent = text;
                b.style.background = "#f7f8fb";
                b.style.border = "1px solid rgba(0,0,0,0.14)";
                b.style.borderRadius = "12px";
                b.style.padding = "8px 10px";
                b.style.cursor = "pointer";
                b.style.fontSize = "12px";
                b.style.color = "#2e2e2e";
                b.style.textAlign = "center";
                b.style.whiteSpace = "nowrap";
                b.style.overflow = "hidden";
                b.style.textOverflow = "ellipsis";
                b.onmouseenter = () => (b.style.background = "#eef2ff");
                b.onmouseleave = () => (b.style.background = "#f7f8fb");
                return b;
            };
        }
        // Ajuste manual del popover (en píxeles)
        const POPOVER_SHIFT_X = 0; // positivo = derecha, negativo = izquierda
        const POPOVER_SHIFT_Y = 0; // positivo = abajo, negativo = arriba

        function buildPopover(anchorRect, mode) {


            const wrap = document.createElement("div");
            wrap.id = MODAL_ID;

            wrap.style.position = "fixed";
            wrap.style.zIndex = "999999";
            wrap.style.left = "0";
            wrap.style.top = "0";
            wrap.style.width = "0";
            wrap.style.height = "0";

            const panel = document.createElement("div");
            panel.style.position = "fixed";
            panel.style.background = "#fff";
            panel.style.border = "1px solid rgba(0,0,0,0.12)";
            panel.style.borderRadius = "12px";
            panel.style.boxShadow = "0 12px 35px rgba(0,0,0,0.18)";
            panel.style.padding = "8px";
            panel.style.display = "flex";
            panel.style.gap = "6px";
            panel.style.alignItems = "flex-start";

            const minW = 320;
            const maxW = 480;
            const extraW = 0;
            const desiredW = Math.max(minW, Math.min(maxW, anchorRect.width + extraW));
            panel.style.width = desiredW + "px";

            const offset = 6;
            let left = anchorRect.left + POPOVER_SHIFT_X;
            let top = anchorRect.bottom + offset + POPOVER_SHIFT_Y;


            if (left + desiredW > window.innerWidth - 8) {
                left = Math.max(8, window.innerWidth - desiredW - 8);
            }

            const maxH = 220;
            const maxHReal = Math.min(maxH, window.innerHeight - top - 10);
            panel.style.maxHeight = maxHReal + "px";
            panel.style.overflow = "hidden";

            if (maxHReal < 140) {
                const upH = 200;
                top = Math.max(8, anchorRect.top - offset - upH);
            }

            panel.style.left = Math.round(left) + "px";
            panel.style.top = Math.round(top) + "px";

            const leftCol = document.createElement("div");
            leftCol.style.minWidth = "70px";
            leftCol.style.maxWidth = "140px";
            leftCol.style.fontSize = "13px";
            leftCol.style.color = "#2e2e2e";
            leftCol.style.lineHeight = "1.2";

            const title = document.createElement("div");
            title.style.fontWeight = "600";
            title.style.marginTop = "2px";
            title.innerHTML = mode === "start" ? "Selección<br>fecha:" : "Ajuste<br>plazo:";
            leftCol.appendChild(title);

            const rightCol = document.createElement("div");
            rightCol.style.flex = "1";
            rightCol.style.maxHeight = (maxHReal - 6) + "px";
            rightCol.style.overflow = "auto";
            rightCol.style.paddingRight = "4px";

            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, minmax(130px, 1fr))";
            grid.style.gap = "8px";

            const mkTile = mkTileFactory();


            //Regla general
            //Por cada nueva opcion “X dias”:
            //Nuevo boton: buttons.bX = mkTile("X dias")
            //Nuevo handler: applyExpectedDelta(..., "dX")
            //Nuevo caso: if (kind === "dX") addBusinessDays(..., X)


            let buttons = {};

            if (mode === "start") {
                buttons.bAceptacion = mkTile("Fecha de Aceptacion");
                buttons.bFinal = mkTile("Fecha Ultimo cierre PRE");
                buttons.bCancel = mkTile("Cancelar");
                grid.appendChild(buttons.bAceptacion);
                grid.appendChild(buttons.bFinal);
                buttons.bCancel.style.gridColumn = "1 / -1";
                grid.appendChild(buttons.bCancel);
            } else {
                // Genera botones a partir de EXPECTED_OPTIONS
                buttons.expected = [];

                for (const opt of EXPECTED_OPTIONS) {
                    const b = mkTile(opt.label);
                    b.dataset.cpKind = opt.kind;
                    b.dataset.cpValue = String(opt.value);
                    buttons.expected.push(b);
                    grid.appendChild(b);
                }

                buttons.bCancel = mkTile("Cancelar");
                buttons.bCancel.style.gridColumn = "1 / -1";
                grid.appendChild(buttons.bCancel);
            }


            rightCol.appendChild(grid);

            panel.appendChild(leftCol);
            panel.appendChild(rightCol);

            wrap.appendChild(panel);

            return { wrap, panel, buttons };
        }

        function cleanup() {
            //document.removeEventListener("mousedown", onDocClick, true);
            document.removeEventListener("pointerdown", onDocClick, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", onReflow, true);
            window.removeEventListener("resize", onReflow, true);
            setTimeout(() => { suppressNextOpen = false; }, 0);
            closePickerModal();
        }

        function isClickOnStartOrExpected(ev) {
            try {
                const t = ev.target;
                if (!t) return false;

                // 1) Click directamente en un input con name Start/Expected
                if (t.closest) {
                    if (t.closest(`input[name="${START_DATE_NAME}"]`)) return true;
                    if (t.closest(`input[name="${EXPECTED_DATE_NAME}"]`)) return true;
                }

                // 2) Click dentro del host Lightning del campo (solo el host cercano al click)
                const host = t.closest
                ? t.closest("lightning-input-field, lightning-input, lightning-datepicker, lightning-combobox")
                : null;

                if (host && host.querySelector) {
                    if (host.querySelector(`input[name="${START_DATE_NAME}"]`)) return true;
                    if (host.querySelector(`input[name="${EXPECTED_DATE_NAME}"]`)) return true;
                }

                // 3) Shadow DOM: composedPath, pero solo revisando hosts Lightning (no contenedores gigantes)
                const p = ev.composedPath ? ev.composedPath() : null;
                if (p && p.length) {
                    for (const n of p) {
                        if (!n || !n.querySelector || !n.matches) continue;

                        // Solo considerar hosts "pequenos" de campos, no document/body/div enormes
                        if (!n.matches("lightning-input-field, lightning-input, lightning-datepicker, lightning-combobox")) continue;

                        if (n.querySelector(`input[name="${START_DATE_NAME}"]`)) return true;
                        if (n.querySelector(`input[name="${EXPECTED_DATE_NAME}"]`)) return true;
                    }
                }

                return false;
            } catch (_) {
                return false;
            }
        }


        function onDocClick(ev) {
            const t = ev.target;

            // Click dentro del wrap/panel: no cerrar
            const wrap = document.getElementById(MODAL_ID);
            if (wrap && (wrap === t || wrap.contains(t))) return;

            if (panelEl && panelEl.contains(t)) return;

            // Click dentro de Start/Expected: no cerrar
            if (isClickOnStartOrExpected(ev)) return;

            // Click fuera: cerrar
            pickerOpen = false;
            cleanup();
        }




        function onKey(ev) {
            if (ev.key === "Escape") {
                pickerOpen = false;
                cleanup();
            }
        }

        function onReflow() {
            pickerOpen = false;
            cleanup();
        }

        function applyExpectedDelta(expectedInputEl, kind, value) {
            CP_HOLIDAY_SET = buildHolidaySet();

            function doCalcAndWrite(info) {
                let out = null;

                if (kind === "bdays") out = addBusinessDays(info.base, value);
                if (kind === "months") out = addMonthsCalendarAndAdjust(info.base, value);

                if (!out) return;

                const txt = formatDateDDMMMYYYY_ES(out);
                suppressNextOpen = true;
                writeDateTextValue(expectedInputEl, txt);

                console.log("[expected_date] Base:", formatDateDDMMYYYY(info.base), "origen:", info.source, "=>", kind, value, "=>", txt);
            }

            let info = getBaseDateForExpected(expectedInputEl);

            if (info.base) {
                doCalcAndWrite(info);
                return;
            }

            // Reintento: Lightning a veces aun no ha fijado el value del Start
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                info = getBaseDateForExpected(expectedInputEl);

                if (info.base) {
                    clearInterval(timer);
                    doCalcAndWrite(info);
                    return;
                }

                if (tries >= 3) {
                    clearInterval(timer);
                    console.log("[expected_date] No se puede calcular: Start vacio o invalido.");
                }
            }, 120);
        }




        function showPickerModalForInput(inputEl, mode) {
            if (!inputEl) return;

            const existingWrap = document.getElementById(MODAL_ID);

            // Caso A: ya esta abierto para el mismo modo/campo
            // - No cierres
            // - Refresca referencia (Lightning puede re-renderizar input)
            // - Si el DOM del popover desaparecio, lo recreas
            if (pickerOpen && activeMode === mode) {
                activeInputEl = inputEl;

                if (!existingWrap) {
                    // estaba "abierto" en estado, pero el DOM ya no existe -> recrear
                    pickerOpen = false;
                } else {
                    return;
                }
            }

            // Caso B: esta abierto pero es otro modo/campo -> cerrar y reabrir
            if (pickerOpen) {
                pickerOpen = false;
                cleanup();
            }

            pickerOpen = true;
            activeInputEl = inputEl;
            activeMode = mode;

            closePickerModal();

            const rect = inputEl.getBoundingClientRect();

            const built = buildPopover(rect, mode);

            panelEl = built.panel;

            const { wrap, buttons } = built;

            //document.addEventListener("mousedown", onDocClick, true);
            document.addEventListener("pointerdown", onDocClick, true);
            document.addEventListener("keydown", onKey, true);
            window.addEventListener("scroll", onReflow, true);
            window.addEventListener("resize", onReflow, true);

            // Cancelar
            buttons.bCancel.addEventListener("click", () => {
                pickerOpen = false;
                cleanup();
            });

            if (mode === "start") {
                buttons.bAceptacion.addEventListener("click", () => {
                    const v = window.CONTROL_PLAZOS_FECHA_ACEPTACION || null;
                    if (!v) {
                        console.log("[start_date] Fecha de Aceptacion: cache null");
                        pickerOpen = false;
                        cleanup();
                        return;
                    }
                    suppressNextOpen = true;
                    writeDateTextValue(inputEl, v);
                    console.log("[start_date] Rellenado con Fecha de Aceptacion:", v);
                    pickerOpen = false;
                    cleanup();
                });

                buttons.bFinal.addEventListener("click", () => {
                    const v = window.CONTROL_PLAZOS_FECHA_REAL_FIN || null;
                    if (!v) {
                        console.log("[start_date] Fecha Ultimo cierre PRE: cache null");
                        pickerOpen = false;
                        cleanup();
                        return;
                    }
                    suppressNextOpen = true;
                    writeDateTextValue(inputEl, v);
                    console.log("[start_date] Rellenado con Fecha Ultimo cierre PRE:", v);
                    pickerOpen = false;
                    cleanup();
                });
            } else {
                // Conecta todos los botones generados
                if (buttons.expected && buttons.expected.length) {
                    for (const b of buttons.expected) {
                        b.addEventListener("click", () => {
                            const kind = b.dataset.cpKind;
                            const value = parseInt(b.dataset.cpValue, 10);
                            applyExpectedDelta(inputEl, kind, value);
                            pickerOpen = false;
                            cleanup();
                        });
                    }
                }
            }


            document.body.appendChild(wrap);

            // NO focus al popover (permite escribir en el input)
        }

        function pathHas(el, ev) {
            try {
                const p = ev.composedPath ? ev.composedPath() : null;
                if (p && p.length) return p.includes(el);
            } catch (_) {}
            return false;
        }


        document.addEventListener("pointerdown", (ev) => {
            if (!isCreateUrl()) return;

            // Si clicas dentro del popover, no reabrir
            try {
                const p0 = ev.composedPath ? ev.composedPath() : null;
                if (p0 && p0.length) {
                    for (const n of p0) {
                        if (n && n.id === MODAL_ID) return;
                    }
                } else if (panelEl && panelEl.contains(ev.target)) {
                    return;
                }
            } catch (_) {}

            // Si vienes de una escritura programatica (al elegir boton), no reabrir en ese click
            if (suppressNextOpen) {
                suppressNextOpen = false;
                return;
            }

            const p = ev.composedPath ? ev.composedPath() : null;

            let startInput = null;
            let expectedInput = null;

            // 1) Buscar INPUT en el composedPath (esto funciona con shadow DOM)
            if (p && p.length) {
                for (const n of p) {
                    if (!n) continue;

                    if (n.tagName === "INPUT") {
                        const nm = n.getAttribute && n.getAttribute("name");
                        if (nm === START_DATE_NAME) {
                            startInput = n;
                            break;
                        }
                        if (nm === EXPECTED_DATE_NAME) {
                            expectedInput = n;
                            break;
                        }
                    }
                }
            }

            if (startInput) {
                if (ENABLE_START_DATE_POPOVER) {
                    setTimeout(() => showPickerModalForInput(startInput, "start"), 0);
                }
                return;
            }

            if (expectedInput) {

                if (ENABLE_EXPECTED_DATE_POPOVER) {
                    setTimeout(() => showPickerModalForInput(expectedInput, "expected"), 0);

                }
                return;


            }

            // 2) Si el click cae sobre un host Lightning dentro del path, buscar el input dentro del host
            if (p && p.length) {
                for (const n of p) {
                    if (!n || !n.querySelector || !n.matches) continue;

                    if (!n.matches("lightning-input-field, lightning-input, lightning-datepicker, lightning-combobox")) continue;

                    const s = n.querySelector(`input[name="${START_DATE_NAME}"]`);
                    if (s) {
                        setTimeout(() => showPickerModalForInput(s, "start"), 0);
                        return;
                    }

                    const e = n.querySelector(`input[name="${EXPECTED_DATE_NAME}"]`);
                    if (e) {
                        setTimeout(() => showPickerModalForInput(e, "expected"), 0);
                        return;
                    }
                }
            }

            // 3) Ultimo fallback: busca por todo el documento
            const s2 = findInputByName(START_DATE_NAME);
            const e2 = findInputByName(EXPECTED_DATE_NAME);

            // Aqui solo abrimos si el click fue sobre el propio campo (lo mas aproximado posible)
            // Si no podemos detectarlo, mejor no abrir para no abrir en cualquier click de la pagina.
            if (s2 && s2 === ev.target) {
                setTimeout(() => showPickerModalForInput(s2, "start"), 0);
                return;
            }
            if (e2 && e2 === ev.target) {
                setTimeout(() => showPickerModalForInput(e2, "expected"), 0);
                return;
            }
        }, true);



    })();



    // ----------------------------------------
    // MODULO 4: UI Create Prerrequisito
    //
    // ----------------------------------------


    (function() {
        const MODAL_WHITELIST = new Set(['01/01', '01/07','03/07']);
        // ——— Auto-relleno de Fecha de inicio ———
        const START_DATE_NAME = 'Start_date__c';
        const START_DATE_SKIP_SET = new Set(['FASE OBRA','OBRA BACKLOG']);

        const NAME_RULES = {
            '01/01': [{label: 'PART', write: 'PART', key: 'PART_Acciones' }, 'REQ ORG CLIENT', 'DIVISIO', 'REHABILITACIO'],
            '01/04': 'CES OC',
            '01/06': 'IE',
            '01/07': ['FASE OBRA', 'ANULAR', 'PTE ACT CLIENT'],
            '01/19': 'CES',
            '01/18': 'OBRA CIVIL',
            '01/20': 'AJUSTAT',
            '01/21': 'ACTA',
            //'01/24': '',
            //'01/25': '',
            //'01/26': '',
            //'01/27': '',
            //----------------------------------------------------------------------------------------------------------------
            '02/08': 'ESCREIX',
            //----------------------------------------------------------------------------------------------------------------
            '03/09': 'CP2',
            '03/11': {label: 'PART', write: 'PART', key: 'PART_Permisos' },
            '03/13': 'PER',
            '03/14': 'APS',
            '03/07': ['OBRA BACKLOG', 'CP1', 'SUPEDITAT', 'CIVICOS', 'ESTUDI', 'AGP', 'CTR', 'FASES', 'TRAÇAT', 'CE'],
            //----------------------------------------------------------------------------------------------------------------
            //'04/15': '',
            //'04/16': '',
        };

        const COMM_RULES_3 = {
            '01/01/DIVISIO': 'Pendiente que nos haga llegar la División Horizontal para poder finalizar el expediente.',
            '01/01/PART_Acciones': 'Pendiente aportación de los permisos de terceros afectados para la realización de los trabajos.',
            '01/01/REHABILITACIO': 'Pendiente que nos haga llegar la nueva estructura del edificio para el reparto de la potencia.',
            '01/01/REQ ORG CLIENT': 'Pendiente aportación de la documentación requerida por los Organismos Oficiales en el proceso de tramitación de permisos.',
            //--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
            '01/07/ANULAR': 'Pendiente aportación carta de anulación, justificante de pago y certificado de titularidad bancaria.',
            '01/07/FASE OBRA': '',
            '01/07/PTE ACT CLIENT': 'Temporalmente, la gestión del expediente queda suspendida a la espera de la aportación por su parte de los documentos que se le han requerido.',
        };

        const COMM_RULES_2 = {
            '01/04': 'En breve les serán requeridos los documentos necesarios para realizar la cesión del CT/CM.',
            '01/06': 'Pendiente instalacion de la Caja General de Protección/Caja de Protección y Medida.',
            //'01/08': 'Pendiente de pago del sobrecoste  indicado en las condiciones - técnico econòmicas remitidas.',
            '01/18': 'Pendiente recibir información del espacio reservado para ubicar el CT/CM.',
            '01/19': 'En breve les serán requeridos los documentos necesarios para la cesión de las instalaciones.',
            '01/20': 'Pendiente recibir proyecto eléctrico para revisión.',
            '01/21': 'Una vez validado el proyecto eléctrico, tendrá que aportar permisos y autorizaciones concedidas, y cronograma de ejecución de obra para programar Acta de Lanzamiento.',
            //'01/24': '',
            //'01/25': '',
            //'01/26': '',
            //'01/27': '',
            //--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

            '02/08': 'Pendiente de pago del sobrecoste  indicado en las condiciones - técnico econòmicas remitidas.',
        };

        const NAME_LABEL_RX = /Nombre del Pre-?requisito/i;
        const COMM_LABEL_RX = /Comunicaci[oó]n al cliente\s*\(push\)/i;


        // Detectores de contexto (URL) //Create
        //const RX_NEW = /\/lightning\/o\/Prerequisite__c\/create(?:\?|$)/i;
        const RX_NEW = /\/lightning\/cmp\/c__nnssCreatePrerequisito(?:\?|$)/i;
        const RX_EDIT = /\/lightning\/r\/Prerequisite__c\/[^/]+\/edit(?:\?|$)/i;
        const RX_VIEW = /\/lightning\/r\/Prerequisite__c\/[^/]+\/view(?:\?|$)/i;

        let COMM_PENDING = false;
        let COMM_DEBOUNCE_T = null;

        // —— Utils de normalización y comparación —— //
        const collator = new Intl.Collator('es', { sensitivity:'base', usage:'sort' });
        const toObj = (x) => (typeof x === 'object' ? x : { label:String(x), write:String(x), key:String(x) });
        const byLabel = (a,b) => collator.compare(
            (toObj(a).label ?? toObj(a).write ?? '').trim(),
            (toObj(b).label ?? toObj(b).write ?? '').trim()
        );
        const buildKey2 = (tipo, subtipo) => `${tipo ?? ''}/${subtipo ?? ''}`;
        const buildKey3 = (tipo, subtipo, nameKey) => `${buildKey2(tipo, subtipo)}/${nameKey ?? ''}`;
        const guardReady = () => !(ST.modalOpen || ST.choosing);


        const ST = {
            tipo: null,
            subtipo: null,
            nameHost: null,
            commHost: null,
            tipoHost: null,
            subtipoHost: null,
            modalOpen: false,
            choosing: false,
            lastKeyName: null,
            lastTextName: null,
            lastKeyComm: null,
            lastTextComm: null,
            pickerEl: null,
            _insidePickerClick: false,
            lockNameOnce: false,
            lastNameKey: null,
            preNameOverride: null,
            noProcShownKey: null,
            _lastHadRule: null,
            // dentro de const ST = { ... }
            mode: 'view', // 'new' | 'edit' | 'view'
            canAutofill: false, // permiso para que applyName/applyComm actúen

        };

        const ESTUDI_TARGET = { tipo: '03', subtipo: '07' };
        const ESTUDI_VARIANTS = [
            { label: 'ESTUDI - PER', write: 'ESTUDI - PER', key: 'ESTUDI_PER' },
            { label: 'ESTUDI - PART', write: 'ESTUDI - PART', key: 'ESTUDI_PART' },
            { label: 'ESTUDI - CAR', write: 'ESTUDI - CAR', key: 'ESTUDI_CAR' },
            { label: 'ESTUDI - ERROR', write: 'ESTUDI - ERROR', key: 'ESTUDI_ERROR' },
            { label: 'ESTUDI - CLIENT', write: 'ESTUDI - CLIENT', key: 'ESTUDI_CLIENT' },
            { label: 'ESTUDI - EXE', write: 'ESTUDI - EXE', key: 'ESTUDI_EXE' },
            { label: 'ESTUDI - SO', write: 'ESTUDI - SO', key: 'ESTUDI_SO' },
        ];

        async function resetFields(level = 4) {
            ensurePickHosts();
            ST.nameHost = ST.nameHost || findHostByLabel(NAME_LABEL_RX, ['lightning-input','lightning-input-field']);
            ST.commHost = ST.commHost || findHostByLabel(COMM_LABEL_RX, ['lightning-textarea','lightning-input-rich-text','lightning-input-field']);

            if (level >= 1) {
                if (ST.nameHost) writeHostValue(ST.nameHost, '');
                ST.lastKeyName = null;
                ST.lastTextName = '';
                ST.lastNameKey = null;
            }
            if (level >= 2) {
                if (ST.commHost) writeHostValue(ST.commHost, '');
                ST.lastKeyComm = null;
                ST.lastTextComm = '';
            }
            if (level >= 3) {
                ST.subtipo = null;
                ST._lastHadRule = null;
                ST.noProcShownKey = null;
                if (ST.subtipoHost) {
                    try {
                        ST.subtipoHost.value = '';
                        ST.subtipoHost.dispatchEvent(new CustomEvent('change', { detail:{ value:'' }, bubbles:true, composed:true }));
                        ST.subtipoHost.dispatchEvent(new Event('blur', { bubbles:true, composed:true }));
                    } catch(_) {}
                }
            }
            if (level >= 4) {
                ST.tipo = null;
                if (ST.tipoHost) {
                    try {
                        ST.tipoHost.value = '';
                        ST.tipoHost.dispatchEvent(new CustomEvent('change', { detail:{ value:'' }, bubbles:true, composed:true }));
                        ST.tipoHost.dispatchEvent(new Event('blur', { bubbles:true, composed:true }));
                    } catch(_) {}
                }
            }
            ST.lockNameOnce = false;
            ST.modalOpen = false;
            ST.choosing = false;
            destroyPicker();
            document.getElementById('__af_modal_root__')?.remove();
        }

        const resetName = () => resetFields(1);
        const resetNameAndComm = () => resetFields(2);
        const resetNameCommAndSubtipo = () => resetFields(3);
        const resetAll = () => resetFields(4);

        async function resetFieldsDeferred(level = 2, ms = 80) { //可选稳妥）把 resetFieldsDeferred 的延时再拉长一点
            await delay(ms); // 延后一个很小的时间，避开 LWC 的一次同步校验周期
            await resetFields(level); // 再去清空
        }

        async function pickEstudiVariant() {
            const sorted = [...ESTUDI_VARIANTS].sort((a,b) => collator.compare(a.label||'', b.label||''));
            await resetFieldsDeferred(2);
            return await showChoiceModal('Seleccione Pre-requisito (ESTUDI)', sorted);
        }

        function requestApplyComm() {
            // 弹窗开着就先记一笔，等关闭后再执行
            if (ST.modalOpen || ST.choosing) { COMM_PENDING = true; return; }
            // 简单防抖
            clearTimeout(COMM_DEBOUNCE_T);
            COMM_DEBOUNCE_T = setTimeout(() => {
                COMM_PENDING = false;
                applyComm(); // 真正调用
            }, 160);// （可选）把通信的防抖再宽一点
        }

        function resetStartDateState({ forceClear = false } = {}) {
            _startDateAutofilledOnce = false;
            _startDateWasAuto = false;
            if (forceClear) {
                const el = findStartDateInput();
                if (el) writeDateTextValue(el, '');
            }
        }

        function* walkDeep(root, opts = {}) {
            const MAX_NODES = opts.maxNodes ?? 2000;
            const MAX_DEPTH = opts.maxDepth ?? 4;
            let seen = 0;
            const stack = [{ node: root, depth: 0 }];
            while (stack.length) {
                const { node, depth } = stack.pop();
                if (!node) continue;
                yield node;
                if (++seen >= MAX_NODES) break;
                if (depth >= MAX_DEPTH) continue;
                if (node.shadowRoot) stack.push({ node: node.shadowRoot, depth: depth + 1 });
                if (node.children && node.children.length) {
                    for (let i = node.children.length - 1; i >= 0; i--) {
                        stack.push({ node: node.children[i], depth: depth + 1 });
                    }
                }
                const tag = node.tagName;
                if (tag === 'IFRAME' || tag === 'FRAME') {
                    try {
                        if (node.contentDocument) {
                            stack.push({ node: node.contentDocument, depth: depth + 1 });
                        }
                    } catch (_) {}
                }
            }
        }

        const __FH_CACHE__ = new Map();

        function findHostByLabel(rx, tags){
            const key = rx.toString() + '|' + tags.join(',');
            const cached = __FH_CACHE__.get(key);
            if (cached && document.contains(cached)) return cached;

            const fast = document.querySelectorAll(tags.join(','));
            for (const el of fast) {
                const lab = (el.label || el.getAttribute?.('label') || '').trim();
                if (rx.test(lab)) { __FH_CACHE__.set(key, el); return el; }
            }
            for (const root of walkDeep(document, { maxNodes: 2000, maxDepth: 4 })) {
                if (!root.querySelectorAll) continue;
                for (const tag of tags) {
                    const list = root.querySelectorAll(tag);
                    for (const el of list) {
                        const lab = (el.label || el.getAttribute?.('label') || '').trim();
                        if (rx.test(lab)) { __FH_CACHE__.set(key, el); return el; }
                    }
                }
            }
            return null;
        }

        function writeHostValue(host, text=''){
            try{
                if(!host) return false;
                const current = (host.value ?? '');
                if(current === text) return true;
                host.value = text;

                try {
                    host.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true }));
                } catch(_) {
                    host.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
                }
                host.dispatchEvent(new CustomEvent('change', { detail:{ value:text }, bubbles:true, composed:true }));
                host.dispatchEvent(new Event('blur', { bubbles:true, composed:true }));
                // —— 关键：若是必填字段且文本非空，主动清除错误并触发一次校验 —— //
                try {
                    if (text && text.trim() !== '') {
                        if (typeof host.setCustomValidity === 'function') host.setCustomValidity('');
                        if (typeof host.reportValidity === 'function') host.reportValidity();
                    }
                } catch(_) {}
                return true;
            }catch(e){
                console.warn('Error al escribir:', e);
                return false;
            }
        }







        // —— Builder de modal genérico —— //
        async function showModal({ title, bodyHTML, actions }) {
            return new Promise(resolve => {
                const root = document.createElement('div');
                root.id = '__af_modal_root__';
                root.innerHTML = `
        <div class="af-backdrop"></div>
        <div class="af-modal" role="dialog" aria-modal="true" aria-label="${title}">
          <div class="af-header">${title}</div>
          <div class="af-body">${bodyHTML || ''}</div>
          <div class="af-actions"></div>
        </div>`;

                const style = document.createElement('style');
                style.id = 'af-modal-style';
                style.textContent = `
  #__af_modal_root__{position:fixed;inset:0;z-index:999999;font-family:system-ui,Segoe UI,Arial,Helvetica,sans-serif}
  #__af_modal_root__ .af-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35)}
  #__af_modal_root__ .af-modal{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);
    padding:16px;display:flex;flex-direction:column;gap:12px;
    width:fit-content;max-width:90vw;min-width:360px;
  }
  #__af_modal_root__ .af-header{font-weight:600;font-size:16px}
  /* grid de opciones (se controla el nº de columnas con --af-cols) */
  #__af_modal_root__ .af-body-grid{
    display:grid;grid-template-columns: repeat(var(--af-cols,3), minmax(110px, 1fr));
    gap:10px; align-items:stretch;
  }
  #__af_modal_root__ .af-option{
    min-height:40px; padding:10px 12px; border-radius:10px;
    border:1px solid #e3e3e3; background:#f6f7f9; cursor:pointer;
    width:100%; display:flex; align-items:center; justify-content:center; text-align:center;
    white-space:normal; word-break:break-word; overflow:visible;
  }
  #__af_modal_root__ .af-option:hover{background:#eef2ff;border-color:#c7d2fe}
  #__af_modal_root__ .af-actions{display:flex;justify-content:flex-end}
  #__af_modal_root__ .af-ok, #__af_modal_root__ .af-cancel{
    padding:8px 12px;border-radius:8px;border:1px solid #ddd;background:#fff;cursor:pointer
  }
  #__af_modal_root__ .af-ok:hover, #__af_modal_root__ .af-cancel:hover{background:#f7f7f7}
  `;

                document.body.appendChild(style);
                document.body.appendChild(root);
                const $actions = root.querySelector('.af-actions');
                (actions || [{label:'Aceptar', id:'ok'}]).forEach(a => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'af-ok';
                    b.textContent = a.label;
                    b.addEventListener('click', () => done(a.id));
                    $actions.appendChild(b);
                });
                function done(result){ root.remove(); style.remove(); resolve(result); }

                //可选
                //function done(result){
                //  try { root.remove(); style.remove(); } catch(_) {}
                // 兜底：任何关闭路径都把标志位清掉
                //  ST.modalOpen = false;
                //  ST.choosing = false;
                //  resolve(result);
                //}

                root.querySelector('.af-backdrop').addEventListener('click', () => done(null));
                document.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); }, { once:true });
            });
        }



        function showChoiceModal(title, choices) {
            if (ST.modalOpen || ST.choosing) return Promise.resolve(null);
            ST.modalOpen = true; ST.choosing = true;

            choices = [...choices].sort(byLabel);
            const cols = Math.min(3, Math.max(1, choices.length));
            const body = `
    <div class="af-body-grid" style="--af-cols:${cols}">
      ${choices.map((c,i)=>`<button class="af-option" data-idx="${i}" type="button" title="${toObj(c).label}">${toObj(c).label}</button>`).join('')}
    </div>`;

            return new Promise(resolve => {
                let finished = false;
                const finalize = (val) => {
                    if (finished) return; // ejecutar solo una vez
                    finished = true;
                    // cerrar modal
                    try {
                        document.getElementById('__af_modal_root__')?.remove();
                        document.getElementById('af-modal-style')?.remove();
                    } catch(_) {}
                    // reset
                    ST.modalOpen = false;
                    ST.choosing = false;
                    ST.canAutofill = true;
                    // 如果有挂起的 applyComm 请求，这里补一次（带防抖）
                    if (typeof COMM_PENDING !== 'undefined' && COMM_PENDING) requestApplyComm();
                    resolve(val ?? null);
                };
                showModal({ title, bodyHTML: body, actions: [{label:'Cancelar', id:null}] })
                    .then(() => finalize(null));

                document.querySelectorAll('.af-option').forEach((btn, i) => {
                    const handler = (ev) => {
                        // 防止被外层 Lightning 失焦/遮罩抢走事件
                        ev.preventDefault();
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                        finalize(choices[i]);
                    };
                    // 提前于 click 的通道，更稳
                    btn.addEventListener('pointerdown', handler, { once: true, capture: true });
                    // 兜底（某些环境仍走 click）
                    btn.addEventListener('click', handler, { once: true, capture: true });
                });

            });
        }


        function showNoticeModal(message){
            if (ST.modalOpen || ST.choosing) return Promise.resolve();
            ST.modalOpen = true; ST.choosing = true;
            return showModal({ title:'Aviso', bodyHTML:`<div class="af-msg" style="padding:6px 2px;">${message}</div>` })
                .then(()=>{ ST.modalOpen=false; ST.choosing=false; });
        }

        async function chooseFromRule(key, rule){
            if (rule === undefined) return null;
            // Si la regla es lista
            if (Array.isArray(rule)) {
                // Sin modal: toma la primera normalizada
                if (!MODAL_WHITELIST.has(key)) return toObj(rule[0]);
                if (!guardReady()) return null;
                await resetFieldsDeferred(2); // limpia Nombre + Comunicación antes del modal
                const picked = await showChoiceModal('Seleccione Pre-requisito', [...rule].sort(byLabel));
                if (!picked) return null;
                // Subflujo ESTUDI centralizado
                if (key === '03/07' && (toObj(picked).label||toObj(picked).write||'').trim().toUpperCase() === 'ESTUDI') {
                    const v = await pickEstudiVariant();
                    return v ? toObj(v) : null;
                }
                return toObj(picked);
            }
            // Regla única
            return toObj(rule);
        }

        function buildNameCatalog(rules){
            const out = [];
            for (const key of Object.keys(rules)) {
                const [tipo, subtipo] = key.split('/');
                const val = rules[key];
                const push = (x) => {
                    if (!x) return;
                    if (typeof x === 'string') {
                        out.push({ label: x, write: x, key: x, tipo, subtipo });
                    } else {
                        const label = x.label ?? x.write ?? '';
                        const write = x.write ?? x.label ?? '';
                        const k = x.key ?? write;
                        out.push({ label, write, key: k, tipo, subtipo });
                    }
                };
                Array.isArray(val) ? val.forEach(push) : push(val);
            }
            out.sort((a,b)=> collator.compare(a.label, b.label));
            return out;
        }
        const NAME_CATALOG = buildNameCatalog(NAME_RULES);

        function computePartGroups(rules){
            const groups = new Map();
            for (const key of Object.keys(rules)) {
                const [tipo, subtipo] = key.split('/');
                const val = rules[key];
                const push = (x) => {
                    if (!x) return;
                    const label = (typeof x==='object') ? (x.label ?? x.write ?? '') : x;
                    const write = (typeof x==='object') ? (x.write ?? x.label ?? '') : x;
                    const k = (typeof x==='object') ? (x.key ?? write) : write;
                    if (String(write).trim().toUpperCase() !== 'PART') return;
                    const gk = `${tipo}/${subtipo}`;
                    if (!groups.has(gk)) groups.set(gk, { tipo, subtipo, variants: [] });
                    groups.get(gk).variants.push({ label, write:'PART', key:k, tipo, subtipo });
                };
                Array.isArray(val) ? val.forEach(push) : push(val);
            }
            return [...groups.values()].filter(g => g.variants.length > 0);
        }
        const PART_GROUPS = computePartGroups(NAME_RULES);

        function ensurePickHosts(){
            if (!ST.tipoHost) ST.tipoHost = findHostByLabel(/^Tipo$/i, ['lightning-combobox']);
            if (!ST.subtipoHost) ST.subtipoHost = findHostByLabel(/^Subtipo$/i, ['lightning-combobox']);
        }

        function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

        function validateCombo(host){
            try { if (typeof host.reportValidity === 'function') return host.reportValidity(); }
            catch(_) {}
            return true;
        }

        async function setComboValue(host, valueOrLabel){
            if (!host) return false;
            try{
                host.value = valueOrLabel;
                host.dispatchEvent(new CustomEvent('change', { detail:{ value: valueOrLabel }, bubbles:true, composed:true }));
                host.dispatchEvent(new Event('blur', { bubbles:true, composed:true }));
                await delay(50);
                if (validateCombo(host)) return true;

                const trigger = host.shadowRoot?.querySelector('input.slds-input,[role="combobox"],button.slds-combobox__input');
                trigger?.click();
                await delay(60);

                const opts = Array.from(document.querySelectorAll('div.slds-listbox__option, li.slds-listbox__item .slds-media, li.slds-listbox__item'));
                const goal = String(valueOrLabel).trim().toLowerCase();
                let target = opts.find(el => {
                    const dv = el.getAttribute?.('data-value') || el.dataset?.value || '';
                    if (dv && String(dv).trim().toLowerCase() === goal) return true;
                    const txt = (el.textContent || '').trim().toLowerCase();
                    return txt === goal;
                }) || opts.find(el => (el.textContent||'').trim().toLowerCase().startsWith(goal));

                if (target) {
                    (target.closest('li') || target).click();
                    await delay(80);
                    if (validateCombo(host)) return true;
                }
                const finalVal = host.value;
                host.dispatchEvent(new CustomEvent('change', { detail:{ value: finalVal }, bubbles:true, composed:true }));
                host.dispatchEvent(new Event('blur', { bubbles:true, composed:true }));
                await delay(30);
                return validateCombo(host);
            } catch(e){
                console.warn('No se pudo establecer combobox:', e);
                return false;
            }
        }

        function destroyPicker(){
            ST.pickerEl?.remove();
            ST.pickerEl = null;
            ST._insidePickerClick = false;
        }

        function positionPickerNear(host, wrap){
            const r = host.getBoundingClientRect?.(); if (!r) return;
            const w = wrap.offsetWidth || 240;
            const gapX = 8, gapY = 8;
            let left = Math.min(r.right + gapX, innerWidth - w - 8);
            let top = Math.max(8, r.top);
            wrap.style.left = left + 'px';
            wrap.style.top = top + 'px';
        }

        function openNamePickerOnDemand(){
            if (document.getElementById('__af_name_picker_ephemeral__')) destroyPicker();

            if (ST.mode !== 'new') return;
            if (!ST.nameHost) return;
            destroyPicker();

            const wrap = document.createElement('div');
            wrap.id = '__af_name_picker_ephemeral__';
            Object.assign(wrap.style, {
                position:'fixed', zIndex:'999998', background:'#fff',
                border:'1px solid #e3e3e3', borderRadius:'8px', padding:'6px 8px',
                boxShadow:'0 6px 24px rgba(0,0,0,0.12)', display:'flex',
                alignItems:'stretch', gap:'8px',
                fontFamily:'system-ui, Segoe UI, Arial, Helvetica, sans-serif',
                width:'auto',
            });

            const label = document.createElement('div');
            label.innerHTML = 'Selección&nbsp;del<br>Pre-requisito:';
            Object.assign(label.style, {
                fontSize: '12px',
                lineHeight: '1.25',
                fontWeight: '600',
                whiteSpace: 'normal',
                wordBreak: 'keep-all',
                overflowWrap: 'normal',
                flex: '0 0 auto',
                minWidth: 'max-content',
                padding: '4px 2px',
                marginRight: '8px'
            });

            const list = document.createElement('div');
            Object.assign(list.style, {
                display:'grid',
                gridTemplateColumns:'repeat(2, minmax(100px, 1fr))',
                gap:'6px',
                maxHeight:'min(60vh, 394px)',
                overflow:'auto',
                width:'100%'
            });

            function mkBtn(entry){
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = entry.label;
                Object.assign(b.style, {
                    fontSize:'12px', padding:'8px 10px', borderRadius:'8px',
                    border:'1px solid #d7d2d7', background:'#f6f7f9',
                    cursor:'pointer', textAlign:'left', width:'100%'
                });
                b.addEventListener('mouseenter', () => { b.style.background = '#eef2ff'; b.style.borderColor = '#c7d2fe'; });
                b.addEventListener('mouseleave', () => { b.style.background = '#f6f7f9'; b.style.borderColor = '#d7d2d7'; });

                b.addEventListener('pointerdown', async (ev) => {
                    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                    ST._insidePickerClick = true; queueMicrotask(()=>{ ST._insidePickerClick = false; });

                    ensurePickHosts();
                    await setComboValue(ST.tipoHost, entry.tipo);
                    setTimeout(async () => {
                        await setComboValue(ST.subtipoHost, entry.subtipo);

                        ST.nameHost = findHostByLabel(NAME_LABEL_RX, ['lightning-input']) || ST.nameHost;
                        if (ST.nameHost) {
                            ST.lockNameOnce = true;
                            writeHostValue(ST.nameHost, entry.write);
                            ST.lastTextName = entry.write;
                            ST.lastNameKey = entry.key;

                            onPrereqNameConfirmedAndMaybeResetDates();

                            maybeHandleStartDateAfterNameChange();
                            maybeHandleExpectedAfterNameChange();

                        }
                        ST.canAutofill = true;
                        requestApplyComm();
                        destroyPicker();
                    }, 180);
                });
                return b;
            }

            function mkUniversalPartBtn(){
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = 'PART';
                Object.assign(b.style, {
                    fontSize:'12px', padding:'8px 10px', borderRadius:'8px',
                    border:'1px solid #d7d2d7', background:'#f6f7f9',
                    cursor:'pointer', textAlign:'left', width:'100%'
                });

                b.addEventListener('mouseenter', () => { b.style.background = '#eef2ff'; b.style.borderColor = '#c7d2fe'; });
                b.addEventListener('mouseleave', () => { b.style.background = '#f6f7f9'; b.style.borderColor = '#d7d2d7'; });

                b.addEventListener('pointerdown', async (ev) => {
                    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                    ST._insidePickerClick = true; queueMicrotask(()=>{ ST._insidePickerClick = false; });

                    try {
                        const labelMap = {
                            'PART_Acciones': 'PART - Pendiente acciones cliente',
                            'PART_Permisos':  'PART - Pendiente de permisos',
                        };

                        const variants = [];
                        for (const g of (PART_GROUPS || [])) {
                            for (const v of (g.variants || [])) {
                                variants.push({
                                    ...v,
                                    label: labelMap[v.key] || v.label || 'PART',
                                    _target: { tipo: g.tipo, subtipo: g.subtipo }
                                });
                            }
                        }
                        if (!variants.length) { destroyPicker(); return; }

                        if (ST.nameHost) writeHostValue(ST.nameHost, '');
                        await resetFieldsDeferred(2);
                        const choice = await showChoiceModal('Seleccione Pre-requisito (PART)', variants);
                        if (!choice) { destroyPicker(); return; }

                        ST.preNameOverride = { write: 'PART', key: choice.key };
                        ST.lockNameOnce = true;
                        ST.lastTextName = 'PART';
                        ST.lastNameKey = choice.key;
                        _nameConfirmed = true; // <-- NUEVO
                        onPrereqNameConfirmedAndMaybeResetDates();

                        maybeHandleStartDateAfterNameChange();
                        maybeHandleExpectedAfterNameChange();


                        ensurePickHosts();
                        await setComboValue(ST.tipoHost, choice._target.tipo);
                        setTimeout(async () => {
                            await setComboValue(ST.subtipoHost, choice._target.subtipo);

                            ST.nameHost = findHostByLabel(NAME_LABEL_RX, ['lightning-input']) || ST.nameHost;
                            if (ST.nameHost) writeHostValue(ST.nameHost, 'PART');
                            ST.canAutofill = true;

                            requestApplyComm();
                            destroyPicker();
                        }, 180);
                    } catch (err) {
                        console.error('[PART] click error:', err);
                        destroyPicker();
                    }
                });
                return b;
            }

            function mkUniversalEstudiBtn(){
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = 'ESTUDI';
                Object.assign(b.style, {
                    fontSize:'12px', padding:'8px 10px', borderRadius:'8px',
                    border:'1px solid #d7d2d7', background:'#f6f7f9',
                    cursor:'pointer', textAlign:'left', width:'100%'
                });
                b.addEventListener('mouseenter', () => { b.style.background = '#eef2ff'; b.style.borderColor = '#c7d2fe'; });
                b.addEventListener('mouseleave', () => { b.style.background = '#f6f7f9'; b.style.borderColor = '#d7d2d7'; });

                b.addEventListener('pointerdown', async (ev) => {
                    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                    ST._insidePickerClick = true; queueMicrotask(()=>{ ST._insidePickerClick = false; });

                    const v = await pickEstudiVariant();
                    if (!v) { destroyPicker(); return; }

                    ST.preNameOverride = { write: v.write, key: v.key };
                    ST.lockNameOnce = true;
                    ST.lastTextName = v.write;
                    ST.lastNameKey = v.key;

                    onPrereqNameConfirmedAndMaybeResetDates();

                    maybeHandleStartDateAfterNameChange();
                    maybeHandleExpectedAfterNameChange();


                    ensurePickHosts();
                    await setComboValue(ST.tipoHost, ESTUDI_TARGET.tipo);
                    setTimeout(async () => {
                        await setComboValue(ST.subtipoHost, ESTUDI_TARGET.subtipo);

                        ST.nameHost = findHostByLabel(NAME_LABEL_RX, ['lightning-input']) || ST.nameHost;
                        if (ST.nameHost) writeHostValue(ST.nameHost, v.write);
                        ST.canAutofill = true;
                        requestApplyComm();
                        destroyPicker();
                    }, 180);
                });
                return b;
            }

            let entries = NAME_CATALOG
            .filter(e => e && e.label && e.label.trim() !== '')
            .filter(e => String(e.write).trim().toUpperCase() !== 'PART')
            .filter(e => String(e.label).trim().toUpperCase() !== 'ESTUDI' &&
                    String(e.write).trim().toUpperCase() !== 'ESTUDI');

            entries.push({ label: 'PART', __isPartUniversal:   true });
            entries.push({ label: 'ESTUDI', __isEstudiUniversal: true });

            entries.sort((a, b) => a.label.localeCompare(b.label, 'es'));

            for (const entry of entries) {
                if (entry.__isPartUniversal) list.appendChild(mkUniversalPartBtn());
                else if (entry.__isEstudiUniversal) list.appendChild(mkUniversalEstudiBtn());
                else list.appendChild(mkBtn(entry));
            }

            wrap.appendChild(label);
            wrap.appendChild(list);
            document.body.appendChild(wrap);
            ST.pickerEl = wrap;
            positionPickerNear(ST.nameHost, wrap);

            const onDocDown = (e) => {
                if (ST._insidePickerClick) return;
                const path = e.composedPath?.() || [];
                if (!path.includes(wrap) && !path.includes(ST.nameHost)) {
                    destroyPicker();
                    document.removeEventListener('mousedown', onDocDown, true);
                    document.removeEventListener('keydown', onKey, true);
                }
            };
            const onKey = (e) => { if (e.key === 'Escape') onDocDown(e); };
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onKey, true);
        }
        let EXEC_TOKEN = 0;
        const nextToken = () => (++EXEC_TOKEN);


        const applyName = (() => {
            let t=null;
            return async () => {
                if (ST.modalOpen || ST.choosing) return;
                if (!ST.canAutofill && !ST.lockNameOnce && !ST.preNameOverride) return;
                if (!ST.subtipo) return;
                clearTimeout(t);
                t = setTimeout(async () => {
                    if (ST.modalOpen || ST.choosing) return; // 先 guard
                    const token = nextToken(); // 再递增

                    const key = `${ST.tipo ?? ''}/${ST.subtipo ?? ''}`;
                    if (ST.lastKeyName === key && ST.lastTextName != null && ST._lastHadRule === true) return;
                    const rule = NAME_RULES[key];
                    ST.nameHost = ST.nameHost || findHostByLabel(NAME_LABEL_RX, ['lightning-input']);
                    if (ST.preNameOverride) {
                        const picked = ST.preNameOverride;
                        ST.preNameOverride = null;
                        ST.nameHost = ST.nameHost || findHostByLabel(NAME_LABEL_RX, ['lightning-input']);
                        if (ST.nameHost) {
                            writeHostValue(ST.nameHost, picked.write || '');
                            ST.lastTextName = picked.write || '';
                            ST.lastNameKey = picked.key || (picked.write || '');
                            _nameConfirmed = !!ST.lastTextName;

                            onPrereqNameConfirmedAndMaybeResetDates();

                            maybeHandleStartDateAfterNameChange();
                            maybeHandleExpectedAfterNameChange();


                        }
                        ST.lastKeyName = key;
                        requestApplyComm();
                        return;
                    }

                    if (rule === undefined) {
                        if (ST.lastTextName && ST.lastTextName !== '') {
                            if (writeHostValue(ST.nameHost, '')) ST.lastTextName = '';
                        }
                        ST.lastKeyName = key;
                        ST._lastHadRule = false;

                        const k = key;
                        if (ST.tipo && ST.subtipo && ST.noProcShownKey !== k) {
                            ST.noProcShownKey = k;
                            clearStartDateIfAuto();
                            clearExpectedIfAuto();
                            _nameConfirmed = false; // limpiar fecha si la autocompletamos antes
                            await resetFields(3);
                            const msg = `No procede el prerrequisito con el TIPO y SUBTIPO seleccionados.`;
                            await showNoticeModal(msg);
                        }
                        return;
                    }

                    if (ST.lockNameOnce) {
                        ST.lockNameOnce = false;
                        ST.lastKeyName = key;

                        onPrereqNameConfirmedAndMaybeResetDates();

                        maybeHandleStartDateAfterNameChange();
                        maybeHandleExpectedAfterNameChange();

                        requestApplyComm();
                        return;
                    }

                    const picked = await chooseFromRule(key, rule);
                    if (token !== EXEC_TOKEN) return; // descarta resultados obsoletos
                    if (picked === null) return;
                    const writeText = picked.write ?? picked.label ?? '';

                    if (writeHostValue(ST.nameHost, writeText)) {
                        ST.lastTextName = writeText;
                        ST.lastNameKey = picked.key ?? writeText;
                        _nameConfirmed = !!ST.lastTextName; // <-- NUEVO

                        ST._lastHadRule = true;
                    }
                    ST.lastKeyName = key;

                    onPrereqNameConfirmedAndMaybeResetDates();

                    maybeHandleStartDateAfterNameChange();
                    maybeHandleExpectedAfterNameChange();

                    requestApplyComm();
                }, 120);
            };
        })();

        const applyComm = (() => {
            let t=null;
            return async () => {
                if (ST.modalOpen || ST.choosing) return;
                if (!ST.canAutofill && !ST.lockNameOnce && !ST.preNameOverride) return;
                clearTimeout(t);
                t = setTimeout(async () => {
                    if (ST.modalOpen || ST.choosing) return; // 先 guard
                    const token = nextToken(); // 再递增

                    const key2 = `${ST.tipo ?? ''}/${ST.subtipo ?? ''}`;
                    const nombreKey = ST.lastNameKey || ST.lastTextName || '';
                    const key3 = buildKey3(ST.tipo, ST.subtipo, nombreKey);
                    const rule3 = COMM_RULES_3[key3];
                    const rule2 = COMM_RULES_2[key2];
                    const rule = (rule3 !== undefined) ? rule3 : rule2;

                    ST.commHost = ST.commHost || findHostByLabel(COMM_LABEL_RX, ['lightning-textarea','lightning-input-rich-text']);
                    if (!ST.commHost) return;

                    if (rule === undefined) {
                        if (ST.lastTextComm && ST.lastTextComm !== '') {
                            if (writeHostValue(ST.commHost, '')) ST.lastTextComm='';
                        }
                        ST.lastKeyComm = (rule3 !== undefined) ? key3 : key2;
                        return;
                    }

                    const picked = await chooseFromRule((rule3 !== undefined) ? key3 : key2, rule);
                    if (token !== EXEC_TOKEN) return; // descarta resultados obsoletos
                    if (picked === null) return;

                    const writeText = (typeof picked === 'object') ? (picked.write ?? picked.label ?? '') : picked;
                    if (writeHostValue(ST.commHost, writeText)) ST.lastTextComm = writeText;
                    ST.lastKeyComm = (rule3 !== undefined) ? key3 : key2;
                }, 140);
            };
        })();

        function onNameManualCommit() {
            if (!ST.nameHost) return;
            const val = (ST.nameHost.value || '').trim();
            ST.lastTextName = val;
            ST.lastNameKey = val; // sin mapeo, usamos el texto
            _nameConfirmed = !!val; // <-- NUEVO

            onPrereqNameConfirmedAndMaybeResetDates();

            maybeHandleStartDateAfterNameChange();
            maybeHandleExpectedAfterNameChange();

        }

        // en install()
        document.addEventListener('blur', (e) => {
            const p = e.composedPath?.() || [];
            const host = p.find(n => n && n.tagName === 'LIGHTNING-INPUT');
            if (!host) return;
            const label = host.label || host.getAttribute?.('label') || '';
            if (NAME_LABEL_RX.test(label)) onNameManualCommit();
        }, true);

        document.addEventListener('change', (e) => {
            const p = e.composedPath?.() || [];
            const host = p.find(n => n && n.tagName === 'LIGHTNING-INPUT');
            if (!host) return;
            const label = host.label || host.getAttribute?.('label') || '';
            if (NAME_LABEL_RX.test(label)) onNameManualCommit();
        }, true);


        function onFocusIn(e){
            const path = e.composedPath?.() || [];
            const tag = n => n && n.tagName;
            const inputHost = path.find(n => tag(n)==='LIGHTNING-INPUT');
            const areaHost = path.find(n => tag(n)==='LIGHTNING-TEXTAREA' || tag(n)==='LIGHTNING-INPUT-RICH-TEXT');

            if (inputHost) {
                const label = inputHost.label || inputHost.getAttribute?.('label') || '';
                if (NAME_LABEL_RX.test(label) && !ST.nameHost) {
                    ST.nameHost = inputHost;
                }
            }
            if (areaHost) {
                const label = areaHost.label || areaHost.getAttribute?.('label') || '';
                if (COMM_LABEL_RX.test(label) && !ST.commHost) {
                    ST.commHost = areaHost;
                    requestApplyComm();
                }
            }
        }

        document.addEventListener('click', (e) => {
            const path = e.composedPath?.() || [];
            if (path.some(n => n && n.id === '__af_name_picker_ephemeral__')) return;

            // NO abrir el picker si no estamos en "nuevo"
            if (ST.mode !== 'new') return;

            const hit = path.find(n => n && n.tagName === 'LIGHTNING-INPUT');
            const lab = hit ? (hit.label || hit.getAttribute?.('label') || '') : '';
            if (hit && NAME_LABEL_RX.test(lab)) {
                ST.nameHost = hit;
                openNamePickerOnDemand();
            }
        }, true);

        document.addEventListener('pointerdown', (e) => {
            const path = e.composedPath?.() || [];
            const combo = path.find(n => n && n.tagName === 'LIGHTNING-COMBOBOX');
            if (!combo) return;
            const label = combo.label || combo.getAttribute?.('label') || '';
            if (label === 'Subtipo') {
                ST._subtipoListOpen = true;
                clearTimeout(ST._subtipoListTimer);
                ST._subtipoListTimer = setTimeout(() => { ST._subtipoListOpen = false; }, 2000);
            }
        }, true);

        document.addEventListener('click', async (e) => {
            if (!ST._subtipoListOpen) return;

            const path = e.composedPath?.() || [];
            let opt = null;
            for (const n of path) {
                if (!n || !n.getAttribute) continue;
                if (n.getAttribute('role') === 'option' || n.classList?.contains?.('slds-listbox__option')) {
                    opt = n; break;
                }
                const li = n.closest?.('li.slds-listbox__item');
                if (li) { opt = li; break; }
            }
            if (!opt) return;

            const picked = (opt.getAttribute('data-value') || opt.dataset?.value || (opt.textContent || '')).trim();
            if (!picked) return;

            const currentSub = (ST.subtipo || '').trim();
            if (picked.toLowerCase() !== currentSub.toLowerCase()) {
                ST._subtipoListOpen = false;
                return;
            }

            const key = buildKey2(ST.tipo, ST.subtipo);
            const rule = NAME_RULES[key];
            const isMulti = Array.isArray(rule);

            if (rule === undefined) {
                ST._subtipoListOpen = false;
                await resetFields(3);
                // limpiar fecha si la autocompletamos antes
                clearStartDateIfAuto();
                clearExpectedIfAuto();
                await showNoticeModal('No procede el prerrequisito con el TIPO y SUBTIPO seleccionados.');
                return;
            }

            if (!isMulti) {
                ST._subtipoListOpen = false;
                return;
            }
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            ST._subtipoListOpen = false;
            await resetFieldsDeferred(2);
            const choice = await showChoiceModal('Seleccione Pre-requisito', rule);

            // —— ★ 新增：03/07 的 ESTUDI 需要二级弹窗 —— //
            const keyNow = `${ST.tipo ?? ''}/${ST.subtipo ?? ''}`;
            const pickedLabel = (typeof choice === 'object'
                                 ? (choice.label ?? choice.write ?? '')
                                 : String(choice)).trim().toUpperCase();

            if (keyNow === '03/07' && pickedLabel === 'ESTUDI') {
                const v = await pickEstudiVariant(); // 打开二级弹窗
                if (!v) return; // 取消就退出
                // 用二级选择的结果覆盖
                const finalWrite = v.write ?? v.label ?? '';
                const finalKey = v.key ?? finalWrite;

                if (ST.nameHost) writeHostValue(ST.nameHost, finalWrite);
                ST.lastTextName = finalWrite;
                ST.lastNameKey = finalKey;
                _nameConfirmed = !!ST.lastTextName;

                onPrereqNameConfirmedAndMaybeResetDates();

                maybeHandleStartDateAfterNameChange(); // ← AÑÁDELO AQUÍ si lo omitiste
                maybeHandleExpectedAfterNameChange();

                ST.canAutofill = true;
                requestApplyComm();
                return; // 二级路径到此结束，避免继续走一级写入
            }



            if (choice == null) return;
            const writeText = (typeof choice === 'object') ? (choice.write ?? choice.label ?? '') : choice;
            const nameKey = (typeof choice === 'object') ? (choice.key ?? writeText) : writeText;
            if (ST.nameHost) writeHostValue(ST.nameHost, writeText);
            ST.lastTextName = writeText;
            ST.lastNameKey = nameKey;
            _nameConfirmed = !!ST.lastTextName;

            onPrereqNameConfirmedAndMaybeResetDates();

            maybeHandleStartDateAfterNameChange();
            maybeHandleExpectedAfterNameChange();
            requestApplyComm();
        }, true);

        async function onPickChange(e){
            const path = e.composedPath?.() || [];
            const host = path.find(n => n && n.tagName === 'LIGHTNING-COMBOBOX');
            if (!host) return;

            const label = host.label || host.getAttribute?.('label') || '';
            const val = ('value' in host) ? host.value : null;
            if (val == null) return;

            if (label === 'Tipo') {
                ST.tipo = val;
                ST.canAutofill = true;
                await resetFields(3);
                clearStartDateIfAuto(); // ← opcional: limpiarla al cambiar Tipo
                clearExpectedIfAuto();
                _nameConfirmed = false;
                return;
            }

            if (label === 'Subtipo') {
                ST.subtipo = val;
                ST._lastHadRule = null;
                ST.noProcShownKey = null;
                ST.canAutofill = true;
                applyName();
                requestApplyComm();
            }
        }


        // === Estado del autofill de Start_date__c ===
        let _startDateAutofilledOnce = false;
        let _startDateWasAuto = false;
        // NUEVO: solo permitimos autocompletar si ya se eligió/introdujo un nombre
        let _nameConfirmed = false;

        // =========================================================
        // BLOQUE DE AJUSTES (reglas futuras)
        // - Define aqui que prerrequisitos rellenan Start/Expected o no
        // - Por defecto: si no hay regla, se aplica la logica actual
        // =========================================================


        //Para añadir futuras reglas (ejemplos)
        const USE_ACCEPTACION = new Set([
            'IE',
            'AGP',
        ]);

        const USE_REAL_FIN = new Set([
            'FASE OBRA',
            'OBRA BACKLOG',
        ]);

        function getRuleForCurrentPrereqName() {
            const raw = (ST.lastTextName || '').trim();
            const name = raw.toUpperCase();

            if (USE_REAL_FIN.has(name)) {
                return { start:{ mode:'cache', source:'REAL_FIN' } };
            }
            if (USE_ACCEPTACION.has(name)) {
                return { start:{ mode:'cache', source:'ACEPTACION' } };
            }
            return null; // default
        }


        // Origenes posibles de cache (expansible)
        function getCacheValueBySource(source) {
            if (source === 'REAL_FIN') return window.CONTROL_PLAZOS_FECHA_REAL_FIN || null;
            if (source === 'ACEPTACION') return window.CONTROL_PLAZOS_FECHA_ACEPTACION || null;
            return null;
        }



        let _lastConfirmedName = null;

        function resetDatesHard() {
            // Start
            try {
                const s = findStartDateInput();
                if (s) writeDateTextValue(s, '');
            } catch(_) {}
            _startDateAutofilledOnce = false;
            _startDateWasAuto = false;
            _startDateWasCache = false;

            // Expected
            try {
                const e = findExpectedInput();
                if (e) writeDateTextValue(e, '');
            } catch(_) {}
            _expectedAutofilledOnce = false;
            _expectedWasAuto = false;
        }


        function onPrereqNameConfirmedAndMaybeResetDates() {
            if (ST.mode !== 'new') return;

            const cur = (ST.lastTextName || '').trim();
            if (!cur) return;

            if (_lastConfirmedName !== null && cur !== _lastConfirmedName) {
                resetDatesHard();
            }
            _lastConfirmedName = cur;
        }


        // Flags nuevos: para saber si Start lo puso el script via cache
        let _startDateWasCache = false;



        function shouldSkipStartDate(){
            const rule = getRuleForCurrentPrereqName();
            // Si hay regla y Start no es "default", entonces no hacemos el autofill "hoy"
            if (rule && rule.start && rule.start.mode && rule.start.mode !== 'keep_default') return true;

            // Mantener compatibilidad por si luego anades reglas y quieres fallback
            const n = (ST.lastTextName || '').trim().toUpperCase();
            return false;
        }


        function clearStartDateIfAuto(){
            try{
                const el = findStartDateInput();
                if (!el) return;

                if (_startDateWasAuto || _startDateWasCache) {
                    writeDateTextValue(el, '');
                    _startDateWasAuto = false;
                    _startDateWasCache = false;
                    _startDateAutofilledOnce = false; // permite volver a autocompletar si procede
                }
            }catch(_){}
        }


        // === Helpers de "Fecha de inicio" ===
        function findStartDateInput() {
            // 1) directo por atributo name
            let el = document.querySelector(`input.slds-input[name="${START_DATE_NAME}"]`);
            if (el) return el;

            // 2) búsqueda más profunda por si el input está dentro de shadowRoots
            for (const n of walkDeep(document, { maxNodes: 3000, maxDepth: 6 })) {
                try {
                    if (!n.querySelectorAll) continue;
                    el = n.querySelector(`input.slds-input[name="${START_DATE_NAME}"]`);
                    if (el) return el;
                } catch (_) {}
            }
            return null;
        }

        function writeDateTextValue(el, text) {
            try {
                if (!el) return false;
                if ((el.value || '') === text) return true;
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
                // limpia errores si es requerido
                try {
                    if (typeof el.setCustomValidity === 'function') el.setCustomValidity('');
                    if (typeof el.reportValidity === 'function') el.reportValidity();
                } catch (_) {}
                return true;
            } catch (e) {
                console.warn('[start_date] write error:', e);
                return false;
            }
        }

        function tryAutofillStartDate() {
            const el = findStartDateInput();
            if (!el) return false;

            // fecha de hoy en formato dd/mm/yyyy
            const d = new Date();
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            const todayES = `${dd}/${mm}/${yyyy}`;
            //const todayES = `${dd}-${mm}-${yyyy}`; //Otro formato de relleno de fecha.

            return writeDateTextValue(el, todayES);
        }



        // Lógica central: decide si autocompletar o limpiar en función del Nombre actual
        async function maybeHandleStartDateAfterNameChange(){
            if (ST.mode !== 'new') return;
            if (!_nameConfirmed) return;

            const el = findStartDateInput();
            if (!el) return;

            const current = (el.value || '').trim();
            const rule = getRuleForCurrentPrereqName();

            // 1) Si hay regla de cache para Start_date y el campo esta vacio -> usar cache
            if (rule && rule.start && rule.start.mode === 'cache') {
                if (!current) {
                    const cached = getCacheValueBySource(rule.start.source);

                    // Si no hay cache, no escribimos nada (y NO pasamos a "hoy", porque en estas reglas
                    // has pedido que NO se autorellene con hoy)
                    if (!cached) {
                        // opcional: si quieres limpiar expected auto cuando estas en estas reglas
                        clearExpectedIfAuto();
                        return;
                    }

                    // Normaliza formato esperado: tu cache ya viene como DD/MM/YYYY
                    // (si algun dia lo guardas distinto, aqui lo adaptas)
                    await delay(80);
                    const ok = writeDateTextValue(el, String(cached).trim());
                    if (ok) {
                        _startDateWasCache = true;
                        _startDateWasAuto = false;
                        _startDateAutofilledOnce = true;
                        // opcional: si quieres limpiar expected auto cuando estas en estas reglas
                        clearExpectedIfAuto();
                    }
                }
                return; // importante: no seguir con logica default
            }

            // 2) Logica default actual (todo lo demas)
            // Si venias de cache antes y ya no aplica, limpia solo si lo pusimos nosotros
            if (_startDateWasCache) {
                // Si el usuario ya puso algo manual encima, no tocamos
                if (!current) clearStartDateIfAuto();
            }

            // Si es una opcion "bloqueada" por reglas (en tu caso ya se gestiona arriba)
            if (shouldSkipStartDate()){
                clearStartDateIfAuto();
                clearExpectedIfAuto();
                return;
            }

            // Si esta vacio -> autocompleta hoy (una vez)
            if (!current && !_startDateAutofilledOnce){
                await delay(80);
                const ok = tryAutofillStartDate();
                _startDateAutofilledOnce = !!ok;
                _startDateWasAuto = !!ok;
                _startDateWasCache = false;
            }
        }



        // === Expected_date__c (Fecha prevista fin) ===
        const EXPECTED_DATE_NAME = 'Expected_date__c';

        // Festivos opcionales (Cataluña) en formato 'YYYY-MM-DD'.
        // Déjalo vacío o mantenlo tú a mano si quieres excluir festivos reales.
        const HOLIDAYS_CAT = new Set([
            // '2025-01-01', '2025-01-06', ...
        ]);

        let _expectedAutofilledOnce = false; // solo true si lo escribió el script
        let _expectedWasAuto = false; // recuerda si el valor actual lo puso el script


        function pad2(n){ return String(n).padStart(2,'0'); }

        function formatES(d){ // dd/mm/yyyy
            return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`;
        }

        function parseES(s){ // dd/mm/yyyy -> Date o null
            const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s||'').trim());
            if(!m) return null;
            const dd = +m[1], MM = +m[2]-1, yyyy = +m[3];
            const d = new Date(yyyy, MM, dd);
            return (d && d.getFullYear()===yyyy && d.getMonth()===MM && d.getDate()===dd) ? d : null;
        }

        function ymd(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

        function isWeekend(d){
            const w = d.getDay(); // 0 dom, 6 sáb
            return (w===0 || w===6);
        }

        function isHoliday(d){
            return HOLIDAYS_CAT.has(ymd(d));
        }

        function addBusinessDays(start, n){
            const out = new Date(start.getFullYear(), start.getMonth(), start.getDate());
            let added = 0;
            while(added < n){
                out.setDate(out.getDate() + 1);
                // Si quieres contar festivos oficiales: usa !isWeekend(out) && !isHoliday(out)
                if(!isWeekend(out) /* && !isHoliday(out) */){
                    added++;
                }
            }
            return out;
        }

        function findExpectedInput(){
            // primero intento rápido
            let el = document.querySelector(`input.slds-input[name="${EXPECTED_DATE_NAME}"]`);
            if (el) return el;
            // búsqueda profunda por shadow roots/iframes
            for (const n of walkDeep(document, { maxNodes: 3000, maxDepth: 6 })) {
                try{
                    if(!n.querySelectorAll) continue;
                    el = n.querySelector(`input.slds-input[name="${EXPECTED_DATE_NAME}"]`);
                    if(el) return el;
                }catch(_){}
            }
            return null;
        }

        function clearExpectedIfAuto(){
            try{
                const el = findExpectedInput();
                if(!el) return;
                if(_expectedWasAuto){
                    writeDateTextValue(el, '');
                    _expectedWasAuto = false;
                    _expectedAutofilledOnce = false;
                }
            }catch(_){}
        }


        function isEstudiName(){
            const v = (ST.lastTextName || '').trim().toUpperCase();
            // Acepta "ESTUDI - ..." con espacios variables
            return /^ESTUDI\s*-\s*/.test(v);
        }

        async function maybeHandleExpectedAfterNameChange(){
            if (ST.mode !== 'new') return;

            const el = findExpectedInput();
            if(!el) return;

            // Si ya hay valor manual, respetamos
            const current = (el.value || '').trim();
            if(current && !_expectedWasAuto) return;

            // Si el Nombre no es ESTUDI - XXX → limpiar si lo puso el script
            if (!isEstudiName()){
                clearExpectedIfAuto();
                return;
            }

            // Base: Start_date__c si existe y es válida; si no, hoy
            const startEl = findStartDateInput?.();
            const base =
                  (startEl && parseES(startEl.value || '')) ||
                  new Date();

            // Sumar 10 días laborables (lun-vie) para sumar dias en prerrequisito ESTUDI - XXX
            const target = addBusinessDays(base, 10);
            const txt = formatES(target);

            if (writeDateTextValue(el, txt)){
                _expectedAutofilledOnce = true;
                _expectedWasAuto = true;
            }
        }




        function resetFormState() {
            ST.tipo = null;
            ST.subtipo = null;
            ST.lastKeyName = null;
            ST.lastTextName = null;
            ST.lastKeyComm = null;
            ST.lastTextComm = null;
            ST.nameHost = null;
            ST.commHost = null;
            ST.tipoHost = null;
            ST.subtipoHost = null;
            ST.modalOpen = false;
            ST.choosing = false;
            ST.lockNameOnce = false;
            ST._lastHadRule = null;
            ST.noProcShownKey = null;
            ST.pickerEl = null; // por si acaso que actica choicemodal en otro sitio
            destroyPicker();
            document.getElementById('__af_modal_root__')?.remove();
            resetStartDateState(); // <- resetea banderas de fecha al cambiar de pantalla/estado
            _nameConfirmed = false; // <-- NUEVO
            _lastConfirmedName = null;



        }

        function install() {
            document.addEventListener('focusin', onFocusIn, true);
            document.addEventListener('change', onPickChange, true);
        }

        (function monitorNewPrereqPage(){
            let lastUrl = location.href;
            const CHECK_INTERVAL = 800;

            setInterval(() => {
                const href = location.href;
                if (href !== lastUrl) {
                    lastUrl = href;

                    // 1) Limpia solo estado interno (NO borra campos del form)
                    resetFormState();

                    // 2) Modo por URL
                    if (RX_NEW.test(href)) ST.mode = 'new';
                    else if (RX_EDIT.test(href)) ST.mode = 'edit';
                    else if (RX_VIEW.test(href)) ST.mode = 'view';
                    else ST.mode = 'view';
                    if (ST.mode === 'new') resetStartDateState();



                    // 3) Localiza hosts y decide si autocompletar
                    setTimeout(() => {
                        ST.nameHost = ST.nameHost || findHostByLabel(NAME_LABEL_RX, ['lightning-input','lightning-input-field']);
                        ST.commHost = ST.commHost || findHostByLabel(COMM_LABEL_RX, ['lightning-textarea','lightning-input-rich-text','lightning-input-field']);

                        const nameVal = (ST.nameHost && 'value' in ST.nameHost) ? (ST.nameHost.value || '').trim() : '';
                        const commVal = (ST.commHost && 'value' in ST.commHost) ? (ST.commHost.value || '').trim() : '';

                        // Política: en "nuevo" siempre; en "editar" solo si ambos están vacíos
                        if (ST.mode === 'new') {
                            ST.canAutofill = true;
                        } else if (ST.mode === 'edit') {
                            ST.canAutofill = (nameVal === '' && commVal === '');
                        } else {
                            ST.canAutofill = false;
                        }
                        // 4) Si procede, dispara cálculos (sin limpiar campos)
                        if (ST.canAutofill) {
                            applyName();
                            requestApplyComm();
                        }
                        // No autocompletar fecha al abrir: esperar a que se confirme el nombre
                        if (ST.mode === 'new' && _nameConfirmed) {
                            onPrereqNameConfirmedAndMaybeResetDates();

                            maybeHandleStartDateAfterNameChange();
                            maybeHandleExpectedAfterNameChange();
                        }


                    }, 400);
                }
            }, CHECK_INTERVAL);

        })();

        if (document.readyState === 'complete' || document.readyState === 'interactive') install();
        else document.addEventListener('DOMContentLoaded', install, { once:true });
    })();
})();
