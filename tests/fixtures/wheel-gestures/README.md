# Recorded wheel input

These four unmodified JSON recordings are copied from the published
`wheel-gestures@2.3.0` package (`src/test/fixtures`). They are covered by its
MIT license, Copyright (c) 2020 Felix Leupold, reproduced in
`THIRD-PARTY-NOTICES.md`.

- `win-chrome-right-ptp.json` and `win-chrome-fast-right-ptp.json` originate
  in the upstream `negative-zero-event` folder and contain Windows Chrome
  Precision Touchpad lift markers. Their user agents identify Chrome 81.
- `double-swipe-right.json` contains two consecutive Mac trackpad swipes.
- `slow-drag-right.json` contains continuous deliberate dragging without
  detected momentum.

Source: https://github.com/xiel/wheel-gestures/tree/v2.3.0/src/test/fixtures

Replay tests retain negative zero, preserve event intervals with fake timers,
and mirror the recordings across both axes/directions. They cover real recorded
inputs, not a claim of testing every current device. Native `momentum` signals
are covered separately. The former application's rearm ratios, probation states
and 55/180/1200 ms inertia windows are no longer application contracts.
