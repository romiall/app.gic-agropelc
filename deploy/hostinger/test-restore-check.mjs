// Essai des fonctions pures de restore-check.mjs (sans serveur de base) :
//   node deploy/hostinger/test-restore-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import {
  DATABASE_PREFIX,
  definerStripper,
  hostOfDefaults,
  inspectDump,
  isLocalHost,
  newestMigrationVersion,
  restoreDatabaseName,
  stripDefiner,
} from './restore-check.mjs';

// -- base jetable : toujours le meme prefixe, jamais un nom saisi ---------------------------------------------------
assert.equal(DATABASE_PREFIX, 'gic_agropelc_restore_check_');
assert.equal(
  restoreDatabaseName(new Date('2026-11-05T22:10:09.123Z')),
  'gic_agropelc_restore_check_20261105221009',
);

// -- serveur local seulement -----------------------------------------------------------------------------------------
assert.equal(
  hostOfDefaults('[client]\nuser=a\npassword="x#y"\nhost=127.0.0.1\nport=3307\n'),
  '127.0.0.1',
);
assert.equal(hostOfDefaults('[client]\nuser=a\n'), 'localhost', 'sans host : localhost');
assert.equal(hostOfDefaults('[client]\r\nhost = "db.example.com"\r\n'), 'db.example.com');
for (const host of ['localhost', '127.0.0.1', '::1', 'LOCALHOST'])
  assert.ok(isLocalHost(host), host);
for (const host of ['145.79.20.169', 'db.example.com', 'localhost.evil.com'])
  assert.ok(!isLocalHost(host), host);

// -- clauses DEFINER ------------------------------------------------------------------------------------------------
assert.equal(
  stripDefiner(
    '/*!50003 CREATE*/ /*!50017 DEFINER=`u720123645_gic`@`localhost`*/ /*!50003 TRIGGER t BEFORE UPDATE ON x FOR EACH ROW',
  ),
  '/*!50003 CREATE*/  /*!50003 TRIGGER t BEFORE UPDATE ON x FOR EACH ROW',
);
assert.equal(
  stripDefiner('CREATE DEFINER=`root`@`%` TRIGGER t BEFORE DELETE ON x'),
  'CREATE  TRIGGER t BEFORE DELETE ON x',
);
assert.equal(
  stripDefiner("CREATE DEFINER='root'@'localhost' PROCEDURE p()"),
  'CREATE  PROCEDURE p()',
);
assert.equal(
  stripDefiner("INSERT INTO t VALUES ('rien a changer');"),
  "INSERT INTO t VALUES ('rien a changer');",
);

// -- le flux passe octet pour octet (colonnes BINARY(16) d'un dump sans --hex-blob), seules les clauses changent ------------
const raw = Buffer.concat([
  Buffer.from("INSERT INTO t VALUES (_binary '", 'latin1'),
  Buffer.from([0x00, 0x80, 0xff, 0xc3, 0x28, 0x9f, 0x92]),
  Buffer.from(
    "');\n/*!50017 DEFINER=`a`@`b`*/ /*!50003 TRIGGER x */;;\nderniere ligne sans fin de ligne",
    'latin1',
  ),
]);
const out = [];
await new Promise((resolve, reject) => {
  Readable.from([raw.subarray(0, 40), raw.subarray(40, 41), raw.subarray(41)])
    .pipe(definerStripper())
    .on('data', (chunk) => out.push(chunk))
    .on('end', resolve)
    .on('error', reject);
});
const result = Buffer.concat(out);
assert.deepEqual(
  result,
  Buffer.concat([
    Buffer.from("INSERT INTO t VALUES (_binary '", 'latin1'),
    Buffer.from([0x00, 0x80, 0xff, 0xc3, 0x28, 0x9f, 0x92]),
    Buffer.from("');\n /*!50003 TRIGGER x */;;\nderniere ligne sans fin de ligne", 'latin1'),
  ]),
);

// -- migration la plus recente du depot ----------------------------------------------------------------------------------
assert.equal(
  newestMigrationVersion([
    '20261104130000_a.sql',
    '20261203100000_b.sql',
    '20261201090600_c.sql',
    'LISEZMOI.md',
  ]),
  '20261203100000',
);
assert.equal(newestMigrationVersion([]), null);

// -- lecture d'une archive : integrite, tables, declencheurs, pied -------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gic-restore-'));
try {
  const dump = [
    '-- MySQL dump 10.13',
    'CREATE TABLE `a` (',
    ') ENGINE=InnoDB;',
    'CREATE TABLE `b` (',
    ') ENGINE=InnoDB;',
    '/*!50003 CREATE*/ /*!50017 DEFINER=`x`@`y`*/ /*!50003 TRIGGER trg BEFORE UPDATE ON a FOR EACH ROW BEGIN END */;;',
    '-- Dump completed on 2026-11-05 22:00:00',
    '',
  ].join('\n');
  const good = path.join(tmp, 'gic-daily-20261105-220000.sql.gz');
  fs.writeFileSync(good, zlib.gzipSync(dump));
  const info = await inspectDump(good);
  assert.deepEqual(info, { createTables: 2, triggers: 1, completed: true, lines: 7 });

  const unfinished = path.join(tmp, 'gic-daily-20261105-230000.sql.gz');
  fs.writeFileSync(
    unfinished,
    zlib.gzipSync(dump.replace('-- Dump completed on 2026-11-05 22:00:00', '')),
  );
  assert.equal(
    (await inspectDump(unfinished)).completed,
    false,
    'sans pied, le dump est incomplet',
  );

  const truncated = path.join(tmp, 'gic-daily-20261105-240000.sql.gz');
  fs.writeFileSync(truncated, zlib.gzipSync(dump).subarray(0, 20));
  await assert.rejects(() => inspectDump(truncated), 'une archive tronquee est refusee');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  "OK : restore-check (base jetable, serveur local, DEFINER, flux binaire, migration du depot, lecture de l'archive)",
);
