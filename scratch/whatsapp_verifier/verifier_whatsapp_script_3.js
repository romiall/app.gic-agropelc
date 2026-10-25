/**
 * VÉRIFICATEUR WHATSAPP B2B — SCRIPT 3
 * GIC AGROPELC
 * Plage par défaut : Contacts 4 001 à 6 000 (Lots de 500 : 4001-4500, 4501-5000, 5001-5500, 5501-6000)
 */
'use strict';
const { lancerWorker } = require('./verifier_worker_base.js');

lancerWorker({
    workerId: 3,
    segmentParDefaut: [4000, 6000],
    lotParDefaut: 9
}).catch((err) => {
    console.error('[ERREUR CRITIQUE SCRIPT 3]', err);
    process.exit(1);
});
