# Kindle Vocab — Product Brief

Oct 25, 2026 · @Miki

This brief is the source of truth for the app. Propose changes to it as edits, not silent deviations. Decisions live in `docs/adr/`.

## 1. The app

A responsive web app where learners upload the words they looked up on their Kindle and practise them with the book context, a translation into their own language and dictionary examples.

### Users and trajectories

- A **user** has an account and a mother language (the owner's is Hungarian).
- A user has one or more **learning trajectories**. A trajectory maps one foreign language (the books' language) to the user's own language, for example German → Hungarian.
- Kindle **word collections** are uploaded into a trajectory. An upload can contain several books; words are filed under the trajectory matching the book's language.

### Every word must carry

1. The **book** it came from (title, author).
2. Its **contexts**: every sentence where the user looked it up, and the surrounding paragraph when the book text is available.
3. **Translations** into the trajectory's own language, with the sense matched to each context.
4. **Dictionary example sentences** in the foreign language, with translations.

### Source data

The Kindle stores lookups in `system/vocabulary/vocab.db`, a SQLite file the user copies over USB. Expected tables (verify against the real fixture before coding):

| Table | Key columns | Use |
| --- | --- | --- |
| `WORDS` | `id`, `word`, `stem`, `lang`, `timestamp` | The looked-up word and its lemma |
| `LOOKUPS` | `word_key`, `book_key`, `usage`, `timestamp` | One lookup; `usage` is the sentence context |
| `BOOK_INFO` | `id`, `title`, `authors`, `lang` | The book |

Real files usually carry more: `BOOK_INFO.asin` and `guid`, `WORDS.profileid`, `LOOKUPS.dict_key` and `pos`, and the tables `DICT_INFO`, `METADATA` and `VERSION`. `WORDS.id` and `LOOKUPS.word_key` look like `en:word`, and timestamps are epoch milliseconds. The fixture script strips the identifying ones: ASINs, GUIDs, profile and device IDs, and `METADATA` values.

- The sentence context comes free in `LOOKUPS.usage`. Paragraph context needs the book text, so the user may optionally upload a DRM-free EPUB of the same book; the importer then locates each sentence and stores its paragraph.
- Re-uploading a newer `vocab.db` must be idempotent: only new lookups are added.

### Enrichment pipeline

- Runs asynchronously after upload (S3 → SQS → Lambda), never on the read path.
- For each new word in context, one Claude call (Batch API where latency allows) returns: lemma, part of speech, the sense used in this context, its translation into the own language, and 2–3 graded example sentences with translations.
- Ground with open data where available (Wiktionary extracts via kaikki.org, Tatoeba sentence pairs) and record which source each item came from.
- Quality is measured by `evals/enrichment/`: about 50 word-in-context cases per language pair with the expected Hungarian sense. Any prompt or model change must not lower the score.

### Practice

- Scheduling uses FSRS (via the `ts-fsrs` library); never a home-made algorithm.
- A review shows the word in the user's own book sentence first, then reveals translation and examples.
- Users can filter practice by trajectory and by book, and mark words as known or as ignored.

### UX process

- The owner wants alternatives, not a single design. Before the first UI work, three distinct directions are made as clickable prototypes, for desktop and mobile. Starting candidates:
  - **Context-first cloze:** the book sentence with the word blanked; reveal gives translation and examples.
  - **Mobile swipe triage:** swipe to mark known or to drill, feeding FSRS.
  - **Book shelf:** each book is a deck with progress; practise words from the book being read now.
- The owner picks or blends one. The result is frozen as a design system (tokens, components, layouts) that every later UI change must follow; screenshots are checked against it.

### Non-functional

- Works on current mobile Safari and Chrome and on desktop browsers; installable as a PWA.
- Importing a 2,000-word `vocab.db` completes, including enrichment, within 15 minutes.
- Personal data stays in one AWS region (eu-central-1).

## 2. Stack and layout

The stack is recorded in ADR 0001. Packages appear as the work needs them:

```
app/
├── contracts/   # zod/OpenAPI contracts
├── web/         # React PWA
├── api/         # Lambda handlers
├── domain/      # pure domain logic (FSRS scheduling, import parsing)
├── e2e/         # Playwright tests
└── fixtures/    # sample vocab.db, sample EPUB
evals/
└── enrichment/  # word-in-context translation eval set
infra/           # the CDK app: base stacks (zone, certificates, database) and the app stack, per environment
```

Every stack lives in eu-central-1. The one exception is a small certificate stack in us-east-1 for the CloudFront certificate. The environments and how they are deployed are in ADR 0006.

## 3. Owner decisions

Decided on 26–27 October 2026 and treated as requirements.

- [x] **Capabilities:** `vocab-import`, `trajectories`, `enrichment`, `practice`, `auth`. New ones need an owner decision.
- [x] **Languages:** English → Hungarian first; the enrichment eval set starts with this pair.
- [x] **Users:** owner only. Admin-created Cognito users, no sign-up page; the data model stays multi-user.
- [x] **Fixture data:** an anonymised copy in git, produced by a committed script that keeps the structure and real sentences from a few books and strips device IDs and ASINs.
- [x] **UX direction:** decide after the three prototypes; no leaning before then.
- [x] **Domain:** web app at `vocab.logtion.app`, API at `api.vocab.logtion.app`. The owner's domain `logtion.app` delegates `vocab.logtion.app` to a Route 53 hosted zone in the app's AWS account (NS records added at the owner's DNS). Certificates come from ACM with DNS validation; the CloudFront certificate must be issued in us-east-1, while the API certificate lives in eu-central-1.
- [x] **Environments (27 November 2026):** two, `test` and `prod`, in the app's own AWS account (100159507559), replacing a preview per pull request. `test` runs the `test` branch, which is `master` plus at most one feature branch, at `test.vocab.logtion.app` and `api.test.vocab.logtion.app`. Its database is rebuilt on every deploy. `prod` runs `master`. Both share one Aurora cluster, with one database each (ADRs 0006 and 0007).
