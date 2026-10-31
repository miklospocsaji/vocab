## Problem
After importing my Kindle lookups, many words don't belong in practice: words I already
know (looked up by accident or out of curiosity), and names, typos or fragments I never
want to see again. They clutter the practice queue.
## What I want
- I can mark a word as known or ignored, from the word list and during a review.
- A known word leaves the practice queue but stays in the word list, shown as known.
  I can un-mark it, and it returns to practice.
- An ignored word leaves the practice queue and is hidden from the word list by default.
  A filter shows ignored words, and I can restore one.
- A mark applies within one learning trajectory. The same word in another trajectory is
  not affected.
- Re-importing a newer vocab.db never resets a mark. New lookups of an ignored word are
  still stored (with their sentence), but the word stays ignored.
## Out of scope
- Bulk marking (selecting many words at once)
- Visual design; a minimal unstyled control is enough
- Automatically suggesting words to ignore
## Open question
When a known word is un-marked, should its scheduling resume where it left off or start
fresh? Scheduling uses ts-fsrs: https://github.com/open-spaced-repetition/ts-fsrs
