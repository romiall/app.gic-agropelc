import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import './src/i18n/index.js';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Attente des éléments (`findBy…`, `waitFor`) : 1 s par défaut, trop court quand la machine est
// chargée (serveur de développement, revues en parallèle) ; un élément qui n'apparaît jamais fait
// toujours échouer le test, au bout de ce délai.
configure({ asyncUtilTimeout: 4_000 });

// `test.globals` n'est pas activé (imports explicites partout, R1 lisibilité) : Testing
// Library ne détecte alors pas d'`afterEach` global pour son nettoyage automatique du DOM
// entre les tests — fait ici une fois pour tous les fichiers.
afterEach(() => cleanup());
