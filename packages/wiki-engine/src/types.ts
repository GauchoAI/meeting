export type WikiNodeKind = "root" | "folder" | "source" | "pattern";

export type QueueStatus = "queued" | "processing" | "done" | "failed";

export interface WikiWorkspace {
  rootDir: string;
  rawDir: string;
  wikiDir: string;
  stateDir: string;
  queuePath: string;
}

export interface QueueItem {
  id: string;
  path: string;
  checksum: string;
  status: QueueStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  resultNodeId?: string;
}

export interface ExtractedSource {
  id: string;
  sourcePath: string;
  title: string;
  summary: string;
  keywords: string[];
  entities: string[];
  pathHints: string[];
  checksum: string;
  contentPreview: string;
}

export interface WikiFrontmatter {
  id: string;
  title: string;
  kind: WikiNodeKind;
  parent: string | null;
  children: string[];
  keywords: string[];
  references: string[];
  sourcePath?: string;
  checksum?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  needsCuration?: boolean;
}

export interface WikiPage {
  path: string;
  frontmatter: WikiFrontmatter;
  body: string;
}

export interface CandidateScore {
  node: WikiPage;
  score: number;
  reasons: string[];
}

export interface AttentionEntry {
  pageId: string;
  visits: number;
  insertions: number;
  searches: number;
  lastVisitedAt: string;
  notes: string[];
}

export interface AttentionIndex {
  entries: Record<string, AttentionEntry>;
}

export interface RouteDecision {
  parentId: string;
  confidence: number;
  reasons: string[];
  usedLlm: boolean;
}

export interface SearchResult {
  page: WikiPage;
  score: number;
  references: TraversalReference[];
}

export interface TraversalReference {
  label: string;
  targetId: string;
  targetTitle: string;
  kind: "child" | "parent" | "reference";
}

export interface ProcessResult {
  item: QueueItem;
  extracted: ExtractedSource;
  decision: RouteDecision;
  page: WikiPage;
  updatedParent: WikiPage;
}
