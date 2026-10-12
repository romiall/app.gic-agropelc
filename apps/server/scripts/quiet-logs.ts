/**
 * Importé en premier par les scripts : les journaux applicatifs (pino) ne gardent que les avertissements
 * et les erreurs, sauf `LOG_LEVEL` explicite. Le niveau est lu au chargement du journal, d'où ce module.
 */
process.env.LOG_LEVEL ??= 'warn';
