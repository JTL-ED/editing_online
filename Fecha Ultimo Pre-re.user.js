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

// Lee la ultima Fecha real fin (max) en la tabla de Pre-requisitos y la guarda en cache.
// Requiere: tu sistema de cache ST / localStorage (ajusta setCache/getCache segun tu script).

function parseDateES(ddmmyyyy) {
  // acepta "18/09/2024" o "3/10/2025"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((ddmmyyyy || "").trim());
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const y = parseInt(m[3], 10);
  const dt = new Date(y, mo, d);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function formatDateES(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const yy = dateObj.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function getCacheKeyForRealEndDate() {
  // Si tu script ya tiene un "expedienteId" o algo similar, usa eso.
  // Aqui hago una clave por URL base (sin query) para que funcione en console tabs.
  const url = location.href.split("?")[0].split("#")[0];
  return `plazos:lastRealEndDate:${url}`;
}

function setCacheValue(key, value) {
  // Ajusta esto a tu cache real (ST.* o localStorage).
  // Yo uso localStorage por defecto.
  try { localStorage.setItem(key, value); } catch (e) {}
}

function getLastRealEndDateFromPrereqTable() {
  // Columna de "Fecha real fin" en tu HTML
  const cells = document.querySelectorAll('td[data-col-key-value^="Real_end_date__c-"], td[data-col-key-value*="Real_end_date__c"]');
  if (!cells || cells.length === 0) return null;

  let maxDt = null;

  cells.forEach(td => {
    const el = td.querySelector("lightning-formatted-date-time");
    const txt = (el ? el.textContent : td.textContent || "").trim();
    if (!txt) return; // vacio = sin fecha real fin
    const dt = parseDateES(txt);
    if (!dt) return;
    if (!maxDt || dt.getTime() > maxDt.getTime()) maxDt = dt;
  });

  return maxDt;
}

function updateCacheLastRealEndDate() {
  const dt = getLastRealEndDateFromPrereqTable();
  if (!dt) return false;

  const key = getCacheKeyForRealEndDate();
  const val = formatDateES(dt);
  setCacheValue(key, val);

  console.log(`[Plazos] Cache guardada: ${key} = ${val}`);
  return true;
}

// Llamalo cuando detectes que estas en la related list de Pre-requisitos,
// o despues de que tu observer detecte cambios de tabla.
updateCacheLastRealEndDate();
