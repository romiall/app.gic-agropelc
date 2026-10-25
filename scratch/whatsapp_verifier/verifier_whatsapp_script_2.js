/**
 * VÉRIFICATEUR WHATSAPP B2B — SCRIPT 2
 * GIC AGROPELC
 * Plage par défaut : Contacts 2 001 à 4 000 (Lots de 500 : 2001-2500, 2501-3000, 3001-3500, 3501-4000)
 */
'use strict';
const { lancerWorker } = require('./verifier_worker_base.js');

lancerWorker({
    workerId: 2,
    segmentParDefaut: [2000, 4000],
    lotParDefaut: 5
}).catch((err) => {
    console.error('[ERREUR CRITIQUE SCRIPT 2]', err);
    process.exit(1);
});
