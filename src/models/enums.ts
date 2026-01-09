/**
 * Enums for session and agent states
 */

export enum Phase {
  Initializing = "initializing",
  Drafting = "drafting",
  PeerReview = "peer_review",
  Synthesizing = "synthesizing",
  UserReview = "user_review",
  Approved = "approved",
  Error = "error",
}

export enum AgentStatus {
  Pending = "pending",
  Working = "working",
  Done = "done",
  Error = "error",
}
