/**
 * VÉRIFICATEUR WHATSAPP B2B — SCRIPT 4
 * GIC AGROPELC
 * Plage par défaut : Contacts 6 001 à 8 126 (Lots de 500 : 6001-6500, 6501-7000, 7001-7500, 7501-8000, 8001-8126)
 */
'use strict';
const { lancerWorker } = require('./verifier_worker_base.js');

lancerWorker({
    workerId: 4,
    segmentParDefaut: [6000, 8126],
    lotParDefaut: 13
}).catch((err) => {
    console.error('[ERREUR CRITIQUE SCRIPT 4]', err);
    process.exit(1);
});
