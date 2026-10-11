# Optional sticky-note handwriting index

Ink Notes exposes one optional adapter on its plugin instance:

```ts
setStickyHandwritingIndexer(indexer: StickyHandwritingIndexer | undefined): void

type StickyHandwritingIndexer = (
  note: Readonly<StickyNote>,
  signal: AbortSignal,
) => Promise<string[]>;
```

The types are defined in `src/sticky-index.ts` and `src/sticky-model.ts`. An integration obtains the loaded `ink-notes` plugin instance using its host integration mechanism and calls the method after Ink Notes loads. Feature-detect the method for compatibility with older versions. Register only while the integration is enabled and unregister with `undefined` on unload. A single adapter is supported; registering another replaces the previous adapter. No adapter is installed by default.

For example, after obtaining the instance:

```ts
inkNotes.setStickyHandwritingIndexer(async (note, signal) => {
  // Use an existing recognizer configured by your integration.
  // Do not mutate the note or save recognition results into it.
  const text = await recognizer.recognize(note.strokes, { signal });
  return [text];
});
```

The hook is called only when **Find sticky notes** opens, once per note containing handwriting, sequentially. Each call receives a deep copy of the note, including its title, text, keywords, strokes and geometry. Stroke points use a fixed board coordinate space: multiply `x` and `y` by `STICKY_UNIT` (1000) to obtain board units. Coordinates can exceed 1; frame resizing does not change them. `scrollX`/`scrollY` describe the current visible window, not the full handwriting bounds. Recognize the full stroke list if the entire note should be searchable.

Return searchable strings. They supplement title/text/keywords for the current search session; they are never written into the note or a persistent recognition database. Search requires every whitespace-separated query term to match the combined content. Non-string results are ignored and at most 1000 strings per note are accepted. Opening search again recomputes these terms.

Each call has a five-second deadline. Closing the search modal, reaching the deadline or completing a call aborts its signal. The adapter must release resources and cancel requests when aborted. A failed or timed-out call stops further handwriting recognition for that session, reports an error and leaves ordinary search usable. Ink Notes ignores late results but cannot terminate an adapter that ignores cancellation or blocks the UI thread; use a worker for expensive recognition.

Registration itself never invokes recognition. The built-in feature makes no network requests. An adapter that uses a remote service must obtain the user's informed authorization, explain which note data it transmits, protect credentials and handle cancellation itself. Do not silently enable a remote provider. Removing the adapter restores title/text/keyword search without changing stored notes.
