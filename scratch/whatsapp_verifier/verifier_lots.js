/**
 * ===================================================================================
 * VÉRIFICATEUR WHATSAPP B2B HAUT DÉBIT INTÉGRAL (8000+ CONTACTS) - GIC AGROPELC
 * ===================================================================================
 * - Utilise la méthode native du protocole WhatsApp : client.isRegisteredUser()
 * - Ne charge aucune discussion, ne clique sur rien, n'envoie AUCUN message
 * - S'appuie sur la session locale déjà enregistrée (.wwebjs_auth)
 * - Filtre automatiquement les lignes fixes (Camtel +237 2..., Gabon 01/11, etc.)
 * - Teste automatiquement le Téléphone Secondaire mobile si le Principal n'est pas sur WA
 * - Pauses anti-bannissement intelligentes (par numéro, par 100 et par 1000)
 * - Sauvegarde instantanée par checkpoint JSON + synchronisation Excel openpyxl (sans perte de style)
 * ===================================================================================
 */

const { Client, LocalAuth } = require('./node_modules/whatsapp-web.js');
const qrcode = require('./node_modules/qrcode-terminal');
const XLSX = require('./node_modules/xlsx');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const EXCEL_PATH = path.resolve(__dirname, '../../BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx');
const CHECKPOINT_PATH = path.resolve(__dirname, 'whatsapp_checkpoint.json');
const SYNC_SCRIPT = path.resolve(__dirname, 'sync_whatsapp_to_excel.py');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

process.on('unhandledRejection', () => {});
process.on('uncaughtException', (err) => {
    console.log('\n\x1b[33m[NOTE SYSTÈME]\x1b[0m Incident capturé :', err.message);
});

// Par défaut : traitement intégral (8500 contacts) ou par grands lots (--lot=2000)
const args = process.argv.slice(2);
let TAILLE_LOT = 8500;
let FILTRE_PAYS = null;

args.forEach(arg => {
    if (arg.startsWith('--lot=')) {
        TAILLE_LOT = parseInt(arg.split('=')[1], 10) || 8500;
    }
    if (arg.startsWith('--pays=')) {
        FILTRE_PAYS = arg.split('=')[1].trim().toLowerCase();
    }
});

console.log("=================================================================");
console.log("   VÉRIFICATEUR WHATSAPP B2B GRANDS LOTS (8000+) - GIC AGROPELC");
console.log("=================================================================");
console.log(`Fichier cible : ${EXCEL_PATH}`);
console.log(`Capacité du lot configurée : ${TAILLE_LOT} contacts`);
if (FILTRE_PAYS) console.log(`Filtre pays : ${FILTRE_PAYS}`);
console.log("-----------------------------------------------------------------");

let checkpoint = {};
if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
        checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    } catch (e) {
        checkpoint = {};
    }
}

function sauvegarderCheckpoint(syncExcel = false) {
    try {
        fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2), 'utf8');
        if (syncExcel && fs.existsSync(SYNC_SCRIPT)) {
            execFileSync('python', [SYNC_SCRIPT], { stdio: 'inherit' });
        }
    } catch (e) {
        console.error('[ERREUR SAUVEGARDE] :', e.message);
    }
}

process.on('SIGINT', () => {
    console.log('\n[INTERRUPTION] Sauvegarde et synchronisation Excel en cours...');
    sauvegarderCheckpoint(true);
    process.exit(0);
});

function estLigneFixe(digits) {
    if (!digits || digits.length < 8) return true;
    if (digits.startsWith('237')) return digits.slice(3).startsWith('2');
    if (digits.startsWith('241')) {
        const sub = digits.slice(3);
        return sub.startsWith('01') || sub.startsWith('11') || sub.startsWith('011');
    }
    if (digits.startsWith('242')) return digits.slice(3).startsWith('22');
    if (digits.startsWith('240')) {
        const sub = digits.slice(3);
        return sub.startsWith('333') || sub.startsWith('350') || sub.startsWith('33');
    }
    if (digits.startsWith('235')) return digits.slice(3).startsWith('22');
    if (digits.startsWith('236')) return digits.slice(3).startsWith('21');
    return false;
}

function extraireMobiles(str) {
    if (!str) return [];
    const parts = String(str).split(/[|;,\/]+/);
    const mobiles = [];
    for (const p of parts) {
        const d = p.replace(/\D/g, '');
        if (d.length >= 8 && !estLigneFixe(d) && !mobiles.includes(d)) {
            mobiles.push(d);
        }
    }
    return mobiles;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.resolve(__dirname, '.wwebjs_auth') }),
    puppeteer: {
        executablePath: fs.existsSync(EDGE_PATH) ? EDGE_PATH : undefined,
        headless: true,
        protocolTimeout: 120000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log("\n[ACTION REQUISE] Scannez ce QR Code avec votre WhatsApp (si la session a expiré) :\n");
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log("\n[SUCCÈS] Session WhatsApp Web connectée et opérationnelle !");
    console.log("Démarrage du contrôle continu des numéros mobiles (reprise automatique)...\n");
    await executerVerification();
});

client.on('auth_failure', (msg) => {
    console.error('\n[ERREUR] Échec de l\'authentification :', msg);
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('\n[INFO] Session WhatsApp déconnectée :', reason);
    sauvegarderCheckpoint(true);
    process.exit(0);
});

client.initialize().catch(err => {
    console.error('[ERREUR INITIALISATION] :', err.message);
});

async function verifierAvecRecuperation(digits) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const numberId = `${digits}@c.us`;
            return await client.isRegisteredUser(numberId);
        } catch (err) {
            if (attempt < 3) {
                process.stdout.write(`[Reconnexion ${attempt}/2...] `);
                await new Promise(r => setTimeout(r, 3000));
                try {
                    if (client.pupPage) {
                        await client.pupPage.evaluate(() => typeof window.Store !== 'undefined');
                    }
                } catch (e) {}
            } else {
                throw err;
            }
        }
    }
    return false;
}

async function executerVerification() {
    if (!fs.existsSync(EXCEL_PATH)) {
        console.error(`[ERREUR] Le classeur Excel n'existe pas : ${EXCEL_PATH}`);
        client.destroy();
        return;
    }

    const workbook = XLSX.readFile(EXCEL_PATH);
    const worksheet = workbook.Sheets['Base Contacts'];
    if (!worksheet) {
        console.error(`[ERREUR] Onglet 'Base Contacts' introuvable.`);
        client.destroy();
        return;
    }

    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    const aTraiter = [];
    let fixesIgnores = 0;
    let dejaQualifies = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const recId = String(row['ID'] || '').trim();
        const telPrincipal = String(row['Téléphone Principal (E.164)'] || '').trim();
        const telSecondaire = String(row['Téléphone Secondaire'] || '').trim();
        const autresNums = String(row['Autres numéros confirmés'] || '').trim();
        const waActuel = String(row['Autre Téléphone / WhatsApp'] || '').trim();
        const pays = String(row['Pays'] || '').trim();

        if (FILTRE_PAYS && !pays.toLowerCase().includes(FILTRE_PAYS)) {
            continue;
        }

        const key = recId || telPrincipal;
        if (waActuel.includes('WA : OUI') || waActuel.includes('WA : NON') || checkpoint[key]) {
            dejaQualifies++;
            continue;
        }

        // Collecter tous les numéros mobiles disponibles sur cette ligne
        const candidatsMobiles = [
            ...extraireMobiles(telPrincipal),
            ...extraireMobiles(telSecondaire),
            ...extraireMobiles(autresNums)
        ];
        const mobilesUniques = [...new Set(candidatsMobiles)];

        if (mobilesUniques.length === 0) {
            // Aucun numéro mobile sur cette ligne (uniquement ligne fixe Camtel/Gabon Telecom/etc.)
            checkpoint[key] = {
                status_str: 'WA : NON (Ligne Fixe uniquement)',
                checked_at: new Date().toISOString()
            };
            fixesIgnores++;
            continue;
        }

        aTraiter.push({
            index: i,
            key,
            recId,
            nomEntreprise: String(row["Nom de l'Entreprise / Raison Sociale"] || "Entreprise"),
            pays,
            telPrincipalDigits: telPrincipal.replace(/\D/g, ''),
            mobilesUniques
        });
    }

    if (fixesIgnores > 0) {
        console.log(`[FILTRE FIXES] ${fixesIgnores} lignes contenant uniquement un numéro fixe (non WhatsApp) ont été marquées automatiquement.`);
        sauvegarderCheckpoint(true);
    }

    console.log(`[INFO] Contacts déjà qualifiés : ${dejaQualifies}`);
    console.log(`[INFO] Contacts avec numéro(s) mobile(s) à tester sur WhatsApp : ${aTraiter.length}`);

    const lotCourant = aTraiter.slice(0, TAILLE_LOT);
    console.log(`[INFO] Ce traitement va vérifier : ${lotCourant.length} entreprises.\n`);

    if (lotCourant.length === 0) {
        console.log("[INFO] Tous les numéros mobiles de la base ont déjà été vérifiés !");
        sauvegarderCheckpoint(true);
        await client.destroy();
        process.exit(0);
    }

    let actifs = 0;
    let inactifs = 0;

    for (let k = 0; k < lotCourant.length; k++) {
        const item = lotCourant[k];
        const { key, nomEntreprise, pays, telPrincipalDigits, mobilesUniques } = item;

        process.stdout.write(`[${k + 1}/${lotCourant.length}] [${pays}] ${nomEntreprise.substring(0, 28).padEnd(28)} : `);

        let trouveWA = null;
        let erreurReseau = false;

        for (const mobDigits of mobilesUniques) {
            try {
                const ok = await verifierAvecRecuperation(mobDigits);
                if (ok) {
                    trouveWA = mobDigits;
                    break;
                }
            } catch (err) {
                erreurReseau = true;
                break;
            }
        }

        if (erreurReseau) {
            console.log(`\x1b[31m[DÉLAI DÉPASSÉ]\x1b[0m Reporté au prochain passage`);
        } else if (trouveWA) {
            actifs++;
            console.log(`\x1b[32m[WA : OUI]\x1b[0m +${trouveWA}`);
            const entry = {
                status_str: `WA : OUI (+${trouveWA})`,
                checked_at: new Date().toISOString()
            };
            // Si le numéro WhatsApp actif était en secondaire, on le promeut en Principal !
            if (trouveWA !== telPrincipalDigits && telPrincipalDigits) {
                entry.promoted_primary = `+${trouveWA}`;
                entry.demoted_secondary = `+${telPrincipalDigits}`;
            }
            checkpoint[key] = entry;
        } else {
            inactifs++;
            console.log(`\x1b[33m[WA : NON]\x1b[0m Non inscrit (${mobilesUniques.map(m => '+' + m).join(', ')})`);
            checkpoint[key] = {
                status_str: `WA : NON`,
                checked_at: new Date().toISOString()
            };
        }

        // Sauvegarde JSON immédiate
        sauvegarderCheckpoint(false);

        // Synchronisation Excel et respiration tous les 100 contacts
        if ((k + 1) % 100 === 0 || k === lotCourant.length - 1) {
            sauvegarderCheckpoint(true);
            if (k < lotCourant.length - 1) {
                console.log(`   \x1b[36m[PAUSE SÉCURITÉ PALIER 100] Pause de 10 secondes...\x1b[0m`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        // Pause anti-bannissement longue tous les 1000 contacts
        if ((k + 1) % 1000 === 0 && k < lotCourant.length - 1) {
            console.log(`\n\x1b[35m=================================================================\x1b[0m`);
            console.log(`\x1b[35m[PALIER 1000 ATTEINT] Pause anti-ban de 45 secondes (${actifs} WA OUI / ${inactifs} WA NON)...\x1b[0m`);
            console.log(`\x1b[35m=================================================================\x1b[0m\n`);
            await new Promise(r => setTimeout(r, 45000));
        } else {
            // Latence aléatoire entre 1.2s et 2.3s entre chaque numéro
            const pause = Math.floor(Math.random() * 1100) + 1200;
            await new Promise(r => setTimeout(r, pause));
        }
    }

    sauvegarderCheckpoint(true);

    console.log("\n=======================================================");
    console.log("RÉSUMÉ DU TRAITEMENT WHATSAPP TERMINÉ :");
    console.log(`- Entreprises vérifiées dans cette session : ${actifs + inactifs}`);
    console.log(`- Comptes WhatsApp actifs confirmés (WA : OUI) : ${actifs}`);
    console.log(`- Numéros sans compte WhatsApp (WA : NON) : ${inactifs}`);
    console.log(`- Lignes fixes filtrées automatiquement : ${fixesIgnores}`);
    console.log(`- Les fichiers Excel maîtres sont à jour et synchronisés.`);
    console.log("=======================================================\n");

    try {
        await client.destroy();
    } catch (e) {}
    process.exit(0);
}
