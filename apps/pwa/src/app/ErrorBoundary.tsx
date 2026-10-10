/**
 * Garde-fou d'affichage : une erreur inattendue dans un écran affiche un message et un bouton de
 * rechargement au lieu d'un écran blanc. Les opérations enregistrées restent dans l'outbox (O1).
 */
import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <section className="sale" role="alert">
      <h1>{t('errors.title')}</h1>
      <p className="home-muted">{t('errors.help')}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t('errors.reload')}
      </button>
    </section>
  );
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Change de valeur à chaque navigation : l'écran suivant repart sans l'erreur. */
  readonly resetKey: string;
}

interface ErrorBoundaryState {
  readonly failedKey: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failedKey: null };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failedKey: '__pending__' };
  }

  override componentDidCatch(): void {
    this.setState({ failedKey: this.props.resetKey });
  }

  override render(): ReactNode {
    const { failedKey } = this.state;
    if (failedKey !== null && (failedKey === '__pending__' || failedKey === this.props.resetKey)) {
      return <ErrorFallback />;
    }
    return this.props.children;
  }
}
