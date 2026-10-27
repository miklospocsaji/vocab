# Fixtures

- `vocab.db`: an anonymised copy of the owner's Kindle `vocab.db` with four books (see ADR 0005).
- `vocab-older.db`: the same data cut at 75% of lookups by time, for idempotent re-import tests ("older, then newer").

Placeholders: book ids and GUIDs are `fixture-book-NN`, ASINs `fixture-asin-NN`, dictionary ids `fixture-dict-NN`, profile ids `fixture-profile`. Timestamps are shifted so the earliest is 2020-01-01T00:00:00Z.

Regenerate (the original stays git-ignored at `docs/vocab.db`):

```sh
node app/fixtures/scripts/anonymise-vocab-db.ts --in docs/vocab.db \
  --out app/fixtures/vocab.db --older-out app/fixtures/vocab-older.db \
  --book "Project Hail Mary" \
  --book "Your Money and Your Brain: How the New Science of Neuroeconomics Can Help Make You Rich (A Personal Finance Guide)" \
  --book "Broken Money: Why Our Financial System is Failing Us and How We Can Make it Better" \
  --book "Rich Dad Poor Dad"
```

The output is byte-identical for the same input and options.
