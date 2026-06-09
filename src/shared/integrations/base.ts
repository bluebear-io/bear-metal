/** Common contract implemented by every external integration client. */
export interface Integration {
  readonly name: string;
}

/** An integration that can leave a comment on one of its resources. */
export interface CommentCapable<Ref> {
  leaveComment(ref: Ref, body: string): Promise<void>;
}
