/**
 * ECR-STK-09 « Seuils d'alerte » (AV-526 ; `inventory.threshold.manage` : Direction, Administrateur,
 * responsables de production et de ferme, magasinier, dans leur portée). Pour un emplacement, le minimum sous
 * lequel un produit est signalé et la cible à laquelle le réapprovisionnement le ramène (BR-STK-051). Chaque
 * réglage est une commande `inventory.threshold.set` (agrégat `STOCK_THRESHOLD`, identifiant choisi par
 * l'appareil) : le serveur désactive l'ancienne version et en crée une nouvelle, rien ne s'efface. Utilisable
 * hors ligne ; les alertes se recalculent dès l'envoi.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  Select,
  Sheet,
  SkeletonRows,
} from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import { stockLocations } from './stock-view.js';
import {
  checkThreshold,
  thresholdPayload,
  thresholdRows,
  type ThresholdRow,
} from './thresholds.js';
import './stock.css';

export function ThresholdsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ThresholdRow | null>(null);
  const [minText, setMinText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string>();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.thresholds')} />
        <SkeletonRows />
      </section>
    );
  }

  const locations = stockLocations(refs);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  const rows = location ? thresholdRows(refs, location.id) : [];
  const check = checkThreshold(minText, targetText);
  const unitOf = (row: ThresholdRow, quantity: number) =>
    unitLabel(row.product.base_unit_code, quantity, refs.units);

  const open = (row: ThresholdRow) => {
    setEditing(row);
    setMinText(row.threshold ? String(Number(row.threshold.min_qty_base)) : '');
    setTargetText(row.threshold ? String(Number(row.threshold.target_qty_base)) : '');
    setError(null);
  };
  const close = () => {
    setEditing(null);
    setError(null);
  };

  const save = async () => {
    if (!editing || !location || !check.values || busy) return;
    setBusy(true);
    setError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.threshold.set',
        aggregateType: 'STOCK_THRESHOLD',
        payload: thresholdPayload({
          locationId: location.id,
          productId: editing.product.id,
          min: check.values.min,
          target: check.values.target,
        }),
      });
      setLast(command.command_id);
      close();
    } catch (failure) {
      setError(t(saveErrorKey(failure)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <PageHeader
        backTo={ROUTES.stock}
        backLabel={t('thresholds.back')}
        title={t('nav.screens.thresholds')}
      />
      <div className="stk-narrow">
        <p className="stk-note">{t('thresholds.intro')}</p>
        {last ? <CommandResult commandId={last} messages="thresholds.result" /> : null}
        {!location ? (
          <EmptyState icon="box" title={t('thresholds.no_location')} />
        ) : (
          <>
            <Field label={t('thresholds.location_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={location.id}
                  onChange={(event) => setLocationChoice(event.target.value)}
                >
                  {locations.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {rows.length === 0 ? (
              <EmptyState icon="box" title={t('thresholds.no_product')} />
            ) : (
              <List>
                {rows.map((row) => (
                  <ListRow
                    key={row.product.id}
                    icon="box"
                    title={row.product.name}
                    subtitle={
                      row.threshold
                        ? t('thresholds.line', {
                            min: formatQuantity(Number(row.threshold.min_qty_base)),
                            target: formatQuantity(Number(row.threshold.target_qty_base)),
                            unit: unitOf(row, Number(row.threshold.target_qty_base)),
                          })
                        : t('thresholds.none')
                    }
                    value={
                      row.onHand === null
                        ? undefined
                        : t('thresholds.on_hand', {
                            quantity: formatQuantity(row.onHand),
                            unit: unitOf(row, row.onHand),
                          })
                    }
                    badge={
                      <Button variant="ghost" size="sm" onClick={() => open(row)}>
                        {row.threshold ? t('thresholds.edit') : t('thresholds.set')}
                      </Button>
                    }
                  />
                ))}
              </List>
            )}
          </>
        )}
      </div>
      <Sheet
        open={editing !== null}
        onClose={close}
        title={editing ? t('thresholds.sheet_title', { product: editing.product.name }) : ''}
        footer={
          <>
            <Button variant="tonal" onClick={close}>
              {t('thresholds.cancel')}
            </Button>
            <Button loading={busy} disabled={!check.values} onClick={() => void save()}>
              {t('thresholds.save')}
            </Button>
          </>
        }
      >
        <p className="stk-note">{t('thresholds.sheet_hint')}</p>
        <Field
          label={t('thresholds.min_label')}
          unit={editing ? unitOf(editing, 2) : undefined}
          error={
            minText && check.issues.includes('MIN_INVALID')
              ? t('thresholds.issue.number')
              : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={minText}
              onChange={(event) => setMinText(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('thresholds.target_label')}
          unit={editing ? unitOf(editing, 2) : undefined}
          error={
            targetText && check.issues.includes('TARGET_INVALID')
              ? t('thresholds.issue.number')
              : check.issues.includes('TARGET_BELOW_MIN')
                ? t('thresholds.issue.below_min')
                : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={targetText}
              onChange={(event) => setTargetText(event.target.value)}
            />
          )}
        </Field>
        {error ? (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        ) : null}
        {editing?.threshold ? <Badge tone="muted">{t('thresholds.versioned')}</Badge> : null}
      </Sheet>
    </section>
  );
}
