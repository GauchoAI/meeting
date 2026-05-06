```diagram
nodes: 10

shapes:
  0: ellipse
  1: ellipse
  2: diamond
  3: diamond
  4: ellipse
  5: ellipse
  6: diamond
  7: ellipse
  8: ellipse
  9: ellipse

positions:
  0: 120, 80
  1: 120, 260
  2: 120, 440
  3: 400, 440
  4: 120, 620
  5: 120, 800
  6: 400, 800
  7: 120, 980
  8: 400, 980
  9: 120, 1160

styles:
  0: stroke=#60a5fa fill=#dbeafe fontSize=20
  2: stroke=#f59e0b fill=#fef3c7 strokeStyle=dashed roughness=2
  3: stroke=#f59e0b fill=#fef3c7 strokeStyle=dashed roughness=2
  6: stroke=#a855f7 fill=#f3e8ff
  9: stroke=#22c55e fill=#dcfce7

edges:
  0 -> 1 "alarm bell"
  1 -> 2 "wake"
  2 -> 3 "yes" dot stroke=#22c55e
  2 -> 1 "snooze" bar stroke=#fb7185
  3 -> 4 "if clear"
  3 -> 5 "if rough weather"
  4 -> 5 "dress"
  5 -> 6 "done?" 
  6 -> 7 "yes" arrow stroke=#22c55e
  6 -> 5 "adjust gear" bar stroke=#fb7185
  7 -> 8 "eat"
  8 -> 9 "ride out"

labels:
  0: "Herald rings dawn"
  1: "Knight awakens"
  2: "Can they rise before noon?"
  3: "Weather favorable for chores"
  4: "Pray and suit armor"
  5: "Saddle horse"
  6: "Armor tight?"
  7: "Breakfast in hall"
  8: "Check sword, mail, orders"
  9: "Begin morning quest"
```
