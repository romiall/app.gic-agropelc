/**
 * Page de référence des composants partagés (ADR-049), réservée au développement : `/dev/composants`.
 * Elle montre en un coup d'œil chaque jeton et chaque composant, dans les deux thèmes, et sert de
 * contrôle visuel après chaque lot. Absente de la construction de production (voir `App.tsx`).
 */
import { useState, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  ICON_NAMES,
  Icon,
  IconButton,
  Input,
  KpiTile,
  LinkButton,
  List,
  ListRow,
  PageHeader,
  Radio,
  Section,
  Segmented,
  Select,
  Sheet,
  Skeleton,
  SkeletonRows,
  Spinner,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  ToastProvider,
  useThemePreference,
  useToast,
  type ThemePreference,
} from '../components/ui/index.js';
import './gallery.css';

const SWATCHES = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'line',
  'line-strong',
  'ink',
  'ink-2',
  'ink-3',
  'brand',
  'brand-strong',
  'brand-tint',
  'brand-tint-2',
  'nav',
  'gold',
  'ok',
  'ok-tint',
  'warn',
  'warn-tint',
  'bad',
  'bad-tint',
  'info',
  'info-tint',
];

const SIZES: ReadonlyArray<readonly [string, string]> = [
  ['--text-xs · 12 px', 'var(--text-xs)'],
  ['--text-sm · 13 px', 'var(--text-sm)'],
  ['--text-md · 15 px', 'var(--text-md)'],
  ['--text-lg · 17 px', 'var(--text-lg)'],
  ['--text-xl · 20 px', 'var(--text-xl)'],
  ['--text-2xl · 24 px', 'var(--text-2xl)'],
  ['--text-3xl · 32 px', 'var(--text-3xl)'],
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gal-block">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ToastButtons() {
  const { notify } = useToast();
  return (
    <div className="row wrap">
      <Button variant="outline" onClick={() => notify('Vente enregistrée.', 'ok')}>
        Notification de réussite
      </Button>
      <Button variant="outline" onClick={() => notify('Envoi différé : réseau absent.', 'warn')}>
        Attention
      </Button>
      <Button variant="outline" onClick={() => notify('Le montant dépasse le total.', 'bad')}>
        Erreur
      </Button>
    </div>
  );
}

function Gallery() {
  const [theme, setTheme] = useThemePreference();
  const [payment, setPayment] = useState('cash');
  const [filter, setFilter] = useState('active');
  const [tab, setTab] = useState('open');
  const [sheet, setSheet] = useState(false);
  const [banner, setBanner] = useState(true);

  return (
    <div className="gal">
      <PageHeader
        title="Composants"
        subtitle="Page de référence du système de design (développement seulement)."
        actions={
          <Segmented<ThemePreference>
            label="Apparence"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Clair' },
              { value: 'dark', label: 'Sombre' },
              { value: 'auto', label: 'Automatique' },
            ]}
          />
        }
      />

      <Block title="Couleurs">
        <div className="gal-grid">
          {SWATCHES.map((name) => (
            <div key={name} className="gal-swatch">
              <i style={{ background: `var(--${name})` }} />
              <span>--{name}</span>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Typographie">
        <div className="gal-type">
          {SIZES.map(([name, size]) => (
            <p key={name}>
              <small>{name}</small>
              <span style={{ fontSize: size }}>Œufs de table, plateau de 30 · 17 500 F CFA</span>
            </p>
          ))}
          <p>
            <small>Barlow 700</small>
            <span className="num" style={{ font: '700 var(--text-3xl)/1 var(--font-display)' }}>
              1 234 567 F CFA
            </span>
          </p>
        </div>
      </Block>

      <Block title="Boutons">
        <div className="row wrap">
          <Button>Enregistrer la vente</Button>
          <Button variant="tonal">Encaisser</Button>
          <Button variant="outline">Annuler</Button>
          <Button variant="ghost">Fiche client</Button>
          <Button variant="danger">Supprimer</Button>
        </div>
        <div className="row wrap">
          <Button icon="plus">Nouvelle vente</Button>
          <Button variant="tonal" icon="phone">
            Appeler
          </Button>
          <Button variant="outline" iconEnd="arrow-right">
            Continuer
          </Button>
          <Button loading>Envoi…</Button>
          <Button disabled>Désactivé</Button>
          <IconButton icon="sync" label="Actualiser" variant="outline" />
          <IconButton icon="trash" label="Supprimer la ligne" size="sm" />
        </div>
        <div className="row wrap">
          <Button size="sm" variant="tonal">
            Petit
          </Button>
          <Button size="lg" icon="plus">
            Action principale
          </Button>
          <LinkButton to="/" variant="outline" icon="home">
            Lien en bouton
          </LinkButton>
        </div>
      </Block>

      <Block title="Champs">
        <div className="gal-grid gal-grid-wide">
          <Field label="Nom du client">
            {(c) => <Input {...c} placeholder="Restaurant Le Wouri" />}
          </Field>
          <Field label="Montant encaissé" unit="F CFA" hint="Payé en totalité">
            {(c) => <Input {...c} inputMode="numeric" defaultValue="14 000" />}
          </Field>
          <Field label="Quantité" unit="plateaux" error="La quantité dépasse le stock disponible.">
            {(c) => <Input {...c} inputMode="numeric" defaultValue="40" />}
          </Field>
          <Field label="Emplacement">
            {(c) => (
              <Select {...c} defaultValue="comptoir">
                <option value="comptoir">Comptoir</option>
                <option value="magasin">Magasin central</option>
              </Select>
            )}
          </Field>
          <Field label="Téléphone" optional>
            {(c) => <Input {...c} type="tel" placeholder="+237 6XX XX XX XX" />}
          </Field>
          <Field label="Désactivé">
            {(c) => <Input {...c} disabled defaultValue="Non modifiable" />}
          </Field>
        </div>
        <Field label="Commentaire" hint="Visible dans l'historique de la vente.">
          {(c) => <Textarea {...c} placeholder="Précisez le motif…" />}
        </Field>
      </Block>

      <Block title="Choix">
        <div className="gal-grid gal-grid-wide">
          <div className="stack">
            <Checkbox
              label="Seulement les produits sous le seuil"
              hint="2 produits concernés"
              defaultChecked
            />
            <Checkbox label="Inclure les ventes annulées" />
            <Checkbox label="Option indisponible" disabled />
          </div>
          <div className="stack">
            <Radio name="g-radio" label="Casse" defaultChecked />
            <Radio name="g-radio" label="Détérioration" />
            <Radio name="g-radio" label="Vol suspect" />
          </div>
          <div className="stack">
            <Switch label="Mode hors ligne forcé" defaultChecked />
            <Switch label="Alertes sonores" />
          </div>
        </div>
        <Segmented
          label="Moyen de paiement"
          value={payment}
          onChange={setPayment}
          options={[
            { value: 'cash', label: 'Espèces' },
            { value: 'om', label: 'Orange Money' },
            { value: 'momo', label: 'MTN MoMo' },
          ]}
        />
        <Segmented
          label="Afficher les comptes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Actifs' },
            { value: 'suspended', label: 'Suspendus' },
            { value: 'disabled', label: 'Désactivés' },
            { value: 'all', label: 'Tous' },
          ]}
        />
      </Block>

      <Block title="Pastilles et personnes">
        <div className="row wrap">
          <Badge tone="ok">Payée</Badge>
          <Badge tone="warn">Payée en partie</Badge>
          <Badge tone="bad">Non payée</Badge>
          <Badge tone="info">Brouillon</Badge>
          <Badge tone="brand">Client</Badge>
          <Badge tone="muted">Prospect</Badge>
          <Badge tone="brand" plain>
            12
          </Badge>
          <Avatar name="Carlos Demo" />
          <Avatar name="Hôtel de la Plage" large />
        </div>
      </Block>

      <Block title="Listes">
        <div className="gal-surface">
          <Section
            title="À traiter"
            action={
              <LinkButton to="/" variant="ghost" size="sm">
                Tout voir
              </LinkButton>
            }
          >
            <List>
              <ListRow
                icon="truck"
                iconTone="warn"
                title="1 transfert à recevoir"
                subtitle="Magasin central vers Comptoir"
                to="/"
              />
              <ListRow
                icon="alert"
                iconTone="info"
                title="3 ventes signalées"
                subtitle="Vente hors prise de service"
                onClick={() => undefined}
              />
            </List>
          </Section>
          <Section title="Dernières ventes">
            <List>
              <ListRow
                leading={<Avatar name="Restaurant Le Wouri" />}
                title="Restaurant Le Wouri"
                subtitle="20:39 · Acompte"
                value="17 500 F"
                badge={<Badge tone="warn">Payée en partie</Badge>}
              />
              <ListRow
                leading={<Avatar name="Client de passage" />}
                title="Client de passage"
                subtitle="20:39 · Espèces"
                value="7 500 F"
                badge={<Badge tone="ok">Payée</Badge>}
              />
            </List>
          </Section>
        </div>
      </Block>

      <Block title="Liste en colonnes (exemple, hors données réelles)">
        <DataList
          aria-label="Créances"
          template="minmax(0,2.2fr) 4rem 8rem 9rem 8rem minmax(0,2fr)"
          columns={[
            { label: 'Client' },
            { label: 'Ventes', numeric: true },
            { label: 'Dû', numeric: true },
            { label: 'Échu' },
            { label: 'Échéance' },
            { label: '' },
          ]}
        >
          <DataRow>
            <DataCell primary>Restaurant Le Wouri</DataCell>
            <DataCell label="Ventes" numeric>
              2
            </DataCell>
            <DataCell label="Dû" numeric>
              52 500 F
            </DataCell>
            <DataCell label="Échu">
              <Badge tone="ok">À jour</Badge>
            </DataCell>
            <DataCell label="Échéance">29 nov. 2026</DataCell>
            <DataCell actions>
              <Button variant="ghost" size="sm" icon="phone">
                Appeler
              </Button>
              <Button variant="tonal" size="sm">
                Encaisser
              </Button>
            </DataCell>
          </DataRow>
          <DataRow>
            <DataCell primary>Hôtel de la Plage</DataCell>
            <DataCell label="Ventes" numeric>
              2
            </DataCell>
            <DataCell label="Dû" numeric>
              96 000 F
            </DataCell>
            <DataCell label="Échu">
              <Badge tone="bad">36 000 F · 12 j</Badge>
            </DataCell>
            <DataCell label="Échéance">18 oct. 2026</DataCell>
            <DataCell actions>
              <Button variant="ghost" size="sm" icon="phone">
                Appeler
              </Button>
              <Button variant="tonal" size="sm">
                Encaisser
              </Button>
            </DataCell>
          </DataRow>
        </DataList>
      </Block>

      <Block title="Tuiles d'indicateur">
        <div className="gal-grid">
          <KpiTile
            label="Ventes du jour"
            icon="cart"
            value="32 000 F"
            detail="3 ventes"
            delta={{ text: '+12 % sur hier', tone: 'ok' }}
            spark={[2, 3, 3, 5, 4, 6, 8]}
          />
          <KpiTile label="Encaissé" icon="cash" value="24 500 F" detail="3 encaissements" />
          <KpiTile label="Échu" value="48 000 F" tone="bad" detail="2 clients en retard" />
          <KpiTile
            label="Stock sous seuil"
            value="2"
            tone="warn"
            detail="produits à réapprovisionner"
          />
        </div>
      </Block>

      <Block title="Onglets">
        <Tabs
          label="Commandes"
          idPrefix="gal"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'open', label: 'En cours', count: 4 },
            { id: 'late', label: 'En retard', count: 1 },
            { id: 'done', label: 'Livrées' },
          ]}
        />
        <TabPanel idPrefix="gal" id="open" active={tab === 'open'}>
          <p className="muted">Quatre commandes en cours.</p>
        </TabPanel>
        <TabPanel idPrefix="gal" id="late" active={tab === 'late'}>
          <p className="muted">Une commande en retard de livraison.</p>
        </TabPanel>
        <TabPanel idPrefix="gal" id="done" active={tab === 'done'}>
          <p className="muted">Commandes livrées.</p>
        </TabPanel>
      </Block>

      <Block title="Bandeaux">
        <div className="stack">
          {banner ? (
            <Banner
              tone="warn"
              title="Cet appareil attend l’approbation"
              onDismiss={() => setBanner(false)}
              action={
                <Button size="sm" variant="outline">
                  Voir le code
                </Button>
              }
            >
              Vos opérations partiront après l’approbation de votre responsable.
            </Banner>
          ) : (
            <Button variant="outline" onClick={() => setBanner(true)}>
              Réafficher le bandeau
            </Button>
          )}
          <Banner tone="ok" title="Vente enregistrée">
            VTE-DEMO-PDV-2026-000004 · 14 000 F CFA
          </Banner>
          <Banner tone="bad" title="Envoi refusé">
            Le stock disponible est insuffisant pour 40 plateaux.
          </Banner>
          <Banner tone="info">Dernière mise à jour à 20:41.</Banner>
        </div>
      </Block>

      <Block title="États vide et chargement">
        <div className="gal-grid gal-grid-wide">
          <Card>
            <EmptyState
              icon="cart"
              title="Aucune vente aujourd’hui"
              action={<Button icon="plus">Nouvelle vente</Button>}
            >
              Les ventes du jour apparaîtront ici, même hors ligne.
            </EmptyState>
          </Card>
          <Card padded>
            <div className="stack">
              <Skeleton width="60%" height={20} />
              <SkeletonRows rows={2} />
              <div className="row">
                <Spinner /> <span className="muted">Chargement…</span>
              </div>
            </div>
          </Card>
        </div>
      </Block>

      <Block title="Feuille et notifications">
        <div className="row wrap">
          <Button variant="outline" onClick={() => setSheet(true)}>
            Ouvrir la feuille
          </Button>
        </div>
        <ToastButtons />
        <Sheet
          open={sheet}
          onClose={() => setSheet(false)}
          title="Actions rapides"
          footer={
            <>
              <Button variant="ghost" onClick={() => setSheet(false)}>
                Annuler
              </Button>
              <Button onClick={() => setSheet(false)}>Valider</Button>
            </>
          }
        >
          <List bare>
            <ListRow icon="cart" title="Nouvelle vente" onClick={() => setSheet(false)} />
            <ListRow icon="users" title="Nouvelle visite" onClick={() => setSheet(false)} />
            <ListRow icon="cash" title="Encaisser" onClick={() => setSheet(false)} />
          </List>
        </Sheet>
      </Block>

      <Block title={`Icônes (${ICON_NAMES.length})`}>
        <div className="gal-icons">
          {ICON_NAMES.map((name) => (
            <div key={name} className="gal-icon">
              <Icon name={name} size={24} />
              <span>{name}</span>
            </div>
          ))}
        </div>
      </Block>
    </div>
  );
}

export function ComponentGallery() {
  return (
    <ToastProvider>
      <Gallery />
    </ToastProvider>
  );
}
