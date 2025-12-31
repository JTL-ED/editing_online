// ==UserScript==
// @name         NNSS - Ultima fecha de Prerrequisito
//nota           cache persistente
// @namespace    sf-control-plazos
// @version      1.0.0
// @description  Detecta y guarda en cache la ultima fecha real fin del ultimo Prerrequisito. Compatible con Lightning Console.
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    const STORAGE_KEY = "NNSS_LAST_PREREQUISITO_DATE";
    const TARGET_COLUMN_LABEL = "Fecha real fin"; // ajusta si el texto exacto cambia
    const LOG_PREFIX = "[Ultimo Prerrequisito]";

    let lastProcessedUrl = location.href;
    let debounceTimer = null;

    function log(msg) {
        console.log(`${LOG_PREFIX} ${msg}`);
    }

    function parseDate(text) {
        // Espera formato dd/mm/yyyy
        const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return null;
        return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
    }

    function saveIfNewer(date) {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored || new Date(stored) < date) {
            localStorage.setItem(STORAGE_KEY, date.toISOString());
            log(`Fecha guardada: ${date.toLocaleDateString("es-ES")}`);
        }
    }

    function scanPrerequisitoTable() {
        const tables = document.querySelectorAll("table");
        if (!tables.length) return;

        tables.forEach(table => {
            const headers = Array.from(table.querySelectorAll("th"))
                .map(th => th.innerText.trim());

            const colIndex = headers.findIndex(h => h.includes(TARGET_COLUMN_LABEL));
            if (colIndex === -1) return;

            const rows = table.querySelectorAll("tbody tr");
            rows.forEach(row => {
                const cell = row.children[colIndex];
                if (!cell) return;

                const text = cell.innerText.trim();
                const date = parseDate(text);
                if (date) saveIfNewer(date);
            });
        });
    }

    function runScanDebounced() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scanPrerequisitoTable, 300);
    }

    // Detectar cambios de DOM
    const observer = new MutationObserver(runScanDebounced);
    observer.observe(document.body, { childList: true, subtree: true });

    // Detectar cambio de URL (Lightning Console)
    setInterval(() => {
        if (location.href !== lastProcessedUrl) {
            lastProcessedUrl = location.href;
            log("Cambio de URL detectado");
            runScanDebounced();
        }
    }, 500);

    // Log inicial
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
        log(`Fecha en cache: ${new Date(cached).toLocaleDateString("es-ES")}`);
    } else {
        log("Sin fecha en cache");
    }
})();
