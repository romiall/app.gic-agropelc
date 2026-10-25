/**
 * VÉRIFICATEUR WHATSAPP B2B — SCRIPT 1
 * GIC AGROPELC
 * Plage par défaut : Contacts 1 à 2 000 (Lots de 500 : 1-500, 501-1000, 1001-1500, 1501-2000)
 */
'use strict';
const { lancerWorker } = require('./verifier_worker_base.js');

lancerWorker({
    workerId: 1,
    segmentParDefaut: [0, 2000],
    lotParDefaut: 1
}).catch((err) => {
    console.error('[ERREUR CRITIQUE SCRIPT 1]', err);
    process.exit(1);
});
