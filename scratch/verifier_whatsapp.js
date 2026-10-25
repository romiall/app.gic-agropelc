/**
 * ===================================================================================
 * VÉRIFICATEUR WHATSAPP B2B HAUT DÉBIT (Node.js & whatsapp-web.js)
 * Projet : GIC AGROPELC - Qualification Base Clients & Partenaires
 * ===================================================================================
 * 
 * Avantage de cette version :
 * - Utilise l'API interne WhatsApp Web via la méthode native `client.isRegisteredUser()`.
 * - N'ouvre AUCUNE fenêtre de discussion, ne clique sur RIEN, n'envoie AUCUN message.
 * - Réponse instantanée du protocole WhatsApp (~200ms par numéro).
 * - Connexion QR code une seule fois avec persistance de session (`.wwebjs_auth`).
 * 
 * Installation préalable :
 *    npm install whatsapp-web.js qrcode-terminal xlsx
 * 
 * Exécution :
 *    node scratch/verifier_whatsapp.js
 * ===================================================================================
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const EXCEL_PATH = path.resolve('c:/xampp/htdocs/app.gic-agropelc/BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx');

console.log("=== VÉRIFICATEUR WHATSAPP B2B HAUT DÉBIT (GIC AGROPELC) ===");

// 1. Initialisation du client WhatsApp Web avec sauvegarde locale de session
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.resolve(__dirname, 'whatsapp_node_session') }),
    puppeteer: {
        headless: true, // Fonctionne en arrière-plan sans ouvrir de fenêtre intrusive
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', (qr) => {
    console.log("\n[ACTION REQUISE] Scannez ce QR Code avec votre WhatsApp :");
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log("\n[SUCCÈS] Client WhatsApp Web connecté et authentifié avec succès !");
    await traiterExcel();
});

client.on('auth_failure', (msg) => {
    console.error('[ERREUR] Échec de l\'authentification WhatsApp :', msg);
});

client.initialize();

async function traiterExcel() {
    if (!fs.existsSync(EXCEL_PATH)) {
        console.error(`[ERREUR] Le fichier ${EXCEL_PATH} est introuvable.`);
        client.destroy();
        return;
    }

    console.log(`[INFO] Lecture du fichier Excel : ${EXCEL_PATH}`);
    const workbook = XLSX.readFile(EXCEL_PATH);
    const sheetName = 'Base Contacts';
    const worksheet = workbook.Sheets[sheetName];

    if (!worksheet) {
        console.error(`[ERREUR] Onglet '${sheetName}' introuvable dans le classeur.`);
        client.destroy();
        return;
    }

    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    console.log(`[INFO] Total lignes chargées : ${rows.length}`);

    let traites = 0;
    let actifsWhatsApp = 0;
    let inactifsWhatsApp = 0;
    const LIMITE_SESSION = 100; // Limite conseillée par session pour préserver le compte

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const telPrincipal = row['Téléphone Principal (E.164)'] || '';
        const waActuel = String(row['Autre Téléphone / WhatsApp'] || '');

        // Ignorer si déjà qualifié
        if (waActuel.includes('WA : OUI') || waActuel.includes('WA : NON')) {
            continue;
        }

        // Nettoyer le numéro pour obtenir les chiffres internationaux
        const digits = telPrincipal.replace(/\D/g, '');
        if (digits.length < 8) {
            continue;
        }

        try {
            console.log(`[${traites + 1}/${LIMITE_SESSION}] Vérification : ${row["Nom de l'Entreprise / Raison Sociale"]} (${digits})...`);

            // Méthode WhatsApp Web native : interroge si le compte existe sans ouvrir de discussion
            const isRegistered = await client.isRegisteredUser(`${digits}@c.us`);

            if (isRegistered) {
                actifsWhatsApp++;
                console.log(`   -> [OUI] Actif sur WhatsApp`);
                row['Autre Téléphone / WhatsApp'] = waActuel ? `${waActuel} | WA : OUI (${digits})` : `WA : OUI (${digits})`;
            } else {
                inactifsWhatsApp++;
                console.log(`   -> [NON] Non inscrit`);
                row['Autre Téléphone / WhatsApp'] = waActuel ? `${waActuel} | WA : NON` : `WA : NON`;
            }

            traites++;

            // Sauvegarde intermédiaire tous les 15 numéros
            if (traites % 15 === 0) {
                const updatedWs = XLSX.utils.json_to_sheet(rows);
                workbook.Sheets[sheetName] = updatedWs;
                XLSX.writeFile(workbook, EXCEL_PATH);
                console.log(`   [SAUVEGARDE] Classeur Excel actualisé.`);
            }

            if (traites >= LIMITE_SESSION) {
                console.log(`\n[INFO] Limite de session atteinte (${LIMITE_SESSION} numéros vérifiés). Arrêt préventif.`);
                break;
            }

            // Pause aléatoire entre 1.5s et 3s
            const delay = Math.floor(Math.random() * 1500) + 1500;
            await new Promise((res) => setTimeout(res, delay));

        } catch (err) {
            console.error(`   [ERREUR] Erreur lors de la vérification de ${digits} :`, err.message);
        }
    }

    // Sauvegarde finale
    const finalWs = XLSX.utils.json_to_sheet(rows);
    workbook.Sheets[sheetName] = finalWs;
    XLSX.writeFile(workbook, EXCEL_PATH);

    console.log("\n=======================================================");
    console.log("BILAN DU TRAITEMENT :");
    console.log(`Total numéros vérifiés : ${traites}`);
    console.log(`Comptes WhatsApp actifs : ${actifsWhatsApp}`);
    console.log(`Non inscrits sur WhatsApp : ${inactifsWhatsApp}`);
    console.log(`Classeur sauvegardé : ${EXCEL_PATH}`);
    console.log("=======================================================");

    client.destroy();
}
