/**
 * Total de trésorerie (AV-487 (a), tranché par le porteur le 08/11/2026 : questionnaire de clôture, Q30 A) : somme
 * des soldes des comptes **actifs**. Une seule définition, servie par la vue d'ensemble des coûts et marges (tous les
 * comptes actifs, `GET /finance/overview`) et par la liste des comptes de trésorerie (ceux que le lecteur voit,
 * `GET /cash-accounts`), pour que les deux écrans affichent le même chiffre. Un compte inactif n'entre pas dans le
 * total ; son solde éventuel reste visible sur sa ligne (la question posée à la Finance, un compte inactif peut-il
 * porter un solde, reste ouverte dans AV-487).
 */
export interface TreasuryAccount {
  readonly status: string;
  readonly balanceXaf: number;
}

export function treasuryTotalXaf(accounts: readonly TreasuryAccount[]): number {
  return accounts.reduce(
    (sum, account) => (account.status === 'ACTIVE' ? sum + account.balanceXaf : sum),
    0,
  );
}

export function activeAccountCount(accounts: readonly TreasuryAccount[]): number {
  return accounts.filter((account) => account.status === 'ACTIVE').length;
}
