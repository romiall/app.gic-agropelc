/**
 * =====================================================================================
 *  VÉRIFICATEUR WHATSAPP INTÉGRAL (v2, Claude) — GIC AGROPELC
 * =====================================================================================
 *  Teste, en une seule exécution, TOUS les numéros de numeros_a_tester.csv :
 *  principal, secondaires, autres numéros documentés, mobiles d'abord puis fixes.
 *
 *  - Aucun message envoyé, aucune discussion ouverte : simple interrogation
 *    « ce numéro a-t-il un compte WhatsApp ? » (fonction getNumberId de whatsapp-web.js).
 *  - Un numéro partagé par plusieurs entreprises n'est testé qu'une fois.
 *  - Reprise exacte : chaque résultat est écrit aussitôt dans resultats_whatsapp.jsonl ;
 *    une relance ne reteste que ce qui manque.
 *  - Témoin anti-blocage : votre propre numéro est revérifié régulièrement ; s'il n'est
 *    plus reconnu (WhatsApp freine les requêtes), les « non » depuis le dernier témoin
 *    valide sont annulés, puis retestés après une pause.
 *  - Résistant aux rechargements de WhatsApp Web : attente que la page soit prête,
 *    nouvel essai du même numéro, redémarrage de la session si besoin (sans nouveau QR).
 *  - Plusieurs comptes WhatsApp en parallèle (option --comptes=2) pour aller plus vite.
 *
 *  Codes de sortie : 0 terminé ou interrompu proprement · 2 incident technique (relance
 *  automatique par le lanceur) · 3 blocage suspecté (arrêt, attendre avant de relancer)
 *  · 4 configuration (fichier absent, session refusée, navigateur déjà ouvert).
 * =====================================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('./node_modules/whatsapp-web.js');
const qrcode = require('./node_modules/qrcode-terminal');

const DIR = __dirname;
const FICHIER_NUMEROS = path.join(DIR, 'numeros_a_tester.csv');
const FICHIER_RESULTATS = path.join(DIR, 'resultats_whatsapp.jsonl');
const FICHIER_JOURNAL = path.join(DIR, 'journal_whatsapp.log');
const FICHIER_RESUME = path.join(DIR, 'resume_whatsapp.json');
const FICHIER_VERROU = path.join(DIR, '.verification_en_cours.lock');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// ------------------------------------------------------------------ options
const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const RYTHMES = {
    // pause entre deux numéros (s), grande pause (s) tous les N numéros, plafond horaire par compte,
    // nombre de « non » consécutifs sur des mobiles avant un contrôle du témoin
    prudent: { min: 4, max: 9, pauseTous: [60, 90], pause: [120, 240], parHeure: 400, seuilNon: 20, temoinTous: 100 },
    normal: { min: 2, max: 5, pauseTous: [100, 150], pause: [60, 120], parHeure: 900, seuilNon: 30, temoinTous: 150 },
    rapide: { min: 1.2, max: 2.5, pauseTous: [150, 200], pause: [30, 60], parHeure: 1800, seuilNon: 40, temoinTous: 200 },
};
const RYTHME_NOM = RYTHMES[ARGS.rythme] ? ARGS.rythme : 'normal';
const RYTHME = RYTHMES[RYTHME_NOM];
const NB_COMPTES = Math.max(1, Math.min(4, parseInt(ARGS.comptes || '1', 10) || 1));
const LIMITE = parseInt(ARGS.limite || '0', 10) || 0;
const FILTRE_PAYS = ARGS.pays ? String(ARGS.pays).toLowerCase() : null;
const SANS_FIXES = Boolean(ARGS['sans-fixes']);
const REFAIRE_NON = Boolean(ARGS['refaire-non']);
const ESSAI = Boolean(ARGS.essai);
const VISIBLE = Boolean(ARGS.visible);

// ------------------------------------------------------------------ utilitaires
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hasard = (a, b) => a + Math.random() * (b - a);
const maintenant = () => new Date().toISOString();
const COUL = { vert: '\x1b[32m', jaune: '\x1b[33m', rouge: '\x1b[31m', cyan: '\x1b[36m', mauve: '\x1b[35m', gris: '\x1b[90m', fin: '\x1b[0m' };

function journal(...morceaux) {
    const ligne = `[${maintenant()}] ${morceaux.map((m) => (m instanceof Error ? m.stack || m.message : typeof m === 'string' ? m : JSON.stringify(m))).join(' ')}`;
    try { fs.appendFileSync(FICHIER_JOURNAL, ligne + '\n', 'utf8'); } catch (e) { /* journal facultatif */ }
}

function ecrireResultat(objet) {
    fs.appendFileSync(FICHIER_RESULTATS, JSON.stringify(objet) + '\n', 'utf8');
}

function duree(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

// ------------------------------------------------------------------ verrou (une seule exécution à la fois)
function poserVerrou() {
    if (fs.existsSync(FICHIER_VERROU)) {
        const pid = parseInt(fs.readFileSync(FICHIER_VERROU, 'utf8'), 10);
        let vivant = false;
        try { if (pid) { process.kill(pid, 0); vivant = true; } } catch (e) { vivant = false; }
        if (vivant && pid !== process.pid) {
            console.error(`${COUL.rouge}[ARRÊT]${COUL.fin} Une vérification tourne déjà (processus ${pid}). Une seule à la fois : deux connexions sur la même session WhatsApp se gêneraient.`);
            process.exit(4);
        }
    }
    fs.writeFileSync(FICHIER_VERROU, String(process.pid), 'utf8');
}
function leverVerrou() {
    try { if (fs.existsSync(FICHIER_VERROU) && fs.readFileSync(FICHIER_VERROU, 'utf8') === String(process.pid)) fs.unlinkSync(FICHIER_VERROU); } catch (e) { /* rien */ }
}

// ------------------------------------------------------------------ données
function lireNumeros() {
    if (!fs.existsSync(FICHIER_NUMEROS)) {
        console.error(`${COUL.rouge}[ARRÊT]${COUL.fin} Fichier introuvable : ${FICHIER_NUMEROS}`);
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
            type: c[idx('type')] || 'inconnu',
            operateur: c[idx('operateur')] || '',
            priorite: parseInt(c[idx('priorite')] || '9', 10),
            entreprise: c[idx('entreprise')] || '',
            nbEntreprises: parseInt(c[idx('nb_entreprises')] || '1', 10),
        });
    }
    return out;
}

function lireResultats() {
    const res = new Map();          // numero -> { statut, wid, teste_le, segment }
    const annules = new Set();      // segments annulés (blocage détecté)
    if (!fs.existsSync(FICHIER_RESULTATS)) return res;
    const brut = [];
    for (const l of fs.readFileSync(FICHIER_RESULTATS, 'utf8').split(/\r?\n/)) {
        if (!l.trim()) continue;
        try {
            const o = JSON.parse(l);
            if (o.evenement === 'segment_annule') annules.add(o.segment);
            else if (o.numero) brut.push(o);
        } catch (e) { /* ligne tronquée par un arrêt brutal : ignorée */ }
    }
    for (const o of brut) {
        if (o.segment && annules.has(o.segment)) continue;
        if (o.statut === 'oui' || o.statut === 'non') res.set(o.numero, o);
    }
    return res;
}

// ------------------------------------------------------------------ file d'attente partagée
function construireFile(numeros, resultats) {
    const file = [];
    let deja = 0;
    for (const n of numeros) {
        if (FILTRE_PAYS && !n.pays.toLowerCase().includes(FILTRE_PAYS)) continue;
        if (SANS_FIXES && n.type === 'fixe') continue;
        const r = resultats.get(n.numero);
        if (r && (r.statut === 'oui' || (r.statut === 'non' && !REFAIRE_NON))) { deja++; continue; }
        file.push(n);
    }
    // mobiles d'abord, puis par priorité (principal de l'entreprise, cœur de cible…)
    const rangType = { mobile: 0, inconnu: 1, fixe: 2 };
    file.sort((a, b) => (rangType[a.type] ?? 1) - (rangType[b.type] ?? 1) || a.priorite - b.priorite);
    return { file: LIMITE ? file.slice(0, LIMITE) : file, deja };
}

// ------------------------------------------------------------------ session WhatsApp
function optionsClient(compte) {
    return {
        authStrategy: new LocalAuth({ dataPath: path.join(DIR, '.wwebjs_auth'), clientId: compte.id === 1 ? undefined : `compte${compte.id}` }),
        authTimeoutMs: 180000,      // la page a 3 min pour se charger (30 s par défaut : cause des « auth timeout »)
        qrMaxRetries: 0,
        puppeteer: {
            executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
            headless: !VISIBLE,
            protocolTimeout: 180000,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu'],
        },
    };
}

async function pagePrete(client) {
    try {
        if (!client || !client.pupPage || client.pupPage.isClosed()) return false;
        return await client.pupPage.evaluate(() => {
            try {
                return typeof window.require === 'function' && !!window.require('WAWebWidFactory') && !!window.require('WAWebQueryExistsJob')
                    && window.require('WAWebSocketModel').Socket.state === 'CONNECTED';
            } catch (e) { return false; }
        });
    } catch (e) { return false; }
}

async function attendrePage(client, maxMs) {
    const fin = Date.now() + maxMs;
    while (Date.now() < fin) {
        if (await pagePrete(client)) return true;
        await dormir(2000);
    }
    return false;
}

function avecDelai(promesse, ms, quoi) {
    let t;
    return Promise.race([promesse, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`délai dépassé (${quoi})`)), ms); })])
        .finally(() => clearTimeout(t));
}

class Compte {
    constructor(id) {
        this.id = id;
        this.client = null;
        this.pret = false;
        this.monNumero = null;
        this.redemarrages = [];
        this.horodatages = [];      // pour le plafond horaire
        this.segment = null;
        this.nonConsecutifs = 0;
        this.depuisTemoin = 0;
        this.echecsTemoin = 0;
        this.stats = { oui: 0, non: 0 };
    }

    nouveauSegment() {
        this.segment = `c${this.id}-${Date.now()}`;
        this.depuisTemoin = 0;
        this.nonConsecutifs = 0;
    }

    async demarrer() {
        this.pret = false;
        this.deconnexion = '';
        const client = new Client(optionsClient(this));
        this.client = client;
        let resoudre;
        const pret = new Promise((r) => { resoudre = r; });
        client.on('qr', (qr) => {
            console.log(`\n${COUL.jaune}[COMPTE ${this.id}] Connexion requise : dans WhatsApp sur le téléphone ${this.id === 1 ? 'du compte habituel' : `du compte n° ${this.id} (un AUTRE numéro)`}, ouvrez Appareils connectés > Connecter un appareil, puis scannez :${COUL.fin}\n`);
            qrcode.generate(qr, { small: true });
        });
        client.on('authenticated', () => journal(`compte ${this.id} authentifié`));
        client.on('auth_failure', (m) => { journal(`compte ${this.id} échec d'authentification`, m); console.error(`${COUL.rouge}[COMPTE ${this.id}] Authentification refusée : ${m}${COUL.fin}`); });
        client.on('change_state', (s) => journal(`compte ${this.id} état`, s));
        client.on('disconnected', (raison) => {
            journal(`compte ${this.id} déconnecté`, raison);
            this.pret = false;
            this.deconnexion = String(raison || '');
        });
        client.on('ready', () => {
            this.pret = true;
            try { this.monNumero = client.info && client.info.wid ? client.info.wid.user : null; } catch (e) { this.monNumero = null; }
            resoudre();
        });
        try {
            await client.initialize();
        } catch (e) {
            const msg = String(e && (e.message || e));
            journal(`compte ${this.id} initialisation`, msg);
            if (/already running|SingletonLock|user data directory is already in use/i.test(msg)) {
                console.error(`${COUL.rouge}[COMPTE ${this.id}] Le navigateur de cette session est déjà ouvert (ancienne exécution ?). Fermez les fenêtres Edge « headless » ou redémarrez l'ordinateur, puis relancez.${COUL.fin}`);
                throw Object.assign(new Error('navigateur occupé'), { codeSortie: 4 });
            }
            throw e;
        }
        await avecDelai(pret, 600000, 'connexion WhatsApp (QR non scanné ?)');
        await attendrePage(client, 120000);
        this.nouveauSegment();
        console.log(`${COUL.vert}[COMPTE ${this.id}] Connecté${this.monNumero ? ` (+${this.monNumero})` : ''}.${COUL.fin}`);
    }

    async arreter() {
        try { if (this.client) await avecDelai(this.client.destroy(), 30000, 'fermeture'); } catch (e) { /* rien */ }
        this.client = null;
        this.pret = false;
    }

    async redemarrer(motif) {
        const h = Date.now() - 3600 * 1000;
        this.redemarrages = this.redemarrages.filter((t) => t > h);
        if (this.redemarrages.length >= 4) {
            throw Object.assign(new Error(`compte ${this.id} : trop de redémarrages en une heure (${motif})`), { codeSortie: 2 });
        }
        this.redemarrages.push(Date.now());
        console.log(`${COUL.mauve}[COMPTE ${this.id}] Redémarrage de la session (${motif})…${COUL.fin}`);
        journal(`compte ${this.id} redémarrage`, motif);
        await this.arreter();
        await dormir(10000);
        await this.demarrer();
    }

    /** Une interrogation, avec attente de la page et nouveaux essais. Retourne { existe, wid } ou lève une erreur fatale. */
    async interroger(numero) {
        for (let essai = 1; essai <= 4; essai++) {
            if (this.deconnexion && /LOGOUT|UNPAIRED/i.test(this.deconnexion)) {
                throw Object.assign(new Error(`compte ${this.id} déconnecté du téléphone (${this.deconnexion}) : reconnectez-le (QR)`), { codeSortie: 4 });
            }
            if (!this.pret || !(await pagePrete(this.client))) {
                const ok = await attendrePage(this.client, 90000);
                if (!ok) { await this.redemarrer('page WhatsApp indisponible'); continue; }
            }
            try {
                const wid = await avecDelai(this.client.getNumberId(numero), 45000, 'requête');
                return { existe: Boolean(wid), wid: wid ? (wid._serialized || `${wid.user}@${wid.server}`) : null };
            } catch (e) {
                const msg = String(e && (e.message || e));
                journal(`compte ${this.id} erreur sur ${numero} (essai ${essai})`, msg);
                // rechargement de WhatsApp Web, contexte détruit, module absent, délai : on attend et on réessaie le MÊME numéro
                await dormir(5000 * essai);
                if (essai === 3) await this.redemarrer(`erreurs répétées : ${msg.slice(0, 60)}`);
            }
        }
        throw Object.assign(new Error(`compte ${this.id} : échec répété sur ${numero}`), { codeSortie: 2 });
    }

    /** Le témoin : votre propre numéro doit être reconnu. Sinon WhatsApp freine les requêtes. */
    async temoinOk() {
        if (!this.monNumero) return true; // numéro inconnu : pas de témoin possible
        try {
            const r = await this.interroger(this.monNumero);
            return r.existe;
        } catch (e) {
            if (e.codeSortie) throw e;
            return false;
        }
    }

    async respecterPlafond() {
        const h = Date.now() - 3600 * 1000;
        this.horodatages = this.horodatages.filter((t) => t > h);
        if (this.horodatages.length >= RYTHME.parHeure) {
            const attente = this.horodatages[0] + 3600 * 1000 - Date.now() + 1000;
            console.log(`${COUL.cyan}[COMPTE ${this.id}] Plafond de ${RYTHME.parHeure} numéros par heure atteint : pause de ${duree(attente / 1000)}.${COUL.fin}`);
            await dormir(attente);
        }
    }
}

// ------------------------------------------------------------------ programme principal
async function principal() {
    const numeros = lireNumeros();
    const resultats = lireResultats();
    const { file, deja } = construireFile(numeros, resultats);
    const parType = file.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {});
    const parPays = file.reduce((acc, n) => { acc[n.pays] = (acc[n.pays] || 0) + 1; return acc; }, {});
    const moy = (RYTHME.min + RYTHME.max) / 2 + (RYTHME.pause[0] + RYTHME.pause[1]) / 2 / ((RYTHME.pauseTous[0] + RYTHME.pauseTous[1]) / 2) + 0.6;
    const parHeureEff = Math.min(RYTHME.parHeure, 3600 / moy) * NB_COMPTES;

    console.log('=====================================================================');
    console.log('   VÉRIFICATEUR WHATSAPP INTÉGRAL (v2) — GIC AGROPELC');
    console.log('=====================================================================');
    console.log(`Numéros documentés dans le fichier : ${numeros.length}`);
    console.log(`Déjà qualifiés (oui / non)        : ${deja}${REFAIRE_NON ? ' (les « non » sont retestés)' : ''}`);
    console.log(`À tester maintenant               : ${file.length}  ${JSON.stringify(parType)}`);
    console.log(`Par pays                          : ${JSON.stringify(parPays)}`);
    console.log(`Rythme « ${RYTHME_NOM} », ${NB_COMPTES} compte(s) : ~${Math.round(parHeureEff)} numéros/heure, durée estimée ${duree(file.length / parHeureEff * 3600)}`);
    console.log('Aucun message n\'est envoyé. Ctrl+C arrête proprement ; une relance reprend où l\'on s\'est arrêté.');
    console.log('---------------------------------------------------------------------');
    if (ESSAI) { console.log('[ESSAI] Mode essai : aucune connexion à WhatsApp.'); return 0; }
    if (!file.length) { console.log(`${COUL.vert}Tous les numéros sont déjà qualifiés.${COUL.fin}`); return 0; }

    poserVerrou();
    let arret = false;
    let codeFinal = 0;
    process.on('SIGINT', () => {
        if (arret) process.exit(0);
        arret = true;
        console.log(`\n${COUL.jaune}[ARRÊT DEMANDÉ] Fin du numéro en cours, puis fermeture propre (relancez pour reprendre)…${COUL.fin}`);
    });

    const comptes = [];
    for (let i = 1; i <= NB_COMPTES; i++) comptes.push(new Compte(i));
    // connexion des comptes l'un après l'autre (un QR à la fois)
    for (const c of comptes) await c.demarrer();

    let faits = 0;
    const debut = Date.now();
    const position = { i: 0 };
    const incidents = [];

    async function travailleur(c) {
        try {
            await boucle(c);
        } catch (e) {
            incidents.push(e);
            arret = true; // les autres comptes terminent leur numéro en cours puis s'arrêtent
        }
    }

    async function boucle(c) {
        let jusquaPause = Math.round(hasard(...RYTHME.pauseTous));
        while (!arret) {
            const total = file.length;
            const n = file[position.i++];
            if (!n) break;
            await c.respecterPlafond();
            const t0 = Date.now();
            const r = await c.interroger(n.numero);
            c.horodatages.push(Date.now());
            faits++;
            ecrireResultat({ numero: n.numero, statut: r.existe ? 'oui' : 'non', wid: r.wid, pays: n.pays, type: n.type, teste_le: maintenant(), compte: c.id, segment: c.segment, duree_ms: Date.now() - t0 });
            if (r.existe) { c.stats.oui++; c.nonConsecutifs = 0; } else { c.stats.non++; if (n.type === 'mobile') c.nonConsecutifs++; }
            c.depuisTemoin++;
            const tauxH = faits / Math.max(1, (Date.now() - debut) / 3600000);
            const reste = (total - faits) / Math.max(1, tauxH) * 3600;
            const etiquette = r.existe ? `${COUL.vert}OUI${COUL.fin}` : `${COUL.jaune}non${COUL.fin}`;
            console.log(`[${faits}/${total}] +${n.numero} ${COUL.gris}${n.pays}, ${n.type}${n.operateur ? ' ' + n.operateur : ''}${n.entreprise ? ' — ' + n.entreprise.slice(0, 34) : ''}${COUL.fin} : ${etiquette}${NB_COMPTES > 1 ? ` (compte ${c.id})` : ''}${faits % 25 === 0 ? `   ${COUL.cyan}[${Math.round(tauxH)}/h, reste ~${duree(reste)}]${COUL.fin}` : ''}`);

            // témoin : périodique, ou après une série anormale de « non » sur des mobiles
            if (c.depuisTemoin >= RYTHME.temoinTous || c.nonConsecutifs >= RYTHME.seuilNon) {
                const motif = c.nonConsecutifs >= RYTHME.seuilNon ? `${c.nonConsecutifs} « non » de suite` : 'contrôle périodique';
                if (await c.temoinOk()) {
                    c.echecsTemoin = 0;
                    c.nouveauSegment();
                } else {
                    c.echecsTemoin++;
                    ecrireResultat({ evenement: 'segment_annule', segment: c.segment, compte: c.id, motif, le: maintenant() });
                    const pauseMin = [15, 30, 60][Math.min(2, c.echecsTemoin - 1)];
                    console.log(`${COUL.rouge}[COMPTE ${c.id}] Témoin non reconnu (${motif}) : WhatsApp semble freiner les requêtes. Les résultats depuis le dernier témoin valide sont annulés et seront retestés. Pause de ${pauseMin} min.${COUL.fin}`);
                    journal(`compte ${c.id} témoin en échec n° ${c.echecsTemoin}`, motif);
                    if (c.echecsTemoin >= 3) throw Object.assign(new Error('blocage suspecté (témoin en échec 3 fois)'), { codeSortie: 3 });
                    // les numéros du segment annulé retournent dans la file
                    const annules = lireResultatsSegment(c.segment);
                    for (const num of annules) { const x = numeros.find((y) => y.numero === num); if (x) file.push(x); }
                    await dormir(pauseMin * 60000);
                    c.nouveauSegment();
                }
            }
            if (--jusquaPause <= 0) {
                const p = hasard(...RYTHME.pause);
                console.log(`${COUL.cyan}   [pause de ${Math.round(p)} s — compte ${c.id} : ${c.stats.oui} oui / ${c.stats.non} non]${COUL.fin}`);
                await dormir(p * 1000);
                jusquaPause = Math.round(hasard(...RYTHME.pauseTous));
            } else {
                await dormir(hasard(RYTHME.min, RYTHME.max) * 1000);
            }
        }
    }

    function lireResultatsSegment(segment) {
        const nums = [];
        for (const l of fs.readFileSync(FICHIER_RESULTATS, 'utf8').split(/\r?\n/)) {
            try { const o = JSON.parse(l); if (o.segment === segment && o.numero) nums.push(o.numero); } catch (e) { /* rien */ }
        }
        return nums;
    }

    await Promise.all(comptes.map((c) => travailleur(c)));
    if (incidents.length) {
        // gravité : 3 (blocage suspecté) > 4 (configuration) > 2 (technique)
        const codes = incidents.map((e) => e.codeSortie || 2);
        codeFinal = codes.includes(3) ? 3 : codes.includes(4) ? 4 : 2;
        for (const e of incidents) {
            console.error(`\n${COUL.rouge}[INCIDENT] ${e.message}${COUL.fin}`);
            journal('incident', e);
        }
    }
    for (const c of comptes) await c.arreter();

    const fin = lireResultats();
    const vus = numeros.filter((n) => fin.has(n.numero));
    const resume = {
        termine_le: maintenant(),
        numeros_documentes: numeros.length,
        qualifies: vus.length,
        whatsapp_oui: vus.filter((n) => fin.get(n.numero).statut === 'oui').length,
        whatsapp_non: vus.filter((n) => fin.get(n.numero).statut === 'non').length,
        restant: numeros.length - vus.length,
        code_sortie: codeFinal,
    };
    fs.writeFileSync(FICHIER_RESUME, JSON.stringify(resume, null, 2), 'utf8');
    console.log('\n=====================================================================');
    console.log(`Qualifiés : ${resume.qualifies}/${resume.numeros_documentes} — WhatsApp OUI : ${resume.whatsapp_oui} — NON : ${resume.whatsapp_non} — restant : ${resume.restant}`);
    console.log('=====================================================================');
    leverVerrou();
    return codeFinal;
}

process.on('unhandledRejection', (r) => journal('promesse rejetée non gérée (bibliothèque)', r));
process.on('uncaughtException', (e) => {
    journal('exception non gérée', e);
    console.error(`${COUL.rouge}[INCIDENT] ${e && e.message}${COUL.fin}`);
    leverVerrou();
    process.exit(2);
});

principal().then((code) => { leverVerrou(); process.exit(code); }).catch((e) => {
    journal('arrêt', e);
    console.error(`${COUL.rouge}[ARRÊT] ${e && e.message}${COUL.fin}`);
    leverVerrou();
    process.exit(e && e.codeSortie ? e.codeSortie : 2);
});
