/**
 * Téléchargement d'un fichier texte produit sur l'appareil (modèle de chargement, export du registre de
 * stock…) : lien temporaire sur un objet binaire, aucune requête au serveur.
 */
export function downloadTextFile(
  name: string,
  text: string,
  mime = 'text/csv;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Certains navigateurs lisent l'adresse après le clic : la révoquer aussitôt annulerait le téléchargement.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
