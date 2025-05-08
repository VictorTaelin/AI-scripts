# Problem

Using `holefill Parse.hs .fill.tmp i` will ask Gemini to complete the `Parse.hs`
file, using `dump.txt` and `Type.hs` as contexts. For some reason, though, its
completion is much different than what we get if we just pass `.fill.tmp`
directly to Gemini on Google AI Studio. Also, I can not figure out how to stream
Gemini's thinking tokens, to mimic the behavior of the AI Studio.

Also, OpenAI's o4-mini and o3 aren't showing thinking tokens either.
Enabling them would be appreciated.
