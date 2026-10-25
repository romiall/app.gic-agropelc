/**
 * =====================================================================================
 * MOTEUR UNIFIÉ MULTI-WORKER WHATSAPP B2B (PAR LOTS DE 500) — GIC AGROPELC
 * =====================================================================================
 * Permet l'exécution parallèle de plusieurs scripts (Script 1, Script 2, Script 3, etc.)
 * chacun disposant de :
 * - Sa propre session WhatsApp isolée (.wwebjs_auth/session-script-X)
 * - Son propre fichier de verrouillage (.verrou_script_X.lock)
 * - Son propre journal de résultats (resultats_whatsapp_script_X.jsonl)
 * - Déduplication croisée dynamique (aucun numéro n'est retesté si un autre worker l'a fait)
 * - Synchronisation automatique vers le classeur Excel principal tous les 500 contacts
 * =====================================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Client, LocalAuth } = require('./node_modules/whatsapp-web.js');
const qrcode = require('./node_modules/qrcode-terminal');

const DIR = __dirname;
const FICHIER_NUMEROS = path.join(DIR, 'numeros_a_tester.csv');
const SYNC_SCRIPT = path.join(DIR, 'sync_whatsapp_to_excel.py');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const RYTHMES = {
    prudent: { min: 3.5, max: 7.0, pause100: 15, pauseLot500: 60 },
    normal:  { min: 1.8, max: 3.8, pause100: 10, pauseLot500: 45 },
    rapide:  { min: 1.2, max: 2.5, pause100: 8,  pauseLot500: 30 }
};

const COUL = {
    vert: '\x1b[32m',
    jaune: '\x1b[33m',
    rouge: '\x1b[31m',
    cyan: '\x1b[36m',
    mauve: '\x1b[35m',
    blanc: '\x1b[37m',
    gras: '\x1b[1m',
    gris: '\x1b[90m',
    fin: '\x1b[0m'
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hasard = (a, b) => a + Math.random() * (b - a);
const maintenant = () => new Date().toISOString();

function duree(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

// Lit TOUS les résultats existants dans TOUS les journaux JSONL et checkpoint pour déduplication universelle
function lireTousResultatsExistants() {
    const vus = new Map();
    try {
        const fichiers = fs.readdirSync(DIR);
        for (const f of fichiers) {
            if (f.startsWith('resultats_whatsapp') && f.endsWith('.jsonl')) {
                const complet = path.join(DIR, f);
                for (const l of fs.readFileSync(complet, 'utf8').split(/\r?\n/)) {
                    if (!l.trim()) continue;
                    try {
                        const o = JSON.parse(l);
                        if (o.numero && (o.statut === 'oui' || o.statut === 'non')) {
                            vus.set(String(o.numero).replace(/\D/g, ''), o.statut);
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    const checkpointPath = path.join(DIR, 'whatsapp_checkpoint.json');
    if (fs.existsSync(checkpointPath)) {
        try {
            const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
            for (const [k, v] of Object.entries(cp)) {
                const digits = k.replace(/\D/g, '');
                if (digits && v.status_str) {
                    vus.set(digits, v.status_str.includes('OUI') ? 'oui' : 'non');
                }
            }
        } catch (e) {}
    }
    return vus;
}

// Lit la liste complète des numéros du fichier CSV
function lireTousNumerosCSV() {
    if (!fs.existsSync(FICHIER_NUMEROS)) {
        console.error(`${COUL.rouge}[ERREUR] Fichier introuvable : ${FICHIER_NUMEROS}${COUL.fin}`);
        process.exit(4);
    }
    const lignes = fs.readFileSync(FICHIER_NUMEROS, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    const entete = lignes.shift().split(';').map((s) => s.trim());
    const idx = (nom) => entete.indexOf(nom);
    const out = [];
    for (const l of lignes) {
        const c = l.split(';');
        const numero = (c[idx('numero')] || '').replace(/\D/g, '');
        if (numero.length < 8) continue;
        out.push({
            numero,
            pays: c[idx('pays')] || '',
            type: c[idx('type')] || 'mobile',
            operateur: c[idx('operateur')] || '',
            priorite: parseInt(c[idx('priorite')] || '9', 10),
            entreprise: c[idx('entreprise')] || '',
            nbEntreprises: parseInt(c[idx('nb_entreprises')] || '1', 10),
        });
    }
    return out;
}

// Déclenche la synchronisation Excel en toute sécurité avec retry
function declencherSyncExcel() {
    if (fs.existsSync(SYNC_SCRIPT)) {
        try {
            console.log(`\n${COUL.cyan}   [SYNC EXCEL] Synchronisation des validations vers le classeur principal...${COUL.fin}`);
            execFileSync('python', [SYNC_SCRIPT], { stdio: 'inherit' });
        } catch (e) {
            console.log(`${COUL.jaune}   [NOTE SYNC] La synchronisation sera reprise au prochain lot (${e.message}).${COUL.fin}`);
        }
    }
}

async function lancerWorker({ workerId, segmentParDefaut, lotParDefaut }) {
    const FICHIER_RESULTATS = path.join(DIR, `resultats_whatsapp_script_${workerId}.jsonl`);
    const FICHIER_JOURNAL = path.join(DIR, `journal_whatsapp_script_${workerId}.log`);
    const FICHIER_VERROU = path.join(DIR, `.verrou_script_${workerId}.lock`);

    const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
    }));

    const RYTHME_NOM = RYTHMES[ARGS.rythme] ? ARGS.rythme : 'normal';
    const RYTHME = RYTHMES[RYTHME_NOM];
    const SANS_FIXES = ARGS['avec-fixes'] ? false : true; // par défaut sans les fixes
    const ESSAI = Boolean(ARGS.essai);
    const VISIBLE = Boolean(ARGS.visible);
    const TAILLE_LOT = parseInt(ARGS.taille || '500', 10) || 500;

    console.log(`\n${COUL.gras}=====================================================================${COUL.fin}`);
    console.log(`${COUL.gras}${COUL.cyan}   VÉRIFICATEUR WHATSAPP B2B — SCRIPT ${workerId} (LOTS DE ${TAILLE_LOT}) - GIC AGROPELC${COUL.fin}`);
    console.log(`${COUL.gras}=====================================================================${COUL.fin}`);

    // Vérification du verrou d'instance pour ce worker
    if (fs.existsSync(FICHIER_VERROU)) {
        const pid = parseInt(fs.readFileSync(FICHIER_VERROU, 'utf8'), 10);
        let vivant = false;
        try { if (pid) { process.kill(pid, 0); vivant = true; } } catch (e) { vivant = false; }
        if (vivant && pid !== process.pid) {
            console.error(`${COUL.rouge}[ARRÊT] Le Script ${workerId} tourne déjà dans un autre terminal (PID ${pid}).${COUL.fin}`);
            console.error(`Pour lancer une autre tranche, ouvrez un autre script (Script 2, Script 3, etc.).`);
            process.exit(4);
        }
    }

    // Si Worker 1 : vérifier si le processus maître PID 30504 ou verifier_whatsapp_complet tourne déjà
    if (workerId === 1) {
        const ancienVerrou = path.join(DIR, '.verification_en_cours.lock');
        if (fs.existsSync(ancienVerrou)) {
            const pid = parseInt(fs.readFileSync(ancienVerrou, 'utf8'), 10);
            let vivant = false;
            try { if (pid) { process.kill(pid, 0); vivant = true; } } catch (e) { vivant = false; }
            if (vivant && pid !== process.pid) {
                console.log(`${COUL.jaune}[INFO SCRIPT 1] Le script principal de base est déjà actif (PID ${pid}) et valide les numéros.${COUL.fin}`);
                console.log(`${COUL.vert}Pour faire tourner en parallèle, lancez plutôt LANCER_SCRIPT_2.bat ou LANCER_SCRIPT_3.bat dans un nouvel onglet !${COUL.fin}`);
                process.exit(0);
            }
        }
    }

    fs.writeFileSync(FICHIER_VERROU, String(process.pid), 'utf8');
    const leverVerrou = () => {
        try { if (fs.existsSync(FICHIER_VERROU)) fs.unlinkSync(FICHIER_VERROU); } catch (e) {}
    };
    process.on('SIGINT', () => {
        console.log(`\n${COUL.jaune}[ARRÊT DEMANDÉ - SCRIPT ${workerId}] Fermeture et synchronisation Excel finale...${COUL.fin}`);
        declencherSyncExcel();
        leverVerrou();
        process.exit(0);
    });

    // 1. Lecture de tous les numéros et filtrage des mobiles
    const tousNumeros = lireTousNumerosCSV();
    const mobilesUniquement = SANS_FIXES ? tousNumeros.filter((n) => n.type === 'mobile') : tousNumeros;
    const totalMobiles = mobilesUniquement.length;

    // 2. Détermination de la plage attribuée à ce Worker
    let debut = segmentParDefaut[0];
    let fin = Math.min(segmentParDefaut[1], totalMobiles);

    if (ARGS.lot) {
        const lotNum = parseInt(ARGS.lot, 10);
        debut = (lotNum - 1) * TAILLE_LOT;
        fin = Math.min(debut + TAILLE_LOT, totalMobiles);
        console.log(`[LOT SPÉCIFIÉ] Lot ${lotNum} : Contacts ${debut + 1} à ${fin}`);
    } else if (ARGS.debut) {
        debut = parseInt(ARGS.debut, 10);
        fin = Math.min(debut + TAILLE_LOT, totalMobiles);
        console.log(`[PLAGE PERSONNALISÉE] Contacts ${debut + 1} à ${fin}`);
    } else {
        console.log(`[SEGMENT ATTRIBUÉ] Contacts ${debut + 1} à ${fin} (sur ${totalMobiles} mobiles au total)`);
    }

    const segmentCandidats = mobilesUniquement.slice(debut, fin);

    // 3. Déduplication croisée immédiate
    const dejaQualifies = lireTousResultatsExistants();
    const aTraiter = segmentCandidats.filter((n) => !dejaQualifies.has(n.numero));

    console.log(`Contacts totaux dans ce segment      : ${segmentCandidats.length}`);
    console.log(`Déjà qualifiés (par d'autres workers) : ${segmentCandidats.length - aTraiter.length}`);
    console.log(`À traiter maintenant dans ce worker   : ${COUL.vert}${aTraiter.length}${COUL.fin}`);
    console.log(`Session WhatsApp dédiée             : ${COUL.blanc}.wwebjs_auth/session-script-${workerId}${COUL.fin}`);
    console.log(`Fichier de résultat dédié            : ${COUL.gris}${path.basename(FICHIER_RESULTATS)}${COUL.fin}`);
    console.log(`---------------------------------------------------------------------`);

    if (ESSAI) {
        console.log(`${COUL.jaune}[MODE ESSAI] Diagnostic réussi. Aucune connexion WhatsApp établie.${COUL.fin}`);
        leverVerrou();
        return;
    }

    if (aTraiter.length === 0) {
        console.log(`${COUL.vert}[SUCCÈS] Tous les contacts de ce segment sont déjà qualifiés !${COUL.fin}`);
        leverVerrou();
        return;
    }

    // 4. Initialisation du client WhatsApp pour ce Worker
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(DIR, '.wwebjs_auth'),
            clientId: `script-${workerId}`
        }),
        authTimeoutMs: 180000,
        qrMaxRetries: 0,
        puppeteer: {
            executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
            headless: !VISIBLE,
            protocolTimeout: 180000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu']
        }
    });

    client.on('qr', (qr) => {
        console.log(`\n${COUL.jaune}[ACTION REQUISE - SCRIPT ${workerId}] Scannez ce QR Code avec WhatsApp sur votre téléphone :${COUL.fin}`);
        console.log(`${COUL.gris}(Dans WhatsApp mobile : Réglages > Appareils connectés > Connecter un appareil)${COUL.fin}\n`);
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => console.log(`${COUL.vert}[SCRIPT ${workerId}] Authentification réussie !${COUL.fin}`));
    client.on('auth_failure', (m) => console.error(`${COUL.rouge}[SCRIPT ${workerId}] Échec authentification : ${m}${COUL.fin}`));
    client.on('disconnected', (r) => {
        console.log(`${COUL.jaune}[SCRIPT ${workerId}] Déconnecté (${r}).${COUL.fin}`);
        declencherSyncExcel();
        leverVerrou();
        process.exit(0);
    });

    let resoudrePret;
    const pretPromise = new Promise((r) => { resoudrePret = r; });
    client.on('ready', () => {
        console.log(`${COUL.vert}[SCRIPT ${workerId}] Session WhatsApp connectée et prête ! Démarrage du traitement...${COUL.fin}\n`);
        resoudrePret();
    });

    await client.initialize();
    await pretPromise;

    // 5. Boucle de validation par lots de 500
    let traites = 0;
    let waOui = 0;
    let waNon = 0;
    const tDebut = Date.now();
    let numDansLotActuel = 0;
    let numeroLotCourant = 1;

    for (let i = 0; i < aTraiter.length; i++) {
        const item = aTraiter[i];
        const numDigits = item.numero;

        // Revérification dynamique : un autre worker l'a-t-il validé pendant notre boucle ?
        const liveVus = lireTousResultatsExistants();
        if (liveVus.has(numDigits)) {
            console.log(`[SCRIPT ${workerId}] ${item.numero} (${item.entreprise.slice(0, 24)}) : ${COUL.gris}déjà validé par un autre worker (ignoré)${COUL.fin}`);
            continue;
        }

        // Interrogation native du protocole WhatsApp
        let existe = false;
        let wid = null;
        const t0 = Date.now();

        try {
            const resp = await client.getNumberId(numDigits);
            if (resp && resp._serialized) {
                existe = true;
                wid = resp._serialized;
            }
        } catch (err) {
            // Tentative de reprise sur coupure réseau brève
            try {
                await dormir(2000);
                const resp = await client.getNumberId(numDigits);
                if (resp && resp._serialized) {
                    existe = true;
                    wid = resp._serialized;
                }
            } catch (e2) {
                existe = false;
            }
        }

        const ms = Date.now() - t0;
        traites++;
        numDansLotActuel++;

        if (existe) {
            waOui++;
            console.log(`[S${workerId} | Lot ${numeroLotCourant} | ${traites}/${aTraiter.length}] +${numDigits} ${COUL.gris}${item.pays}${COUL.fin} : ${COUL.vert}WA : OUI${COUL.fin} (${item.entreprise.slice(0, 28)})`);
        } else {
            waNon++;
            console.log(`[S${workerId} | Lot ${numeroLotCourant} | ${traites}/${aTraiter.length}] +${numDigits} ${COUL.gris}${item.pays}${COUL.fin} : ${COUL.jaune}non${COUL.fin} (${item.entreprise.slice(0, 28)})`);
        }

        // Écriture immédiate dans le journal JSONL de ce worker
        const resObj = {
            numero: numDigits,
            statut: existe ? 'oui' : 'non',
            wid: wid,
            pays: item.pays,
            type: item.type,
            entreprise: item.entreprise,
            teste_le: maintenant(),
            worker: workerId,
            duree_ms: ms
        };
        fs.appendFileSync(FICHIER_RESULTATS, JSON.stringify(resObj) + '\n', 'utf8');

        // Pause anti-bannissement de 10s tous les 100 numéros
        if (traites % 100 === 0 && i < aTraiter.length - 1 && numDansLotActuel < TAILLE_LOT) {
            console.log(`\n${COUL.cyan}   [PALIER 100] Pause de sécurité de 10 secondes (Script ${workerId} : ${waOui} OUI / ${waNon} NON)...${COUL.fin}`);
            await dormir(10000);
        }

        // FIN DU LOT DE 500 : Synchronisation Excel automatique + Pause de respiration
        if (numDansLotActuel >= TAILLE_LOT || i === aTraiter.length - 1) {
            console.log(`\n${COUL.mauve}=====================================================================${COUL.fin}`);
            console.log(`${COUL.mauve}[FIN DU LOT ${numeroLotCourant} DE ${TAILLE_LOT}] ${traites} vérifiés au total (${waOui} OUI / ${waNon} NON)${COUL.fin}`);
            console.log(`${COUL.mauve}=====================================================================${COUL.fin}`);

            declencherSyncExcel();

            if (i < aTraiter.length - 1) {
                console.log(`${COUL.cyan}Pause de respiration anti-ban de ${RYTHME.pauseLot500}s avant le lot ${numeroLotCourant + 1}...${COUL.fin}\n`);
                await dormir(RYTHME.pauseLot500 * 1000);
                numeroLotCourant++;
                numDansLotActuel = 0;
            }
        } else {
            // Pacing normal aléatoire entre chaque numéro
            await dormir(hasard(RYTHME.min, RYTHME.max) * 1000);
        }
    }

    console.log(`\n${COUL.vert}=====================================================================${COUL.fin}`);
    console.log(`${COUL.vert}TRAITEMENT SCRIPT ${workerId} TERMINÉ : ${traites} vérifiés (WA OUI : ${waOui} | NON : ${waNon})${COUL.fin}`);
    console.log(`${COUL.vert}=====================================================================${COUL.fin}\n`);

    declencherSyncExcel();
    leverVerrou();
    try { await client.destroy(); } catch (e) {}
    process.exit(0);
}

module.exports = { lancerWorker };
