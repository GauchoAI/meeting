```diagram
nodes: 14

shapes:
  0: ellipse
  3: diamond
  6: diamond
  9: diamond
  13: ellipse

positions:
  0: 80, 80
  1: 380, 80
  2: 680, 80
  3: 980, 80
  4: 220, 300
  5: 520, 300
  6: 820, 300
  7: 1120, 300
  8: 520, 520
  9: 820, 520
  10: 1120, 520
  11: 1420, 520
  12: 820, 740

styles:
  0: stroke=#60a5fa fill=#dbeafe fontSize=20
  3: stroke=#f59e0b fill=#fef3c7 strokeStyle=dashed roughness=2
  6: stroke=#a855f7 fill=#f3e8ff
  9: stroke=#fb7185 fill=#ffe4e6 strokeWidth=3
  13: stroke=#22c55e fill=#dcfce7
edges:
  0 -> 1 "voice"
  1 -> 2 "events"
  2 -> 3 "intent?"
  3 -> 4 "yes" dot stroke=#22c55e
  3 -> 1 "clarify" bar stroke=#fb7185
  4 -> 5 "plan"
  5 -> 6 "choose"
  6 -> 7 "diagram"
  6 -> 8 "markdown"
  6 -> 9 "UI"
  7 -> 10 "render"
  8 -> 10 "render"
  9 -> 10 "render"
  10 -> 11 "inspect"
  11 -> 12 "fix"
  12 -> 6 "iterate" arrow stroke=#a855f7
  9 -> 9 "retry UI" arrow stroke=#fb7185
  10 -> 3 "bad result" bar stroke=#f59e0b
  12 -> 13 "ship" arrow stroke=#22c55e strokeWidth=3

labels:
  0: "Host speaks in Meeting"
  1: "Stable shell captures audio"
  2: "Transcript becomes agent input"
  3: "Did we understand the objective?"
  4: "Task-driven assistant loop"
  5: "Plan next concrete action"
  6: "Select output surface"
  7: "Excalidraw"
  8: "Concise Markdown artifact"
  9: "Generated interactive UI"
  10: "Meeting canvas renderer"
  11: "Human visual inspection"
  12: "Screenshot-driven fixes"
  13: "Polished shared result"
```
