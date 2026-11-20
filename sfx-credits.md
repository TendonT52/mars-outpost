# Sound effects: sources and credits

All sound effects in `game/mars-game/sprites/Sfx/sounds/` come from the audio packs of Kenney (https://kenney.nl).
Each pack has the license Creative Commons Zero (CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/).
CC0 puts the sounds in the public domain, so a school can use, change and share them with no attribution.
We give the credit here because it is good practice, not because the license tells us to.

The tool `game/tools/fetch-sfx.mjs` downloads the packs and makes each file again with the same steps.
If you change a recipe in the tool, change this file too.

## Common steps for all files

The tool converts each file to WAV, 22050 Hz, mono, 16-bit PCM.
The tool adds a short fade at the start and at the end, so the sound does not click.
The tool sets the level to a target windowed RMS (100 ms window) that matches the sounds that the game has already.
The peak never goes above -3 dBFS.
Some files then get a trim of some dB lower ("trim" in the tool), so no effect is louder than the voice of the computer in the game.
"Semitones" below means a pitch change with `asetrate`, so the speed changes too.

## Packs

| Pack | Page |
|---|---|
| Interface Sounds | https://kenney.nl/assets/interface-sounds |
| UI Audio | https://kenney.nl/assets/ui-audio |
| Sci-fi Sounds | https://kenney.nl/assets/sci-fi-sounds |
| Impact Sounds | https://kenney.nl/assets/impact-sounds |
| Digital Audio | https://kenney.nl/assets/digital-audio |
| RPG Audio | https://kenney.nl/assets/rpg-audio |

## Files

| Name | Pack | Original file | License | Changes |
|---|---|---|---|---|
| click | Interface Sounds | select_001.ogg | CC0 | Low-pass filter at 5 kHz. |
| hover | Interface Sounds | click_003.ogg | CC0 | Low-pass filter at 5 kHz. Very low level. |
| open | Interface Sounds, Sci-fi Sounds | maximize_009.ogg, thrusterFire_003.ogg | CC0 | Rising tone plus 0.3 s of filtered hiss that gets louder, 12 dB lower. |
| close | Interface Sounds, Sci-fi Sounds | minimize_009.ogg, thrusterFire_003.ogg | CC0 | Falling tone plus 0.3 s of filtered hiss that gets quieter, 12 dB lower. |
| toast | Interface Sounds | glass_002.ogg | CC0 | Two copies. The second copy is 5 semitones higher and starts 0.12 s later. |
| message | Interface Sounds | glass_005.ogg | CC0 | Low-pass filter at 6 kHz. |
| type | Interface Sounds | click_002.ogg | CC0 | Low-pass filter at 4.5 kHz. Very low level. |
| success | Interface Sounds | confirmation_003.ogg | CC0 | Level only, then 3.5 dB lower, so it is quieter than the voice of the computer. |
| partial | Interface Sounds | question_001.ogg | CC0 | Level only. |
| miss | Interface Sounds | bong_001.ogg | CC0 | Low-pass filter at 3 kHz. Cut to 0.1 s. |
| pickup | Interface Sounds | drop_004.ogg | CC0 | Level only. |
| drop | Interface Sounds | drop_002.ogg | CC0 | Cut to 0.16 s. |
| plant | Impact Sounds | impactSoft_medium_002.ogg, footstep_snow_002.ogg | CC0 | Soft hit 7 semitones higher, plus 0.18 s of the snow step, 6 dB lower and filtered. |
| water | Sci-fi Sounds | slime_001.ogg | CC0 | 1 s from the 1 s point. Low-pass filter at 4 kHz. |
| door | Sci-fi Sounds, Impact Sounds | thrusterFire_003.ogg, impactMetal_heavy_002.ogg | CC0 | 0.6 s of filtered hiss, then a metal thunk at 0.55 s with a low-pass filter. |
| air | Sci-fi Sounds | thrusterFire_001.ogg | CC0 | 1.2 s of hiss. Band filter from 250 Hz to 3 kHz. Slow fades. |
| step | Impact Sounds | footstep_concrete_000.ogg | CC0 | Low-pass filter at 3 kHz. Cut to 0.085 s. Low level. |
| step-out | Impact Sounds | footstep_snow_002.ogg | CC0 | First 0.22 s. 2 semitones lower. Low-pass filter at 3.5 kHz. |
| station | Interface Sounds | confirmation_001.ogg | CC0 | Level only. |
| sol | Interface Sounds | confirmation_002.ogg | CC0 | 5 semitones lower. Three echoes make the tail longer. Then 1 dB lower, so it is quieter than the voice of the computer. |
| sleep | Interface Sounds | glass_002.ogg | CC0 | Four copies that go down in pitch (+7, +4, 0, -5 semitones), 0.18 s apart, with echo. |
| ship | Sci-fi Sounds | spaceEngineLow_001.ogg, spaceEngineSmall_002.ogg | CC0 | 2.5 s of each, mixed. The second file is 6 dB lower and filtered. Slow fades. |
| storm | Sci-fi Sounds | spaceEngineSmall_001.ogg, lowFrequency_explosion_000.ogg | CC0 | A filtered rumble that gets louder, plus the low explosion played backwards. 1.5 s. |
| card | RPG Audio, Interface Sounds | bookFlip3.ogg, glass_005.ogg | CC0 | Page flip, then a soft bell at 0.1 s, 4 dB lower. |
| warn | Interface Sounds | switch_003.ogg | CC0 | The first 0.22 s two times. The second copy is 4 semitones lower. Quieter than the danger alarm. |
| power | Digital Audio | phaseJump3.ogg | CC0 | 3 semitones lower. Made slower to 0.8 s with `atempo`. Band filter. |
| repair | Interface Sounds | glass_005.ogg | CC0 | Four copies that go up in pitch (0, +4, +7, +12 semitones), 0.06 s apart. |
| slider-tick | Interface Sounds | tick_004.ogg | CC0 | Low-pass filter at 4.5 kHz. Low level. |
| near | UI Audio | rollover2.ogg | CC0 | Low-pass filter at 5 kHz. Very low level. |
| chat-open | Interface Sounds | maximize_007.ogg | CC0 | Low-pass filter at 5 kHz. |
| chat-close | Interface Sounds | minimize_007.ogg | CC0 | Low-pass filter at 5 kHz. |
| send | Interface Sounds | maximize_002.ogg | CC0 | Low-pass filter at 6 kHz. |
| mic-on | Interface Sounds | pluck_001.ogg | CC0 | Two copies that go up (0, then +7 semitones 0.08 s later). Low-pass filter at 6 kHz. |
| mic-off | Interface Sounds | pluck_001.ogg | CC0 | Two copies that go down (+7, then 0 semitones 0.08 s later). Low-pass filter at 6 kHz. |
| pack-in | RPG Audio, Digital Audio | metalLatch.ogg, phaseJump3.ogg | CC0 | Metal latch with a low-pass filter at 4 kHz, then 0.25 s of the power hum at 0.08 s, 10 dB lower. The peak limit makes it about 4 dB quieter than the target. |
| swap | Interface Sounds | drop_002.ogg | CC0 | Two short copies, 0.11 s apart. The first copy is 2 semitones higher, and the second copy is 2 semitones lower. |
| drop-back | Interface Sounds | back_003.ogg | CC0 | Low-pass filter at 4 kHz. Lower level than drop. |
| unplant | RPG Audio, Interface Sounds | cloth2.ogg, pluck_002.ogg | CC0 | 0.25 s of cloth rustle with a low-pass filter at 3.5 kHz, plus a pluck 5 semitones lower, 8 dB lower. Cut to 0.3 s. |
| build-thud | Impact Sounds | impactPlate_medium_002.ogg, impactSoft_heavy_000.ogg | CC0 | Plate hit with a low-pass filter at 2.5 kHz, plus a soft heavy hit, 3 dB lower. Cut to 0.4 s. |
| beam-lock | Interface Sounds, Sci-fi Sounds | toggle_002.ogg, glass_005.ogg, forceField_002.ogg | CC0 | A toggle click, a bell 7 semitones higher at 0.04 s, and 0.55 s of force field hum, 8 dB lower. Cut to 0.6 s. |
