# Knights of King Arthur

A polished, narrative-rich overview of the Knights of King Arthur and the ideals that shaped Camelot.

## 1) Core figures

- **King Arthur** — the once and future king, ruler of Camelot and founder of the Round Table.
- **Merlin** — the wizard who helped bring Arthur to the throne and guided the kingdom.
- **Sir Lancelot** — renowned for martial skill, loyalty, and tragic emotional conflict.
- **Sir Gawain** — a symbol of honor, discipline, and duty.
- **Sir Percival** — the pure-hearted knight associated with the Quest for the Holy Grail.
- **Sir Galahad** — the paragon of purity and ultimate quest integrity.

## 2) Knights’ guiding values

1. **Honor** over convenience.
2. **Loyalty** to king, oath, and fellowship.
3. **Courage** in battle and in counsel.
4. **Compassion** for the vulnerable.
5. **Service** to Camelot’s peace and people.

## 3) The Round Table: what made it powerful

The Round Table was more than furniture: it was a governance model.

- No fixed “head” seat, representing shared merit.
- Debates and counsel in open exchange.
- Bonds across regions and lineages through common purpose.
- A mythic model of peer accountability.

## 4) The arc of legend

From Arthur’s coronation to the rise of Camelot, Arthurian legend cycles through:

- **Unity and rise**
- **Heroic quests** (including the Grail quest)
- **Intrigue and betrayal**
- **Fragmentation and reflection** on legacy

> The strongest stories are less about conquest and more about trying to *be worthy* of power.

## 5) Mermaid overview

```mermaid
flowchart LR
  A[Arthur crowned at Camelot] --> B[Round Table formed]
  B --> C[Quests and trials]
  C --> D[Sir Percival seeks the Grail]
  C --> E[Sir Lancelot rides with honor and conflict]
  C --> F[Sir Gawain guards Camelot]
  B --> G[Court of counsel and justice]
  G --> H[Unity of knights]
  D --> I[Spiritual revelation]
  E --> J[Tragic fracture]
  F --> K[Defense of kingdom]
  H --> L[Legacy endures]
  J --> L
  I --> L
```

## 6) Excalidraw sketch of the Arthurian constellation

![Arthurian constellation diagram](./artifact.smart.section-6.diagram-0.image-fix.png)

<!-- generated-diagram-image: section=6 diagram=0 prompt=./artifact.smart.section-6.diagram-0.image-fix.prompt.md source=./artifact.smart.section-6.diagram-0.image-fix.source.md -->

## 7) Britain in the Arthurian age: regions and dynamics

A simplified map of the political landscape often associated with the post-Roman, early Arthurian setting: fragmented Brittonic kingdoms, expanding Anglo-Saxon settlements, northern powers, and older Roman infrastructure still shaping movement and defense.

```mermaid
flowchart TB
  subgraph North[North Britain]
    P[Picts beyond the Forth]
    D[Dal Riata / Scotti]
    R[Rheged]
    G[Gododdin]
  end

  subgraph West[Western Brittonic kingdoms]
    W[Gwynedd]
    PW[Powys]
    DY[Dyfed]
    DU[Dumnonia]
  end

  subgraph Midlands[Central frontier]
    E[Elmet]
    VR[Old Roman roads & forts]
    CH[Christian monasteries / bishops]
  end

  subgraph EastSouth[East and south coastal zones]
    K[Kent]
    SX[Sussex]
    WS[West Saxons]
    AN[Anglian settlements]
  end

  subgraph Sea[Sea routes]
    IR[Irish Sea exchange]
    ARM[Armorica / Brittany]
    GA[Gaulish trade links]
  end

  P -->|pressure / raids| R
  D -->|sea links| IR
  IR <--> W
  IR <--> DY
  DU <--> ARM
  ARM <--> GA

  R -->|alliances & rivalries| G
  W <--> PW
  PW <--> E
  E -->|frontier defense| AN
  DU -->|western strongholds| WS

  K -->|settlement expansion| SX
  SX -->|pressure inland| WS
  WS -->|conflict zones| DU
  AN -->|pressure westward| E

  VR -.-> R
  VR -.-> E
  VR -.-> DU
  CH -.-> W
  CH -.-> PW
  CH -.-> DU

  classDef brit fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef saxon fill:#fee2e2,stroke:#b91c1c,color:#0f172a;
  classDef north fill:#dcfce7,stroke:#166534,color:#0f172a;
  classDef infra fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef sea fill:#e0e7ff,stroke:#3730a3,color:#0f172a;

  class W,PW,DY,DU,E brit;
  class K,SX,WS,AN saxon;
  class P,D,R,G north;
  class VR,CH infra;
  class IR,ARM,GA sea;
```

