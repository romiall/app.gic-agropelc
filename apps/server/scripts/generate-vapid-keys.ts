/**
 * Génère une paire de clés VAPID pour le Web Push (AV-365, AV-536) :
 *
 *   pnpm --filter @gic/server run vapid:generate
 *
 * **N'écrit rien** : la paire s'imprime sur la sortie standard et le porteur la recopie lui-même dans
 * l'environnement du serveur (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). La clé privée ne va
 * jamais dans le dépôt, dans un fichier versionné ni dans un journal. Générer une nouvelle paire invalide tous
 * les abonnements existants (les appareils se réabonnent à leur prochaine ouverture).
 */
import { generateVapidKeyPair } from '../src/modules/communication/application/public/index.js';

const { publicKey, privateKey } = generateVapidKeyPair();
console.log('Paire VAPID générée. À poser dans l’environnement du serveur (API et worker) :');
console.log('');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:<adresse de contact du porteur>');
console.log('');
console.log('La clé privée est secrète : ne la copiez ni dans le dépôt ni dans un message.');
