/**
 * Composants partagés (ADR-049) : rôles ARIA, liaison libellé-contrôle, clavier des onglets et
 * stabilité du DOM des listes (les essais des écrans passent par rôles, libellés et textes).
 */
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Banner,
  Button,
  DataCell,
  DataList,
  DataRow,
  Field,
  Input,
  KpiTile,
  LinkButton,
  Segmented,
  Sheet,
  TabPanel,
  Tabs,
  ToastProvider,
  initials,
  useToast,
} from './index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Button', () => {
  it('ne soumet pas un formulaire sans le demander', () => {
    render(<Button>Annuler</Button>);
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveAttribute('type', 'button');
  });

  it('se désactive pendant le chargement', () => {
    render(<Button loading>Envoi</Button>);
    const button = screen.getByRole('button', { name: 'Envoi' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('porte la variante demandée, et le lien en bouton reste un lien', () => {
    render(
      <MemoryRouter>
        <Button variant="tonal" size="lg" block>
          Encaisser
        </Button>
        <LinkButton to="/ventes" variant="outline">
          Ventes
        </LinkButton>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Encaisser' })).toHaveClass(
      'btn',
      'btn-tonal',
      'btn-lg',
      'btn-block',
    );
    expect(screen.getByRole('link', { name: 'Ventes' })).toHaveAttribute('href', '/ventes');
  });
});

describe('Field', () => {
  it('relie le libellé, l’aide et l’erreur au contrôle', () => {
    render(
      <Field label="Quantité" unit="plateaux" hint="Au plus 30" error="Dépasse le stock">
        {(control) => <Input {...control} />}
      </Field>,
    );
    const input = screen.getByLabelText('Quantité');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Dépasse le stock');
    expect(screen.getByText('Au plus 30')).toBeInTheDocument();
    expect(screen.getByText('plateaux')).toBeInTheDocument();
  });

  it('marque le champ facultatif sans changer le contrôle', () => {
    render(
      <Field label="Téléphone" optional>
        {(control) => <Input {...control} />}
      </Field>,
    );
    expect(screen.getByLabelText(/Téléphone/)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(/facultatif/)).toBeInTheDocument();
  });
});

describe('Segmented', () => {
  function Demo({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState('cash');
    return (
      <Segmented
        label="Moyen de paiement"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          { value: 'cash', label: 'Espèces' },
          { value: 'om', label: 'Orange Money' },
        ]}
      />
    );
  }

  it('est un groupe de radios nommés, dont celui de la valeur est coché', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Demo onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Moyen de paiement' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Espèces' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Orange Money' }));
    expect(onChange).toHaveBeenCalledWith('om');
    expect(screen.getByRole('radio', { name: 'Orange Money' })).toBeChecked();
  });
});

describe('Tabs', () => {
  function Demo() {
    const [value, setValue] = useState('a');
    return (
      <>
        <Tabs
          label="Commandes"
          idPrefix="t"
          value={value}
          onChange={setValue}
          items={[
            { id: 'a', label: 'En cours', count: 4 },
            { id: 'b', label: 'Livrées' },
          ]}
        />
        <TabPanel idPrefix="t" id="a" active={value === 'a'}>
          Premier panneau
        </TabPanel>
        <TabPanel idPrefix="t" id="b" active={value === 'b'}>
          Second panneau
        </TabPanel>
      </>
    );
  }

  it('change d’onglet au clic et aux flèches, un seul onglet dans l’ordre de tabulation', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const first = screen.getByRole('tab', { name: /En cours/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Livrées' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('Premier panneau')).toBeVisible();
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Livrées' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Second panneau')).toBeVisible();
    expect(screen.queryByText('Premier panneau')).not.toBeVisible();
    await user.click(first);
    expect(screen.getByText('Premier panneau')).toBeVisible();
  });
});

describe('Banner, Badge, KpiTile', () => {
  it('lit une alerte tout de suite et un message neutre poliment', () => {
    render(
      <>
        <Banner tone="bad" title="Envoi refusé" />
        <Banner tone="ok" title="Vente enregistrée" />
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Envoi refusé');
    expect(screen.getByRole('status')).toHaveTextContent('Vente enregistrée');
  });

  it('porte le ton de la pastille et transmet les attributs de la tuile', () => {
    render(
      <>
        <Badge tone="bad">Non payée</Badge>
        <KpiTile label="Échu" value="48 000 F" tone="bad" data-kpi="KPI-FIN-01" />
      </>,
    );
    expect(screen.getByText('Non payée')).toHaveClass('badge', 'badge-bad');
    const tile = screen.getByText('48 000 F').closest('[data-kpi]');
    expect(tile).toHaveAttribute('data-kpi', 'KPI-FIN-01');
    expect(tile).toHaveClass('tile-bad');
  });

  it('tire deux initiales au plus', () => {
    expect(initials('Hôtel de la Plage')).toBe('HD');
    expect(initials('  mama  ')).toBe('M');
    expect(initials('')).toBe('?');
  });
});

describe('DataList', () => {
  it('reste une liste : un élément de liste par ligne', () => {
    render(
      <DataList
        aria-label="Créances"
        template="2fr 1fr"
        columns={[{ label: 'Client' }, { label: 'Dû', numeric: true }]}
      >
        <DataRow>
          <DataCell primary>Restaurant Le Wouri</DataCell>
          <DataCell label="Dû" numeric>
            52 500 F
          </DataCell>
        </DataRow>
        <DataRow>
          <DataCell primary>Hôtel de la Plage</DataCell>
          <DataCell label="Dû" numeric>
            96 000 F
          </DataCell>
        </DataRow>
      </DataList>,
    );
    expect(screen.getByRole('list', { name: 'Créances' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Sheet', () => {
  it('affiche son titre et se ferme par le bouton « Fermer »', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Sheet open onClose={onClose} title="Actions rapides">
        <p>Contenu</p>
      </Sheet>,
    );
    expect(screen.getByRole('heading', { name: 'Actions rapides' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ToastProvider', () => {
  function Trigger() {
    const { notify } = useToast();
    return <button onClick={() => notify('Vente enregistrée.', 'ok')}>Notifier</button>;
  }

  it('affiche la notification puis la retire au bout de 4 s', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'Notifier' }).click();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Vente enregistrée.');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText('Vente enregistrée.')).not.toBeInTheDocument();
  });
});
