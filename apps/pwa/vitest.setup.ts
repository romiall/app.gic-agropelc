import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import './src/i18n/index.js';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `test.globals` n'est pas activé (imports explicites partout, R1 lisibilité) : Testing
// Library ne détecte alors pas d'`afterEach` global pour son nettoyage automatique du DOM
// entre les tests — fait ici une fois pour tous les fichiers.
afterEach(() => cleanup());
