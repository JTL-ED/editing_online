// ==UserScript==
// @name         Control Plazos - Fecha real fin + Fecha aceptacion
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
    // MODULO 3: UI Create Prerrequisito
    // (popover debajo del input + rellenar fecha inicio)
    // ----------------------------------------
    (function () {
        "use strict";

        const MODAL_ID = "cp_fecha_picker_modal";
        let suppressNextOpen = false;

        // URL Create (cmp)
        const RX_NEW = /\/lightning\/cmp\/c__nnssCreatePrerequisito(?:\?|$)/i;

        function isCreateUrl() {
            return RX_NEW.test(location.pathname);
        }

        // === Helpers de "Fecha de inicio" ===
        const START_DATE_NAME = "Start_date__c";

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

        function findStartDateInput() {
            // 1) directo por name
            let el = document.querySelector(`input.slds-input[name="${START_DATE_NAME}"]`);
            if (el) return el;

            // 2) deep (shadow roots)
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
                console.warn("[start_date] write error:", e);
                return false;
            }
        }

        // Estado UI
        // Estado UI
        let pickerOpen = false;
        let panelEl = null;
        let activeInputEl = null; // NUEVO: input que disparo el popover

function closePickerModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
    panelEl = null;
    activeInputEl = null; // NUEVO
}





        function buildPopover(anchorRect) {
            const wrap = document.createElement("div");
            wrap.id = MODAL_ID;

            // contenedor fijo, sin backdrop
            wrap.style.position = "fixed";
            wrap.style.zIndex = "999999";
            wrap.style.left = "0";
            wrap.style.top = "0";
            wrap.style.width = "0";
            wrap.style.height = "0";

            // Panel blanco (estilo Salesforce)
            const panel = document.createElement("div");
            panel.style.position = "fixed";
            panel.style.background = "#fff";
            panel.style.border = "1px solid rgba(0,0,0,0.12)";
            panel.style.borderRadius = "12px";                // AJUSTE: radio de borde (mas pequeño = mas compacto)
            panel.style.boxShadow = "0 12px 35px rgba(0,0,0,0.18)";
            panel.style.padding = "8px";                      // AJUSTE: padding general del panel (reduce tamaño visual)
            panel.style.display = "flex";
            panel.style.gap = "10px";                         // AJUSTE: separación entre columnas (reduce/incrementa)
            panel.style.alignItems = "flex-start";

            // ancho: parecido al ejemplo (panel con scroll interno)
            const minW = 320;                                 // AJUSTE: ancho mínimo del popover
            const maxW = 480;                                 // AJUSTE: ancho máximo del popover
            const extraW = 0;                                 // AJUSTE: extra respecto al input (0 = casi igual que input)
            const desiredW = Math.max(minW, Math.min(maxW, anchorRect.width + extraW));
            panel.style.width = desiredW + "px";

            // posicion: debajo del input
            const offset = 6;                                 // AJUSTE: distancia vertical debajo del input
            let top = anchorRect.bottom + offset;
            let left = anchorRect.left;

            // evitar salirse por la derecha
            if (left + desiredW > window.innerWidth - 8) {
                left = Math.max(8, window.innerWidth - desiredW - 8);
            }

            // alto maximo + scroll (como tu ejemplo)
            const maxH = 220;                                 // AJUSTE: altura máxima del popover (mas pequeño = menos “modal”)
            const maxHReal = Math.min(maxH, window.innerHeight - top - 10);
            panel.style.maxHeight = maxHReal + "px";
            panel.style.overflow = "hidden";                  // el scroll lo hara la columna derecha

            // si no cabe abajo, sube arriba
            if (maxHReal < 140) {                              // AJUSTE: umbral para decidir “subir arriba”
                const upH = 200;                               // AJUSTE: cuanto sube si no cabe abajo
                top = Math.max(8, anchorRect.top - offset - upH);
            }

            panel.style.left = Math.round(left) + "px";
            panel.style.top = Math.round(top) + "px";

            // Columna izquierda: titulo
            const leftCol = document.createElement("div");
            leftCol.style.minWidth = "120px";                 // AJUSTE: ancho mínimo de la columna izquierda
            leftCol.style.maxWidth = "140px";                 // AJUSTE: ancho máximo de la columna izquierda
            leftCol.style.fontSize = "13px";                  // AJUSTE: tamaño de texto de la columna izquierda
            leftCol.style.color = "#2e2e2e";
            leftCol.style.lineHeight = "1.2";

            const title = document.createElement("div");
            title.innerHTML = 'Selección&nbsp;de<br>fecha:';
            //title.innerHTML = 'Selección&nbsp;del<br>Pre-requisito:';
            title.style.fontWeight = "600";
            title.style.marginTop = "2px";

            leftCol.appendChild(title);

            // Columna derecha: grid con scroll interno
            const rightCol = document.createElement("div");
            rightCol.style.flex = "1";
            rightCol.style.maxHeight = (maxHReal - 6) + "px";  // AJUSTE: altura interna para el scroll de la lista
            rightCol.style.overflow = "auto";
            rightCol.style.paddingRight = "4px";               // AJUSTE: margen derecho para scrollbar

            const grid = document.createElement("div");
            grid.style.display = "grid";
            grid.style.gridTemplateColumns = "repeat(2, minmax(130px, 1fr))"; // AJUSTE: tamaño mínimo de cada “tile”
            grid.style.gap = "8px";                            // AJUSTE: separación entre tiles

            function mkTile(text) {
                const b = document.createElement("button");
                b.type = "button";
                b.textContent = text;
                b.style.background = "#f7f8fb";
                b.style.border = "1px solid rgba(0,0,0,0.14)";
                b.style.borderRadius = "12px";                 // AJUSTE: radio de cada botón
                b.style.padding = "8px 10px";                  // AJUSTE: padding del botón (reduce altura/ancho visual)
                b.style.cursor = "pointer";
                b.style.fontSize = "12px";                     // AJUSTE: tamaño de letra del botón
                b.style.color = "#2e2e2e";
                b.style.textAlign = "center";
                b.style.whiteSpace = "nowrap";
                b.style.overflow = "hidden";
                b.style.textOverflow = "ellipsis";
                b.onmouseenter = () => (b.style.background = "#eef2ff");
                b.onmouseleave = () => (b.style.background = "#f7f8fb");
                return b;
            }

            // Botones (los mismos ids logicos que ya usas)
            const bAceptacion = mkTile("Fecha de Aceptación");
            const bFinal = mkTile("Fecha Último cierre PRE");
            const bCancel = mkTile("Cancelar");

            grid.appendChild(bAceptacion);
            grid.appendChild(bFinal);

            // AJUSTE: si quieres que "Cancelar" ocupe todo el ancho (como el selector nativo), descomenta estas 2 lineas:
            bCancel.style.gridColumn = "1 / -1";               // AJUSTE: hace que Cancelar sea una fila completa
            // bCancel.style.textAlign = "center";             // AJUSTE: centrar el texto (ya esta centrado)

            grid.appendChild(bCancel);

            rightCol.appendChild(grid);

            panel.appendChild(leftCol);
            panel.appendChild(rightCol);

            wrap.appendChild(panel);

            return { wrap, panel, bAceptacion, bFinal, bCancel };
        }



        function cleanup() {
            document.removeEventListener("mousedown", onDocClick, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", onReflow, true);
            window.removeEventListener("resize", onReflow, true);
            setTimeout(() => { suppressNextOpen = false; }, 0);
            closePickerModal();
        }

function onDocClick(ev) {
    const t = ev.target;

    // Si el click es dentro del panel, no cerrar
    if (panelEl && panelEl.contains(t)) return;

    // Si el click es en el input que abrio el popover (o dentro de el), no cerrar
    if (activeInputEl) {
        try {
            const p = ev.composedPath ? ev.composedPath() : null;
            if (p && p.includes(activeInputEl)) return;
        } catch (_) {}

        if (t === activeInputEl) return;
        if (activeInputEl.contains && activeInputEl.contains(t)) return;
    }

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


        function showPickerModalForInput(inputEl) {
            if (!inputEl) return;
            if (pickerOpen) return;

            pickerOpen = true;
            activeInputEl = inputEl; // NUEVO

            closePickerModal();

            const rect = inputEl.getBoundingClientRect();
            const built = buildPopover(rect);

            panelEl = built.panel;

            const { wrap, bAceptacion, bFinal, bCancel } = built;

            // listeners solo mientras esta abierto
            document.addEventListener("mousedown", onDocClick, true);
            document.addEventListener("keydown", onKey, true);
            window.addEventListener("scroll", onReflow, true);
            window.addEventListener("resize", onReflow, true);

            bCancel.addEventListener("click", () => {
                pickerOpen = false;
                cleanup();
            });

            bAceptacion.addEventListener("click", () => {
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

            bFinal.addEventListener("click", () => {
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

            document.body.appendChild(wrap);

            // opcional: foco para que ESC funcione sin click previo
            //wrap.tabIndex = -1;
            //wrap.focus();
        }

        function pathHas(el, ev) {
            try {
                const p = ev.composedPath ? ev.composedPath() : null;
                if (p && p.length) return p.includes(el);
            } catch (_) {}
            return false;
        }

        // Abrir al enfocar el campo en CREATE
        document.addEventListener("focusin", (ev) => {
            if (!isCreateUrl()) return;

            const input = findStartDateInput();
            if (!input) return;

            if (suppressNextOpen) {
                suppressNextOpen = false; // solo bloquea UNA vez
                return;
            }

            const t = ev.target;

            const hit =
                  (t === input) ||
                  pathHas(input, ev) || // importante para shadow DOM
                  (t && t.closest && t.closest(`input[name="${START_DATE_NAME}"]`) === input) || // click/focus en wrapper cercano
                  (input.contains && input.contains(t)); // deja esto como ultimo fallback

            if (!hit) return;


            setTimeout(() => showPickerModalForInput(input), 0);
        }, true);

    })();


})();
