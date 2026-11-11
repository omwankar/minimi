export type Claim = {
  subject: string;
  aspect: string;
  value: string;
  source?: string;
};

export type Episode = {
  id: string;
  at: string;
  day: string;
  threadId: string;
  user: string;
  assistant: string;
  topics: string[];
  entities: string[];
  claims: Claim[];
  sources: string[];
};

export type SourceLink = {
  title: string;
  url: string;
};

export type StoredMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
  sources?: SourceLink[];
  recalled?: string[];
};

export type Thread = {
  id: string;
  title: string;
  createdAt: string;
  messages: StoredMessage[];
};
