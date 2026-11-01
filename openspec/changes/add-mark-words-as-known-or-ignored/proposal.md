# Proposal

## Why

After importing Kindle lookups, many words do not belong in practice: words the learner already knows (looked up by accident or out of curiosity), and names, typos or fragments they never want to see again. They clutter the practice queue. The brief (section 6, Practice) already promises that users can mark words as known or as ignored; this change specifies that behaviour.

## What Changes

- A learner can mark a word as **known** or **ignored**, both from the word list and during a review.
- A **known** word leaves the practice queue but stays in the word list, shown as known. Un-marking it returns it to practice.
- An **ignored** word leaves the practice queue and is hidden from the word list by default. A filter shows ignored words, and the learner can restore one, which returns it to practice.
- A mark belongs to one word within one learning trajectory; the same word in another trajectory is unaffected.
- When a known or ignored word is restored, its scheduling resumes from the state it had when it was marked (proposed; see open questions).
- Re-importing a newer `vocab.db` never resets a mark. New lookups of a marked word are still stored with their sentence, but the word keeps its mark.

### Out of scope

- Bulk marking (selecting many words at once).
- Visual design; a minimal unstyled control is enough.
- Automatically suggesting words to ignore.
- Any change to the scheduling algorithm itself (FSRS via `ts-fsrs` stays as is).

## Capabilities

### New Capabilities
- `practice`: no main spec exists yet; this change creates it with the requirements for marking words as known or ignored and their effect on the practice queue and the word list. (`practice` is one of the agreed capabilities, so no new capability name is introduced.)

### Modified Capabilities
- `vocab-import`: adds the requirement that re-import preserves marks while still storing new lookups of marked words.

## Impact

- Data model: a per-trajectory word mark (none, known, ignored), kept alongside the word's scheduling state, which is a schema change.
- App API and contracts: operations to set and clear a mark, and a word-list filter for ignored words.
- Practice queue selection must exclude marked words; the review screen and word list gain a minimal mark control.
- Importer: re-import must leave marks untouched.
- Depends on the practice flow and word list (milestone M6 workload) and on trajectories and import (M4) existing.
