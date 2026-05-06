# Napoleonic Artillery Armament Across Europe

Artillery was one of the decisive arms of the Napoleonic Wars. Napoleon had been trained as an artillery officer, and he understood cannon not merely as support weapons but as instruments for shaping the entire battlefield: breaking infantry lines, silencing enemy guns, creating breaches, and preparing decisive attacks.

This document compares the main artillery types used by France, Britain, Austria, Prussia, Russia, and other European forces during the period.

## 1) Main types of artillery

- **Field guns** — mobile battlefield cannon firing solid shot, canister, and sometimes shell.
- **Howitzers** — shorter-barrel weapons firing explosive shells in a higher arc.
- **Horse artillery** — lighter guns with mounted crews, designed for rapid movement.
- **Siege artillery** — heavy cannon and mortars used against fortifications.
- **Rockets** — especially British Congreve rockets; terrifying but often inaccurate.

```mermaid
flowchart LR
  A[Napoleonic artillery] --> F[Field guns]
  A --> H[Howitzers]
  A --> HA[Horse artillery]
  A --> S[Siege guns and mortars]
  A --> R[Rockets]

  F --> F1[Solid shot]
  F --> F2[Canister at close range]
  H --> H1[Explosive shells]
  HA --> HA1[Fast redeployment]
  S --> S1[Fortress reduction]
  R --> R1[Morale shock]

  classDef root fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef weapon fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef effect fill:#dcfce7,stroke:#166534,color:#0f172a;

  class A root;
  class F,H,HA,S,R weapon;
  class F1,F2,H1,HA1,S1,R1 effect;
```

## 2) Comparative armament by country

| Country / force | Common artillery armament | Distinctive character |
|---|---|---|
| **France** | 4-, 6-, 8-, and 12-pounder guns; 6-inch howitzers | Mobile, aggressive, often concentrated in grand batteries |
| **Britain** | 6- and 9-pounder guns; 5.5-inch howitzers; Congreve rockets | Professional crews, strong horse artillery, disciplined fire |
| **Austria** | 3-, 6-, and 12-pounder guns; 7-pounder howitzers | Large, standardized, methodical artillery arm |
| **Prussia** | 6- and 12-pounder guns; 7- and 10-pounder howitzers | Reformed after 1806, increasingly mobile and efficient |
| **Russia** | 6- and 12-pounder guns; unicorn howitzers | Heavy batteries, strong defensive firepower, many guns |
| **Ottoman Empire / allied forces** | Mixed field, fortress, and imported artillery models | Varied quality; often strongest in fixed or fortified positions |

## 3) Battlefield roles

Artillery worked best when coordinated with infantry and cavalry. A commander could use guns to weaken a target, force enemy movement, disrupt morale, or create the exact opening needed for an assault.

```mermaid
flowchart TB
  C[Commander chooses artillery plan] --> M[Massed field battery]
  C --> H[Howitzer fire]
  C --> HA[Horse artillery]
  C --> S[Siege or fortress guns]
  C --> R[Congreve rockets]

  M -->|solid shot| I[Break infantry formations]
  M -->|counter-battery fire| G[Silence enemy guns]
  H -->|shells over cover| V[Strike villages, slopes, redoubts]
  HA -->|rapid movement| FL[Exploit flank or battlefield crisis]
  S -->|heavy bombardment| F[Reduce fortifications]
  R -->|noise, flame, uncertainty| MS[Create morale shock]

  I --> A[Infantry or cavalry assault]
  G --> A
  FL --> A
  MS --> A

  classDef command fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef artillery fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef effect fill:#dcfce7,stroke:#166534,color:#0f172a;
  classDef assault fill:#fee2e2,stroke:#b91c1c,color:#0f172a;

  class C command;
  class M,H,HA,S,R artillery;
  class I,G,V,FL,F,MS effect;
  class A assault;
```

## 4) National artillery profiles

```mermaid
flowchart LR
  subgraph France[France]
    FR1[Grand batteries]
    FR2[Mobile field guns]
    FR3[Offensive shock doctrine]
  end

  subgraph Britain[Britain]
    BR1[Royal Artillery]
    BR2[Royal Horse Artillery]
    BR3[Congreve rockets]
  end

  subgraph Austria[Austria]
    AU1[Standardized batteries]
    AU2[Strong 6- and 12-pounder use]
    AU3[Methodical deployment]
  end

  subgraph Prussia[Prussia]
    PR1[Post-1806 reforms]
    PR2[Improved corps artillery]
    PR3[Greater mobility]
  end

  subgraph Russia[Russia]
    RU1[Large gun parks]
    RU2[Unicorn howitzers]
    RU3[Heavy defensive firepower]
  end

  France --> N[Napoleonic battlefield]
  Britain --> N
  Austria --> N
  Prussia --> N
  Russia --> N

  classDef fr fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef br fill:#fee2e2,stroke:#b91c1c,color:#0f172a;
  classDef au fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef pr fill:#e5e7eb,stroke:#111827,color:#0f172a;
  classDef ru fill:#dcfce7,stroke:#166534,color:#0f172a;
  classDef center fill:#ede9fe,stroke:#6d28d9,color:#0f172a;

  class FR1,FR2,FR3 fr;
  class BR1,BR2,BR3 br;
  class AU1,AU2,AU3 au;
  class PR1,PR2,PR3 pr;
  class RU1,RU2,RU3 ru;
  class N center;
```

## 5) Why Napoleon cared so much about artillery

Napoleonic warfare relied on timing. Muskets were short-ranged and slow to reload, cavalry needed openings, and infantry assaults could collapse under disciplined fire. Artillery helped solve these problems by damaging formations before contact and forcing the enemy to react.

The French often used **massed batteries** to concentrate fire at a decisive point. Britain leaned heavily on professional gunnery and horse artillery. Russia relied on large numbers of guns and powerful defensive batteries. Austria and Prussia, especially after reforms, tried to balance standardization, mobility, and firepower.

In short: artillery was the battlefield lever that turned movement into decision.
